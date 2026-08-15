import type { RunStatusCode } from '../types.js'
import type { TraceRecord } from './records.js'
import { materializeRun } from './materialize.js'
import {
  TRACE_STORE_SCHEMA_MAJOR,
  TraceStoreError,
  type AppendResult,
  type DeleteResult,
  type GetRunOptions,
  type Page,
  type RetentionPolicy,
  type RunSummary,
  type StoredRun,
  type TraceDeleteQuery,
  type TraceQuery,
  type TraceStore,
  type TraceStoreDiagnostic,
} from './store.js'

const STATUS_CODES = new Set<RunStatusCode>([
  'ok', 'error', 'cancelled', 'timeout', 'budget_exhausted', 'rejected', 'suspended', 'skipped',
])
const SPAN_KINDS = new Set(['run', 'routing', 'agent', 'task', 'llm', 'tool', 'plan', 'consensus', 'checkpoint', 'callback'])
const EVENT_NAMES = new Set([
  'retry_scheduled', 'budget_exhausted', 'first_chunk', 'approval_decision',
  'checkpoint_failed', 'telemetry_diagnostic', 'loop_detected', 'stream_chunk',
  'consensus_verdict',
])
const LINK_RELATIONS = new Set(['continued_from', 'depends_on', 'consumed', 'delegated_from'])

interface StoredRecordEntry {
  readonly record: TraceRecord
  readonly revision: number
  readonly arrival: number
}

interface SeenRecord {
  readonly runId: string
  readonly fingerprint: string
}

interface CursorState {
  readonly snapshotRevision: number
  readonly deleteEpoch: number
  readonly queryFingerprint: string
  readonly startedAt: string
  readonly runId: string
}

interface NormalizedQuery {
  readonly runIds?: readonly string[]
  readonly startedAfterMs?: number
  readonly startedBeforeMs?: number
  readonly status?: readonly RunStatusCode[]
  readonly agent?: readonly string[]
  readonly taskId?: readonly string[]
  readonly model?: readonly string[]
  readonly provider?: readonly string[]
  readonly limit: number
  readonly order: 'started_desc' | 'started_asc'
}

export interface InMemoryTraceStoreOptions {
  /** Injectable wall clock used only by retention. */
  readonly now?: () => number
  readonly onDiagnostic?: (diagnostic: TraceStoreDiagnostic) => void
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) output[key] = cloneValue(child)
    return output as T
  }
  return value
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value)
}

function hash(value: string): string {
  let current = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    current ^= value.charCodeAt(index)
    current = Math.imul(current, 0x01000193)
  }
  return (current >>> 0).toString(36)
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${field} must be a non-empty string.`, field)
  }
}

function finiteNumber(value: unknown, field: string, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${field} must be a finite number >= ${min}.`, field)
  }
}

function validateRecord(record: unknown, index: number): asserts record is TraceRecord {
  const prefix = `records[${index}]`
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${prefix} must be an object.`, prefix)
  }
  const candidate = record as Record<string, unknown>
  if (candidate['schemaVersion'] !== TRACE_STORE_SCHEMA_MAJOR) {
    if (typeof candidate['schemaVersion'] === 'number') {
      throw new TraceStoreError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Unsupported TraceRecord schema major ${candidate['schemaVersion']}; supported major is ${TRACE_STORE_SCHEMA_MAJOR}.`,
        `${prefix}.schemaVersion`,
      )
    }
    throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.schemaVersion must be ${TRACE_STORE_SCHEMA_MAJOR}.`, `${prefix}.schemaVersion`)
  }
  nonEmptyString(candidate['recordId'], `${prefix}.recordId`)
  finiteNumber(candidate['sequence'], `${prefix}.sequence`, 1)
  if (!Number.isInteger(candidate['sequence'])) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.sequence must be an integer.`, `${prefix}.sequence`)
  }
  finiteNumber(candidate['timestampUnixMs'], `${prefix}.timestampUnixMs`)
  nonEmptyString(candidate['runId'], `${prefix}.runId`)
  finiteNumber(candidate['attempt'], `${prefix}.attempt`, 1)
  if (!Number.isInteger(candidate['attempt'])) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.attempt must be an integer.`, `${prefix}.attempt`)
  }
  nonEmptyString(candidate['traceId'], `${prefix}.traceId`)
  nonEmptyString(candidate['spanId'], `${prefix}.spanId`)
  if (candidate['parentSpanId'] !== undefined) nonEmptyString(candidate['parentSpanId'], `${prefix}.parentSpanId`)
  if (candidate['recordType'] !== 'span_start'
    && candidate['recordType'] !== 'span_event'
    && candidate['recordType'] !== 'span_end') {
    throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.recordType is invalid.`, `${prefix}.recordType`)
  }
  if (!candidate['attributes'] || typeof candidate['attributes'] !== 'object' || Array.isArray(candidate['attributes'])) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.attributes must be an object.`, `${prefix}.attributes`)
  }
  for (const [key, value] of Object.entries(candidate['attributes'] as Record<string, unknown>)) {
    const scalar = typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    const array = Array.isArray(value) && value.every((item) =>
      typeof item === 'string' || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item)))
      && new Set(value.map((item) => typeof item)).size <= 1
    if (!scalar && !array) {
      throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.attributes.${key} is not a supported trace attribute.`, `${prefix}.attributes.${key}`)
    }
  }
  if (candidate['recordType'] === 'span_start' || candidate['recordType'] === 'span_end') {
    nonEmptyString(candidate['kind'], `${prefix}.kind`)
    if (!SPAN_KINDS.has(candidate['kind'])) {
      throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.kind is invalid.`, `${prefix}.kind`)
    }
    nonEmptyString(candidate['name'], `${prefix}.name`)
    finiteNumber(candidate['startUnixMs'], `${prefix}.startUnixMs`)
  }
  if (candidate['recordType'] === 'span_event') {
    nonEmptyString(candidate['name'], `${prefix}.name`)
    if (!EVENT_NAMES.has(candidate['name'])) {
      throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.name is not a supported event name.`, `${prefix}.name`)
    }
  }
  if (candidate['links'] !== undefined) {
    if (!Array.isArray(candidate['links'])) {
      throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.links must be an array.`, `${prefix}.links`)
    }
    candidate['links'].forEach((link, linkIndex) => {
      const field = `${prefix}.links[${linkIndex}]`
      if (!link || typeof link !== 'object' || Array.isArray(link)) {
        throw new TraceStoreError('INVALID_ARGUMENT', `${field} must be an object.`, field)
      }
      const value = link as Record<string, unknown>
      nonEmptyString(value['traceId'], `${field}.traceId`)
      nonEmptyString(value['spanId'], `${field}.spanId`)
      if (!LINK_RELATIONS.has(value['relation'] as string)) {
        throw new TraceStoreError('INVALID_ARGUMENT', `${field}.relation is invalid.`, `${field}.relation`)
      }
    })
  }
  if (candidate['recordType'] === 'span_end') {
    finiteNumber(candidate['endUnixMs'], `${prefix}.endUnixMs`)
    finiteNumber(candidate['durationMs'], `${prefix}.durationMs`)
    const status = candidate['status']
    if (!status || typeof status !== 'object' || !STATUS_CODES.has((status as { code?: RunStatusCode }).code!)) {
      throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.status.code is invalid.`, `${prefix}.status.code`)
    }
    const message = (status as { message?: unknown }).message
    if (message !== undefined && typeof message !== 'string') {
      throw new TraceStoreError('INVALID_ARGUMENT', `${prefix}.status.message must be a string.`, `${prefix}.status.message`)
    }
  }
}

function stringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${field} must contain non-empty strings.`, field)
  }
  return [...new Set(values)].sort()
}

function statusList(value: unknown, field: string): readonly RunStatusCode[] | undefined {
  const values = stringList(value, field)
  if (!values) return undefined
  if (values.some((status) => !STATUS_CODES.has(status as RunStatusCode))) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${field} contains an unsupported status.`, field)
  }
  return values as RunStatusCode[]
}

function parseDate(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new TraceStoreError('INVALID_ARGUMENT', `${field} must be a valid ISO-8601 timestamp.`, field)
  }
  return Date.parse(value)
}

function normalizeQuery(query: TraceQuery = {}): NormalizedQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TraceStoreError('INVALID_ARGUMENT', 'query must be an object.', 'query')
  }
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TraceStoreError('INVALID_ARGUMENT', 'limit must be an integer from 1 through 500.', 'limit')
  }
  if (query.order !== undefined && query.order !== 'started_asc' && query.order !== 'started_desc') {
    throw new TraceStoreError('INVALID_ARGUMENT', 'order must be started_asc or started_desc.', 'order')
  }
  const startedAfterMs = parseDate(query.startedAfter, 'startedAfter')
  const startedBeforeMs = parseDate(query.startedBefore, 'startedBefore')
  if (startedAfterMs !== undefined && startedBeforeMs !== undefined && startedAfterMs >= startedBeforeMs) {
    throw new TraceStoreError('INVALID_ARGUMENT', 'startedAfter must be before startedBefore.', 'startedAfter')
  }
  return {
    ...(stringList(query.runId, 'runId') ? { runIds: stringList(query.runId, 'runId') } : {}),
    ...(startedAfterMs !== undefined ? { startedAfterMs } : {}),
    ...(startedBeforeMs !== undefined ? { startedBeforeMs } : {}),
    ...(statusList(query.status, 'status') ? { status: statusList(query.status, 'status') } : {}),
    ...(stringList(query.agent, 'agent') ? { agent: stringList(query.agent, 'agent') } : {}),
    ...(stringList(query.taskId, 'taskId') ? { taskId: stringList(query.taskId, 'taskId') } : {}),
    ...(stringList(query.model, 'model') ? { model: stringList(query.model, 'model') } : {}),
    ...(stringList(query.provider, 'provider') ? { provider: stringList(query.provider, 'provider') } : {}),
    limit,
    order: query.order ?? 'started_desc',
  }
}

function queryIdentity(query: NormalizedQuery): string {
  const { limit: _limit, ...identity } = query
  return JSON.stringify(identity)
}

function intersects(actual: readonly string[], expected: readonly string[] | undefined): boolean {
  return !expected || expected.some((value) => actual.includes(value))
}

function matches(summary: RunSummary, query: NormalizedQuery): boolean {
  const started = Date.parse(summary.startedAt)
  return (!query.runIds || query.runIds.includes(summary.runId))
    && (query.startedAfterMs === undefined || started >= query.startedAfterMs)
    && (query.startedBeforeMs === undefined || started < query.startedBeforeMs)
    && (!query.status || (summary.status !== undefined && query.status.includes(summary.status)))
    && intersects(summary.agents, query.agent)
    && intersects(summary.taskIds, query.taskId)
    && intersects(summary.models, query.model)
    && intersects(summary.providers, query.provider)
}

function compareRuns(a: RunSummary, b: RunSummary, order: NormalizedQuery['order']): number {
  const time = Date.parse(a.startedAt) - Date.parse(b.startedAt)
  const stable = time || a.runId.localeCompare(b.runId)
  return order === 'started_asc' ? stable : -stable
}

/** Non-durable reference TraceStore for tests and short-lived local runs. */
export class InMemoryTraceStore implements TraceStore {
  private readonly entries: StoredRecordEntry[] = []
  private readonly seen = new Map<string, SeenRecord>()
  private readonly firstEndBySpan = new Map<string, string>()
  private revision = 0
  private arrival = 0
  private deleteEpoch = 0
  private readonly cursorSecret = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  private readonly now: () => number

  constructor(private readonly options: InMemoryTraceStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async append(records: readonly TraceRecord[]): Promise<AppendResult> {
    if (!Array.isArray(records)) {
      throw new TraceStoreError('INVALID_ARGUMENT', 'records must be an array.', 'records')
    }
    records.forEach(validateRecord)
    records.forEach((record, index) => {
      try {
        const serialized = JSON.stringify(record)
        if (serialized === undefined) throw new Error('not serializable')
      } catch {
        throw new TraceStoreError('INVALID_ARGUMENT', `records[${index}] must be JSON-serializable.`, `records[${index}]`)
      }
    })
    const stagedSeen = new Map(this.seen)
    const stagedEnds = new Map(this.firstEndBySpan)
    const writes: TraceRecord[] = []
    const diagnostics: TraceStoreDiagnostic[] = []
    let deduplicated = 0

    for (const input of records) {
      const record = cloneValue(input)
      const existing = stagedSeen.get(record.recordId)
      if (existing) {
        deduplicated++
        if (existing.fingerprint !== fingerprint(record)) {
          diagnostics.push({
            code: 'record_id_collision', runId: record.runId, traceId: record.traceId, spanId: record.spanId,
            message: 'A recordId already existed with a different payload; the first record was retained.',
          })
        }
        continue
      }
      if (record.recordType === 'span_end') {
        const spanKey = `${record.traceId}:${record.spanId}`
        if (stagedEnds.has(spanKey)) {
          deduplicated++
          diagnostics.push({
            code: 'duplicate_span_end', runId: record.runId, traceId: record.traceId, spanId: record.spanId,
            message: 'A duplicate span_end was ignored; the first accepted end remains authoritative.',
          })
          stagedSeen.set(record.recordId, { runId: record.runId, fingerprint: fingerprint(record) })
          continue
        }
        stagedEnds.set(spanKey, record.recordId)
      }
      writes.push(record)
      stagedSeen.set(record.recordId, { runId: record.runId, fingerprint: fingerprint(record) })
    }

    const revision = writes.length > 0 ? this.revision + 1 : this.revision
    for (const record of writes) this.entries.push({ record, revision, arrival: ++this.arrival })
    if (writes.length > 0) this.revision = revision
    this.seen.clear()
    for (const [key, value] of stagedSeen) this.seen.set(key, value)
    this.firstEndBySpan.clear()
    for (const [key, value] of stagedEnds) this.firstEndBySpan.set(key, value)
    for (const diagnostic of diagnostics) {
      try { this.options.onDiagnostic?.(cloneValue(diagnostic)) } catch { /* telemetry diagnostics are fail-open */ }
    }
    return cloneValue({ written: writes.length, deduplicated, diagnostics })
  }

  async getRun(runId: string, options: GetRunOptions = {}): Promise<StoredRun | null> {
    nonEmptyString(runId, 'runId')
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TraceStoreError('INVALID_ARGUMENT', 'options must be an object.', 'options')
    }
    const result = materializeRun(
      this.entries.filter((entry) => entry.record.runId === runId).map((entry) => entry.record),
      options.includeRecords ?? false,
    )
    return result ? cloneValue(result) : null
  }

  async queryRuns(query: TraceQuery = {}): Promise<Page<RunSummary>> {
    const normalized = normalizeQuery(query)
    const identity = queryIdentity(normalized)
    let snapshotRevision = this.revision
    let after: Pick<CursorState, 'startedAt' | 'runId'> | undefined
    if (query.cursor !== undefined) {
      const state = this.decodeCursor(query.cursor)
      if (state.queryFingerprint !== identity || state.deleteEpoch !== this.deleteEpoch) {
        throw new TraceStoreError('INVALID_CURSOR', 'Cursor does not match this query or is no longer valid.', 'cursor')
      }
      snapshotRevision = state.snapshotRevision
      after = state
    }
    const summaries = this.materializeSummaries(snapshotRevision)
      .filter((summary) => matches(summary, normalized))
      .sort((a, b) => compareRuns(a, b, normalized.order))
    const startIndex = after
      ? summaries.findIndex((summary) => summary.startedAt === after!.startedAt && summary.runId === after!.runId) + 1
      : 0
    if (after && startIndex === 0) {
      throw new TraceStoreError('INVALID_CURSOR', 'Cursor position is not present in the query snapshot.', 'cursor')
    }
    const items = summaries.slice(startIndex, startIndex + normalized.limit)
    const hasMore = startIndex + items.length < summaries.length
    const nextCursor = hasMore && items.length > 0
      ? this.encodeCursor({
        snapshotRevision,
        deleteEpoch: this.deleteEpoch,
        queryFingerprint: identity,
        startedAt: items.at(-1)!.startedAt,
        runId: items.at(-1)!.runId,
      })
      : undefined
    return cloneValue({ items, ...(nextCursor ? { nextCursor } : {}) })
  }

  async deleteRun(runId: string): Promise<DeleteResult> {
    nonEmptyString(runId, 'runId')
    return this.deleteRunIds([runId])
  }

  async delete(query: TraceDeleteQuery): Promise<DeleteResult> {
    if (query && ('cursor' in query || 'limit' in query || 'order' in query)) {
      throw new TraceStoreError('INVALID_ARGUMENT', 'delete does not accept cursor, limit, or order.', 'query')
    }
    const normalized = normalizeQuery({ ...query, limit: 500 })
    const ids = this.materializeSummaries(this.revision)
      .filter((summary) => matches(summary, normalized))
      .sort((a, b) => compareRuns(a, b, 'started_asc'))
      .map((summary) => summary.runId)
    return this.deleteRunIds(ids)
  }

  async applyRetention(policy: RetentionPolicy): Promise<DeleteResult> {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new TraceStoreError('INVALID_ARGUMENT', 'policy must be an object.', 'policy')
    }
    if (policy.maxAgeMs === undefined && policy.maxRuns === undefined && policy.statuses === undefined) {
      throw new TraceStoreError('INVALID_ARGUMENT', 'Retention policy must set maxAgeMs, maxRuns, or statuses.', 'policy')
    }
    if (policy.maxAgeMs !== undefined) finiteNumber(policy.maxAgeMs, 'maxAgeMs')
    if (policy.maxRuns !== undefined && (!Number.isInteger(policy.maxRuns) || policy.maxRuns < 0)) {
      throw new TraceStoreError('INVALID_ARGUMENT', 'maxRuns must be a non-negative integer.', 'maxRuns')
    }
    const statuses = statusList(policy.statuses, 'statuses')
    let scoped = this.materializeSummaries(this.revision)
      .filter((summary) => !statuses || (summary.status !== undefined && statuses.includes(summary.status)))
    const deleteIds = new Set<string>()
    if (policy.maxAgeMs !== undefined) {
      const cutoff = this.now() - policy.maxAgeMs
      for (const summary of scoped) if (Date.parse(summary.startedAt) < cutoff) deleteIds.add(summary.runId)
    }
    if (policy.maxRuns !== undefined) {
      scoped = scoped.sort((a, b) => compareRuns(a, b, 'started_desc'))
      for (const summary of scoped.slice(policy.maxRuns)) deleteIds.add(summary.runId)
    } else if (policy.maxAgeMs === undefined && statuses) {
      for (const summary of scoped) deleteIds.add(summary.runId)
    }
    const ordered = this.materializeSummaries(this.revision)
      .filter((summary) => deleteIds.has(summary.runId))
      .sort((a, b) => compareRuns(a, b, 'started_asc'))
      .map((summary) => summary.runId)
    return this.deleteRunIds(ordered)
  }

  private materializeSummaries(snapshotRevision: number): RunSummary[] {
    const byRun = new Map<string, TraceRecord[]>()
    for (const entry of this.entries) {
      if (entry.revision > snapshotRevision) continue
      const records = byRun.get(entry.record.runId) ?? []
      records.push(entry.record)
      byRun.set(entry.record.runId, records)
    }
    const summaries: RunSummary[] = []
    for (const records of byRun.values()) {
      const run = materializeRun(records)
      if (run) {
        const { spans: _spans, records: _records, ...summary } = run
        summaries.push(summary)
      }
    }
    return summaries
  }

  private deleteRunIds(runIds: readonly string[]): DeleteResult {
    const ids = new Set(runIds)
    if (ids.size === 0) return { runsDeleted: 0, recordsDeleted: 0, runIds: [] }
    const existing = new Set(
      this.entries.filter((entry) => ids.has(entry.record.runId)).map((entry) => entry.record.runId),
    )
    const actuallyDeleted = runIds.filter((runId, index) =>
      runIds.indexOf(runId) === index && existing.has(runId))
    if (actuallyDeleted.length === 0) return { runsDeleted: 0, recordsDeleted: 0, runIds: [] }
    let recordsDeleted = 0
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (!ids.has(this.entries[index]!.record.runId)) continue
      this.entries.splice(index, 1)
      recordsDeleted++
    }
    for (const [recordId, seen] of this.seen) if (ids.has(seen.runId)) this.seen.delete(recordId)
    this.rebuildEndIndex()
    this.deleteEpoch++
    return cloneValue({ runsDeleted: actuallyDeleted.length, recordsDeleted, runIds: actuallyDeleted })
  }

  private rebuildEndIndex(): void {
    this.firstEndBySpan.clear()
    for (const entry of [...this.entries].sort((a, b) => a.arrival - b.arrival)) {
      if (entry.record.recordType === 'span_end') {
        this.firstEndBySpan.set(`${entry.record.traceId}:${entry.record.spanId}`, entry.record.recordId)
      }
    }
  }

  private encodeCursor(state: CursorState): string {
    const body = encodeURIComponent(JSON.stringify(state))
    return `oma-ts1.${body}.${hash(`${this.cursorSecret}:${body}`)}`
  }

  private decodeCursor(cursor: unknown): CursorState {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new TraceStoreError('INVALID_CURSOR', 'cursor must be an opaque non-empty string.', 'cursor')
    }
    const match = /^oma-ts1\.(.+)\.([a-z0-9]+)$/.exec(cursor)
    if (!match || hash(`${this.cursorSecret}:${match[1]}`) !== match[2]) {
      throw new TraceStoreError('INVALID_CURSOR', 'Cursor is invalid or has been tampered with.', 'cursor')
    }
    try {
      const state = JSON.parse(decodeURIComponent(match[1]!)) as Partial<CursorState>
      if (!Number.isInteger(state.snapshotRevision) || !Number.isInteger(state.deleteEpoch)
        || typeof state.queryFingerprint !== 'string' || typeof state.startedAt !== 'string'
        || typeof state.runId !== 'string') throw new Error('invalid')
      return state as CursorState
    } catch {
      throw new TraceStoreError('INVALID_CURSOR', 'Cursor payload is invalid.', 'cursor')
    }
  }
}
