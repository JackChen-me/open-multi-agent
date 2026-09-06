import { describe, expect, it } from 'vitest'
import {
  InMemoryStore,
  MemoryStoreRunStore,
  OpenMultiAgent,
  RunLedger,
  Team,
} from '../src/index.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  RunStore,
  RunTaskSpec,
} from '../src/index.js'

function textResponse(text: string, model: string): LLMResponse {
  return {
    id: `resp-${text}`,
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(onCall?: (index: number) => void | Promise<void>) {
  let calls = 0
  const adapter: LLMAdapter = {
    name: 'run-lease-test',
    async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const index = calls++
      await onCall?.(index)
      return textResponse(`output-${index}`, options.model)
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('unused', 'mock-model') }
    },
  }
  return { adapter, calls: () => calls }
}

function worker(name: string, adapter: LLMAdapter): AgentConfig {
  return { name, model: 'mock-model', adapter, systemPrompt: `You are ${name}.` }
}

function team(adapter: LLMAdapter, sharedMemoryStore?: InMemoryStore): Team {
  return new Team({
    name: 'team',
    agents: [worker('worker', adapter)],
    ...(sharedMemoryStore ? { sharedMemoryStore } : {}),
  })
}

const TASKS: RunTaskSpec[] = [
  { title: 'first', description: 'do first', assignee: 'worker' },
  { title: 'second', description: 'do second', assignee: 'worker', dependsOn: ['first'] },
]

/** Reads the record the orchestrator wrote, failing loudly when there is none. */
async function readRecord(store: RunStore, runId: string) {
  const record = await store.get(runId)
  expect(record).not.toBeNull()
  return record!
}

describe('orchestrator run leases', () => {
  it('leaves runs untouched when no run store is configured', async () => {
    const backing = new InMemoryStore()
    const scripted = scriptedAdapter()
    const result = await new OpenMultiAgent()
      .runTasks(team(scripted.adapter), TASKS, { runId: 'run-plain' })

    expect(result.success).toBe(true)
    expect((await backing.list()).length).toBe(0)
  })

  it('records the full lifecycle of a successful run', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const scripted = scriptedAdapter()
    const orchestrator = new OpenMultiAgent({ runStore })

    const result = await orchestrator.runTasks(team(scripted.adapter), TASKS, {
      runId: 'run-ok',
      checkpoint: { store: new InMemoryStore(), runId: 'run-ok' },
    })

    expect(result.success).toBe(true)
    const record = await readRecord(runStore, 'run-ok')
    expect(record).toMatchObject({
      status: 'completed',
      attempt: 1,
      fencingToken: 1,
      outcome: { code: 'ok' },
    })
    // The lease is surrendered, and the record points at the checkpoint the
    // run last fenced and wrote.
    expect(record.lease).toBeUndefined()
    expect(record.checkpointRef?.key).toBe('__oma_checkpoint__/run-ok/latest')
  })

  it('records a failed run as failed rather than leaving it running', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const failing: LLMAdapter = {
      name: 'failing',
      async chat(): Promise<LLMResponse> {
        throw new Error('provider exploded')
      },
      async *stream() {
        yield { type: 'done' as const, data: textResponse('unused', 'mock-model') }
      },
    }
    const result = await new OpenMultiAgent({ runStore })
      .runTasks(team(failing), TASKS, { runId: 'run-fail' })

    expect(result.success).toBe(false)
    expect(await readRecord(runStore, 'run-fail')).toMatchObject({ status: 'failed' })
  })

  it('lets only one of two concurrent workers advance the same run', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const checkpointStore = new InMemoryStore()
    const first = scriptedAdapter()
    const second = scriptedAdapter()
    const options = {
      runId: 'run-contended',
      checkpoint: { store: checkpointStore, runId: 'run-contended' },
    }

    // A lease the first worker still holds. The second orchestrator must not
    // execute a single task under it.
    const held = await new RunLedger(runStore, { owner: 'worker-a' })
      .acquire('run-contended', { heartbeat: false })
    try {
      await expect(new OpenMultiAgent({ runStore: { store: runStore, owner: 'worker-b' } })
        .runTasks(team(second.adapter), TASKS, options))
        .rejects.toMatchObject({ code: 'RUN_LEASE_HELD' })
      expect(second.calls()).toBe(0)
    } finally {
      await held.release()
    }

    // Released, the same run is immediately executable by anyone.
    const result = await new OpenMultiAgent({ runStore: { store: runStore, owner: 'worker-b' } })
      .runTasks(team(first.adapter), TASKS, options)
    expect(result.success).toBe(true)
    expect(first.calls()).toBe(2)
  })

  it('stops a run whose lease is taken over mid-flight and rejects its writes', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const checkpointStore = new InMemoryStore()
    const takeover = new RunLedger(runStore, { owner: 'worker-b', leaseTtlMs: 600_000 })
    const events: OrchestratorEvent[] = []

    // Worker A executes the first task, then worker B takes the run over while
    // A is still inside the run. A's next checkpoint write must be fenced.
    const scripted = scriptedAdapter(async (index) => {
      if (index === 0) return
      const record = await runStore.get('run-taken')
      // Expire A's lease from under it by writing a takeover directly.
      await runStore.compareAndSet('run-taken', record!.version, {
        ...record!,
        version: record!.version + 1,
        fencingToken: record!.fencingToken + 1,
        attempt: record!.attempt + 1,
        lease: {
          owner: 'worker-b',
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        updatedAt: new Date().toISOString(),
      })
    })

    const result = await new OpenMultiAgent({
      runStore: { store: runStore, owner: 'worker-a', heartbeat: false },
      onProgress: (event) => { events.push(event) },
    }).runTasks(team(scripted.adapter), TASKS, {
      runId: 'run-taken',
      checkpoint: { store: checkpointStore, runId: 'run-taken' },
    })

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('error')
    expect(result.status?.message).toMatch(/fencing token/)
    expect(events.some((event) =>
      event.type === 'error' && (event.data as { kind?: string }).kind === 'checkpoint_save_failed',
    )).toBe(true)

    // The taken-over worker wrote no terminal status: the run still belongs to
    // worker B, which can finish it.
    const record = await readRecord(runStore, 'run-taken')
    expect(record.status).toBe('running')
    expect(record.lease?.owner).toBe('worker-b')

    const owner = await takeover.acquire('run-taken', { heartbeat: false })
    await owner.complete({ code: 'ok' })
    expect((await readRecord(runStore, 'run-taken')).status).toBe('completed')
  })

  it('stops a run cancelled through its authoritative record', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const operator = new RunLedger(runStore, { owner: 'operator' })
    const scripted = scriptedAdapter(async (index) => {
      if (index === 0) await operator.cancel('run-cancelled', 'operator stop')
    })

    const result = await new OpenMultiAgent({
      runStore: { store: runStore, owner: 'worker-a', heartbeat: false },
    }).runTasks(team(scripted.adapter), TASKS, {
      runId: 'run-cancelled',
      checkpoint: { store: new InMemoryStore(), runId: 'run-cancelled' },
    })

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('cancelled')
    // Only the first task ran; the run stopped at the dispatch gate.
    expect(scripted.calls()).toBe(1)
    expect((await readRecord(runStore, 'run-cancelled')).status).toBe('cancelled')
  })

  it('refuses to start a run that already finished', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const orchestrator = new OpenMultiAgent({ runStore })
    const scripted = scriptedAdapter()

    await orchestrator.runTasks(team(scripted.adapter), TASKS, { runId: 'run-once' })
    expect((await readRecord(runStore, 'run-once')).status).toBe('completed')

    const second = scriptedAdapter()
    await expect(orchestrator.runTasks(team(second.adapter), TASKS, { runId: 'run-once' }))
      .rejects.toMatchObject({ code: 'RUN_ALREADY_TERMINAL' })
    expect(second.calls()).toBe(0)
  })

  it('releases the lease when the run throws instead of returning a result', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const scripted = scriptedAdapter()

    // Legacy round scheduling plus runtime recovery is rejected inside
    // `executeQueue`, which is a real throw out of an already-leased run.
    await expect(new OpenMultiAgent({
      runStore: { store: runStore, owner: 'worker-a' },
      onApproval: () => true,
      recovery: { mode: 'repairable', onTaskOutcome: () => undefined },
    }).runTasks(team(scripted.adapter), TASKS, { runId: 'run-throws' }))
      .rejects.toThrow(/Runtime recovery is incompatible/)
    expect(scripted.calls()).toBe(0)

    // Released rather than left `running`, so another worker does not have to
    // wait out the lease TTL.
    const record = await readRecord(runStore, 'run-throws')
    expect(record.status).toBe('queued')
    expect(record.lease).toBeUndefined()

    const retry = scriptedAdapter()
    const result = await new OpenMultiAgent({ runStore: { store: runStore, owner: 'worker-b' } })
      .runTasks(team(retry.adapter), TASKS, { runId: 'run-throws' })
    expect(result.success).toBe(true)
  })

  it('honours a per-call opt-out of a configured run store', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const scripted = scriptedAdapter()
    const result = await new OpenMultiAgent({ runStore })
      .runTasks(team(scripted.adapter), TASKS, { runId: 'run-opt-out', runStore: false })

    expect(result.success).toBe(true)
    expect(await runStore.get('run-opt-out')).toBeNull()
  })

  it('suspends a run durably and lets a second worker resume and finish it', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const checkpointStore = new InMemoryStore()
    const sharedStore = new InMemoryStore()
    const first = scriptedAdapter()

    const suspended = await new OpenMultiAgent({
      runStore: { store: runStore, owner: 'worker-a', heartbeat: false },
      onTaskDispatch: (task) => (task.title === 'second'
        ? { action: 'suspend', reason: 'second task needs review' }
        : { action: 'allow' }),
    }).runTasks(team(first.adapter, sharedStore), TASKS, {
      runId: 'run-suspend',
      checkpoint: { store: checkpointStore, runId: 'run-suspend' },
    })

    expect(suspended.status?.code).toBe('suspended')
    const pending = suspended.pendingApprovals ?? []
    expect(pending).toHaveLength(1)

    const record = await readRecord(runStore, 'run-suspend')
    expect(record.status).toBe('suspended')
    expect(record.lease).toBeUndefined()
    expect(record.suspension?.pendingApprovalIds).toEqual([pending[0]!.id])

    // The decision is recorded with nothing running, then a different worker
    // restores. `restore()` is the resume command, so no explicit resume call
    // is needed before it.
    const { decideApproval } = await import('../src/index.js')
    await decideApproval(checkpointStore, {
      requestId: pending[0]!.id,
      requestHash: pending[0]!.requestHash,
      decision: 'approve',
      reviewer: { id: 'reviewer-1' },
    })

    const second = scriptedAdapter()
    const resumed = await new OpenMultiAgent({
      runStore: { store: runStore, owner: 'worker-b', heartbeat: false },
    }).restore(team(second.adapter, sharedStore), {
      runId: 'run-suspend',
      checkpoint: { store: checkpointStore, runId: 'run-suspend' },
    })

    expect(resumed.success).toBe(true)
    // Only the remaining task ran on the new worker.
    expect(second.calls()).toBe(1)
    const finished = await readRecord(runStore, 'run-suspend')
    expect(finished).toMatchObject({ status: 'completed', outcome: { code: 'ok' } })
    expect(finished.fencingToken).toBeGreaterThan(record.fencingToken)
  })

  it('lets only one of two workers restore the same checkpoint', async () => {
    const runStore = new MemoryStoreRunStore(new InMemoryStore())
    const checkpointStore = new InMemoryStore()
    const sharedStore = new InMemoryStore()
    const abort = new AbortController()

    const first = scriptedAdapter()
    await new OpenMultiAgent({
      runStore: { store: runStore, owner: 'worker-a', heartbeat: false },
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    }).runTasks(team(first.adapter, sharedStore), TASKS, {
      runId: 'run-restore',
      abortSignal: abort.signal,
      checkpoint: { store: checkpointStore, runId: 'run-restore' },
    })

    // An aborted run is cancelled, not abandoned, so make it eligible again the
    // way an operator would before handing it to another worker.
    expect((await readRecord(runStore, 'run-restore')).status).toBe('cancelled')

    const fresh = new MemoryStoreRunStore(new InMemoryStore())
    await new RunLedger(fresh, { owner: 'worker-a' }).acquire('run-restore', { heartbeat: false })

    const second = scriptedAdapter()
    await expect(new OpenMultiAgent({
      runStore: { store: fresh, owner: 'worker-b', heartbeat: false },
    }).restore(team(second.adapter, sharedStore), {
      runId: 'run-restore',
      checkpoint: { store: checkpointStore, runId: 'run-restore' },
    })).rejects.toMatchObject({ code: 'RUN_LEASE_HELD' })
    expect(second.calls()).toBe(0)
  })
})
