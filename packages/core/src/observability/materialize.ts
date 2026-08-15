import type { TraceAttributeValue, TraceLink } from '../types.js'
import type { SpanEndRecord, SpanEventRecord, SpanStartRecord, TraceRecord } from './records.js'
import {
  TRACE_STORE_SCHEMA_MAJOR,
  type MaterializedSpan,
  type RunAttemptSummary,
  type RunCostSummary,
  type RunSummary,
  type RunTokenSummary,
  type StoredRun,
} from './store.js'

const INPUT_TOKEN_KEYS = ['oma.usage.input_tokens', 'gen_ai.usage.input_tokens']
const OUTPUT_TOKEN_KEYS = ['oma.usage.output_tokens', 'gen_ai.usage.output_tokens']
const CACHE_READ_KEYS = ['oma.usage.cache_read_input_tokens', 'gen_ai.usage.cache_read_input_tokens']
const CACHE_CREATE_KEYS = ['oma.usage.cache_creation_input_tokens']
const REASONING_KEYS = ['oma.usage.reasoning_output_tokens', 'oma.reasoning.output_tokens']
const MODEL_KEYS = ['oma.llm.model', 'oma.model', 'gen_ai.request.model', 'gen_ai.response.model']
const PROVIDER_KEYS = ['oma.llm.provider', 'oma.provider', 'gen_ai.provider.name', 'gen_ai.system']
const RUN_METADATA_PREFIX = 'oma.meta.'
const RUN_METADATA_OVERRIDE_ATTRIBUTE = 'oma.meta._overridden'

function numberAttribute(
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

function stringAttributes(
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  keys: readonly string[],
): string[] {
  const values: string[] = []
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string') values.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') values.push(item)
    }
  }
  return values
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

function recordOrder(a: TraceRecord, b: TraceRecord): number {
  return a.traceId.localeCompare(b.traceId)
    || a.sequence - b.sequence
    || a.recordId.localeCompare(b.recordId)
}

function spanOrder(a: MaterializedSpan, b: MaterializedSpan): number {
  return a.traceId.localeCompare(b.traceId)
    || (a.startUnixMs ?? Number.MAX_SAFE_INTEGER) - (b.startUnixMs ?? Number.MAX_SAFE_INTEGER)
    || a.spanId.localeCompare(b.spanId)
}

interface MutableSpan {
  start?: SpanStartRecord
  end?: SpanEndRecord
  events: SpanEventRecord[]
}

/** Materialize one logical run from its accepted records. Inputs may arrive out of order. */
export function materializeRun(recordsInput: readonly TraceRecord[], includeRecords = false): StoredRun | null {
  if (recordsInput.length === 0) return null
  const records = [...recordsInput].sort(recordOrder)
  const runId = records[0]!.runId
  const spanMap = new Map<string, MutableSpan>()
  const agents = new Set<string>()
  const tasks = new Set<string>()
  const models = new Set<string>()
  const providers = new Set<string>()
  const costs = new Map<string, number>()
  const tokens = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  }

  for (const record of records) {
    const key = `${record.traceId}:${record.spanId}`
    const span = spanMap.get(key) ?? { events: [] }
    if (record.recordType === 'span_start') span.start ??= record
    else if (record.recordType === 'span_end') span.end ??= record
    else span.events.push(record)
    spanMap.set(key, span)

    const attrs = record.attributes
    for (const value of stringAttributes(attrs, ['oma.agent.name'])) agents.add(value)
    for (const value of stringAttributes(attrs, ['oma.task.id'])) tasks.add(value)
    for (const value of stringAttributes(attrs, MODEL_KEYS)) models.add(value)
    for (const value of stringAttributes(attrs, PROVIDER_KEYS)) providers.add(value)
    if (
      record.recordType === 'span_end'
      && (
        record.kind === 'llm'
        || (record.kind === 'routing' && record.name === 'profile_execution_route')
      )
    ) {
      tokens.input_tokens += numberAttribute(attrs, INPUT_TOKEN_KEYS)
      tokens.output_tokens += numberAttribute(attrs, OUTPUT_TOKEN_KEYS)
      tokens.cache_read_input_tokens += numberAttribute(attrs, CACHE_READ_KEYS)
      tokens.cache_creation_input_tokens += numberAttribute(attrs, CACHE_CREATE_KEYS)
      tokens.reasoning_output_tokens += numberAttribute(attrs, REASONING_KEYS)
      const amount = numberAttribute(attrs, ['oma.cost.amount'])
      const currency = stringAttributes(attrs, ['oma.cost.currency'])[0]
      if (currency && amount !== 0) costs.set(currency, (costs.get(currency) ?? 0) + amount)
    }
    if (record.recordType === 'span_end' && record.error?.provider) providers.add(record.error.provider)
  }

  const spans: MaterializedSpan[] = []
  for (const [key, value] of spanMap) {
    const start = value.start
    const end = value.end
    const source = end ?? start
    if (!source) continue
    const kind = end?.kind ?? start?.kind
    const name = end?.name ?? start?.name
    const startUnixMs = end?.startUnixMs ?? start?.startUnixMs
    spans.push({
      traceId: source.traceId,
      spanId: source.spanId,
      ...(source.parentSpanId ? { parentSpanId: source.parentSpanId } : {}),
      ...(kind ? { kind } : {}),
      ...(name ? { name } : {}),
      ...(startUnixMs !== undefined ? { startUnixMs } : {}),
      ...(end ? { endUnixMs: end.endUnixMs, durationMs: end.durationMs, status: end.status.code } : {}),
      attributes: { ...(start?.attributes ?? {}), ...(end?.attributes ?? {}) },
      links: [...(end?.links ?? start?.links ?? [])] as TraceLink[],
      events: [...value.events],
      incomplete: !end,
    })
  }
  spans.sort(spanOrder)

  const byTrace = new Map<string, TraceRecord[]>()
  for (const record of records) {
    const attemptRecords = byTrace.get(record.traceId) ?? []
    attemptRecords.push(record)
    byTrace.set(record.traceId, attemptRecords)
  }
  const attempts: RunAttemptSummary[] = []
  for (const [traceId, attemptRecords] of byTrace) {
    const rootEnd = attemptRecords.find((record): record is SpanEndRecord =>
      record.recordType === 'span_end' && record.kind === 'run' && !record.parentSpanId)
    const rootStart = attemptRecords.find((record): record is SpanStartRecord =>
      record.recordType === 'span_start' && record.kind === 'run' && !record.parentSpanId)
    const startedUnixMs = rootEnd?.startUnixMs
      ?? rootStart?.startUnixMs
      ?? Math.min(...attemptRecords.map((record) => record.timestampUnixMs))
    attempts.push({
      attempt: Math.min(...attemptRecords.map((record) => record.attempt)),
      traceId,
      ...(rootEnd?.spanId ?? rootStart?.spanId ? { rootSpanId: rootEnd?.spanId ?? rootStart?.spanId } : {}),
      startedAt: new Date(startedUnixMs).toISOString(),
      ...(rootEnd ? {
        endedAt: new Date(rootEnd.endUnixMs).toISOString(),
        durationMs: rootEnd.durationMs,
        status: rootEnd.status.code,
      } : {}),
      incomplete: !rootEnd || attemptRecords.some((record) =>
        record.recordType === 'span_start'
        && !spanMap.get(`${record.traceId}:${record.spanId}`)?.end),
    })
  }
  attempts.sort((a, b) => a.attempt - b.attempt || a.traceId.localeCompare(b.traceId))
  const latest = attempts.at(-1)!
  const latestRootStart = records.find((record): record is SpanStartRecord =>
    record.traceId === latest.traceId
    && record.recordType === 'span_start'
    && record.kind === 'run'
    && !record.parentSpanId)
  const latestRootEnd = records.find((record): record is SpanEndRecord =>
    record.traceId === latest.traceId
    && record.recordType === 'span_end'
    && record.kind === 'run'
    && !record.parentSpanId)
  const rootAttributes = { ...latestRootStart?.attributes, ...latestRootEnd?.attributes }
  const metadataEntries: Array<readonly [string, TraceAttributeValue]> = []
  for (const [key, value] of Object.entries(rootAttributes)) {
    if (!key.startsWith(RUN_METADATA_PREFIX) || key === RUN_METADATA_OVERRIDE_ATTRIBUTE) continue
    const metadataKey = key.slice(RUN_METADATA_PREFIX.length)
    metadataEntries.push([
      metadataKey,
      Array.isArray(value) ? [...value] as TraceAttributeValue : value,
    ])
  }
  const metadata = Object.fromEntries(metadataEntries) as Record<string, TraceAttributeValue>
  const startedAtMs = Math.min(...attempts.map((attempt) => Date.parse(attempt.startedAt)))
  const endedAttempts = attempts.filter((attempt) => attempt.endedAt !== undefined)
  const endedAtMs = endedAttempts.length > 0
    ? Math.max(...endedAttempts.map((attempt) => Date.parse(attempt.endedAt!)))
    : undefined
  const incomplete = attempts.some((attempt) => attempt.incomplete)
  const tokenSummary: RunTokenSummary = {
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    ...(tokens.cache_read_input_tokens ? { cache_read_input_tokens: tokens.cache_read_input_tokens } : {}),
    ...(tokens.cache_creation_input_tokens ? { cache_creation_input_tokens: tokens.cache_creation_input_tokens } : {}),
    ...(tokens.reasoning_output_tokens ? { reasoning_output_tokens: tokens.reasoning_output_tokens } : {}),
  }
  const costSummary: RunCostSummary[] = [...costs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }))
  const summary: RunSummary = {
    schemaVersion: TRACE_STORE_SCHEMA_MAJOR,
    runId,
    attempts,
    startedAt: new Date(startedAtMs).toISOString(),
    ...(endedAtMs !== undefined ? {
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
    } : {}),
    ...(latest.status ? { status: latest.status } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    agents: sorted(agents),
    taskIds: sorted(tasks),
    models: sorted(models),
    providers: sorted(providers),
    tokens: tokenSummary,
    costs: costSummary,
    incomplete,
  }
  return {
    ...summary,
    spans,
    ...(includeRecords ? { records } : {}),
  }
}
