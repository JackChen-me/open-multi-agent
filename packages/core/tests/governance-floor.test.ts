import { describe, expect, it } from 'vitest'
import {
  buildExecutionReceipt,
  evaluateGovernance,
  OpenMultiAgent,
} from '../src/index.js'
import type {
  AgentConfig,
  AgentRunResult,
  AgentTrace,
  ExecutionReceipt,
  GovernanceDeclaration,
  LLMAdapter,
  LLMResponse,
  RunTeamOptions,
  TaskExecutionRecord,
} from '../src/index.js'

const requiredChain = {
  governanceIntent: 'required',
  requiredRoles: ['reviewer', 'security'],
  requiredOrder: ['reviewer', 'security'],
} as const satisfies GovernanceDeclaration

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    mode: 'single',
    rolesExecuted: [],
    executionOrder: [],
    dependencyEdges: [],
    independentRolesCount: 0,
    independentReviewOccurred: false,
    totalTokens: { input: 0, output: 0 },
    durationMs: 0,
    partial: false,
    ...overrides,
  }
}

function textAdapter(output: string): LLMAdapter {
  return {
    name: 'governance-floor-test',
    async chat(): Promise<LLMResponse> {
      return {
        id: `response-${output}`,
        content: [{ type: 'text', text: output }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function errorAdapter(message: string): LLMAdapter {
  return {
    name: 'governance-floor-error-test',
    async chat(): Promise<LLMResponse> {
      throw new Error(message)
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function agent(name: string, adapter: LLMAdapter): AgentConfig {
  return {
    name,
    model: 'mock-model',
    systemPrompt: `You are the ${name}.`,
    adapter,
  }
}

async function runTeam(
  options?: RunTeamOptions,
  reviewerAdapter: LLMAdapter = textAdapter('reviewer output'),
  securityAdapter: LLMAdapter = textAdapter('security output'),
) {
  const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
  const team = orchestrator.createTeam('governance-floor-team', {
    name: 'governance-floor-team',
    agents: [
      agent('reviewer', reviewerAdapter),
      agent('security', securityAdapter),
    ],
    sharedMemory: true,
  })
  return orchestrator.runTeam(team, 'Say hello.', options)
}

function topology(tasks: readonly TaskExecutionRecord[] | undefined) {
  const records = tasks ?? []
  const assigneeById = new Map(records.map((task) => [task.id, task.assignee]))
  return records.map((task) => ({
    assignee: task.assignee,
    status: task.status,
    dependsOn: task.dependsOn.map((dependency) => assigneeById.get(dependency)),
    executed: task.metrics !== undefined,
  }))
}

describe('evaluateGovernance', () => {
  it('is satisfied when all required roles execute in the declared review chain', () => {
    expect(evaluateGovernance(requiredChain, receipt({
      mode: 'multi-agent',
      rolesExecuted: ['reviewer', 'security'],
      executionOrder: ['reviewer', 'security'],
      dependencyEdges: [{ from: 'reviewer', to: 'security' }],
      independentRolesCount: 2,
      independentReviewOccurred: true,
    }))).toBe('satisfied')
  })

  it('is unsatisfied when one required role did not execute', () => {
    const declaration = {
      governanceIntent: 'required',
      requiredRoles: ['reviewer', 'security', 'operator'],
      requiredOrder: ['reviewer', 'security', 'operator'],
    } as const satisfies GovernanceDeclaration

    expect(evaluateGovernance(declaration, receipt({
      mode: 'multi-agent',
      rolesExecuted: ['reviewer', 'security'],
      executionOrder: ['reviewer', 'security'],
      dependencyEdges: [{ from: 'reviewer', to: 'security' }],
      independentRolesCount: 2,
      independentReviewOccurred: true,
    }))).toBe('unsatisfied')
  })

  it.each([
    {
      name: 'parallel roles with no dependency edge',
      executionOrder: ['reviewer', 'security'],
      dependencyEdges: [],
    },
    {
      name: 'roles executing in the opposite dependency order',
      executionOrder: ['security', 'reviewer'],
      dependencyEdges: [{ from: 'security', to: 'reviewer' }],
    },
    {
      name: 'the declared start order with a reversed dependency edge',
      executionOrder: ['reviewer', 'security'],
      dependencyEdges: [{ from: 'security', to: 'reviewer' }],
    },
  ])('is unsatisfied for $name', ({ executionOrder, dependencyEdges }) => {
    expect(evaluateGovernance(requiredChain, receipt({
      mode: 'multi-agent',
      rolesExecuted: ['reviewer', 'security'],
      executionOrder,
      dependencyEdges,
      independentRolesCount: 2,
      independentReviewOccurred: dependencyEdges.length > 0,
    }))).toBe('unsatisfied')
  })

  it('accepts a dependency path between adjacent required roles', () => {
    expect(evaluateGovernance(requiredChain, receipt({
      mode: 'multi-agent',
      rolesExecuted: ['reviewer', 'analyst', 'security'],
      executionOrder: ['reviewer', 'analyst', 'security'],
      dependencyEdges: [
        { from: 'reviewer', to: 'analyst' },
        { from: 'analyst', to: 'security' },
      ],
      independentRolesCount: 3,
      independentReviewOccurred: true,
    }))).toBe('satisfied')
  })

  it('is unsatisfied when two roles are required but only one agent executed', () => {
    expect(evaluateGovernance(requiredChain, receipt({
      rolesExecuted: ['reviewer'],
      executionOrder: ['reviewer'],
      independentRolesCount: 1,
      independentReviewOccurred: false,
    }))).toBe('unsatisfied')
  })

  it('ignores review markers in answer text and judges only the I1 receipt', () => {
    const answer: AgentRunResult = {
      success: true,
      output: 'reviewer approved; security approved; INDEPENDENT_REVIEW_COMPLETE',
      messages: [],
      tokenUsage: { input_tokens: 1, output_tokens: 1 },
      toolCalls: [],
    }
    const trace: AgentTrace = {
      type: 'agent',
      runId: 'run-1',
      spanId: 'span-1',
      agent: 'reviewer',
      startMs: 0,
      endMs: 1,
      durationMs: 1,
      turns: 1,
      tokens: { input_tokens: 1, output_tokens: 1 },
      toolCalls: 0,
    }

    expect(evaluateGovernance(requiredChain, buildExecutionReceipt(answer, [trace])))
      .toBe('unsatisfied')
  })

  it.each([
    { name: 'omitted intent', declaration: {} },
    {
      name: 'none intent',
      declaration: { governanceIntent: 'none', requiredRoles: ['reviewer', 'security'] },
    },
    {
      name: 'preferred intent',
      declaration: { governanceIntent: 'preferred', requiredRoles: ['reviewer', 'security'] },
    },
  ] as const)('is not applicable for $name', ({ declaration }) => {
    expect(evaluateGovernance(declaration, receipt())).toBe('not-applicable')
  })
})

describe('runTeam governance floor', () => {
  it('returns satisfied for a required run with the declared executed topology', async () => {
    const result = await runTeam(requiredChain)
    const execution = buildExecutionReceipt(result)

    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('satisfied')
    expect(result.tasks?.some((task) => task.id === 'short-circuit')).toBe(false)
    expect(topology(result.tasks)).toEqual([
      { assignee: 'reviewer', status: 'completed', dependsOn: [], executed: true },
      { assignee: 'security', status: 'completed', dependsOn: ['reviewer'], executed: true },
    ])
    expect(execution).toMatchObject({
      rolesExecuted: ['reviewer', 'security'],
      executionOrder: ['reviewer', 'security'],
      dependencyEdges: [{ from: 'reviewer', to: 'security' }],
      independentReviewOccurred: true,
    })
  })

  it('returns unsatisfied when an upstream required task fails and a downstream role never runs', async () => {
    const result = await runTeam(
      requiredChain,
      errorAdapter('reviewer failed'),
      textAdapter('security output'),
    )
    const execution = buildExecutionReceipt(result)

    expect(result.success).toBe(false)
    expect(result.governanceConclusion).toBe('unsatisfied')
    expect(topology(result.tasks)).toEqual([
      { assignee: 'reviewer', status: 'failed', dependsOn: [], executed: true },
      { assignee: 'security', status: 'failed', dependsOn: ['reviewer'], executed: false },
    ])
    expect(execution.executionOrder).not.toEqual(['reviewer', 'security'])
  })

  it('keeps runtime success separate from an unsatisfied governance conclusion', async () => {
    const result = await runTeam({
      governanceIntent: 'required',
      requiredRoles: ['reviewer', 'security'],
    })
    const execution = buildExecutionReceipt(result)

    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('unsatisfied')
    expect(execution.dependencyEdges).toEqual([])
    expect(execution.independentReviewOccurred).toBe(false)
  })

  it('returns not-applicable and preserves the existing simple-goal route when undeclared', async () => {
    const result = await runTeam()

    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('not-applicable')
    expect(result.tasks?.map((task) => task.id)).toEqual(['short-circuit'])
  })

  it('does not enforce the floor for preferred governance', async () => {
    const result = await runTeam({
      ...requiredChain,
      governanceIntent: 'preferred',
    })

    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('not-applicable')
  })
})
