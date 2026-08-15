import { describe, expect, it } from 'vitest'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  RunTeamOptions,
  TaskExecutionRecord,
} from '../src/types.js'

function userPrompt(messages: LLMMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'user')
  return (message?.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function responseAdapter(reply: string, captures: string[] = []): LLMAdapter {
  return {
    name: 'governance-test',
    async chat(messages): Promise<LLMResponse> {
      captures.push(userPrompt(messages))
      return {
        id: `response-${captures.length}`,
        content: [{ type: 'text', text: reply }],
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

function agent(name: string, reply: string, captures?: string[]): AgentConfig {
  return {
    name,
    model: 'mock-model',
    systemPrompt: `You are the ${name}.`,
    adapter: responseAdapter(reply, captures),
  }
}

function normalizeTopology(tasks: readonly TaskExecutionRecord[] | undefined) {
  const records = tasks ?? []
  const assigneeById = new Map(records.map((task) => [task.id, task.assignee]))
  return records.map((task) => ({
    assignee: task.assignee,
    dependsOn: task.dependsOn.map((dependencyId) => assigneeById.get(dependencyId)),
  }))
}

async function runGovernedGoal(goal: string, options: RunTeamOptions) {
  const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
  const team = orchestrator.createTeam('governance-team', {
    name: 'governance-team',
    agents: [
      agent('reviewer', 'reviewer output'),
      agent('security', 'security output'),
    ],
    sharedMemory: true,
  })
  return orchestrator.runTeam(team, goal, options)
}

describe('runTeam declared governance intent', () => {
  const requiredGovernance = {
    governanceIntent: 'required',
    requiredRoles: ['reviewer', 'security'],
    requiredOrder: ['reviewer', 'security'],
  } as const satisfies RunTeamOptions

  it('executes every required role in the declared dependency order', async () => {
    const reviewerPrompts: string[] = []
    const securityPrompts: string[] = []
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = orchestrator.createTeam('governance-team', {
      name: 'governance-team',
      agents: [
        agent('reviewer', 'reviewer output', reviewerPrompts),
        agent('security', 'security output', securityPrompts),
      ],
      sharedMemory: true,
    })
    const goal = 'Review this transfer request.'

    const result = await orchestrator.runTeam(team, goal, requiredGovernance)

    expect(result.success).toBe(true)
    expect(result.agentResults.has('coordinator')).toBe(false)
    expect(result.agentResults.has('reviewer')).toBe(true)
    expect(result.agentResults.has('security')).toBe(true)
    expect(normalizeTopology(result.tasks)).toEqual([
      { assignee: 'reviewer', dependsOn: [] },
      { assignee: 'security', dependsOn: ['reviewer'] },
    ])
    expect(result.tasks?.every((task) => task.description === goal)).toBe(true)
    expect(result.tasks?.every((task) => task.memoryScope === 'dependencies')).toBe(true)
    expect(reviewerPrompts).toHaveLength(1)
    expect(securityPrompts[0]).toContain('## Context from prerequisite tasks')
    expect(securityPrompts[0]).toContain('reviewer output')
  })

  it('builds the same role topology for equivalent English and Chinese goals', async () => {
    const english = await runGovernedGoal(
      'Review the key rotation and verify that it is safe.',
      requiredGovernance,
    )
    const chinese = await runGovernedGoal(
      '审核密钥轮换并确认其安全性。',
      requiredGovernance,
    )

    expect(normalizeTopology(english.tasks)).toEqual(normalizeTopology(chinese.tasks))
    expect(normalizeTopology(chinese.tasks)).toEqual([
      { assignee: 'reviewer', dependsOn: [] },
      { assignee: 'security', dependsOn: ['reviewer'] },
    ])
  })

  it('treats preferred as the same satisfying topology in this release', async () => {
    const result = await runGovernedGoal('Check this request.', {
      ...requiredGovernance,
      governanceIntent: 'preferred',
    })

    expect(normalizeTopology(result.tasks)).toEqual([
      { assignee: 'reviewer', dependsOn: [] },
      { assignee: 'security', dependsOn: ['reviewer'] },
    ])
  })

  it.each(['required', 'preferred'] as const)(
    'returns the pending role DAG without executing agents for %s planOnly',
    async (governanceIntent) => {
      const result = await runGovernedGoal('Check this request.', {
        ...requiredGovernance,
        governanceIntent,
        planOnly: true,
      })

      expect(result).toMatchObject({
        success: true,
        planOnly: true,
        governanceConclusion: 'not-applicable',
      })
      expect(result.agentResults.size).toBe(0)
      expect(result.totalTokenUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
      expect(result.tasks?.every((task) => (
        task.status === 'pending' && task.metrics === undefined
      ))).toBe(true)
      expect(normalizeTopology(result.tasks)).toEqual([
        { assignee: 'reviewer', dependsOn: [] },
        { assignee: 'security', dependsOn: ['reviewer'] },
      ])
    },
  )

  it('replays a governed plan with the same role topology as direct execution', async () => {
    const workerCalls: string[] = []
    const orchestrator = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = orchestrator.createTeam('governance-team', {
      name: 'governance-team',
      agents: [
        agent('reviewer', 'reviewer output', workerCalls),
        agent('security', 'security output', workerCalls),
      ],
      sharedMemory: true,
    })
    const planned = await orchestrator.runTeam(team, 'Check this request.', {
      ...requiredGovernance,
      planOnly: true,
    })
    const replay = await orchestrator.runFromPlan(
      team,
      orchestrator.createPlanArtifact(planned),
    )
    const direct = await runGovernedGoal('Check this request.', requiredGovernance)

    expect(replay.success).toBe(true)
    expect(normalizeTopology(replay.tasks)).toEqual(normalizeTopology(direct.tasks))
    expect(workerCalls).toHaveLength(2)
  })

  it.each([
    ['omitted', {}],
    ['none', { governanceIntent: 'none' as const }],
  ])('preserves coordinator planning when governance intent is %s', async (_label, declaration) => {
    const coordinatorCalls: string[] = []
    const result = await runGovernedGoal('Plan this request.', {
      ...declaration,
      planOnly: true,
      coordinator: {
        adapter: responseAdapter(
          '```json\n[{"title":"Coordinator plan","description":"Plan it","assignee":"reviewer"}]\n```',
          coordinatorCalls,
        ),
      },
    })

    expect(result.planOnly).toBe(true)
    expect(result.tasks?.map((task) => task.title)).toEqual(['Coordinator plan'])
    expect(result.agentResults.has('coordinator')).toBe(true)
    expect(coordinatorCalls).toHaveLength(1)
  })

  it('leaves declared roles unordered when requiredOrder is omitted', async () => {
    const result = await runGovernedGoal('Check this request.', {
      governanceIntent: 'required',
      requiredRoles: ['reviewer', 'security'],
    })

    expect(normalizeTopology(result.tasks)).toEqual([
      { assignee: 'reviewer', dependsOn: [] },
      { assignee: 'security', dependsOn: [] },
    ])
  })

  it('preserves the existing simple-goal route for none and an omitted intent', async () => {
    const withoutIntent = await runGovernedGoal('Say hello.', {
      requiredRoles: ['reviewer', 'security'],
      requiredOrder: ['reviewer', 'security'],
    })
    const withNone = await runGovernedGoal('Say hello.', { governanceIntent: 'none' })

    expect(normalizeTopology(withNone.tasks)).toEqual(normalizeTopology(withoutIntent.tasks))
    expect(withNone.tasks?.map((task) => task.id)).toEqual(['short-circuit'])
    expect(withNone.agentResults.has('coordinator')).toBe(false)
    expect(withoutIntent.tasks?.map((task) => task.id)).toEqual(['short-circuit'])
    expect(withoutIntent.agentResults.has('coordinator')).toBe(false)
  })

  it('rejects required roles that are absent from the team roster', async () => {
    await expect(runGovernedGoal('Review this request.', {
      governanceIntent: 'required',
      requiredRoles: ['reviewer', 'auditor'],
      planOnly: true,
    })).rejects.toThrow(
      'runTeam requiredRoles must exist in the team roster; unknown role(s): auditor.',
    )
  })

  it('rejects requiredOrder entries that are not declared in requiredRoles', async () => {
    await expect(runGovernedGoal('Review this request.', {
      governanceIntent: 'required',
      requiredRoles: ['reviewer'],
      requiredOrder: ['security'],
    })).rejects.toThrow(
      'runTeam requiredOrder may reference only requiredRoles; invalid role(s): security.',
    )
  })
})
