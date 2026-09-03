/**
 * Behavioral contract for {@link TraceStore} implementations.
 *
 * Imports resolve through the public barrels rather than deep `src/` paths, so
 * the suite type-checks against exactly the surface a third-party implementer
 * sees. Only the observability barrel is a runtime import; the root-barrel
 * types are erased at compile time and cost the consumer nothing.
 */

import { describe, expect, it } from 'vitest'
import type { RunStatusCode, TraceLink } from '../../src/index.js'
import {
  TraceStoreError,
  type SpanEndRecord,
  type SpanEventRecord,
  type SpanStartRecord,
  type TraceRecord,
  type TraceStore,
  type TraceStoreDiagnostic,
} from '../../src/observability/index.js'

export interface TraceStoreContractFactoryOptions {
  readonly now?: () => number
  readonly onDiagnostic?: (diagnostic: TraceStoreDiagnostic) => void
}

export type TraceStoreContractFactory = (options?: TraceStoreContractFactoryOptions) => TraceStore

interface AttemptOptions {
  readonly runId: string
  readonly attempt?: number
  readonly trace?: string
  readonly start?: number
  readonly status?: RunStatusCode
  readonly startOnly?: boolean
  readonly endOnly?: boolean
  readonly attributes?: Record<string, string | number | boolean>
  readonly links?: readonly TraceLink[]
}

let id = 0

function recordBase(options: AttemptOptions, sequence: number, spanId?: string) {
  const attempt = options.attempt ?? 1
  return {
    schemaVersion: 2 as const,
    recordId: `contract-record-${++id}`,
    sequence,
    timestampUnixMs: (options.start ?? 1_000) + sequence,
    runId: options.runId,
    attempt,
    traceId: options.trace ?? `${options.runId}-trace-${attempt}`,
    spanId: spanId ?? `${options.runId}-span-${attempt}`,
  }
}

export function attemptRecords(options: AttemptOptions): TraceRecord[] {
  const start = options.start ?? 1_000
  const attributes = options.attributes ?? {}
  const records: TraceRecord[] = []
  if (!options.endOnly) {
    records.push({
      ...recordBase(options, 1), recordType: 'span_start', kind: 'run', name: 'oma.run',
      startUnixMs: start, attributes, ...(options.links ? { links: options.links } : {}),
    } satisfies SpanStartRecord)
  }
  if (!options.startOnly) {
    records.push({
      ...recordBase(options, 3), recordType: 'span_end', kind: 'run', name: 'oma.run',
      startUnixMs: start, endUnixMs: start + 100, durationMs: 100,
      status: { code: options.status ?? 'ok' }, attributes,
      ...(options.links ? { links: options.links } : {}),
    } satisfies SpanEndRecord)
  }
  return records
}

function event(options: AttemptOptions): SpanEventRecord {
  return {
    ...recordBase(options, 2), recordType: 'span_event', name: 'retry_scheduled',
    attributes: { 'oma.retry': true },
  }
}

/**
 * Reusable behavioral suite. Both shipped stores run it unchanged:
 * `InMemoryTraceStore` in `trace-store-contract.test.ts` and `FileTraceStore`
 * in `file-trace-store.test.ts`.
 */
export function runTraceStoreContractSuite(name: string, createStore: TraceStoreContractFactory): void {
  describe(`${name} TraceStore contract`, () => {
    it('makes a valid batch atomically visible and rejects an invalid batch atomically', async () => {
      const store = createStore()
      const good = attemptRecords({ runId: 'atomic-good' })
      await expect(store.append(good)).resolves.toMatchObject({ written: 2, deduplicated: 0 })
      const valid = attemptRecords({ runId: 'atomic-rejected' })[0]!
      const unsupported = { ...attemptRecords({ runId: 'atomic-rejected' })[1]!, schemaVersion: 3 } as unknown as TraceRecord
      await expect(store.append([valid, unsupported])).rejects.toMatchObject({
        code: 'UNSUPPORTED_SCHEMA_VERSION', field: 'records[1].schemaVersion',
      })
      await expect(store.getRun('atomic-rejected')).resolves.toBeNull()
    })

    it('deduplicates recordId and preserves the first payload without leaking mutable references', async () => {
      const store = createStore()
      const records = attemptRecords({ runId: 'dedupe', attributes: { custom: 'first' } })
      await store.append(records)
      // `TraceRecord.attributes` is readonly by type; mutate through a writable
      // view to prove the store copied rather than retained the caller's object.
      ;(records[0] as { attributes: Record<string, unknown> }).attributes = { custom: 'mutated' }
      await expect(store.append(records)).resolves.toMatchObject({ written: 0, deduplicated: 2 })
      const first = await store.getRun('dedupe', { includeRecords: true })
      expect(first?.records?.[0]?.attributes).toMatchObject({ custom: 'first' })
      ;(first!.records![0]!.attributes as Record<string, string>)['custom'] = 'external mutation'
      expect((await store.getRun('dedupe', { includeRecords: true }))?.records?.[0]?.attributes)
        .toMatchObject({ custom: 'first' })
    })

    it('uses first-write-wins for duplicate span_end and emits a payload-free diagnostic', async () => {
      const diagnostics: TraceStoreDiagnostic[] = []
      const store = createStore({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) })
      const records = attemptRecords({ runId: 'duplicate-end', status: 'ok' })
      await store.append(records)
      const duplicate = {
        ...records[1]!, recordId: `contract-record-${++id}`, sequence: 4,
        status: { code: 'error' as const },
      } as SpanEndRecord
      const result = await store.append([duplicate])
      expect(result).toMatchObject({ written: 0, deduplicated: 1 })
      expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'duplicate_span_end' })])
      expect(diagnostics).toEqual([expect.objectContaining({ code: 'duplicate_span_end' })])
      expect((await store.getRun('duplicate-end'))?.status).toBe('ok')
    })

    it('materializes sequence order, events, start-only, end-only, and links from out-of-order arrival', async () => {
      const store = createStore()
      const links: TraceLink[] = [
        { traceId: '1'.repeat(32), spanId: '1'.repeat(16), relation: 'continued_from' },
        { traceId: '2'.repeat(32), spanId: '2'.repeat(16), relation: 'depends_on' },
        { traceId: '3'.repeat(32), spanId: '3'.repeat(16), relation: 'delegated_from' },
        { traceId: '4'.repeat(32), spanId: '4'.repeat(16), relation: 'consumed' },
      ]
      const complete = attemptRecords({ runId: 'out-of-order', links })
      const middle = event({ runId: 'out-of-order' })
      await store.append([complete[1]!, middle, complete[0]!])
      const run = await store.getRun('out-of-order', { includeRecords: true })
      expect(run?.records?.map((record) => record.sequence)).toEqual([1, 2, 3])
      expect(run?.spans[0]).toMatchObject({ incomplete: false, links })
      expect(run?.spans[0]?.events).toHaveLength(1)

      await store.append(attemptRecords({ runId: 'start-only', startOnly: true }))
      const startOnly = await store.getRun('start-only')
      expect(startOnly?.incomplete).toBe(true)
      expect(startOnly).not.toHaveProperty('status')
      await store.append(attemptRecords({ runId: 'end-only', endOnly: true }))
      expect(await store.getRun('end-only')).toMatchObject({ incomplete: false, status: 'ok' })
    })

    it('groups multiple attempts/traces under one logical run and takes the latest actual terminal status', async () => {
      const store = createStore()
      await store.append([
        ...attemptRecords({ runId: 'restored', attempt: 2, trace: '2'.repeat(32), start: 2_000, status: 'ok' }),
        ...attemptRecords({ runId: 'restored', attempt: 1, trace: '1'.repeat(32), start: 1_000, status: 'error' }),
      ])
      const run = await store.getRun('restored')
      expect(run).toMatchObject({ runId: 'restored', status: 'ok', incomplete: false })
      expect(run?.attempts.map((attempt) => [attempt.attempt, attempt.traceId, attempt.status])).toEqual([
        [1, '1'.repeat(32), 'error'], [2, '2'.repeat(32), 'ok'],
      ])
    })

    it('materializes actual agent/task/model/provider and token/cost facts without double counting parent spans', async () => {
      const store = createStore()
      const root = attemptRecords({ runId: 'summary-facts', endOnly: true })[0] as SpanEndRecord
      const llm = {
        ...root,
        recordId: `contract-record-${++id}`,
        sequence: 2,
        spanId: 'summary-facts-llm',
        parentSpanId: root.spanId,
        kind: 'llm' as const,
        name: 'chat',
        attributes: {
          'oma.agent.name': 'researcher', 'oma.task.id': 'task-1',
          'oma.llm.model': 'model-1', 'oma.llm.provider': 'provider-1',
          'oma.usage.input_tokens': 11, 'oma.usage.output_tokens': 7,
          'oma.cost.amount': 0.25, 'oma.cost.currency': 'USD',
        },
      } satisfies SpanEndRecord
      await store.append([root, llm])
      expect(await store.getRun('summary-facts')).toMatchObject({
        agents: ['researcher'], taskIds: ['task-1'], models: ['model-1'], providers: ['provider-1'],
        tokens: { input_tokens: 11, output_tokens: 7 }, costs: [{ amount: 0.25, currency: 'USD' }],
      })
    })

    it('combines run/time/status/agent/task/model/provider filters', async () => {
      const store = createStore()
      await store.append(attemptRecords({
        runId: 'match', start: 2_000, status: 'error', attributes: {
          'oma.agent.name': 'researcher', 'oma.task.id': 'task-a',
          'oma.llm.model': 'model-a', 'oma.llm.provider': 'provider-a',
        },
      }))
      await store.append(attemptRecords({
        runId: 'other', start: 3_000, status: 'ok', attributes: {
          'oma.agent.name': 'writer', 'oma.task.id': 'task-b',
          'oma.llm.model': 'model-b', 'oma.llm.provider': 'provider-b',
        },
      }))
      const page = await store.queryRuns({
        runId: 'match', startedAfter: new Date(1_000).toISOString(),
        startedBefore: new Date(2_500).toISOString(), status: ['error'],
        agent: ['researcher'], taskId: ['task-a'], model: ['model-a'], provider: ['provider-a'],
      })
      expect(page.items.map((run) => run.runId)).toEqual(['match'])
    })

    it('paginates stable same-time ties without gaps and snapshots concurrent appends', async () => {
      const store = createStore()
      for (const runId of ['a', 'b', 'c', 'd', 'e']) {
        await store.append(attemptRecords({ runId, start: 5_000 }))
      }
      const first = await store.queryRuns({ limit: 2, order: 'started_asc' })
      expect(first.items.map((run) => run.runId)).toEqual(['a', 'b'])
      await store.append(attemptRecords({ runId: 'aa-new', start: 5_000 }))
      const second = await store.queryRuns({ limit: 2, order: 'started_asc', cursor: first.nextCursor })
      const third = await store.queryRuns({ limit: 2, order: 'started_asc', cursor: second.nextCursor })
      expect([...first.items, ...second.items, ...third.items].map((run) => run.runId)).toEqual(['a', 'b', 'c', 'd', 'e'])
      expect((await store.queryRuns({ limit: 10, order: 'started_asc' })).items.map((run) => run.runId))
        .toEqual(['a', 'aa-new', 'b', 'c', 'd', 'e'])
    })

    it('rejects invalid, tampered, mismatched, and delete-invalidated cursors structurally', async () => {
      const store = createStore()
      await store.append(attemptRecords({ runId: 'cursor-a' }))
      await store.append(attemptRecords({ runId: 'cursor-b', start: 2_000 }))
      const page = await store.queryRuns({ limit: 1, status: ['ok'] })
      await expect(store.queryRuns({ cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(TraceStoreError)
      await expect(store.queryRuns({ limit: 1, status: ['error'], cursor: page.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
      await expect(store.queryRuns({ limit: 1, status: ['ok'], cursor: `${page.nextCursor}x` })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
      await store.deleteRun('cursor-b')
      await expect(store.queryRuns({ limit: 1, status: ['ok'], cursor: page.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    })

    it('makes delete idempotent and immediately consistent', async () => {
      const store = createStore()
      await store.append(attemptRecords({ runId: 'delete-me' }))
      await expect(store.deleteRun('delete-me')).resolves.toMatchObject({ runsDeleted: 1, recordsDeleted: 2, runIds: ['delete-me'] })
      await expect(store.deleteRun('delete-me')).resolves.toEqual({ runsDeleted: 0, recordsDeleted: 0, runIds: [] })
      await expect(store.getRun('delete-me')).resolves.toBeNull()
      expect((await store.queryRuns({ runId: 'delete-me' })).items).toHaveLength(0)
    })

    it('bulk deletes only runs matching the frozen query filters', async () => {
      const store = createStore()
      await store.append(attemptRecords({ runId: 'bulk-error', status: 'error', attributes: { 'oma.agent.name': 'a' } }))
      await store.append(attemptRecords({ runId: 'bulk-ok', status: 'ok', attributes: { 'oma.agent.name': 'a' } }))
      await store.append(attemptRecords({ runId: 'bulk-other', status: 'error', attributes: { 'oma.agent.name': 'b' } }))
      await expect(store.delete({ status: ['error'], agent: ['a'] })).resolves.toMatchObject({ runIds: ['bulk-error'] })
      expect((await store.queryRuns({ order: 'started_asc' })).items.map((run) => run.runId)).toEqual(['bulk-ok', 'bulk-other'])
    })

    it('applies age, maxRuns, and status retention deterministically and idempotently', async () => {
      const store = createStore({ now: () => 10_000 })
      await store.append(attemptRecords({ runId: 'old-error', start: 1_000, status: 'error' }))
      await store.append(attemptRecords({ runId: 'mid-error', start: 6_000, status: 'error' }))
      await store.append(attemptRecords({ runId: 'new-ok', start: 9_000, status: 'ok' }))
      await expect(store.applyRetention({ maxAgeMs: 5_000, statuses: ['error'] }))
        .resolves.toMatchObject({ runIds: ['old-error'] })
      await expect(store.applyRetention({ maxRuns: 0, statuses: ['error'] }))
        .resolves.toMatchObject({ runIds: ['mid-error'] })
      await expect(store.applyRetention({ statuses: ['ok'] }))
        .resolves.toMatchObject({ runIds: ['new-ok'] })
      await expect(store.applyRetention({ statuses: ['ok'] })).resolves.toEqual({ runsDeleted: 0, recordsDeleted: 0, runIds: [] })
    })

    it('preserves unknown minor fields and rejects invalid inputs with structured errors', async () => {
      const store = createStore()
      const record = {
        ...attemptRecords({ runId: 'minor-field', endOnly: true })[0]!,
        futureMinorField: { preserved: true },
        // A forward-compatible record carries fields this version has no type
        // for, so the widening cast is the point of the case, not an oversight.
      } as unknown as TraceRecord
      await store.append([record])
      expect((await store.getRun('minor-field', { includeRecords: true }))?.records?.[0])
        .toMatchObject({ futureMinorField: { preserved: true } })
      await expect(store.queryRuns({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', field: 'limit' })
      await expect(store.queryRuns({ startedAfter: 'not-a-date' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', field: 'startedAfter' })
    })
  })
}
