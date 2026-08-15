import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { computeRunKey, FileRunStateStore } from '../src/state.js'
import { BASE_SHA } from './helpers.js'

const input = {
  repository: 'open-multi-agent/open-multi-agent',
  issueNumber: 101,
  issueRevision: 'c'.repeat(64),
  baseSha: BASE_SHA,
}

describe('authoritative run state and idempotency', () => {
  it('allows only one concurrent claimant for an issue revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-state-'))
    const store = new FileRunStateStore(root)
    const [first, second] = await Promise.all([
      store.claim({ ...input, runId: 'run-a' }),
      store.claim({ ...input, runId: 'run-b' }),
    ])
    expect([first.claimed, second.claimed].sort()).toEqual([false, true])
    const rejected = first.claimed ? second : first
    expect(rejected.record.issueRevision).toBe(input.issueRevision)
  })

  it('uses base SHA in the idempotency key for the same issue revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-state-'))
    const store = new FileRunStateStore(root)
    const first = await store.claim({ ...input, runId: 'run-a' })
    const second = await store.claim({ ...input, baseSha: 'd'.repeat(40), runId: 'run-b' })
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(true)
    expect(computeRunKey(input)).not.toBe(computeRunKey({ ...input, baseSha: 'd'.repeat(40) }))
  })

  it('fails an expired RUNNING lease closed to NEEDS_HUMAN instead of auto-resuming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-state-'))
    let now = new Date('2026-08-10T00:00:00.000Z')
    const store = new FileRunStateStore(root, { now: () => now })
    const first = await store.claim({ ...input, runId: 'run-a', leaseMs: 1_000 })
    expect(first.claimed).toBe(true)

    now = new Date('2026-08-10T00:00:02.000Z')
    const takeover = await store.claim({ ...input, runId: 'run-b', leaseMs: 1_000 })
    expect(takeover).toMatchObject({
      claimed: false,
      reason: 'stale-needs-human',
      record: { runId: 'run-a', status: 'NEEDS_HUMAN' },
    })
    expect(takeover.record.detail).toMatch(/Automatic takeover is forbidden/)
  })

  it('offers a controlled stale marker but refuses to stop an active lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-state-'))
    let now = new Date('2026-08-10T00:00:00.000Z')
    const store = new FileRunStateStore(root, { now: () => now })
    await store.claim({ ...input, runId: 'run-a', leaseMs: 1_000 })
    const runKey = computeRunKey(input)
    await expect(store.failStaleRun(runKey, 'run-a', 'Maintainer inspected this active run.'))
      .rejects.toThrow(/active lease/)

    now = new Date('2026-08-10T00:00:02.000Z')
    const failedClosed = await store.failStaleRun(
      runKey,
      'run-a',
      'Maintainer confirmed the worker process exited and requires fresh authorization.',
    )
    expect(failedClosed.status).toBe('NEEDS_HUMAN')
  })

  it('persists manifest, proposal, and host acknowledgment transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-state-'))
    const store = new FileRunStateStore(root, {
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    const claimed = await store.claim({ ...input, runId: 'run-a' })
    expect(claimed.claimed).toBe(true)
    const runKey = computeRunKey(input)
    await store.attachContext('run-a', runKey, 'e'.repeat(64))
    await store.transition('run-a', runKey, 'DRAFT_PR_PROPOSAL_READY', 'ready', 'f'.repeat(64))
    const created = await store.transition('run-a', runKey, 'DRAFT_PR_CREATED', 'host acknowledged')
    expect(created).toMatchObject({
      status: 'DRAFT_PR_CREATED',
      contextManifestHash: 'e'.repeat(64),
      proposalHash: 'f'.repeat(64),
    })
    expect((await store.get(runKey))?.status).toBe('DRAFT_PR_CREATED')
  })

  it('rejects transitions from a different run owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-state-'))
    const store = new FileRunStateStore(root)
    await store.claim({ ...input, runId: 'run-a' })
    await expect(store.transition('run-b', computeRunKey(input), 'FAILED')).rejects.toThrow(/different runId/)
  })
})
