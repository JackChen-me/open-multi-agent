import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FileStore,
  InMemoryStore,
  MemoryStoreRunStore,
  RUN_KEY_PREFIX,
  RunLedger,
  RunStoreError,
  assertRunRecord,
  canTransitionRun,
  isRunLeaseLive,
  isRunRecord,
  isRunRecordKey,
  isTerminalRunStatus,
  resolveRunStoreConfig,
  runRecordKey,
} from '../src/index.js'
import type { MemoryStore, RunLifecycleStatus, RunRecord } from '../src/index.js'
import { runRunStoreContractSuite } from './helpers/run-store-contract.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oma-run-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const filePath = () => join(dir, 'runs.json')

runRunStoreContractSuite(
  'MemoryStoreRunStore(InMemoryStore)',
  () => new MemoryStoreRunStore(new InMemoryStore()),
)

runRunStoreContractSuite(
  'MemoryStoreRunStore(FileStore)',
  () => new MemoryStoreRunStore(new FileStore(filePath())),
  { reopen: () => new MemoryStoreRunStore(new FileStore(filePath())) },
)

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const iso = '2026-09-01T00:00:00.000Z'
  return {
    schema: 1,
    runId: 'run-1',
    version: 1,
    status: 'running',
    attempt: 1,
    fencingToken: 1,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  }
}

describe('run record shape', () => {
  it('enumerates only the legal transitions and closes every terminal status', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true)
    expect(canTransitionRun('running', 'suspended')).toBe(true)
    expect(canTransitionRun('suspended', 'queued')).toBe(true)
    expect(canTransitionRun('suspended', 'running')).toBe(true)
    expect(canTransitionRun('queued', 'suspended')).toBe(false)

    const terminal: readonly RunLifecycleStatus[] = ['completed', 'failed', 'cancelled']
    for (const from of terminal) {
      expect(isTerminalRunStatus(from)).toBe(true)
      for (const to of ['queued', 'running', 'suspended', ...terminal] as RunLifecycleStatus[]) {
        expect(canTransitionRun(from, to)).toBe(false)
      }
    }
  })

  it('rejects records that are malformed rather than merely unfamiliar', () => {
    expect(isRunRecord(record())).toBe(true)
    expect(isRunRecord({ ...record(), schema: 2 })).toBe(false)
    expect(isRunRecord({ ...record(), version: 0 })).toBe(false)
    expect(isRunRecord({ ...record(), attempt: 0 })).toBe(false)
    expect(isRunRecord({ ...record(), fencingToken: -1 })).toBe(false)
    expect(isRunRecord({ ...record(), status: 'paused' })).toBe(false)
    expect(isRunRecord({ ...record(), updatedAt: 'yesterday' })).toBe(false)
    expect(isRunRecord({ ...record(), lease: { owner: '', acquiredAt: '', expiresAt: '' } })).toBe(false)
    expect(isRunRecord({
      ...record(),
      suspension: { suspendedAt: '2026-09-01T00:00:00.000Z', pendingApprovalIds: [1] },
    })).toBe(false)
    expect(() => assertRunRecord({ ...record(), runId: '' })).toThrow(RunStoreError)
  })

  it('treats a record with no lease, or an expired one, as unowned', () => {
    const now = new Date('2026-09-01T00:00:10.000Z')
    expect(isRunLeaseLive(record(), now)).toBe(false)
    expect(isRunLeaseLive(
      record({ lease: { owner: 'a', acquiredAt: '', expiresAt: '2026-09-01T00:00:05.000Z' } }),
      now,
    )).toBe(false)
    expect(isRunLeaseLive(
      record({ lease: { owner: 'a', acquiredAt: '', expiresAt: '2026-09-01T00:00:30.000Z' } }),
      now,
    )).toBe(true)
  })

  it('namespaces run records under a reserved prefix', () => {
    expect(runRecordKey('run-1')).toBe(`${RUN_KEY_PREFIX}run-1`)
    expect(isRunRecordKey(runRecordKey('run-1'))).toBe(true)
    expect(isRunRecordKey('__oma_checkpoint__/run-1/latest')).toBe(false)
  })
})

describe('MemoryStoreRunStore', () => {
  it('requires compare-and-set from the backing store', () => {
    const noCas: MemoryStore = {
      async get() { return null },
      async set() {},
      async list() { return [] },
      async delete() {},
      async clear() {},
    }
    expect(() => new MemoryStoreRunStore(noCas))
      .toThrow(expect.objectContaining({ code: 'RUN_STORE_ATOMIC_REQUIRED' }))
  })

  it('defaults to process atomicity and only claims more when told', () => {
    expect(new MemoryStoreRunStore(new InMemoryStore()).atomicity).toBe('process')
    expect(new MemoryStoreRunStore(new InMemoryStore(), { atomicity: 'cross-process' }).atomicity)
      .toBe('cross-process')
  })

  it('surfaces a corrupt or misfiled row instead of starting empty', async () => {
    const backing = new InMemoryStore()
    const store = new MemoryStoreRunStore(backing)

    await backing.set(runRecordKey('run-1'), 'not json')
    await expect(store.get('run-1')).rejects.toMatchObject({ code: 'RUN_INTEGRITY_ERROR' })

    await backing.set(runRecordKey('run-2'), JSON.stringify(record({ runId: 'other' })))
    await expect(store.get('run-2')).rejects.toMatchObject({ code: 'RUN_INTEGRITY_ERROR' })
  })

  it('deletes a record it owns', async () => {
    const store = new MemoryStoreRunStore(new InMemoryStore())
    await store.create(record())
    await store.delete('run-1')
    expect(await store.get('run-1')).toBeNull()
  })
})

describe('RunLedger commands', () => {
  const owner = 'worker-a'
  const build = () => new MemoryStoreRunStore(new InMemoryStore())

  it('validates its own configuration before it can mint a bad lease', () => {
    expect(() => new RunLedger(build(), { leaseTtlMs: 0 })).toThrow(RunStoreError)
    expect(() => new RunLedger(build(), { owner: '  ' })).toThrow(RunStoreError)
  })

  it('generates a distinct owner per ledger when none is given', () => {
    const store = build()
    expect(new RunLedger(store).owner).not.toBe(new RunLedger(store).owner)
  })

  it('converges on repeated resume, cancel, and completion commands', async () => {
    const store = build()
    const ledger = new RunLedger(store, { owner })

    const handle = await ledger.acquire('run-1', { heartbeat: false })
    await handle.suspend(['apr_a'])
    const suspended = (await store.get('run-1'))!
    expect(suspended.suspension?.pendingApprovalIds).toEqual(['apr_a'])

    // Repeating the suspension the handle already recorded is a no-op, not a
    // second transition and not a fencing violation.
    await handle.suspend(['apr_a'])
    expect((await store.get('run-1'))!.version).toBe(suspended.version)

    const resumed = await ledger.requestResume('run-1')
    expect(resumed.status).toBe('queued')
    expect((await ledger.requestResume('run-1')).version).toBe(resumed.version)

    const second = await ledger.acquire('run-1', { heartbeat: false })
    await second.complete({ code: 'ok' })
    const completed = (await store.get('run-1'))!
    await second.complete({ code: 'ok' })
    expect((await store.get('run-1'))!.version).toBe(completed.version)

    const cancelled = build()
    const cancelLedger = new RunLedger(cancelled, { owner })
    await cancelLedger.acquire('run-2', { heartbeat: false })
    const first = await cancelLedger.cancel('run-2', 'operator stop')
    expect(first.outcome).toEqual({ code: 'cancelled', message: 'operator stop' })
    expect((await cancelLedger.cancel('run-2')).version).toBe(first.version)
  })

  it('fences the running worker when an operator cancels out of band', async () => {
    const store = build()
    const ledger = new RunLedger(store, { owner })
    const handle = await ledger.acquire('run-1', { heartbeat: false })

    await ledger.cancel('run-1', 'operator stop')

    expect(handle.held).toBe(true)
    await expect(handle.recordCheckpoint({
      key: 'k',
      snapshotVersion: 5,
      savedAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    expect(handle.held).toBe(false)
    expect(handle.lost?.record?.status).toBe('cancelled')

    // Latched: no further write is even attempted.
    await expect(handle.renew()).rejects.toBe(handle.lost)
    expect((await store.get('run-1'))!.status).toBe('cancelled')
  })

  it('releases a run for immediate pickup without finishing it', async () => {
    const store = build()
    const a = new RunLedger(store, { owner: 'worker-a', leaseTtlMs: 600_000 })
    const b = new RunLedger(store, { owner: 'worker-b', leaseTtlMs: 600_000 })

    const first = await a.acquire('run-1', { heartbeat: false })
    await first.release()
    expect((await store.get('run-1'))!.status).toBe('queued')

    const second = await b.acquire('run-1', { heartbeat: false })
    expect(second.record.status).toBe('running')
    // A voluntary release is not a takeover, so it does not burn an attempt.
    expect(second.attempt).toBe(1)
  })

  it('records the checkpoint reference and renews the lease in one write', async () => {
    const store = build()
    let clock = new Date('2026-09-01T00:00:00.000Z')
    const ledger = new RunLedger(store, { owner, leaseTtlMs: 1_000, now: () => clock })
    const handle = await ledger.acquire('run-1', { heartbeat: false })
    const firstExpiry = handle.record.lease!.expiresAt

    clock = new Date(clock.getTime() + 500)
    const updated = await handle.recordCheckpoint({
      key: '__oma_checkpoint__/run-1/latest',
      snapshotVersion: 5,
      savedAt: clock.toISOString(),
    })
    expect(updated.checkpointRef).toMatchObject({ snapshotVersion: 5 })
    expect(Date.parse(updated.lease!.expiresAt)).toBeGreaterThan(Date.parse(firstExpiry))
  })

  it('reports a run with no record rather than inventing one', async () => {
    const ledger = new RunLedger(build(), { owner })
    await expect(ledger.requestResume('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(ledger.cancel('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(ledger.acquire('  ')).rejects.toMatchObject({ code: 'RUN_VALIDATION_ERROR' })
    expect(await ledger.get('missing')).toBeNull()
  })

  it('refuses to resume a run another worker is still executing', async () => {
    const store = build()
    const a = new RunLedger(store, { owner: 'worker-a', leaseTtlMs: 600_000 })
    const b = new RunLedger(store, { owner: 'worker-b', leaseTtlMs: 600_000 })
    await a.acquire('run-1', { heartbeat: false })
    await expect(b.requestResume('run-1')).rejects.toMatchObject({ code: 'RUN_LEASE_HELD' })
  })

  it('renews in the background while the handle is open', async () => {
    const store = build()
    const ledger = new RunLedger(store, { owner, leaseTtlMs: 750 })
    const handle = await ledger.acquire('run-1')
    try {
      const first = (await store.get('run-1'))!.version
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect((await store.get('run-1'))!.version).toBeGreaterThan(first)
    } finally {
      handle.stopHeartbeat()
    }
  })
})

describe('resolveRunStoreConfig', () => {
  it('normalises a bare store, prefers the first layer, and honours an explicit opt-out', () => {
    const store = new MemoryStoreRunStore(new InMemoryStore())
    const other = new MemoryStoreRunStore(new InMemoryStore())

    expect(resolveRunStoreConfig(store)).toEqual({ store })
    expect(resolveRunStoreConfig(undefined, store)).toEqual({ store })
    expect(resolveRunStoreConfig({ store, owner: 'w' }, other)).toEqual({ store, owner: 'w' })
    expect(resolveRunStoreConfig(false, store)).toBeUndefined()
    expect(resolveRunStoreConfig(undefined, undefined)).toBeUndefined()
  })
})
