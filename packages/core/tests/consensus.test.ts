import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  TokenUsage,
  TraceEvent,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock adapter with known per-call usage and prompt capture
// ---------------------------------------------------------------------------

function extractUserPrompt(messages: LLMMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  return (lastUser?.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

interface Capture {
  readonly adapter: LLMAdapter
  readonly prompts: string[]
  readonly calls: () => number
}

/**
 * Build an adapter that replies with `reply` (or a per-prompt function),
 * reporting `usage` per call and recording every user prompt it received.
 */
function captureAdapter(
  reply: string | ((prompt: string) => string),
  usage: TokenUsage = { input_tokens: 5, output_tokens: 5 },
): Capture {
  const prompts: string[] = []
  const adapter: LLMAdapter = {
    name: 'mock',
    async chat(messages: LLMMessage[]): Promise<LLMResponse> {
      const prompt = extractUserPrompt(messages)
      prompts.push(prompt)
      const text = typeof reply === 'function' ? reply(prompt) : reply
      return {
        id: `r-${prompts.length}`,
        content: [{ type: 'text', text }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage,
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
  return { adapter, prompts, calls: () => prompts.length }
}

function agent(name: string, adapter: LLMAdapter): AgentConfig {
  return { name, model: 'mock-model', adapter }
}

const ACCEPT = '{"accept": true, "critique": ""}'
const DISSENT = '{"accept": false, "critique": "the answer is wrong"}'

// ---------------------------------------------------------------------------
// runConsensus — budget accounting (the hard merge gate)
// ---------------------------------------------------------------------------

describe('runConsensus token accounting', () => {
  it('accumulates proposer + judge usage into tokenUsage', async () => {
    const proposer = captureAdapter('Paris.', { input_tokens: 10, output_tokens: 10 })
    const judge = captureAdapter(ACCEPT, { input_tokens: 3, output_tokens: 3 })
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })

    const res = await orch.runConsensus(team, 'Capital of France?', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge1', judge.adapter)],
      quorum: 1,
    })

    expect(res.tokenUsage).toEqual({ input_tokens: 13, output_tokens: 13 })
    expect(res.verdict).toBe('accepted')
    expect(res.answer).toBe('Paris.')
  })

  it('rejects (never accepts) when every proposer produces no output', async () => {
    // A proposer that yields nothing must not come back accepted on an empty answer.
    const proposer = captureAdapter('', { input_tokens: 4, output_tokens: 0 })
    const judge = captureAdapter(ACCEPT)
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })

    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge', judge.adapter)],
      quorum: 1,
    })

    expect(res.verdict).toBe('rejected')
    expect(res.answer).toBe('')
    expect(judge.calls()).toBe(0) // nothing to judge → judges never run
    expect(res.tokenUsage).toEqual({ input_tokens: 4, output_tokens: 0 })
  })

  it('stops issuing judge calls once cumulative usage crosses the parent budget', async () => {
    // proposer 20, judge1 +10 = 30 > budget 25 → stop before judge2.
    const proposer = captureAdapter('answer', { input_tokens: 10, output_tokens: 10 })
    const j1 = captureAdapter(ACCEPT, { input_tokens: 5, output_tokens: 5 })
    const j2 = captureAdapter(ACCEPT, { input_tokens: 5, output_tokens: 5 })
    const orch = new OpenMultiAgent({ maxTokenBudget: 25 })
    const team = orch.createTeam('t', { name: 't', agents: [] })

    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge1', j1.adapter), agent('judge2', j2.adapter)],
      quorum: 2, // both needed, so without the budget gate judge2 would run
    })

    expect(proposer.calls()).toBe(1)
    expect(j1.calls()).toBe(1)
    expect(j2.calls()).toBe(0) // budget gate stopped the remaining judge
    expect(res.verdict).toBe('rejected')
  })
})

// ---------------------------------------------------------------------------
// Quorum + rounds
// ---------------------------------------------------------------------------

describe('runConsensus quorum and rounds', () => {
  it('exits early once quorum judges accept, leaving the rest unrun', async () => {
    const proposer = captureAdapter('answer')
    const j1 = captureAdapter(ACCEPT)
    const j2 = captureAdapter(ACCEPT)
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })

    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge1', j1.adapter), agent('judge2', j2.adapter)],
      quorum: 1,
    })

    expect(j1.calls()).toBe(1)
    expect(j2.calls()).toBe(0)
    expect(res.verdict).toBe('accepted')
    expect(res.rounds).toBe(1)
  })

  it('caps the loop at maxRounds (no unbounded revision)', async () => {
    const proposer = captureAdapter('answer')
    const judge = captureAdapter(DISSENT)
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })

    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge', judge.adapter)],
      quorum: 1,
      maxRounds: 2,
      onDissent: 'revise',
    })

    expect(res.rounds).toBe(2)
    expect(judge.calls()).toBe(2) // one judge per round
    expect(proposer.calls()).toBe(2) // initial + one revision
    expect(res.verdict).toBe('rejected')
  })
})

// ---------------------------------------------------------------------------
// Judge prompting (refute vs lens, judgePrompt override)
// ---------------------------------------------------------------------------

describe('runConsensus judge prompting', () => {
  async function runTwoJudges(
    opts: { mode?: 'refute' | 'lens'; judgePrompt?: string | ((j: string) => string) },
  ): Promise<{ p0: string; p1: string }> {
    const proposer = captureAdapter('answer')
    const j0 = captureAdapter(ACCEPT)
    const j1 = captureAdapter(ACCEPT)
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })
    await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge0', j0.adapter), agent('judge1', j1.adapter)],
      quorum: 2, // force both to run
      ...opts,
    })
    return { p0: j0.prompts[0]!, p1: j1.prompts[0]! }
  }

  it('refute gives every judge the same framing; lens gives distinct angles', async () => {
    const refute = await runTwoJudges({ mode: 'refute' })
    expect(refute.p0).toBe(refute.p1)

    const lens = await runTwoJudges({ mode: 'lens' })
    expect(lens.p0).not.toBe(lens.p1)

    // The two modes themselves differ.
    expect(refute.p0).not.toBe(lens.p0)
  })

  it('judgePrompt string overrides the default for all judges', async () => {
    const { p0, p1 } = await runTwoJudges({ judgePrompt: 'CUSTOM SKEPTIC FRAMING' })
    expect(p0).toContain('CUSTOM SKEPTIC FRAMING')
    expect(p0).toBe(p1)
  })

  it('judgePrompt function applies per-judge framing', async () => {
    const { p0, p1 } = await runTwoJudges({ judgePrompt: (j) => `Framing for ${j}` })
    expect(p0).toContain('Framing for judge0')
    expect(p1).toContain('Framing for judge1')
    expect(p0).not.toBe(p1)
  })
})

// ---------------------------------------------------------------------------
// onDissent branches
// ---------------------------------------------------------------------------

describe('runConsensus onDissent', () => {
  async function run(onDissent: 'revise' | 'reject' | 'keep') {
    const proposer = captureAdapter('answer')
    const judge = captureAdapter(DISSENT)
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })
    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge', judge.adapter)],
      quorum: 1,
      maxRounds: 2,
      onDissent,
    })
    return { res, proposerCalls: proposer.calls() }
  }

  it('revise re-runs the proposer for another round', async () => {
    const { res, proposerCalls } = await run('revise')
    expect(proposerCalls).toBe(2)
    expect(res.rounds).toBe(2)
    expect(res.verdict).toBe('rejected')
  })

  it('reject stops after the first round with a rejected verdict', async () => {
    const { res, proposerCalls } = await run('reject')
    expect(proposerCalls).toBe(1)
    expect(res.rounds).toBe(1)
    expect(res.verdict).toBe('rejected')
  })

  it('keep stops but keeps the answer (accepted despite dissent)', async () => {
    const { res, proposerCalls } = await run('keep')
    expect(proposerCalls).toBe(1)
    expect(res.rounds).toBe(1)
    expect(res.verdict).toBe('accepted')
    expect(res.dissent.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// verdictSchema
// ---------------------------------------------------------------------------

describe('runConsensus verdictSchema', () => {
  const schema = z.object({ accept: z.boolean(), confidence: z.number() })

  it('accepts when the judge verdict matches the schema', async () => {
    const proposer = captureAdapter('answer')
    const judge = captureAdapter('{"accept": true, "confidence": 0.9}')
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })
    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge', judge.adapter)],
      quorum: 1,
      verdictSchema: schema,
    })
    expect(res.verdict).toBe('accepted')
  })

  it('treats a schema-invalid verdict as dissent', async () => {
    const proposer = captureAdapter('answer')
    const judge = captureAdapter('{"accept": true}') // missing required confidence
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', { name: 't', agents: [] })
    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge', judge.adapter)],
      quorum: 1,
      maxRounds: 1,
      onDissent: 'reject',
      verdictSchema: schema,
    })
    expect(res.verdict).toBe('rejected')
    expect(res.dissent.join(' ')).toMatch(/schema/i)
  })
})

// ---------------------------------------------------------------------------
// Dissent plumbing: result + shared memory + trace
// ---------------------------------------------------------------------------

describe('runConsensus dissent plumbing', () => {
  it('records dissent in the result, shared memory, and trace', async () => {
    const traces: TraceEvent[] = []
    const proposer = captureAdapter('answer')
    const judge = captureAdapter(DISSENT)
    const orch = new OpenMultiAgent({ onTrace: (e) => traces.push(e) })
    const team = orch.createTeam('t', { name: 't', agents: [], sharedMemory: true })

    const res = await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', proposer.adapter),
      judges: [agent('judge', judge.adapter)],
      quorum: 1,
      maxRounds: 1,
      onDissent: 'reject',
    })

    // result
    expect(res.dissent.join(' ')).toContain('the answer is wrong')

    // shared memory
    const mem = team.getSharedMemoryInstance()!
    const entry = await mem.read('judge/consensus:round:1:dissent')
    expect(entry?.value).toBe('the answer is wrong')

    // trace
    const consensusTraces = traces.filter((t) => t.type === 'consensus')
    expect(consensusTraces.length).toBe(1)
    expect(consensusTraces[0]).toMatchObject({ accepted: false, round: 1, agent: 'judge' })
  })

  it('emits an accepted trace for a judge that accepts (no dissent)', async () => {
    const traces: TraceEvent[] = []
    const orch = new OpenMultiAgent({ onTrace: (e) => traces.push(e) })
    const team = orch.createTeam('t', { name: 't', agents: [], sharedMemory: true })

    await orch.runConsensus(team, 'go', {
      proposer: agent('proposer', captureAdapter('answer').adapter),
      judges: [agent('judge', captureAdapter(ACCEPT).adapter)],
      quorum: 1,
      maxRounds: 1,
    })

    const consensusTraces = traces.filter((t) => t.type === 'consensus')
    expect(consensusTraces.length).toBe(1)
    expect(consensusTraces[0]).toMatchObject({ accepted: true, round: 1, agent: 'judge' })
    expect((consensusTraces[0] as { dissent?: string }).dissent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Per-task verify hook (composes with runTasks)
// ---------------------------------------------------------------------------

describe('per-task verify hook', () => {
  it('runs consensus on a task result only when verify is set', async () => {
    const worker = captureAdapter('task output', { input_tokens: 5, output_tokens: 5 })
    const judge = captureAdapter(ACCEPT, { input_tokens: 5, output_tokens: 5 })
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', {
      name: 't',
      agents: [agent('worker', worker.adapter)],
    })

    // No verify → judge never runs.
    await orch.runTasks(team, [
      { title: 'plain', description: 'do work', assignee: 'worker' },
    ])
    expect(judge.calls()).toBe(0)

    // With verify → judge runs once.
    await orch.runTasks(team, [
      {
        title: 'verified',
        description: 'do work',
        assignee: 'worker',
        verify: { judges: [agent('judge', judge.adapter)], quorum: 1 },
      },
    ])
    expect(judge.calls()).toBe(1)
  })

  it('rolls hook judge usage into the parent budget and trips the same gate', async () => {
    // worker 10 (under budget 15), then judge1 +10 = 20 > 15 → budget_exceeded,
    // judge2 never runs.
    const worker = captureAdapter('task output', { input_tokens: 5, output_tokens: 5 })
    const j1 = captureAdapter(ACCEPT, { input_tokens: 5, output_tokens: 5 })
    const j2 = captureAdapter(ACCEPT, { input_tokens: 5, output_tokens: 5 })

    const budgetEvents: unknown[] = []
    const orch = new OpenMultiAgent({
      maxTokenBudget: 15,
      onProgress: (e) => {
        if (e.type === 'budget_exceeded') budgetEvents.push(e)
      },
    })
    const team = orch.createTeam('t', {
      name: 't',
      agents: [agent('worker', worker.adapter)],
    })

    await orch.runTasks(team, [
      {
        title: 'verified',
        description: 'do work',
        assignee: 'worker',
        verify: { judges: [agent('judge1', j1.adapter), agent('judge2', j2.adapter)], quorum: 2 },
      },
    ])

    expect(j1.calls()).toBe(1)
    expect(j2.calls()).toBe(0) // budget gate stopped the remaining judge
    expect(budgetEvents.length).toBe(1)
  })

  it('does not overwrite the task result when the revision is still rejected', async () => {
    // Worker emits 'original' first, then 'revised' once it sees its prior answer.
    const worker = captureAdapter((p) => (p.includes('previous answer') ? 'revised' : 'original'))
    const judge = captureAdapter(DISSENT) // never accepts → verdict stays rejected
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', {
      name: 't',
      agents: [agent('worker', worker.adapter)],
      sharedMemory: true,
    })

    const run = await orch.runTasks(team, [
      {
        title: 'verified',
        description: 'do work',
        assignee: 'worker',
        verify: { judges: [agent('judge', judge.adapter)], quorum: 1, maxRounds: 2, onDissent: 'revise' },
      },
    ])
    const taskId = run.tasks![0]!.id

    const mem = team.getSharedMemoryInstance()!
    // Rejected revision must not supersede the original task result downstream.
    const result = await mem.read(`worker/task:${taskId}:result`)
    expect(result?.value).toBe('original')
    // The verdict is surfaced as a task-level outcome.
    const verdict = await mem.read(`worker/task:${taskId}:verdict`)
    expect(verdict?.value).toMatch(/^rejected/)
  })

  it('surfaces an accepted revision to the caller, not just downstream', async () => {
    // Judge dissents on the original, accepts once it sees the revision.
    const worker = captureAdapter((p) => (p.includes('previous answer') ? 'revised' : 'original'))
    const judge = captureAdapter((p) => (p.includes('revised') ? ACCEPT : DISSENT))
    const events: { type: string; output: string }[] = []
    const orch = new OpenMultiAgent({
      onProgress: (e) => {
        if (e.type === 'task_complete' || e.type === 'agent_complete') {
          events.push({ type: e.type, output: (e.data as { output: string }).output })
        }
      },
    })
    const team = orch.createTeam('t', {
      name: 't',
      agents: [agent('worker', worker.adapter)],
      sharedMemory: true,
    })

    const run = await orch.runTasks(team, [
      {
        title: 'verified',
        description: 'do work',
        assignee: 'worker',
        verify: { judges: [agent('judge', judge.adapter)], quorum: 1, maxRounds: 2, onDissent: 'revise' },
      },
    ])
    const taskId = run.tasks![0]!.id

    // The accepted revision must reach the returned result, the progress events,
    // and shared memory — not vanish while only downstream tasks see it.
    expect(run.agentResults.get('worker')?.output).toBe('revised')
    expect(events).toEqual([
      { type: 'task_complete', output: 'revised' },
      { type: 'agent_complete', output: 'revised' },
    ])
    const mem = team.getSharedMemoryInstance()!
    expect((await mem.read(`worker/task:${taskId}:result`))?.value).toBe('revised')
    expect((await mem.read(`worker/task:${taskId}:verdict`))?.value).toBe('accepted')
  })

  it('replaces stale structured output when a verified task accepts a revision', async () => {
    const worker = captureAdapter((p) =>
      p.includes('previous answer')
        ? '{"decision":"quarantine"}'
        : '{"decision":"accept"}',
    )
    const judge = captureAdapter((p) =>
      p.includes('quarantine') ? ACCEPT : DISSENT,
    )
    const consumer = captureAdapter('done')
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', {
      name: 't',
      agents: [{
        ...agent('worker', worker.adapter),
        outputSchema: z.object({ decision: z.enum(['accept', 'quarantine']) }),
      }, agent('consumer', consumer.adapter)],
    })

    const run = await orch.runTasks(team, [
      {
        title: 'verified',
        description: 'classify the interval',
        assignee: 'worker',
        verify: {
          judges: [agent('judge', judge.adapter)],
          quorum: 1,
          maxRounds: 2,
          onDissent: 'revise',
        },
      },
      {
        title: 'consume-verdict',
        description: 'use the verified structured decision',
        assignee: 'consumer',
        dependsOn: ['verified'],
        dependencyPayload: 'structured',
      },
    ])
    const taskId = run.tasks![0]!.id

    expect(run.taskResults?.get(taskId)?.output).toBe('{"decision":"quarantine"}')
    expect(run.taskResults?.get(taskId)?.structured).toEqual({ decision: 'quarantine' })
    expect(consumer.prompts[0]).toContain('{"decision":"quarantine"}')
    expect(consumer.prompts[0]).not.toContain('{"decision":"accept"}')
  })

  it('feeds the prior answer into the revision prompt', async () => {
    const worker = captureAdapter((p) => (p.includes('previous answer') ? 'revised' : 'original'))
    const judge = captureAdapter(DISSENT)
    const orch = new OpenMultiAgent()
    const team = orch.createTeam('t', {
      name: 't',
      agents: [agent('worker', worker.adapter)],
    })

    await orch.runTasks(team, [
      {
        title: 'verified',
        description: 'do work',
        assignee: 'worker',
        verify: { judges: [agent('judge', judge.adapter)], quorum: 1, maxRounds: 2, onDissent: 'revise' },
      },
    ])

    // The revision prompt (worker's 2nd call) must echo the answer being revised.
    expect(worker.prompts[1]).toContain('## Your previous answer')
    expect(worker.prompts[1]).toContain('original')
  })
})
