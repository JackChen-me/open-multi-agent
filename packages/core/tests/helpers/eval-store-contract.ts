/**
 * Behavioral contract for {@link EvalStore} implementations.
 *
 * Imports resolve through the public `/eval` barrel rather than deep `src/`
 * paths, so the suite type-checks against exactly the surface a third-party
 * implementer sees.
 *
 * Both shipped stores run it unchanged: `InMemoryEvalStore` in
 * `eval-in-memory-store.test.ts` and `FileEvalStore` in
 * `eval-file-store.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  EvalStoreError,
  type EvalRecord,
  type EvalStore,
} from '../../src/eval/index.js'

export interface EvalStoreContractFactoryOptions {
  readonly now?: () => number
}

export type EvalStoreContractFactory = (
  options?: EvalStoreContractFactoryOptions,
) => EvalStore

interface RecordOptions {
  readonly recordId?: string
  readonly evalRunId?: string
  readonly runId?: string
  readonly evalSetName?: string
  readonly scorer?: string
  readonly source?: EvalRecord['source']
  readonly status?: EvalRecord['status']
  readonly timestamp?: number
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

let id = 0

export function evalRecord(options: RecordOptions = {}): EvalRecord {
  const recordId = options.recordId ?? `eval-contract-${++id}`
  const runId = options.runId ?? `run-${recordId}`
  return {
    schemaVersion: 1,
    recordId,
    evalRunId: options.evalRunId ?? `eval-run-${recordId}`,
    source: options.source ?? 'offline',
    timestampUnixMs: options.timestamp ?? 1_000,
    evalSet: { name: options.evalSetName ?? 'contract-set', version: '1.0.0' },
    caseId: `case-${recordId}`,
    repeat: 1,
    scorer: { name: options.scorer ?? 'exact', version: '1.0.0' },
    status: options.status ?? 'scored',
    ...(options.status === undefined || options.status === 'scored'
      ? { score: 1, pass: true, reason: 'matched' }
      : {}),
    runRef: {
      runId,
      attempt: 1,
      traceId: `trace-${recordId}`,
      rootSpanId: `span-${recordId}`,
    },
    metadata: options.metadata ?? { suite: 'contract' },
  }
}

function ids(records: readonly EvalRecord[]): string[] {
  return records.map((record) => record.recordId)
}

/** Reusable behavioral suite for every EvalStore implementation. */
export function runEvalStoreContractSuite(
  name: string,
  createStore: EvalStoreContractFactory,
): void {
  describe(`${name} EvalStore contract`, () => {
    it('makes valid batches atomically visible and rejects invalid batches atomically', async () => {
      const store = createStore()
      const first = evalRecord({ recordId: 'atomic-first' })
      const second = evalRecord({ recordId: 'atomic-second' })
      await expect(store.append([first, second])).resolves.toEqual({
        written: 2,
        deduplicated: 0,
        diagnostics: [],
      })

      const valid = evalRecord({ recordId: 'atomic-rejected-valid' })
      const unsupported = {
        ...evalRecord({ recordId: 'atomic-rejected-version' }),
        schemaVersion: 2,
      } as unknown as EvalRecord
      await expect(store.append([valid, unsupported])).rejects.toMatchObject({
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        field: 'records[1].schemaVersion',
      })
      expect((await store.query({ evalRunId: valid.evalRunId })).items).toHaveLength(0)
    })

    it('deduplicates by recordId, preserves the first payload, and does not leak references', async () => {
      const store = createStore()
      const first = evalRecord({ recordId: 'dedupe', metadata: { value: 'first' } })
      await store.append([first])
      ;(first.metadata as Record<string, string>)['value'] = 'mutated'
      const collision = evalRecord({ recordId: 'dedupe', metadata: { value: 'second' } })
      await expect(store.append([collision])).resolves.toMatchObject({
        written: 0,
        deduplicated: 1,
      })
      const result = (await store.query({ evalRunId: first.evalRunId })).items[0]!
      expect(result.metadata).toEqual({ value: 'first' })
      ;(result.metadata as Record<string, string>)['value'] = 'external'
      expect((await store.query({ evalRunId: first.evalRunId })).items[0]?.metadata)
        .toEqual({ value: 'first' })
    })

    it('supports every filter independently and in combination', async () => {
      const store = createStore()
      const first = evalRecord({
        recordId: 'filter-a', evalRunId: 'eval-a', runId: 'run-a',
        evalSetName: 'set-a', scorer: 'exact', source: 'offline',
        status: 'scored', timestamp: 1_000,
      })
      const second = evalRecord({
        recordId: 'filter-b', evalRunId: 'eval-b', runId: 'run-b',
        evalSetName: 'set-b', scorer: 'judge', source: 'online',
        status: 'scorer_error', timestamp: 2_000,
      })
      const third = evalRecord({
        recordId: 'filter-c', evalRunId: 'eval-a', runId: 'run-c',
        evalSetName: 'set-a', scorer: 'judge', source: 'offline',
        status: 'skipped', timestamp: 3_000,
      })
      await store.append([first, second, third])

      expect(ids((await store.query({ evalRunId: 'eval-a', order: 'time_asc' })).items))
        .toEqual(['filter-a', 'filter-c'])
      expect(ids((await store.query({ evalRunId: ['eval-b'] })).items)).toEqual(['filter-b'])
      expect(ids((await store.query({ runId: 'run-b' })).items)).toEqual(['filter-b'])
      expect(ids((await store.query({ runId: ['run-a', 'run-c'], order: 'time_asc' })).items))
        .toEqual(['filter-a', 'filter-c'])
      expect(ids((await store.query({ evalSetName: 'set-b' })).items)).toEqual(['filter-b'])
      expect(ids((await store.query({ scorer: ['judge'], order: 'time_asc' })).items))
        .toEqual(['filter-b', 'filter-c'])
      expect(ids((await store.query({ source: 'online' })).items)).toEqual(['filter-b'])
      expect(ids((await store.query({ status: ['skipped'] })).items)).toEqual(['filter-c'])
      expect(ids((await store.query({ after: new Date(2_000).toISOString(), order: 'time_asc' })).items))
        .toEqual(['filter-b', 'filter-c'])
      expect(ids((await store.query({ before: new Date(3_000).toISOString(), order: 'time_asc' })).items))
        .toEqual(['filter-a', 'filter-b'])
      expect(ids((await store.query({
        evalRunId: 'eval-a', runId: 'run-c', evalSetName: 'set-a',
        scorer: ['judge'], source: 'offline', status: ['skipped'],
        after: new Date(2_500).toISOString(), before: new Date(3_500).toISOString(),
      })).items)).toEqual(['filter-c'])
    })

    it('uses a default limit of 100 and accepts limits through 1000', async () => {
      const store = createStore()
      await store.append(Array.from({ length: 101 }, (_, index) => evalRecord({
        recordId: `limit-${index.toString().padStart(3, '0')}`,
        timestamp: index,
      })))
      const defaultPage = await store.query({ order: 'time_asc' })
      expect(defaultPage.items).toHaveLength(100)
      expect(defaultPage.nextCursor).toBeTypeOf('string')
      expect((await store.query({ limit: 1_000 })).items).toHaveLength(101)
      await expect(store.query({ limit: 0 })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', field: 'limit',
      })
      await expect(store.query({ limit: 1_001 })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', field: 'limit',
      })
    })

    it('orders both ways and paginates same-time ties over a stable append snapshot', async () => {
      const store = createStore()
      await store.append(['a', 'b', 'c', 'd', 'e'].map((recordId) =>
        evalRecord({ recordId, timestamp: 5_000 })))
      expect(ids((await store.query({ order: 'time_desc' })).items))
        .toEqual(['e', 'd', 'c', 'b', 'a'])

      const first = await store.query({ limit: 2, order: 'time_asc' })
      expect(ids(first.items)).toEqual(['a', 'b'])
      await store.append([evalRecord({ recordId: 'aa-new', timestamp: 5_000 })])
      const second = await store.query({
        limit: 2, order: 'time_asc', cursor: first.nextCursor,
      })
      const third = await store.query({
        limit: 2, order: 'time_asc', cursor: second.nextCursor,
      })
      expect(ids([...first.items, ...second.items, ...third.items]))
        .toEqual(['a', 'b', 'c', 'd', 'e'])
      expect(ids((await store.query({ limit: 10, order: 'time_asc' })).items))
        .toEqual(['a', 'aa-new', 'b', 'c', 'd', 'e'])
    })

    it('rejects invalid, tampered, mismatched, and delete-invalidated cursors', async () => {
      const store = createStore()
      await store.append([
        evalRecord({ recordId: 'cursor-a', scorer: 'exact', timestamp: 1_000 }),
        evalRecord({ recordId: 'cursor-b', scorer: 'exact', timestamp: 2_000 }),
      ])
      const page = await store.query({ limit: 1, scorer: ['exact'] })
      await expect(store.query({ cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(EvalStoreError)
      await expect(store.query({ limit: 1, scorer: ['other'], cursor: page.nextCursor }))
        .rejects.toMatchObject({ code: 'INVALID_CURSOR' })
      await expect(store.query({ limit: 1, scorer: ['exact'], cursor: `${page.nextCursor}x` }))
        .rejects.toMatchObject({ code: 'INVALID_CURSOR' })
      await store.delete({ evalRunId: (page.items[0]!).evalRunId })
      await expect(store.query({ limit: 1, scorer: ['exact'], cursor: page.nextCursor }))
        .rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    })

    it('preserves unknown minor fields and rejects a higher schema major', async () => {
      const store = createStore()
      const record = {
        ...evalRecord({ recordId: 'minor-field' }),
        futureMinorField: { preserved: true },
      } as EvalRecord
      await store.append([record])
      expect((await store.query({ evalRunId: record.evalRunId })).items[0])
        .toMatchObject({ futureMinorField: { preserved: true } })
      await expect(store.append([{
        ...evalRecord({ recordId: 'higher-major' }),
        schemaVersion: 2,
      } as unknown as EvalRecord])).rejects.toMatchObject({
        code: 'UNSUPPORTED_SCHEMA_VERSION',
      })
    })

    it('deletes by every delete dimension, reports affected eval runs, and is idempotent', async () => {
      const store = createStore()
      await store.append([
        evalRecord({ recordId: 'delete-a', evalRunId: 'delete-run', evalSetName: 'set-a', timestamp: 1_000 }),
        evalRecord({ recordId: 'delete-b', evalRunId: 'delete-run', evalSetName: 'set-b', timestamp: 2_000 }),
        evalRecord({ recordId: 'delete-c', evalRunId: 'keep-run', evalSetName: 'set-a', timestamp: 3_000 }),
      ])
      const query = {
        evalRunId: 'delete-run',
        evalSetName: 'set-a',
        before: new Date(1_500).toISOString(),
      }
      await expect(store.delete(query)).resolves.toEqual({
        runsDeleted: 1,
        recordsDeleted: 1,
        runIds: ['delete-run'],
      })
      await expect(store.delete(query)).resolves.toEqual({
        runsDeleted: 0, recordsDeleted: 0, runIds: [],
      })
      await expect(store.delete({ evalSetName: 'set-b' })).resolves.toMatchObject({
        recordsDeleted: 1, runIds: ['delete-run'],
      })
      expect(ids((await store.query()).items)).toEqual(['delete-c'])
    })

    it('applies age, record-count, and source retention deterministically and idempotently', async () => {
      const store = createStore({ now: () => 10_000 })
      await store.append([
        evalRecord({ recordId: 'old-offline', evalRunId: 'old', source: 'offline', timestamp: 1_000 }),
        evalRecord({ recordId: 'mid-online', evalRunId: 'mid', source: 'online', timestamp: 6_000 }),
        evalRecord({ recordId: 'new-offline', evalRunId: 'new', source: 'offline', timestamp: 9_000 }),
      ])
      await expect(store.applyRetention({ maxAgeMs: 5_000, sources: ['offline'] }))
        .resolves.toMatchObject({ recordsDeleted: 1, runIds: ['old'] })
      await expect(store.applyRetention({ maxRecords: 0, sources: ['online'] }))
        .resolves.toMatchObject({ recordsDeleted: 1, runIds: ['mid'] })
      await expect(store.applyRetention({ sources: ['offline'] }))
        .resolves.toMatchObject({ recordsDeleted: 1, runIds: ['new'] })
      await expect(store.applyRetention({ sources: ['offline'] })).resolves.toEqual({
        runsDeleted: 0, recordsDeleted: 0, runIds: [],
      })
    })

    it('returns structured errors for invalid query, retention, and record inputs', async () => {
      const store = createStore()
      await expect(store.query({ after: 'not-a-date' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', field: 'after',
      })
      await expect(store.query({ status: ['not-a-status'] as never })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', field: 'status',
      })
      await expect(store.applyRetention({})).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT', field: 'policy',
      })
      await expect(store.append([{
        ...evalRecord({ recordId: 'invalid-score' }),
        score: 2,
      }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', field: 'records[0].score' })
    })
  })
}
