/**
 * Security regression tests for default-deny built-in tools.
 *
 * Built-in tools (bash, the filesystem tools, delegate_to_agent) are opt-in: an
 * agent that grants no tools (`tools` / `toolPreset` both unset) resolves to
 * zero built-in tools, and even a model that emits a tool_use for an ungranted
 * tool — whether confused or steered by prompt injection — is blocked at the
 * runner with a clear "not granted" signal instead of silently executing it.
 *
 * These tests assert the security property end-to-end across the standalone
 * `Agent` path and the orchestrator `runTeam` short-circuit / `runTasks` paths,
 * plus the `defaultToolPreset` escape hatch that restores the prior convenience.
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolUse(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `resp-${name}`,
    content: [{ type: 'tool_use', id: `tu-${name}`, name, input }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 5 },
  }
}

function text(t: string): LLMResponse {
  return {
    id: `resp-text`,
    content: [{ type: 'text', text: t }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  }
}

/**
 * A scripted adapter that replays `steps` one per turn (repeating the last step
 * once exhausted) and records the tool names offered to the model on each call.
 */
function scriptedAdapter(steps: LLMResponse[]): {
  adapter: LLMAdapter
  offered: () => Array<readonly string[] | undefined>
} {
  let i = 0
  const offered: Array<readonly string[] | undefined> = []
  const adapter: LLMAdapter = {
    name: 'mock',
    async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      offered.push(options.tools?.map((t) => t.name))
      return steps[Math.min(i++, steps.length - 1)]!
    },
    async *stream() {
      /* unused */
    },
  }
  return { adapter, offered: () => offered }
}

/** A bash-named tool whose execute flips a flag so we can prove non-execution. */
function spyBash(): { tool: ReturnType<typeof defineTool>; ran: () => boolean } {
  let didRun = false
  const tool = defineTool({
    name: 'bash',
    description: 'Run a shell command.',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {
      didRun = true
      return { data: 'SPY_BASH_OUTPUT', isError: false }
    },
  })
  return { tool, ran: () => didRun }
}

// A short goal with no multi-step / coordination signals → hits the runTeam
// short-circuit (single agent, no coordinator).
const SIMPLE_GOAL = 'Briefly explain what a hash map is.'

// ---------------------------------------------------------------------------
// Standalone Agent path
// ---------------------------------------------------------------------------

describe('default-deny: standalone Agent', () => {
  it('an agent with no tools cannot execute a registered bash tool', async () => {
    const { tool: bash, ran } = spyBash()
    const registry = new ToolRegistry()
    registry.register(bash)
    const { adapter, offered } = scriptedAdapter([
      toolUse('bash', { command: 'echo hi' }),
      text('done'),
    ])

    // No `tools` / `toolPreset` → default-deny.
    const agent = new Agent(
      { name: 'solo', model: 'mock-model', adapter } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    const result = await agent.run('Do something useful.')

    // bash was registered but never granted → never executed.
    expect(ran()).toBe(false)
    // The model was offered no tools at all.
    expect(offered()[0]).toBeUndefined()
    // The ungranted call produced a clear, non-silent error signal.
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.toolName).toBe('bash')
    expect(result.toolCalls[0]!.output.toLowerCase()).toContain('not granted')
    expect(result.toolCalls[0]!.output).not.toContain('SPY_BASH_OUTPUT')
    // The run still completes on the following text turn.
    expect(result.output).toBe('done')
  })

  it('tools allowlist still grants exactly as before', async () => {
    const { tool: bash, ran } = spyBash()
    const registry = new ToolRegistry()
    registry.register(bash)
    const { adapter, offered } = scriptedAdapter([
      toolUse('bash', { command: 'echo hi' }),
      text('done'),
    ])

    const agent = new Agent(
      { name: 'solo', model: 'mock-model', adapter, tools: ['bash'] } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    const result = await agent.run('Run the command.')

    expect(ran()).toBe(true)
    expect(offered()[0]).toEqual(['bash'])
    expect(result.toolCalls[0]!.output).toBe('SPY_BASH_OUTPUT')
  })

  it('toolPreset still grants exactly as before', async () => {
    const { tool: bash, ran } = spyBash()
    const registry = new ToolRegistry()
    registry.register(bash)
    const { adapter } = scriptedAdapter([toolUse('bash', { command: 'echo hi' }), text('done')])

    // `full` includes bash.
    const agent = new Agent(
      { name: 'solo', model: 'mock-model', adapter, toolPreset: 'full' } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    await agent.run('Run the command.')
    expect(ran()).toBe(true)
  })

  it('custom / runtime tools registered in code stay available without a grant', async () => {
    let customRan = false
    const registry = new ToolRegistry()
    // Registration is the grant for runtime tools.
    registry.register(
      defineTool({
        name: 'my_custom',
        description: 'A custom capability.',
        inputSchema: z.object({}),
        execute: async () => {
          customRan = true
          return { data: 'CUSTOM_OK', isError: false }
        },
      }),
      { runtimeAdded: true },
    )
    const { adapter, offered } = scriptedAdapter([toolUse('my_custom', {}), text('done')])

    // No `tools` / `toolPreset` — the runtime tool is still granted.
    const agent = new Agent(
      { name: 'solo', model: 'mock-model', adapter } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    const result = await agent.run('Use your capability.')
    expect(customRan).toBe(true)
    expect(offered()[0]).toEqual(['my_custom'])
    expect(result.toolCalls[0]!.output).toBe('CUSTOM_OK')
  })
})

// ---------------------------------------------------------------------------
// Orchestrator short-circuit path (real built-in bash)
// ---------------------------------------------------------------------------

describe('default-deny: runTeam short-circuit', () => {
  it('a no-tools agent cannot run real shell on the short-circuit path', async () => {
    const sentinel = 'OMA_SENTINEL_should_never_run'
    const { adapter } = scriptedAdapter([
      toolUse('bash', { command: `echo ${sentinel}` }),
      text('finished'),
    ])

    const oma = new OpenMultiAgent({
      executionRouting: { strategy: 'deterministic' },
    })
    const team = oma.createTeam('t', {
      name: 't',
      agents: [{ name: 'solo', model: 'mock-model', adapter }],
    })

    const result = await oma.runTeam(team, SIMPLE_GOAL)
    const solo = result.agentResults.get('solo')!

    expect(solo.toolCalls).toHaveLength(1)
    expect(solo.toolCalls[0]!.toolName).toBe('bash')
    expect(solo.toolCalls[0]!.output.toLowerCase()).toContain('not granted')
    // The real bash subprocess never ran — the sentinel is absent.
    expect(solo.toolCalls[0]!.output).not.toContain(sentinel)
    expect(solo.output).toBe('finished')
  })

  it('defaultToolPreset:"full" restores the prior convenience (bash runs again)', async () => {
    const sentinel = 'OMA_DEFAULT_PRESET_RAN'
    const { adapter } = scriptedAdapter([
      toolUse('bash', { command: `echo ${sentinel}` }),
      text('finished'),
    ])

    const oma = new OpenMultiAgent({
      defaultToolPreset: 'full',
      executionRouting: { strategy: 'deterministic' },
    })
    const team = oma.createTeam('t', {
      name: 't',
      agents: [{ name: 'solo', model: 'mock-model', adapter }],
    })

    const result = await oma.runTeam(team, SIMPLE_GOAL)
    const solo = result.agentResults.get('solo')!

    expect(solo.toolCalls).toHaveLength(1)
    expect(solo.toolCalls[0]!.toolName).toBe('bash')
    // Granted via the default preset → the executor ran the real command.
    expect(solo.toolCalls[0]!.output.toLowerCase()).not.toContain('not granted')
    expect(solo.toolCalls[0]!.output).toContain(sentinel)
  })

  it('onToolCall can deny a granted tool before it executes', async () => {
    const sentinel = 'OMA_GATE_should_never_run'
    const { adapter } = scriptedAdapter([
      toolUse('bash', { command: `echo ${sentinel}` }),
      text('finished'),
    ])
    const onToolCall = vi.fn(async () => ({ action: 'deny' as const, reason: 'blocked by policy' }))

    const oma = new OpenMultiAgent({
      defaultToolPreset: 'full',
      executionRouting: { strategy: 'deterministic' },
      onToolCall,
    })
    const team = oma.createTeam('t', {
      name: 't',
      agents: [{ name: 'solo', model: 'mock-model', adapter }],
    })

    const result = await oma.runTeam(team, SIMPLE_GOAL)
    const solo = result.agentResults.get('solo')!

    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'bash',
      input: { command: `echo ${sentinel}` },
      agentName: 'solo',
    }))
    expect(solo.toolCalls).toHaveLength(1)
    expect(solo.toolCalls[0]!.toolName).toBe('bash')
    expect(solo.toolCalls[0]!.output).toContain('blocked by policy')
    expect(solo.toolCalls[0]!.output).not.toContain(sentinel)
  })

  it('per-agent toolPreset overrides defaultToolPreset', async () => {
    const sentinel = 'OMA_OVERRIDE_should_never_run'
    const { adapter } = scriptedAdapter([
      toolUse('bash', { command: `echo ${sentinel}` }),
      text('finished'),
    ])

    // Default would grant bash, but the agent narrows itself to readonly,
    // which excludes bash.
    const oma = new OpenMultiAgent({
      defaultToolPreset: 'full',
      executionRouting: { strategy: 'deterministic' },
    })
    const team = oma.createTeam('t', {
      name: 't',
      agents: [{ name: 'solo', model: 'mock-model', adapter, toolPreset: 'readonly' }],
    })

    const result = await oma.runTeam(team, SIMPLE_GOAL)
    const solo = result.agentResults.get('solo')!

    expect(solo.toolCalls[0]!.output.toLowerCase()).toContain('not granted')
    expect(solo.toolCalls[0]!.output).not.toContain(sentinel)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator runTasks path + delegate_to_agent
// ---------------------------------------------------------------------------

describe('default-deny: runTasks and delegate_to_agent', () => {
  it('a no-tools agent cannot delegate without granting delegate_to_agent', async () => {
    // buildPool always registers delegate_to_agent (includeDelegateTool), but
    // under default-deny it still requires a positive grant — consistent with
    // every other built-in. The example/test convention is tools:['delegate_to_agent'].
    const { adapter } = scriptedAdapter([
      toolUse('delegate_to_agent', { target_agent: 'b', prompt: 'help' }),
      text('finished'),
    ])

    const oma = new OpenMultiAgent({})
    const team = oma.createTeam('t', {
      name: 't',
      agents: [
        { name: 'a', model: 'mock-model', adapter },
        { name: 'b', model: 'mock-model', adapter },
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Task A', description: 'do A', assignee: 'a' },
    ])

    const a = result.agentResults.get('a')!
    expect(a.toolCalls).toHaveLength(1)
    expect(a.toolCalls[0]!.toolName).toBe('delegate_to_agent')
    expect(a.toolCalls[0]!.output.toLowerCase()).toContain('not granted')
  })
})
