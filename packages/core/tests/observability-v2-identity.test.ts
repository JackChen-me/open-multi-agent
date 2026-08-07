import { describe, expect, it } from 'vitest'
import { Checkpoint } from '../src/memory/checkpoint.js'
import { InMemoryStore } from '../src/memory/store.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { classifyRunFailure } from '../src/observability/status.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import { Team } from '../src/team/team.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  RunIdentity,
} from '../src/types.js'

function response(text: string, usage = { input_tokens: 1, output_tokens: 1 }): LLMResponse {
  return {
    id: `response-${text}`,
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: 'end_turn',
    usage,
  }
}

function adapter(
  chat: (messages: LLMMessage[], options: LLMChatOptions) => Promise<LLMResponse>,
): LLMAdapter {
  return {
    name: 'obs-1a-test',
    chat,
    async *stream() { /* unused */ },
  }
}

function staticAdapter(text = 'ok', usage?: { input_tokens: number; output_tokens: number }): LLMAdapter {
  return adapter(async () => response(text, usage))
}

function agentConfig(name = 'worker', llm: LLMAdapter = staticAdapter()): AgentConfig {
  return { name, model: 'test-model', adapter: llm }
}

function teamWith(llm: LLMAdapter = staticAdapter()): Team {
  return new Team({ name: 'team', agents: [agentConfig('worker', llm)] })
}

function expectIdentity(identity: RunIdentity | undefined, attempt = 1): RunIdentity {
  expect(identity).toBeDefined()
  expect(identity!.runId.length).toBeGreaterThan(0)
  expect(identity!.attempt).toBe(attempt)
  expect(identity!.traceId).toMatch(/^[0-9a-f]{32}$/)
  expect(identity!.traceId).not.toMatch(/^0+$/)
  expect(identity!.rootSpanId).toMatch(/^[0-9a-f]{16}$/)
  expect(identity!.rootSpanId).not.toMatch(/^0+$/)
  return identity!
}

describe('OBS-1A run identity', () => {
  it('returns unique identity without onTrace from every top-level entry', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'test-model' })
    const runAgent = await oma.runAgent(agentConfig(), 'hello')
    const runTeam = await oma.runTeam(teamWith(), 'Say hello')
    const runTasks = await oma.runTasks(teamWith(), [
      { title: 'task', description: 'work', assignee: 'worker' },
    ])
    const runFromPlan = await oma.runFromPlan(teamWith(), {
      version: 1,
      tasks: [{ id: 'planned', title: 'planned', description: 'work', assignee: 'worker' }],
    })

    let consensusCall = 0
    const consensusAdapter = adapter(async () => response(
      consensusCall++ === 0 ? 'answer' : '{"accept":true,"critique":""}',
    ))
    const runConsensus = await oma.runConsensus(teamWith(), 'question', {
      proposer: agentConfig('proposer', consensusAdapter),
      judges: [agentConfig('judge', consensusAdapter)],
      maxRounds: 1,
    })

    const identities = [
      runAgent.identity,
      runTeam.identity,
      runTasks.identity,
      runFromPlan.identity,
      runConsensus.identity,
    ].map((identity) => expectIdentity(identity))

    expect(new Set(identities.map((identity) => identity.runId)).size).toBe(5)
    expect(new Set(identities.map((identity) => identity.traceId)).size).toBe(5)
    expect(runAgent.status?.code).toBe('ok')
    expect(runTeam.status?.code).toBe('ok')
    expect(runTasks.status?.code).toBe('ok')
    expect(runFromPlan.status?.code).toBe('ok')
    expect(runConsensus.status?.code).toBe('ok')
  })

  it('uses a caller runId and keeps it stable through nested results', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'test-model' })
    const result = await oma.runTasks(teamWith(), [
      { title: 'task', description: 'work', assignee: 'worker' },
    ], { runId: 'customer-run-42' })

    expect(result.identity?.runId).toBe('customer-run-42')
    expect(result.agentResults.get('worker')?.identity).toEqual(result.identity)
  })

  it('rejects empty, overlong, and conflicting run IDs', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'test-model' })
    await expect(oma.runAgent(agentConfig(), 'hello', { runId: '' })).rejects.toThrow(/1 and 128/)
    await expect(oma.runAgent(agentConfig(), 'hello', { runId: 'x'.repeat(129) })).rejects.toThrow(/1 and 128/)
    await expect(oma.runTasks(teamWith(), [], {
      runId: 'one',
      checkpoint: { store: new InMemoryStore(), runId: 'two' },
    })).rejects.toThrow(/runId conflict/)
  })
})

describe('OBS-1A outcome semantics', () => {
  it('maps success and provider execution failure', async () => {
    const ok = await new OpenMultiAgent().runAgent(agentConfig(), 'hello')
    expect(ok.success).toBe(true)
    expect(ok.status?.code).toBe('ok')
    expect(ok.errorInfo).toBeUndefined()

    const providerError = Object.assign(new Error('provider unavailable'), { status: 503 })
    const failed = await new OpenMultiAgent().runAgent(
      agentConfig('worker', adapter(async () => { throw providerError })),
      'hello',
    )
    expect(failed.success).toBe(false)
    expect(failed.status?.code).toBe('error')
    expect(failed.errorInfo).toMatchObject({ kind: 'provider', httpStatus: 503, retryable: true })
    expect(failed.error).toBe(providerError)
  })

  it('classifies provider 401/429/500 retryability', () => {
    const classified = (status: number) => classifyRunFailure(
      Object.assign(new Error(`HTTP ${status}`), { status }),
    ).errorInfo
    expect(classified(401)).toMatchObject({ kind: 'provider', httpStatus: 401, retryable: false })
    expect(classified(429)).toMatchObject({ kind: 'provider', httpStatus: 429, retryable: true })
    expect(classified(500)).toMatchObject({ kind: 'provider', httpStatus: 500, retryable: true })
  })

  it('maps caller abort and whole-run timeout without reporting success', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelled = await new OpenMultiAgent().runAgent(
      agentConfig('worker', staticAdapter()),
      'hello',
      { abortSignal: controller.signal },
    )
    expect(cancelled.success).toBe(false)
    expect(cancelled.status?.code).toBe('cancelled')
    expect(cancelled.errorInfo?.kind).toBe('cancellation')

    const waitsForAbort = adapter(async (_messages, options) => {
      await new Promise<void>((resolve) => {
        if (options.abortSignal?.aborted) resolve()
        else options.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return response('late')
    })
    const timedOut = await new OpenMultiAgent().runAgent(
      { ...agentConfig('worker', waitsForAbort), timeoutMs: 5 },
      'hello',
    )
    expect(timedOut.success).toBe(false)
    expect(timedOut.status?.code).toBe('timeout')
    expect(timedOut.errorInfo?.kind).toBe('timeout')
  })

  it('maps token budget exhaustion', async () => {
    const result = await new OpenMultiAgent().runAgent(
      { ...agentConfig('worker', staticAdapter('large', { input_tokens: 8, output_tokens: 8 })), maxTokenBudget: 10 },
      'hello',
    )
    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('budget_exhausted')
    expect(result.errorInfo?.kind).toBe('budget')
  })

  it('maps pre-aborted task runs, plan-only, plan rejection, and callback failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelled = await new OpenMultiAgent({ defaultModel: 'test-model' }).runTasks(
      teamWith(),
      [{ title: 'task', description: 'work', assignee: 'worker' }],
      { abortSignal: controller.signal },
    )
    expect(cancelled.success).toBe(false)
    expect(cancelled.status?.code).toBe('cancelled')
    expect(cancelled.tasks?.[0]?.status).toBe('skipped')

    const taskJson = '```json\n[{"title":"task","description":"work","assignee":"worker"}]\n```'
    const planOnly = await new OpenMultiAgent({ defaultModel: 'test-model' }).runTeam(
      teamWith(staticAdapter(taskJson)),
      'First plan the work, then execute it',
      { planOnly: true, coordinator: { adapter: staticAdapter(taskJson) } },
    )
    expect(planOnly.success).toBe(true)
    expect(planOnly.status?.code).toBe('ok')
    expect(planOnly.planOnly).toBe(true)

    const rejected = await new OpenMultiAgent({
      defaultModel: 'test-model',
      onPlanReady: async () => false,
    }).runTeam(teamWith(), 'First plan the work, then execute it', {
      coordinator: { adapter: staticAdapter(taskJson) },
    })
    expect(rejected.success).toBe(false)
    expect(rejected.status?.code).toBe('rejected')
    expect(rejected.errorInfo).toBeUndefined()

    const callbackError = await new OpenMultiAgent({
      defaultModel: 'test-model',
      onPlanReady: async () => { throw new Error('gate failed') },
    }).runTeam(teamWith(), 'First plan the work, then execute it', {
      coordinator: { adapter: staticAdapter(taskJson) },
    })
    expect(callbackError.success).toBe(false)
    expect(callbackError.status?.code).toBe('error')
    expect(callbackError.errorInfo?.kind).toBe('callback')
  })

  it('keeps a rejected consensus verdict as an ok execution outcome', async () => {
    let call = 0
    const llm = adapter(async () => response(
      call++ === 0 ? 'answer' : '{"accept":false,"critique":"not enough"}',
    ))
    const result = await new OpenMultiAgent().runConsensus(teamWith(), 'question', {
      proposer: agentConfig('proposer', llm),
      judges: [agentConfig('judge', llm)],
      maxRounds: 1,
      onDissent: 'reject',
    })
    expect(result.verdict).toBe('rejected')
    expect(result.status?.code).toBe('ok')
  })

  it('reports a judge execution failure as an error outcome', async () => {
    const proposer = staticAdapter('answer')
    const judgeError = Object.assign(new Error('judge provider failed'), { status: 500 })
    const judge = adapter(async () => { throw judgeError })
    const result = await new OpenMultiAgent().runConsensus(teamWith(), 'question', {
      proposer: agentConfig('proposer', proposer),
      judges: [agentConfig('judge', judge)],
      maxRounds: 1,
      onDissent: 'reject',
    })
    expect(result.verdict).toBe('rejected')
    expect(result.status?.code).toBe('error')
    expect(result.errorInfo).toMatchObject({ kind: 'provider', httpStatus: 500 })
  })

  it('maps between-round approval rejection to rejected', async () => {
    const oma = new OpenMultiAgent({
      defaultModel: 'test-model',
      onApproval: async () => false,
    })
    const result = await oma.runTasks(teamWith(), [
      { title: 'first', description: 'work', assignee: 'worker' },
      { title: 'second', description: 'work', assignee: 'worker', dependsOn: ['first'] },
    ])
    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('rejected')
    expect(result.tasks?.map((task) => task.status)).toEqual(['completed', 'skipped'])
  })
})

describe('OBS-1A checkpoint identity restore', () => {
  it('writes v4 and restores with the same runId, incremented attempt, and a new trace link', async () => {
    const store = new InMemoryStore()
    const oma = new OpenMultiAgent({ defaultModel: 'test-model' })
    const initial = await oma.runTasks(teamWith(), [
      { title: 'task', description: 'work', assignee: 'worker' },
    ], { checkpoint: { store, runId: 'logical-run' } })
    const stored = await new Checkpoint(store, { runId: 'logical-run' }).loadLatest()

    expect(stored?.version).toBe(4)
    if (stored?.version !== 4) throw new Error('expected checkpoint v4')
    expect(stored.identity).toEqual({
      runId: initial.identity?.runId,
      attempt: 1,
      lastTraceId: initial.identity?.traceId,
      lastRootSpanId: initial.identity?.rootSpanId,
    })

    const restored = await oma.restore(teamWith(), {
      checkpoint: { store, runId: 'logical-run' },
    })
    const restoredIdentity = expectIdentity(restored.identity, 2)
    expect(restoredIdentity.runId).toBe(initial.identity?.runId)
    expect(restoredIdentity.traceId).not.toBe(initial.identity?.traceId)
    expect(restoredIdentity.rootSpanId).not.toBe(initial.identity?.rootSpanId)
    expect(restoredIdentity.links).toEqual([{
      traceId: initial.identity?.traceId,
      spanId: initial.identity?.rootSpanId,
      relation: 'continued_from',
    }])

    const restoredAgain = await oma.restore(teamWith(), {
      checkpoint: { store, runId: 'logical-run' },
    })
    expectIdentity(restoredAgain.identity, 3)
    expect(restoredAgain.identity?.links?.[0]).toMatchObject({
      traceId: restored.identity?.traceId,
      spanId: restored.identity?.rootSpanId,
      relation: 'continued_from',
    })
  })

  it('reads v1, treats it as attempt 1, and rejects a conflicting restore runId', async () => {
    const store = new InMemoryStore()
    const queue = new TaskQueue()
    const completed = { ...createTask({ title: 'task', description: 'work', assignee: 'worker' }), id: 'task' }
    queue.add(completed)
    queue.complete('task', 'done')
    await new Checkpoint(store, { runId: 'legacy-run' }).save({
      version: 1,
      mode: 'runTasks',
      createdAt: new Date().toISOString(),
      runId: 'legacy-run',
      queue: queue.snapshot(),
      completedTaskResults: [{ taskId: 'task', assignee: 'worker', result: 'done' }],
    })

    const oma = new OpenMultiAgent({ defaultModel: 'test-model' })
    const restored = await oma.restore(teamWith(), {
      checkpoint: { store, runId: 'legacy-run' },
    })
    expectIdentity(restored.identity, 2)
    expect(restored.identity?.runId).toBe('legacy-run')
    expect(restored.identity?.links).toBeUndefined()

    await expect(oma.restore(teamWith(), {
      runId: 'different-run',
      checkpoint: { store, runId: 'legacy-run' },
    })).rejects.toThrow(/runId conflict/)
  })
})
