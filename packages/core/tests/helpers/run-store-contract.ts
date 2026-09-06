/**
 * Behavioral contract for {@link RunStore} implementations.
 *
 * A run record is the one row in OMA that decides who may advance a run, so an
 * implementation that gets compare-and-set subtly wrong does not fail loudly —
 * it lets two workers execute the same run. This suite pins the behavior that
 * single-active execution actually rests on, and is meant to be run unchanged
 * by an outside Postgres/Redis/DynamoDB backend.
 *
 * Imports resolve through the public root barrel, so the suite describes the
 * contract using exactly the surface an external implementer sees.
 *
 * **What this suite deliberately does not require.**
 *
 * - *Real cross-process atomicity.* Nothing in a single Vitest process can
 *   prove it. The suite asserts the `atomicity` a store *declares* is one of
 *   the two legal values and exercises concurrent callers within one process;
 *   a `'cross-process'` claim is the implementation's, and belongs in its own
 *   integration test against the real backend.
 * - *A particular storage layout.* Keys, columns, and encoding are the
 *   implementation's business. Only `get`/`create`/`compareAndSet` semantics
 *   are contractual.
 * - *Validation of every malformed record.* `assertRunRecord` is shared and
 *   already covered; a store only has to reject a write whose version does not
 *   follow the expected one.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUN_LEASE_TTL_MS,
  RunLedger,
  RunStoreError,
  isTerminalRunStatus,
} from '../../src/index.js'
import type { RunRecord, RunStore } from '../../src/index.js'

export type RunStoreContractFactory = () => RunStore | Promise<RunStore>

export interface RunStoreContractOptions {
  /**
   * Opens a second handle onto the same backing state the factory just built.
   * Supplied only by stores that claim durability, and enables the
   * cross-instance group. A store without it is not judged on durability
   * either way.
   */
  readonly reopen?: () => RunStore | Promise<RunStore>
}

function seedRecord(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const iso = new Date('2026-09-01T00:00:00.000Z').toISOString()
  return {
    schema: 1,
    runId,
    version: 1,
    status: 'running',
    attempt: 1,
    fencingToken: 1,
    lease: { owner: 'worker-a', acquiredAt: iso, expiresAt: iso },
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  }
}

function bump(record: RunRecord, overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...record, version: record.version + 1, ...overrides }
}

/**
 * Reusable behavioral suite. Every shipped run store runs it unchanged from
 * `run-store.test.ts`.
 */
export function runRunStoreContractSuite(
  name: string,
  createStore: RunStoreContractFactory,
  options: RunStoreContractOptions = {},
): void {
  describe(`${name} RunStore contract`, () => {
    // -----------------------------------------------------------------------
    // Required: declared atomicity
    // -----------------------------------------------------------------------

    it('declares how far its atomicity reaches', async () => {
      const store = await createStore()
      expect(['process', 'cross-process']).toContain(store.atomicity)
    })

    // -----------------------------------------------------------------------
    // Required: create
    // -----------------------------------------------------------------------

    it('creates a record once and reports the loser of a create race', async () => {
      const store = await createStore()
      expect(await store.get('run-1')).toBeNull()

      expect(await store.create(seedRecord('run-1'))).toBe(true)
      expect(await store.create(seedRecord('run-1', { attempt: 2 }))).toBe(false)

      const stored = await store.get('run-1')
      expect(stored).toMatchObject({ runId: 'run-1', version: 1, attempt: 1 })
    })

    it('rejects a create at a version other than 1', async () => {
      const store = await createStore()
      await expect(store.create(seedRecord('run-1', { version: 2 })))
        .rejects.toBeInstanceOf(RunStoreError)
    })

    // -----------------------------------------------------------------------
    // Required: compare-and-set
    // -----------------------------------------------------------------------

    it('swaps only when the stored version matches', async () => {
      const store = await createStore()
      await store.create(seedRecord('run-1'))
      const current = (await store.get('run-1'))!

      expect(await store.compareAndSet('run-1', 1, bump(current, { status: 'suspended' })))
        .toBe(true)
      expect((await store.get('run-1'))!.status).toBe('suspended')

      // The same stale expectation must not win a second time.
      expect(await store.compareAndSet('run-1', 1, bump(current, { status: 'completed' })))
        .toBe(false)
      expect((await store.get('run-1'))!.status).toBe('suspended')
    })

    it('reports a missing record as a failed swap rather than creating one', async () => {
      const store = await createStore()
      expect(await store.compareAndSet('absent', 1, seedRecord('absent', { version: 2 })))
        .toBe(false)
      expect(await store.get('absent')).toBeNull()
    })

    it('rejects a write that does not follow the expected version', async () => {
      const store = await createStore()
      await store.create(seedRecord('run-1'))
      await expect(store.compareAndSet('run-1', 1, seedRecord('run-1', { version: 5 })))
        .rejects.toBeInstanceOf(RunStoreError)
      await expect(store.compareAndSet('run-1', 1, seedRecord('other', { version: 2 })))
        .rejects.toBeInstanceOf(RunStoreError)
    })

    it('lets exactly one of two concurrent swaps win', async () => {
      const store = await createStore()
      await store.create(seedRecord('run-1'))
      const current = (await store.get('run-1'))!

      const results = await Promise.all([
        store.compareAndSet('run-1', 1, bump(current, { status: 'completed' })),
        store.compareAndSet('run-1', 1, bump(current, { status: 'failed' })),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      const stored = (await store.get('run-1'))!
      expect(stored.version).toBe(2)
      expect(isTerminalRunStatus(stored.status)).toBe(true)
    })

    // -----------------------------------------------------------------------
    // Required: the ledger behaviors the store has to support
    // -----------------------------------------------------------------------

    it('supports single-active acquisition across two workers', async () => {
      const store = await createStore()
      const a = new RunLedger(store, { owner: 'worker-a' })
      const b = new RunLedger(store, { owner: 'worker-b' })

      const held = await a.acquire('run-1', { heartbeat: false })
      expect(held.fencingToken).toBe(1)
      await expect(b.acquire('run-1', { heartbeat: false }))
        .rejects.toMatchObject({ code: 'RUN_LEASE_HELD' })
    })

    it('lets a second worker take over an expired lease and fences the first', async () => {
      const store = await createStore()
      let clock = new Date('2026-09-01T00:00:00.000Z')
      const now = () => clock
      const a = new RunLedger(store, { owner: 'worker-a', leaseTtlMs: 1_000, now })
      const b = new RunLedger(store, { owner: 'worker-b', leaseTtlMs: 1_000, now })

      const first = await a.acquire('run-1', { heartbeat: false })
      clock = new Date(clock.getTime() + 5_000)

      const second = await b.acquire('run-1', { heartbeat: false })
      expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
      expect(second.attempt).toBe(first.attempt + 1)

      await expect(first.renew()).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
      await expect(first.complete()).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
      expect((await store.get('run-1'))!.status).toBe('running')

      await second.complete({ code: 'ok' })
      expect((await store.get('run-1'))!.status).toBe('completed')
    })

    it('keeps a suspended run resumable without a live worker', async () => {
      const store = await createStore()
      const a = new RunLedger(store, { owner: 'worker-a' })
      const b = new RunLedger(store, { owner: 'worker-b' })

      const first = await a.acquire('run-1', { heartbeat: false })
      await first.suspend(['apr_1'])
      expect((await store.get('run-1'))!.status).toBe('suspended')

      await expect(b.acquire('run-1', { heartbeat: false }))
        .rejects.toMatchObject({ code: 'RUN_SUSPENDED' })

      await b.requestResume('run-1')
      await b.requestResume('run-1')
      const second = await b.acquire('run-1', { heartbeat: false })
      expect(second.record.status).toBe('running')
    })

    it('refuses to reopen a terminal run', async () => {
      const store = await createStore()
      const ledger = new RunLedger(store, { owner: 'worker-a' })
      const handle = await ledger.acquire('run-1', { heartbeat: false })
      await handle.complete({ code: 'ok' })

      await expect(ledger.acquire('run-1', { heartbeat: false }))
        .rejects.toMatchObject({ code: 'RUN_ALREADY_TERMINAL' })
      await expect(ledger.requestResume('run-1'))
        .rejects.toMatchObject({ code: 'RUN_ALREADY_TERMINAL' })
      await expect(ledger.cancel('run-1'))
        .rejects.toMatchObject({ code: 'RUN_ALREADY_TERMINAL' })
    })

    it('uses the default lease window when none is configured', async () => {
      const store = await createStore()
      const start = new Date('2026-09-01T00:00:00.000Z')
      const ledger = new RunLedger(store, { owner: 'worker-a', now: () => start })
      const handle = await ledger.acquire('run-1', { heartbeat: false })
      expect(Date.parse(handle.record.lease!.expiresAt) - start.getTime())
        .toBe(DEFAULT_RUN_LEASE_TTL_MS)
    })

    // -----------------------------------------------------------------------
    // Optional: durability across handles
    // -----------------------------------------------------------------------

    if (options.reopen) {
      const reopen = options.reopen
      it('serves a record written through one handle from another', async () => {
        const store = await createStore()
        await new RunLedger(store, { owner: 'worker-a' })
          .acquire('run-1', { heartbeat: false })

        const reopened = await reopen()
        const record = await reopened.get('run-1')
        expect(record).toMatchObject({ runId: 'run-1', status: 'running', fencingToken: 1 })
      })
    }
  })
}
