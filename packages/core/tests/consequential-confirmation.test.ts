import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  buildExecutionReceipt,
  defineTool,
  OpenMultiAgent,
} from '../src/index.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMResponse,
  OrchestratorConfig,
} from '../src/index.js'

function toolUse(name: string): LLMResponse {
  return {
    id: `tool-${name}`,
    content: [{ type: 'tool_use', id: `call-${name}`, name, input: {} }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function text(output = 'done'): LLMResponse {
  return {
    id: `text-${output}`,
    content: [{ type: 'text', text: output }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(...responses: LLMResponse[]): LLMAdapter {
  let index = 0
  return {
    name: 'consequential-confirmation-test',
    async chat(): Promise<LLMResponse> {
      return responses[Math.min(index++, responses.length - 1)]!
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function mockTool(name: string, consequential: boolean) {
  const execute = vi.fn(async () => ({ data: `${name}-executed`, isError: false }))
  const tool = defineTool({
    name,
    description: `${name} test tool`,
    inputSchema: z.object({}),
    consequential,
    execute,
  })
  return { tool, execute }
}

function agent(tool?: ReturnType<typeof mockTool>['tool']): AgentConfig {
  return {
    name: 'operator',
    model: 'mock-model',
    adapter: tool
      ? scriptedAdapter(toolUse(tool.name), text())
      : scriptedAdapter(text('unchanged benign output')),
    ...(tool ? { customTools: [tool] } : {}),
  }
}

async function runAutomaticTeam(
  config: OrchestratorConfig,
  agentConfig: AgentConfig,
  goal = 'Rotate the password security secret.',
) {
  const orchestrator = new OpenMultiAgent({
    defaultModel: 'mock-model',
    executionRouting: { strategy: 'deterministic' },
    ...config,
  })
  const team = orchestrator.createTeam('consequential-test-team', {
    name: 'consequential-test-team',
    agents: [agentConfig],
  })
  return orchestrator.runTeam(team, goal)
}

describe('undeclared consequential run fallback', () => {
  it('flags Probe-A and keeps confirmation off by default', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)

    const result = await runAutomaticTeam({}, agent(tool))

    expect(result.success).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.flags).toEqual(['consequential-no-independence'])
    expect(result.confirmationRequired).toBeUndefined()
    expect(buildExecutionReceipt(result).flags)
      .toEqual(['consequential-no-independence'])
  })

  it('returns confirmationRequired and does not execute Probe-A when confirmation is enabled', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)

    const result = await runAutomaticTeam(
      { requireConsequentialConfirmation: true },
      agent(tool),
    )

    expect(execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('rejected')
    expect(result.confirmationRequired).toBe(true)
    expect(result.flags).toEqual(['consequential-no-independence'])
  })

  it('keeps undeclared consequential confirmation independent from execution routing', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)

    const result = await runAutomaticTeam({
      requireConsequentialConfirmation: true,
      executionRouter: {
        version: 'single-test-v1',
        decide: () => ({
          mode: 'single',
          reasons: ['Test the undeclared confirmation boundary.'],
          routerVersion: 'single-test-v1',
        }),
      },
    }, agent(tool))

    expect(result.routingDecision?.routerVersion).toBe('single-test-v1')
    expect(execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.confirmationRequired).toBe(true)
    expect(result.flags).toEqual(['consequential-no-independence'])
  })

  it('uses the existing onToolCall gate to approve a consequential action', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const onToolCall = vi.fn(async () => ({ action: 'allow' as const }))

    const result = await runAutomaticTeam(
      { requireConsequentialConfirmation: true, onToolCall },
      agent(tool),
    )

    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'rotate_secret',
      consequential: true,
    }))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.confirmationRequired).toBeUndefined()
    expect(result.flags).toEqual(['consequential-no-independence'])
  })

  it('does not flag Probe-B when risky words appear but the granted tool is benign', async () => {
    const { tool, execute } = mockTool('inspect_password_security', false)

    const result = await runAutomaticTeam(
      { requireConsequentialConfirmation: true },
      agent(tool),
      'Inspect password rotation security in production.',
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.flags).toBeUndefined()
    expect(result.confirmationRequired).toBeUndefined()
    expect(buildExecutionReceipt(result).flags).toBeUndefined()
  })

  it('checks the final grant set and ignores a disallowed consequential tool', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const config = agent(tool)

    const result = await runAutomaticTeam(
      { requireConsequentialConfirmation: true },
      { ...config, disallowedTools: ['rotate_secret'] },
    )

    expect(execute).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.flags).toBeUndefined()
    expect(result.confirmationRequired).toBeUndefined()
  })

  it('leaves a pure benign run unchanged', async () => {
    const result = await new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
    }).runAgent(agent(), 'Summarize this paragraph.')

    expect(result.success).toBe(true)
    expect(result.output).toBe('unchanged benign output')
    expect(result.flags).toBeUndefined()
    expect(result.confirmationRequired).toBeUndefined()
  })

  it('leaves required governance to I3 even when a consequential tool executes', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
    })
    const team = orchestrator.createTeam('required-governance-team', {
      name: 'required-governance-team',
      agents: [agent(tool)],
    })

    const result = await orchestrator.runTeam(team, 'Rotate the secret.', {
      governanceIntent: 'required',
      requiredRoles: ['operator'],
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.governanceConclusion).toBe('satisfied')
    expect(result.flags).toBeUndefined()
    expect(result.confirmationRequired).toBeUndefined()
  })

  it('treats governanceIntent none as an explicit declaration, not an omission', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
    })
    const team = orchestrator.createTeam('declared-none-team', {
      name: 'declared-none-team',
      agents: [agent(tool)],
    })

    const result = await orchestrator.runTeam(team, 'Rotate the secret.', {
      governanceIntent: 'none',
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.flags).toBeUndefined()
    expect(result.confirmationRequired).toBeUndefined()
  })

  it("keeps consequential confirmation enabled for mode 'single'", async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
    })
    const team = orchestrator.createTeam('explicit-single-mode-team', {
      name: 'explicit-single-mode-team',
      agents: [agent(tool)],
    })

    const result = await orchestrator.runTeam(team, 'Rotate the secret.', {
      mode: 'single',
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.confirmationRequired).toBe(true)
    expect(result.flags).toEqual(['consequential-no-independence'])
  })

  it("keeps consequential confirmation enabled for mode 'team'", async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
    })
    const team = orchestrator.createTeam('explicit-team-mode-team', {
      name: 'explicit-team-mode-team',
      agents: [agent(tool)],
    })
    const plan = '```json\n[{"title":"Rotate","description":"Rotate it","assignee":"operator"}]\n```'

    const result = await orchestrator.runTeam(team, 'Rotate the secret.', {
      mode: 'team',
      coordinator: {
        adapter: scriptedAdapter(text(plan), text('synthesized')),
      },
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.confirmationRequired).toBe(true)
    expect(result.flags).toEqual(['consequential-no-independence'])
  })

  it('reuses an approved runTeam plan gate when no per-call gate is configured', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const onPlanReady = vi.fn(async () => true)
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
      onPlanReady,
    })
    const team = orchestrator.createTeam('plan-approved-team', {
      name: 'plan-approved-team',
      agents: [agent(tool)],
    })
    const plan = '```json\n[{"title":"Rotate","description":"Rotate it","assignee":"operator"}]\n```'

    const result = await orchestrator.runTeam(
      team,
      'First prepare the rotation plan, then perform the rotation.',
      { coordinator: { adapter: scriptedAdapter(text(plan), text('synthesized')) } },
    )

    expect(onPlanReady).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.flags).toEqual(['consequential-no-independence'])
    expect(result.confirmationRequired).toBeUndefined()
  })

  it('does not apply the fallback to an explicit runTasks DAG', async () => {
    const { tool, execute } = mockTool('rotate_secret', true)
    const orchestrator = new OpenMultiAgent({
      defaultModel: 'mock-model',
      requireConsequentialConfirmation: true,
    })
    const team = orchestrator.createTeam('explicit-dag-team', {
      name: 'explicit-dag-team',
      agents: [agent(tool)],
    })

    const result = await orchestrator.runTasks(team, [{
      title: 'Rotate',
      description: 'Rotate the secret.',
      assignee: 'operator',
    }])

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.flags).toBeUndefined()
    expect(result.confirmationRequired).toBeUndefined()
  })
})
