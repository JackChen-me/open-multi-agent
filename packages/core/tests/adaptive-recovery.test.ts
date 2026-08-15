import { describe, expect, it, vi } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Checkpoint } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  OrchestratorEvent,
  TaskOutcome,
  MemoryEntry,
  MemoryStore,
  CheckpointSnapshot,
  PlanArtifact,
} from '../src/types.js'

function userPrompt(messages: LLMMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')
    ?.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? ''
}

function taskTitle(messages: LLMMessage[]): string {
  return userPrompt(messages).match(/^# Task: (.+)$/m)?.[1] ?? ''
}

function response(text: string, options: LLMChatOptions): LLMResponse {
  return {
    id: `response-${text}`,
    content: [{ type: 'text', text }],
    model: options.model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function adapter(
  handler: (title: string) => string | Error,
  calls: string[],
): LLMAdapter {
  return {
    name: 'adaptive-recovery-test',
    async chat(messages, options) {
      const title = taskTitle(messages)
      calls.push(title)
      const value = handler(title)
      if (value instanceof Error) throw value
      return response(value, options)
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function agent(name: string, llm: LLMAdapter): AgentConfig {
  return {
    name,
    model: 'test-model',
    systemPrompt: `You are ${name}.`,
    adapter: llm,
  }
}

describe('adaptive runtime recovery', () => {
  it('repairs a failed branch by superseding old downstream work and appending replacements', async () => {
    const calls: string[] = []
    const events: OrchestratorEvent[] = []
    const llm = adapter(
      (title) => title === 'Search' ? new Error('search unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent({
      maxConcurrency: 2,
      onProgress: (event) => events.push(event),
    })
    const team = oma.createTeam('repair', {
      name: 'repair',
      agents: [agent('worker-a', llm), agent('worker-b', llm)],
    })

    const result = await oma.runTasks(team, [
      { title: 'Search', description: 'Search the primary source.', assignee: 'worker-a' },
      {
        title: 'Analysis',
        description: 'Analyze the primary source.',
        assignee: 'worker-a',
        dependsOn: ['Search'],
      },
    ], {
      recovery: {
        mode: 'repairable',
        onTaskOutcome: (outcome: TaskOutcome) => {
          if (outcome.kind !== 'failure' || outcome.task.title !== 'Search') return undefined
          const oldAnalysis = outcome.tasks.find((task) => task.title === 'Analysis')!
          return {
            reason: 'Primary search failed; use the fallback source.',
            supersedePending: [oldAnalysis.id],
            addTasks: [
              {
                key: 'fallback-search',
                title: 'Fallback Search',
                description: 'Search the fallback source.',
                assignee: 'worker-b',
              },
              {
                key: 'replacement-analysis',
                title: 'Replacement Analysis',
                description: 'Analyze the fallback source.',
                assignee: 'worker-b',
                dependsOn: ['fallback-search'],
              },
            ],
          }
        },
      },
    })

    expect(calls).toEqual(['Search', 'Fallback Search', 'Replacement Analysis'])
    expect(result.success).toBe(true)
    expect(result.tasks?.find((task) => task.title === 'Search')).toMatchObject({
      status: 'failed',
      recoveredByRevision: 1,
    })
    expect(result.tasks?.find((task) => task.title === 'Analysis')).toMatchObject({
      status: 'skipped',
      supersededByRevision: 1,
    })
    expect(result.tasks?.find((task) => task.title === 'Fallback Search')?.status).toBe('completed')
    expect(result.tasks?.find((task) => task.title === 'Replacement Analysis')?.status).toBe('completed')
    expect(result.planRevisions).toHaveLength(1)
    expect(result.planRevisions?.[0]).toMatchObject({
      version: 1,
      trigger: 'failure',
      reason: 'Primary search failed; use the fallback source.',
    })
    expect(events.some((event) => event.type === 'plan_revision')).toBe(true)
  })

  it('holds original downstream dispatch until a success expansion is applied', async () => {
    const calls: string[] = []
    const llm = adapter((title) => `completed ${title}`, calls)
    const oma = new OpenMultiAgent({ maxConcurrency: 3 })
    const team = oma.createTeam('expand', {
      name: 'expand',
      agents: [agent('worker', llm)],
    })

    const onTaskOutcome = vi.fn((outcome: TaskOutcome) => {
      if (outcome.kind !== 'success' || outcome.task.title !== 'Upstream') return undefined
      const oldDownstream = outcome.tasks.find((task) => task.title === 'Old Downstream')!
      return {
        reason: 'Expand work from the actual upstream result.',
        supersedePending: [oldDownstream.id],
        addTasks: [
          {
            key: 'branch-a',
            title: 'Branch A',
            description: 'Process branch A.',
            assignee: 'worker',
            dependsOn: [outcome.task.id],
          },
          {
            key: 'branch-b',
            title: 'Branch B',
            description: 'Process branch B.',
            assignee: 'worker',
            dependsOn: [outcome.task.id],
          },
        ],
      }
    })

    const result = await oma.runTasks(team, [
      { title: 'Upstream', description: 'Produce structured scope.', assignee: 'worker' },
      {
        title: 'Old Downstream',
        description: 'Original downstream.',
        assignee: 'worker',
        dependsOn: ['Upstream'],
      },
    ], {
      recovery: { mode: 'repairable', onTaskOutcome },
    })

    expect(calls).toEqual(['Upstream', 'Branch A', 'Branch B'])
    expect(result.success).toBe(true)
    expect(result.tasks?.find((task) => task.title === 'Old Downstream')).toMatchObject({
      status: 'skipped',
      supersededByRevision: 1,
    })
    expect(result.tasks?.filter((task) => task.status === 'completed').map((task) => task.title))
      .toEqual(['Upstream', 'Branch A', 'Branch B'])
  })

  it('preserves fixed DAG cascade behavior when recovery is omitted', async () => {
    const calls: string[] = []
    const llm = adapter(
      (title) => title === 'Search' ? new Error('search unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent()
    const team = oma.createTeam('fixed', {
      name: 'fixed',
      agents: [agent('worker', llm)],
    })

    const result = await oma.runTasks(team, [
      { title: 'Search', description: 'Search.', assignee: 'worker' },
      {
        title: 'Analysis',
        description: 'Analyze.',
        assignee: 'worker',
        dependsOn: ['Search'],
      },
    ])

    expect(calls).toEqual(['Search'])
    expect(result.success).toBe(false)
    expect(result.tasks?.map((task) => task.status)).toEqual(['failed', 'failed'])
  })

  it('accepts a first-class replanner policy and applies its repair', async () => {
    const calls: string[] = []
    const replan = vi.fn((outcome: TaskOutcome) => outcome.kind === 'failure'
      ? {
          reason: 'Replanner selected a fallback agent.',
          addTasks: [{
            key: 'fallback',
            title: 'Fallback',
            description: 'Recover through the fallback agent.',
            assignee: 'worker-b',
          }],
        }
      : undefined)
    const llm = adapter(
      (title) => title === 'Primary' ? new Error('primary unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent()
    const team = oma.createTeam('replanner', {
      name: 'replanner',
      agents: [agent('worker-a', llm), agent('worker-b', llm)],
    })

    const result = await oma.runTasks(team, [
      { title: 'Primary', description: 'Use the primary path.', assignee: 'worker-a' },
    ], {
      recovery: {
        mode: 'repairable',
        replanner: { name: 'fallback-policy', replan },
      },
    })

    expect(replan).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['Primary', 'Fallback'])
    expect(result.success).toBe(true)
  })

  it('keeps the original failure path when plan-patch approval rejects a proposal', async () => {
    const calls: string[] = []
    const events: OrchestratorEvent[] = []
    const approval = vi.fn(() => false)
    const llm = adapter(
      (title) => title === 'Primary' ? new Error('primary unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent({ onProgress: (event) => events.push(event) })
    const team = oma.createTeam('approval', {
      name: 'approval',
      agents: [agent('worker', llm)],
    })

    const result = await oma.runTasks(team, [
      { title: 'Primary', description: 'Use the primary path.', assignee: 'worker' },
    ], {
      recovery: {
        mode: 'repairable',
        onTaskOutcome: (outcome) => outcome.kind === 'failure'
          ? {
              reason: 'Try fallback.',
              addTasks: [{
                key: 'fallback',
                title: 'Fallback',
                description: 'Use fallback.',
                assignee: 'worker',
              }],
            }
          : undefined,
        onPlanPatch: approval,
      },
    })

    expect(approval).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['Primary'])
    expect(result.success).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery_decision',
      data: expect.objectContaining({ decision: 'rejected' }),
    }))
  })

  it('appends investigation work when consensus verification rejects evidence', async () => {
    const workerCalls: string[] = []
    const judgeCalls: string[] = []
    const worker = adapter((title) => `completed ${title}`, workerCalls)
    const judge = adapter(
      () => '{"accept":false,"critique":"sources conflict"}',
      judgeCalls,
    )
    const oma = new OpenMultiAgent()
    const team = oma.createTeam('verification-repair', {
      name: 'verification-repair',
      agents: [agent('worker', worker)],
    })

    const result = await oma.runTasks(team, [{
      title: 'Verify Evidence',
      description: 'Validate the available evidence.',
      assignee: 'worker',
      verify: {
        judges: [agent('judge', judge)],
        quorum: 1,
        maxRounds: 1,
        onDissent: 'reject',
      },
    }], {
      recovery: {
        mode: 'repairable',
        onTaskOutcome: (outcome) => outcome.kind === 'verification_rejected'
          ? {
              reason: 'The evidence conflicted; gather a second source.',
              addTasks: [{
                key: 'supplemental-investigation',
                title: 'Supplemental Investigation',
                description: 'Gather and reconcile an independent source.',
                assignee: 'worker',
              }],
            }
          : undefined,
      },
    })

    expect(judgeCalls).toHaveLength(1)
    expect(workerCalls).toEqual(['Verify Evidence', 'Supplemental Investigation'])
    expect(result.success).toBe(true)
    expect(result.tasks?.find((task) => task.title === 'Verify Evidence')).toMatchObject({
      status: 'completed',
      recoveredByRevision: 1,
    })
    expect(result.tasks?.find((task) => task.title === 'Supplemental Investigation')?.status)
      .toBe('completed')
  })

  it('persists plan revision history in checkpoint queue snapshot v2', async () => {
    const calls: string[] = []
    const store = new InMemoryStore()
    const llm = adapter(
      (title) => title === 'Search' ? new Error('search unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent()
    const team = oma.createTeam('checkpoint-repair', {
      name: 'checkpoint-repair',
      agents: [agent('worker', llm)],
    })

    await oma.runTasks(team, [
      { title: 'Search', description: 'Search.', assignee: 'worker' },
    ], {
      checkpoint: { store },
      recovery: {
        mode: 'repairable',
        onTaskOutcome: (outcome) => outcome.kind === 'failure'
          ? {
              reason: 'Use fallback.',
              addTasks: [{
                key: 'fallback',
                title: 'Fallback',
                description: 'Fetch fallback.',
                assignee: 'worker',
              }],
            }
          : undefined,
      },
    })

    const snapshot = await new Checkpoint(store).loadLatest()
    expect(snapshot?.queue.version).toBe(2)
    if (snapshot?.queue.version !== 2) throw new Error('expected adaptive queue snapshot')
    expect(snapshot.queue.planRevision).toBe(1)
    expect(snapshot.queue.planRevisions).toHaveLength(1)
    expect(snapshot.queue.planRevisions[0]).toMatchObject({
      trigger: 'failure',
      reason: 'Use fallback.',
    })
  })

  it('rolls back a repair and preserves failure cascade when patch checkpointing fails', async () => {
    const calls: string[] = []
    const events: OrchestratorEvent[] = []
    const store = new FailingStore()
    const llm = adapter(
      (title) => title === 'Search' ? new Error('search unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent({ onProgress: (event) => events.push(event) })
    const team = oma.createTeam('rollback-repair', {
      name: 'rollback-repair',
      agents: [agent('worker', llm)],
    })

    const result = await oma.runTasks(team, [
      { title: 'Search', description: 'Search.', assignee: 'worker' },
      {
        title: 'Analysis',
        description: 'Analyze.',
        assignee: 'worker',
        dependsOn: ['Search'],
      },
    ], {
      checkpoint: { store },
      recovery: {
        mode: 'repairable',
        onTaskOutcome: (outcome) => outcome.kind === 'failure'
          ? {
              reason: 'Use fallback.',
              supersedePending: [
                outcome.tasks.find((task) => task.title === 'Analysis')!.id,
              ],
              addTasks: [{
                key: 'fallback',
                title: 'Fallback',
                description: 'Fetch fallback.',
                assignee: 'worker',
              }],
            }
          : undefined,
      },
    })

    expect(calls).toEqual(['Search'])
    expect(result.success).toBe(false)
    expect(result.tasks?.map((task) => task.status)).toEqual(['failed', 'failed'])
    expect(result.tasks?.some((task) => task.title === 'Fallback')).toBe(false)
    expect(events.some((event) =>
      event.type === 'warning'
      && (event.data as { code?: string }).code === 'PLAN_REVISION_NOT_DURABLE')).toBe(true)
  })

  it('restores a crash-boundary revision without appending the repair twice', async () => {
    const calls: string[] = []
    const store = new InMemoryStore()
    const queue = new TaskQueue()
    const primary = createTask({
      title: 'Primary',
      description: 'Use the primary source.',
      assignee: 'worker',
    })
    queue.add(primary)
    queue.update(primary.id, { status: 'in_progress' })
    const { revision } = queue.applyPlanPatch({
      reason: 'Use fallback after the primary failure.',
      addTasks: [{
        key: 'fallback',
        title: 'Fallback',
        description: 'Use the fallback source.',
        assignee: 'worker',
      }],
    }, primary.id, 'failure')
    queue.publishPlanRevision(revision)

    const checkpoint: CheckpointSnapshot = {
      version: 2,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      identity: {
        runId: 'adaptive-restore',
        attempt: 1,
        lastTraceId: '00000000000000000000000000000001',
        lastRootSpanId: '0000000000000001',
      },
      queue: queue.snapshot(),
      completedTaskResults: [],
    }
    await new Checkpoint(store).save(checkpoint)

    const llm = adapter(
      (title) => title === 'Primary' ? new Error('primary unavailable') : `completed ${title}`,
      calls,
    )
    const oma = new OpenMultiAgent({ maxConcurrency: 1 })
    const team = oma.createTeam('adaptive-restore', {
      name: 'adaptive-restore',
      agents: [agent('worker', llm)],
    })
    const replan = vi.fn((outcome: TaskOutcome) => outcome.kind === 'failure'
      ? {
          reason: 'This duplicate proposal must not be called.',
          addTasks: [{
            key: 'duplicate',
            title: 'Duplicate',
            description: 'Must not be appended.',
            assignee: 'worker',
          }],
        }
      : undefined)

    const result = await oma.restore(team, {
      checkpoint: { store },
      recovery: {
        mode: 'repairable',
        replanner: { replan },
      },
    })

    expect(replan).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['Primary', 'Fallback'])
    expect(result.success).toBe(true)
    expect(result.tasks?.map((task) => task.title)).toEqual(['Primary', 'Fallback'])
    expect(result.tasks?.find((task) => task.title === 'Primary')?.recoveredByRevision).toBe(1)
  })

  it('keeps runFromPlan and its checkpoints exact', async () => {
    const calls: string[] = []
    const store = new InMemoryStore()
    const llm = adapter((title) => `completed ${title}`, calls)
    const oma = new OpenMultiAgent()
    const team = oma.createTeam('exact-plan', {
      name: 'exact-plan',
      agents: [agent('worker', llm)],
    })
    const plan: PlanArtifact = {
      version: 1,
      tasks: [{
        id: 'planned-task',
        title: 'Planned Task',
        description: 'Execute exactly.',
        assignee: 'worker',
      }],
    }
    const recovery = {
      mode: 'repairable' as const,
      replanner: { replan: () => undefined },
    }

    await expect(oma.runFromPlan(team, plan, { recovery }))
      .rejects.toThrow('runFromPlan requires fixed recovery')
    await oma.runFromPlan(team, plan, { checkpoint: { store } })
    expect((await new Checkpoint(store).loadLatest())?.mode).toBe('runFromPlan')
    await expect(oma.restore(team, { checkpoint: { store }, recovery }))
      .rejects.toThrow('runFromPlan checkpoint requires fixed recovery')
  })
})

class FailingStore implements MemoryStore {
  async get(): Promise<MemoryEntry | null> { return null }
  async set(): Promise<void> { throw new Error('checkpoint unavailable') }
  async list(): Promise<MemoryEntry[]> { return [] }
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
}
