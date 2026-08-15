/**
 * Regression guard: coordinator-generated tasks can opt into the verify hook
 * when `RunTeamOptions.verifyJudges` is provided.
 *
 * Tests cover:
 *   - `verify: true` in coordinator JSON → full ConsensusVerifyOptions with judges
 *   - `verify: { mode, quorum }` partial object → merged with verifyJudges
 *   - No `verify` field → task gets no verify config
 *   - `verify: true` in coordinator JSON without verifyJudges → ignored (no verify)
 *   - Coordinator prompt includes verify field docs only when verifyJudges present
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type { AgentConfig, LLMChatOptions, LLMMessage, LLMResponse, TeamConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

let mockAdapterResponses: string[] = []

vi.mock('../src/llm/adapter.js', () => ({
  createAdapter: async () => {
    let callIndex = 0
    return {
      name: 'mock',
      async chat(_msgs: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
        const text = mockAdapterResponses[callIndex] ?? 'default mock response'
        callIndex++
        return {
          id: `resp-${callIndex}`,
          content: [{ type: 'text', text }],
          model: options.model ?? 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }
      },
      async *stream() {
        yield { type: 'done' as const, data: {} }
      },
    }
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(name: string): AgentConfig {
  return { name, model: 'mock-model', provider: 'openai', systemPrompt: `You are ${name}.` }
}

function teamCfg(agents: AgentConfig[]): TeamConfig {
  return { name: 'test-team', agents }
}

function coordinatorPlan(tasks: object[]): string {
  return '```json\n' + JSON.stringify(tasks) + '\n```'
}

// Goal complex enough to bypass the simple-goal short-circuit; planOnly avoids
// running actual workers so we can inspect the decomposed task graph.
const GOAL = 'Design and implement a complete secure multi-tier software system architecture'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTeam verify hook integration', () => {
  beforeEach(() => {
    mockAdapterResponses = []
  })

  it('applies verify with judges when coordinator emits verify: true and verifyJudges provided', async () => {
    const worker = agent('worker')
    const judge = agent('judge')

    mockAdapterResponses = [
      coordinatorPlan([{ title: 'Task A', description: 'Do A', assignee: 'worker', dependsOn: [], verify: true }]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([worker]))

    const result = await oma.runTeam(team, GOAL, {
      planOnly: true,
      verifyJudges: [judge],
    })

    expect(result.success).toBe(true)
    expect(result.tasks).toBeDefined()
    const taskA = result.tasks!.find((t) => t.title === 'Task A')
    expect(taskA).toBeDefined()
    expect(taskA!.verify).toBeDefined()
    expect(taskA!.verify!.judges).toHaveLength(1)
    expect(taskA!.verify!.judges[0]!.name).toBe('judge')
  })

  it('merges coordinator partial verify spec with verifyJudges', async () => {
    const worker = agent('worker')
    const judge = agent('judge')

    mockAdapterResponses = [
      coordinatorPlan([{
        title: 'Task B',
        description: 'Do B',
        assignee: 'worker',
        dependsOn: [],
        verify: { mode: 'lens', quorum: 1, maxRounds: 3, onDissent: 'reject' },
      }]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([worker]))

    const result = await oma.runTeam(team, GOAL, {
      planOnly: true,
      verifyJudges: [judge],
    })

    expect(result.success).toBe(true)
    const taskB = result.tasks!.find((t) => t.title === 'Task B')
    expect(taskB).toBeDefined()
    expect(taskB!.verify).toBeDefined()
    expect(taskB!.verify!.judges).toHaveLength(1)
    expect(taskB!.verify!.mode).toBe('lens')
    expect(taskB!.verify!.quorum).toBe(1)
    expect(taskB!.verify!.maxRounds).toBe(3)
    expect(taskB!.verify!.onDissent).toBe('reject')
  })

  it('does not apply verify when coordinator emits verify: true but verifyJudges absent', async () => {
    const worker = agent('worker')

    mockAdapterResponses = [
      coordinatorPlan([{ title: 'Task C', description: 'Do C', assignee: 'worker', dependsOn: [], verify: true }]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([worker]))

    const result = await oma.runTeam(team, GOAL, { planOnly: true })

    expect(result.success).toBe(true)
    const taskC = result.tasks!.find((t) => t.title === 'Task C')
    expect(taskC).toBeDefined()
    expect(taskC!.verify).toBeUndefined()
  })

  it('does not apply verify to tasks without verify field', async () => {
    const worker = agent('worker')
    const judge = agent('judge')

    mockAdapterResponses = [
      coordinatorPlan([{ title: 'Task D', description: 'Do D', assignee: 'worker', dependsOn: [] }]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([worker]))

    const result = await oma.runTeam(team, GOAL, {
      planOnly: true,
      verifyJudges: [judge],
    })

    expect(result.success).toBe(true)
    const taskD = result.tasks!.find((t) => t.title === 'Task D')
    expect(taskD).toBeDefined()
    expect(taskD!.verify).toBeUndefined()
  })

  it('rejects an invalid coordinator verify field instead of silently dropping it', async () => {
    const worker = agent('worker')
    const judge = agent('judge')

    mockAdapterResponses = [
      coordinatorPlan([
        { title: 'Task E1', description: 'Do E1', assignee: 'worker', dependsOn: [], verify: null },
        { title: 'Task E2', description: 'Do E2', assignee: 'worker', dependsOn: [], verify: 42 },
        { title: 'Task E3', description: 'Do E3', assignee: 'worker', dependsOn: [], verify: 'yes' },
      ]),
      coordinatorPlan([
        { title: 'Task E1', description: 'Do E1', assignee: 'worker', dependsOn: [], verify: null },
        { title: 'Task E2', description: 'Do E2', assignee: 'worker', dependsOn: [], verify: 42 },
        { title: 'Task E3', description: 'Do E3', assignee: 'worker', dependsOn: [], verify: 'yes' },
      ]),
    ]

    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('t', teamCfg([worker]))

    const result = await oma.runTeam(team, GOAL, {
      planOnly: true,
      verifyJudges: [judge],
    })

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({ kind: 'validation', code: 'COORDINATOR_PLAN_INVALID' })
    expect(result.tasks).toEqual([])
  })
})
