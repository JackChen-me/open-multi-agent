import { describe, expect, it } from 'vitest'
import {
  buildExecutionReceipt,
  GOVERNANCE_OVERRIDDEN_FLAG,
  OpenMultiAgent,
  REVIEW_SKIPPED_DUE_TO_BUDGET_FLAG,
} from '../src/index.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMResponse,
  RunTeamOptions,
} from '../src/index.js'

interface ScriptedReply {
  readonly output: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

function scriptedAdapter(
  replies: readonly ScriptedReply[],
  calls: string[] = [],
): LLMAdapter {
  let index = 0
  return {
    name: 'mode-governance-test',
    async chat(): Promise<LLMResponse> {
      const reply = replies[index] ?? replies.at(-1)
      if (!reply) throw new Error('No scripted reply configured.')
      index++
      calls.push(reply.output)
      return {
        id: `response-${index}`,
        content: [{ type: 'text', text: reply.output }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: reply.inputTokens ?? 1,
          output_tokens: reply.outputTokens ?? 1,
        },
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function agent(name: string, output: string): AgentConfig {
  return {
    name,
    model: 'mock-model',
    systemPrompt: `You are the ${name}.`,
    adapter: scriptedAdapter([{ output }]),
  }
}

function createGovernanceTeam(orchestrator: OpenMultiAgent) {
  return orchestrator.createTeam('mode-governance-team', {
    name: 'mode-governance-team',
    agents: [
      agent('reviewer', 'reviewer output'),
      agent('security', 'security output'),
    ],
    sharedMemory: true,
  })
}

const requiredGovernance = {
  governanceIntent: 'required',
  requiredRoles: ['reviewer', 'security'],
  requiredOrder: ['reviewer', 'security'],
} as const satisfies RunTeamOptions

describe('runTeam explicit mode and budget/governance resolution', () => {
  it('forces the coordinator-generated DAG over the automatic simple-goal route', async () => {
    const coordinatorCalls: string[] = []
    const coordinator = scriptedAdapter([
      {
        output: '```json\n['
          + '{"title":"Review","description":"Review the request.","assignee":"reviewer"},'
          + '{"title":"Security","description":"Check the review.","assignee":"security","dependsOn":["Review"]}'
          + ']\n```',
      },
      { output: 'coordinator synthesis' },
    ], coordinatorCalls)
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(team, 'Say hello.', {
      mode: 'team',
      coordinator: { model: 'mock-model', adapter: coordinator },
    })
    const receipt = buildExecutionReceipt(result)

    expect(result.success).toBe(true)
    expect(result.tasks?.some((task) => task.id === 'short-circuit')).toBe(false)
    expect(result.agentResults.get('coordinator')?.output).toContain('coordinator synthesis')
    expect(coordinatorCalls).toHaveLength(2)
    expect(result.routingDecision).toMatchObject({ source: 'override', mode: 'team' })
    expect(result.routingDecision?.routerVersion).toBeUndefined()
    expect(receipt).toMatchObject({
      mode: 'multi-agent',
      rolesExecuted: ['reviewer', 'security'],
      dependencyEdges: [{ from: 'reviewer', to: 'security' }],
    })
  })

  it("keeps mode 'single' incompatible with planOnly", async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    await expect(orchestrator.runTeam(team, 'Plan this request.', {
      mode: 'single',
      planOnly: true,
    })).rejects.toThrow("runTeam mode 'single' cannot be combined with planOnly.")
  })

  it("keeps mode 'team' on the coordinator plan when governance is also declared", async () => {
    const coordinatorCalls: string[] = []
    const coordinator = scriptedAdapter([{
      output: '```json\n[{"title":"Coordinator plan","description":"Plan it","assignee":"reviewer"}]\n```',
    }], coordinatorCalls)
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(team, 'Plan this request.', {
      ...requiredGovernance,
      mode: 'team',
      planOnly: true,
      coordinator: { model: 'mock-model', adapter: coordinator },
    })

    expect(result.tasks?.map((task) => task.title)).toEqual(['Coordinator plan'])
    expect(result.agentResults.has('coordinator')).toBe(true)
    expect(result.agentResults.has('reviewer')).toBe(false)
    expect(coordinatorCalls).toHaveLength(1)
    expect(result.routingDecision).toMatchObject({ source: 'override', mode: 'team' })
  })

  it('executes a forced Single but discloses an overridden required floor', async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(
      team,
      'First review the request, then assess its security.',
      { ...requiredGovernance, mode: 'single' },
    )

    expect(result.success).toBe(true)
    expect(result.tasks?.map((task) => task.id)).toEqual(['short-circuit'])
    expect(buildExecutionReceipt(result).mode).toBe('single')
    expect(result.governanceConclusion).toBe('unsatisfied')
    expect(result.governanceReason).toBe('overridden')
    expect(result.flags).toContain(GOVERNANCE_OVERRIDDEN_FLAG)
    expect(result.routingDecision).toMatchObject({ source: 'override', mode: 'single' })
  })

  it('marks required governance unsatisfied with a budget reason when roles cannot finish', async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(team, 'Review this request.', {
      ...requiredGovernance,
      maxTokenBudget: 1,
    })

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('budget_exhausted')
    expect(result.governanceConclusion).toBe('unsatisfied')
    expect(result.governanceReason).toBe('budget')
    expect(buildExecutionReceipt(result).rolesExecuted).toEqual(['reviewer'])
    expect(result.tasks?.map((task) => task.status)).toEqual(['completed', 'skipped'])
  })

  it('degrades preferred governance to Single under a declared ceiling and discloses it', async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(
      team,
      'First review the request, then assess its security.',
      {
        ...requiredGovernance,
        governanceIntent: 'preferred',
        preferredUnderBudget: 'degrade',
        maxTokenBudget: 3,
      },
    )

    expect(result.success).toBe(true)
    expect(result.tasks?.map((task) => task.id)).toEqual(['short-circuit'])
    expect(buildExecutionReceipt(result)).toMatchObject({
      mode: 'single',
      flags: [REVIEW_SKIPPED_DUE_TO_BUDGET_FLAG],
    })
    expect(result.governanceConclusion).toBe('not-applicable')
    expect(result.governanceReason).toBeUndefined()
    expect(result.flags).toContain(REVIEW_SKIPPED_DUE_TO_BUDGET_FLAG)
    expect(result.routingDecision).toMatchObject({ source: 'policy', mode: 'single' })
    expect(result.routingDecision?.routerVersion).toBeUndefined()
  })

  it('preserves the required topology when no override occurs and budget is sufficient', async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(team, 'Review this request.', {
      ...requiredGovernance,
      maxTokenBudget: 10,
    })

    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('satisfied')
    expect(result.governanceReason).toBeUndefined()
    expect(result.flags).toBeUndefined()
    expect(buildExecutionReceipt(result)).toMatchObject({
      mode: 'multi-agent',
      rolesExecuted: ['reviewer', 'security'],
      dependencyEdges: [{ from: 'reviewer', to: 'security' }],
    })
    expect(result.routingDecision).toMatchObject({ source: 'declared', mode: 'team' })
  })

  it('keeps the existing preferred-role attempt when no degrade policy is selected', async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(team, 'Review this request.', {
      ...requiredGovernance,
      governanceIntent: 'preferred',
      maxTokenBudget: 10,
    })

    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('not-applicable')
    expect(result.flags).toBeUndefined()
    expect(buildExecutionReceipt(result).rolesExecuted).toEqual(['reviewer', 'security'])
    expect(result.routingDecision).toMatchObject({ source: 'declared', mode: 'team' })
  })

  it('applies a per-run cost ceiling through the existing estimator', async () => {
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      estimateCost: (usage) => usage.input_tokens + usage.output_tokens,
    })
    const team = createGovernanceTeam(orchestrator)

    const result = await orchestrator.runTeam(team, 'Review this request.', {
      ...requiredGovernance,
      maxCostBudget: 1,
    })

    expect(result.status?.code).toBe('budget_exhausted')
    expect(result.governanceConclusion).toBe('unsatisfied')
    expect(result.governanceReason).toBe('budget')
  })

  it('rejects a per-run cost ceiling when no estimator is configured', async () => {
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = createGovernanceTeam(orchestrator)

    await expect(orchestrator.runTeam(team, 'Review this request.', {
      ...requiredGovernance,
      maxCostBudget: 1,
    })).rejects.toThrow(/maxCostBudget requires estimateCost/)
  })
})
