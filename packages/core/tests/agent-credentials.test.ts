/**
 * Tests for per-agent scoped tool credentials (issue #19).
 *
 * `AgentConfig.credentials` is a per-agent secret bag threaded into
 * `ToolUseContext.credentials`, so tool code reads `context.credentials?.KEY`
 * instead of closing a single shared secret over every tool. The security
 * property under test: each agent holds only the bag assigned to it — one
 * agent's tool cannot read another agent's credentials — the bag is absent by
 * default, survives the orchestrator's per-agent config spread, and never
 * leaks into emitted traces.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { isSensitiveName } from '../src/utils/redaction.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  ToolUseContext,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers (mirror tests/default-deny-tools.test.ts)
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
    id: 'resp-text',
    content: [{ type: 'text', text: t }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  }
}

/** Replays `steps` one per turn, repeating the last once exhausted. */
function scriptedAdapter(steps: LLMResponse[]): LLMAdapter {
  let i = 0
  return {
    name: 'mock',
    async chat(_messages: LLMMessage[], _options: LLMChatOptions): Promise<LLMResponse> {
      return steps[Math.min(i++, steps.length - 1)]!
    },
    async *stream() {
      /* unused */
    },
  }
}

/**
 * A custom tool that records the `ToolUseContext.credentials` it was handed.
 * Registration is the grant (custom tools bypass preset/allowlist), so the
 * agent can call it without a `toolPreset`.
 */
function credentialSpy(name = 'read_secret'): {
  tool: ReturnType<typeof defineTool>
  seen: () => ToolUseContext['credentials']
  callCount: () => number
} {
  let seen: ToolUseContext['credentials']
  let calls = 0
  const tool = defineTool({
    name,
    description: 'Records the credentials visible to this agent.',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      calls++
      seen = context.credentials
      return { data: 'ok', isError: false }
    },
  })
  return { tool, seen: () => seen, callCount: () => calls }
}

// A short goal with no coordination signals → runTeam short-circuit (single agent).
const SIMPLE_GOAL = 'Briefly explain what a hash map is.'

// ---------------------------------------------------------------------------
// Standalone Agent path
// ---------------------------------------------------------------------------

describe('per-agent credentials: standalone Agent', () => {
  it('threads the agent credentials bag into ToolUseContext', async () => {
    const { tool, seen } = credentialSpy()
    const registry = new ToolRegistry()
    registry.register(tool, { runtimeAdded: true })

    const agent = new Agent(
      {
        name: 'solo',
        model: 'mock-model',
        adapter: scriptedAdapter([toolUse('read_secret', {}), text('done')]),
        credentials: { SEARCH_API_KEY: 'sk-search-123' },
      } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    await agent.run('Use the tool.')

    expect(seen()).toEqual({ SEARCH_API_KEY: 'sk-search-123' })
  })

  it('leaves context.credentials undefined when no bag is set', async () => {
    const { tool, seen, callCount } = credentialSpy()
    const registry = new ToolRegistry()
    registry.register(tool, { runtimeAdded: true })

    const agent = new Agent(
      {
        name: 'solo',
        model: 'mock-model',
        adapter: scriptedAdapter([toolUse('read_secret', {}), text('done')]),
      } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    await agent.run('Use the tool.')

    // The tool ran, but saw no credentials.
    expect(callCount()).toBe(1)
    expect(seen()).toBeUndefined()
  })

  it("isolates one agent's credentials from another's", async () => {
    const a = credentialSpy('read_secret')
    const regA = new ToolRegistry()
    regA.register(a.tool, { runtimeAdded: true })
    const agentA = new Agent(
      {
        name: 'a',
        model: 'mock-model',
        adapter: scriptedAdapter([toolUse('read_secret', {}), text('done')]),
        credentials: { TOKEN: 'secret-A' },
      } satisfies AgentConfig,
      regA,
      new ToolExecutor(regA),
    )

    const b = credentialSpy('read_secret')
    const regB = new ToolRegistry()
    regB.register(b.tool, { runtimeAdded: true })
    const agentB = new Agent(
      {
        name: 'b',
        model: 'mock-model',
        adapter: scriptedAdapter([toolUse('read_secret', {}), text('done')]),
        credentials: { TOKEN: 'secret-B' },
      } satisfies AgentConfig,
      regB,
      new ToolExecutor(regB),
    )

    await agentA.run('go')
    await agentB.run('go')

    expect(a.seen()).toEqual({ TOKEN: 'secret-A' })
    expect(b.seen()).toEqual({ TOKEN: 'secret-B' })
    // Neither tool ever observed the other agent's secret.
    expect(JSON.stringify(a.seen())).not.toContain('secret-B')
    expect(JSON.stringify(b.seen())).not.toContain('secret-A')
  })

  it('does not leak credential values into emitted traces', async () => {
    const { tool } = credentialSpy()
    const registry = new ToolRegistry()
    registry.register(tool, { runtimeAdded: true })
    const traces: unknown[] = []

    const agent = new Agent(
      {
        name: 'solo',
        model: 'mock-model',
        adapter: scriptedAdapter([toolUse('read_secret', {}), text('done')]),
        credentials: { TOKEN: 'top-secret-value' },
      } satisfies AgentConfig,
      registry,
      new ToolExecutor(registry),
    )

    await agent.run('Use the tool.', {
      onTrace: (e) => {
        traces.push(e)
      },
      runId: 'run-creds',
    })

    // Traces were actually captured, so the negative assertion is meaningful.
    expect(traces.length).toBeGreaterThan(0)
    // The credential value never appears anywhere in the trace stream.
    expect(JSON.stringify(traces)).not.toContain('top-secret-value')
  })

  it("relies on 'credentials' being a redaction-sensitive key", () => {
    // Defense in depth: the field is documented as auto-redacted. If a bag is
    // ever serialized into a payload passing through redactSensitiveObject, the
    // key name must trigger redaction. Guards the field name against silent
    // divergence from the redaction pattern.
    expect(isSensitiveName('credentials')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator path
// ---------------------------------------------------------------------------

describe('per-agent credentials: orchestrator', () => {
  it('survives the runTeam short-circuit config spread', async () => {
    const { tool, seen } = credentialSpy()
    const oma = new OpenMultiAgent({
      executionRouting: { strategy: 'deterministic' },
    })
    const team = oma.createTeam('t', {
      name: 't',
      agents: [
        {
          name: 'solo',
          model: 'mock-model',
          adapter: scriptedAdapter([toolUse('read_secret', {}), text('finished')]),
          credentials: { CMS_TOKEN: 'cms-xyz' },
          customTools: [tool],
        },
      ],
    })

    await oma.runTeam(team, SIMPLE_GOAL)

    expect(seen()).toEqual({ CMS_TOKEN: 'cms-xyz' })
  })

  it("gives a delegated subagent its own credentials, not the delegator's", async () => {
    // The #19 headline: a compromised/misbehaving subagent must not inherit the
    // delegator's access. Agent `a` delegates to `b`; `b`'s tool must see only
    // `b`'s bag — never `a`'s secret.
    const b = credentialSpy('read_secret')
    const oma = new OpenMultiAgent({})
    const team = oma.createTeam('t', {
      name: 't',
      agents: [
        {
          name: 'a',
          model: 'mock-model',
          adapter: scriptedAdapter([
            toolUse('delegate_to_agent', { target_agent: 'b', prompt: 'read the secret' }),
            text('delegated'),
          ]),
          tools: ['delegate_to_agent'],
          credentials: { TOKEN: 'secret-A' },
        },
        {
          name: 'b',
          model: 'mock-model',
          adapter: scriptedAdapter([toolUse('read_secret', {}), text('done')]),
          customTools: [b.tool],
          credentials: { TOKEN: 'secret-B' },
        },
      ],
    })

    await oma.runTasks(team, [{ title: 'Task A', description: 'delegate to b', assignee: 'a' }])

    // `b` ran via delegation and saw exactly its own bag — never the delegator's.
    expect(b.seen()).toEqual({ TOKEN: 'secret-B' })
    expect(JSON.stringify(b.seen())).not.toContain('secret-A')
  })
})
