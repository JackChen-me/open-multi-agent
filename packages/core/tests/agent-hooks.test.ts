import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent/agent.js'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { AgentConfig, AgentRunResult, LLMAdapter, LLMMessage, LLMResponse, StreamEvent } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock adapter that records every `chat()` call's messages
 * and returns a fixed text response.
 */
function mockAdapter(responseText: string) {
  const calls: LLMMessage[][] = []
  const adapter: LLMAdapter = {
    name: 'mock',
    async chat(messages) {
      calls.push([...messages])
      return {
        id: 'mock-1',
        content: [{ type: 'text' as const, text: responseText }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused */
    },
  }
  return { adapter, calls }
}

/** Build an Agent with a mocked LLM, bypassing createAdapter. */
function buildMockAgent(config: AgentConfig, responseText: string) {
  const { adapter, calls } = mockAdapter(responseText)
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const agent = new Agent(config, registry, executor)

  const runner = new AgentRunner(adapter, registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    agentName: config.name,
  })
  ;(agent as any).backend = runner

  return { agent, calls }
}

const baseConfig: AgentConfig = {
  name: 'test-agent',
  model: 'mock-model',
  systemPrompt: 'You are a test agent.',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent hooks — beforeRun / afterRun', () => {
  // -----------------------------------------------------------------------
  // Baseline — no hooks
  // -----------------------------------------------------------------------

  it('works normally without hooks', async () => {
    const { agent } = buildMockAgent(baseConfig, 'hello')
    const result = await agent.run('ping')

    expect(result.success).toBe(true)
    expect(result.output).toBe('hello')
  })

  // -----------------------------------------------------------------------
  // beforeRun
  // -----------------------------------------------------------------------

  it('beforeRun can modify the prompt', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => ({ ...ctx, prompt: 'modified prompt' }),
    }
    const { agent, calls } = buildMockAgent(config, 'response')
    await agent.run('original prompt')

    // The adapter should have received the modified prompt.
    const lastUserMsg = calls[0]!.find(m => m.role === 'user')
    const textBlock = lastUserMsg!.content.find(b => b.type === 'text')
    expect((textBlock as any).text).toBe('modified prompt')
  })

  it('beforeRun that returns context unchanged does not alter prompt', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => ctx,
    }
    const { agent, calls } = buildMockAgent(config, 'response')
    await agent.run('keep this')

    const lastUserMsg = calls[0]!.find(m => m.role === 'user')
    const textBlock = lastUserMsg!.content.find(b => b.type === 'text')
    expect((textBlock as any).text).toBe('keep this')
  })

  it('beforeRun throwing aborts the run with failure', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: () => { throw new Error('budget exceeded') },
    }
    const { agent, calls } = buildMockAgent(config, 'should not reach')
    const result = await agent.run('hi')

    expect(result.success).toBe(false)
    expect(result.output).toContain('budget exceeded')
    // No LLM call should have been made.
    expect(calls).toHaveLength(0)
  })

  it('async beforeRun works', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: async (ctx) => {
        await Promise.resolve()
        return { ...ctx, prompt: 'async modified' }
      },
    }
    const { agent, calls } = buildMockAgent(config, 'ok')
    await agent.run('original')

    const lastUserMsg = calls[0]!.find(m => m.role === 'user')
    const textBlock = lastUserMsg!.content.find(b => b.type === 'text')
    expect((textBlock as any).text).toBe('async modified')
  })

  // -----------------------------------------------------------------------
  // afterRun
  // -----------------------------------------------------------------------

  it('afterRun can modify the result', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      afterRun: (result) => ({ ...result, output: 'modified output' }),
    }
    const { agent } = buildMockAgent(config, 'original output')
    const result = await agent.run('hi')

    expect(result.success).toBe(true)
    expect(result.output).toBe('modified output')
  })

  it('afterRun throwing marks run as failed', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      afterRun: () => { throw new Error('content violation') },
    }
    const { agent } = buildMockAgent(config, 'bad content')
    const result = await agent.run('hi')

    expect(result.success).toBe(false)
    expect(result.output).toContain('content violation')
  })

  it('async afterRun works', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      afterRun: async (result) => {
        await Promise.resolve()
        return { ...result, output: result.output.toUpperCase() }
      },
    }
    const { agent } = buildMockAgent(config, 'hello')
    const result = await agent.run('hi')

    expect(result.output).toBe('HELLO')
  })

  // -----------------------------------------------------------------------
  // Both hooks together
  // -----------------------------------------------------------------------

  it('beforeRun and afterRun compose correctly', async () => {
    const hookOrder: string[] = []

    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => {
        hookOrder.push('before')
        return { ...ctx, prompt: 'injected prompt' }
      },
      afterRun: (result) => {
        hookOrder.push('after')
        return { ...result, output: `[processed] ${result.output}` }
      },
    }
    const { agent, calls } = buildMockAgent(config, 'raw output')
    const result = await agent.run('original')

    expect(hookOrder).toEqual(['before', 'after'])

    const lastUserMsg = calls[0]!.find(m => m.role === 'user')
    const textBlock = lastUserMsg!.content.find(b => b.type === 'text')
    expect((textBlock as any).text).toBe('injected prompt')

    expect(result.output).toBe('[processed] raw output')
  })

  // -----------------------------------------------------------------------
  // prompt() multi-turn mode
  // -----------------------------------------------------------------------

  it('hooks fire on prompt() calls', async () => {
    const beforeSpy = vi.fn((ctx) => ctx)
    const afterSpy = vi.fn((result) => result)

    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: beforeSpy,
      afterRun: afterSpy,
    }
    const { agent } = buildMockAgent(config, 'reply')
    await agent.prompt('hello')

    expect(beforeSpy).toHaveBeenCalledOnce()
    expect(afterSpy).toHaveBeenCalledOnce()
    expect(beforeSpy.mock.calls[0]![0].prompt).toBe('hello')
  })

  // -----------------------------------------------------------------------
  // stream() mode
  // -----------------------------------------------------------------------

  it('beforeRun fires in stream mode', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => ({ ...ctx, prompt: 'stream modified' }),
    }
    const { agent, calls } = buildMockAgent(config, 'streamed')

    const events: StreamEvent[] = []
    for await (const event of agent.stream('original')) {
      events.push(event)
    }

    const lastUserMsg = calls[0]!.find(m => m.role === 'user')
    const textBlock = lastUserMsg!.content.find(b => b.type === 'text')
    expect((textBlock as any).text).toBe('stream modified')

    // Should have at least a text event and a done event.
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('afterRun fires in stream mode and modifies done event', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      afterRun: (result) => ({ ...result, output: 'stream modified output' }),
    }
    const { agent } = buildMockAgent(config, 'original')

    const events: StreamEvent[] = [] 
    for await (const event of agent.stream('hi')) {
      events.push(event)
    }

    const doneEvent = events.find(e => e.type === 'done')
    expect(doneEvent).toBeDefined()
    expect((doneEvent!.data as AgentRunResult).output).toBe('stream modified output')
  })

  it('beforeRun throwing in stream mode yields error event', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: () => { throw new Error('stream abort') },
    }
    const { agent } = buildMockAgent(config, 'unreachable')

    const events: StreamEvent[] = []
    for await (const event of agent.stream('hi')) {
      events.push(event)
    }

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent!.data as Error).message).toContain('stream abort')
  })

  it('afterRun throwing in stream mode yields error event', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      afterRun: () => { throw new Error('stream content violation') },
    }
    const { agent } = buildMockAgent(config, 'streamed output')

    const events: StreamEvent[] = []
    for await (const event of agent.stream('hi')) {
      events.push(event)
    }

    // Text events may have been yielded before the error.
    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent!.data as Error).message).toContain('stream content violation')
    // No done event should be present since afterRun rejected it.
    expect(events.find(e => e.type === 'done')).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // prompt() history integrity
  // -----------------------------------------------------------------------

  it('beforeRun modifying prompt preserves non-text content blocks', async () => {
    // Simulate a multi-turn message where the last user message has mixed content
    // (text + tool_result). beforeRun should only replace text, not strip other blocks.
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => ({ ...ctx, prompt: 'modified' }),
    }
    const { adapter, calls } = mockAdapter('ok')
    const registry = new ToolRegistry()
    const executor = new ToolExecutor(registry)
    const agent = new Agent(config, registry, executor)

    const runner = new AgentRunner(adapter, registry, executor, {
      model: config.model,
      agentName: config.name,
    })
    ;(agent as any).backend = runner

    // Directly call run which creates a single text-only user message.
    // To test mixed content, we need to go through the private executeRun.
    // Instead, we test via prompt() after injecting history with mixed content.
    ;(agent as any).messageHistory = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'original' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' } },
        ],
      },
    ]

    // prompt() appends a new user message then calls executeRun with full history
    await agent.prompt('follow up')

    // The last user message sent to the LLM should have modified text
    const sentMessages = calls[0]!
    const lastUser = [...sentMessages].reverse().find(m => m.role === 'user')!
    const textBlock = lastUser.content.find(b => b.type === 'text')
    expect((textBlock as any).text).toBe('modified')

    // The earlier user message (with the image) should be untouched
    const firstUser = sentMessages.find(m => m.role === 'user')!
    const imageBlock = firstUser.content.find(b => b.type === 'image')
    expect(imageBlock).toBeDefined()
  })

  it('beforeRun modifying prompt does not corrupt messageHistory', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => ({ ...ctx, prompt: 'hook-modified' }),
    }
    const { agent, calls } = buildMockAgent(config, 'reply')

    await agent.prompt('original message')

    // The LLM should have received the modified prompt.
    const lastUserMsg = calls[0]!.find(m => m.role === 'user')
    expect((lastUserMsg!.content[0] as any).text).toBe('hook-modified')

    // But the persistent history should retain the original message.
    const history = agent.getHistory()
    const firstUserInHistory = history.find(m => m.role === 'user')
    expect((firstUserInHistory!.content[0] as any).text).toBe('original message')
  })

  it('restores constructor history for stateless prompt conversations', async () => {
    const history: LLMMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'previous question' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'previous answer' }],
      },
    ]
    const { agent, calls } = buildMockAgent({ ...baseConfig, history }, 'new answer')

    await agent.prompt('follow-up question')

    expect(calls[0]).toEqual([
      ...history,
      {
        role: 'user',
        content: [{ type: 'text', text: 'follow-up question' }],
      },
    ])
    expect(agent.getHistory()).toEqual([
      ...history,
      {
        role: 'user',
        content: [{ type: 'text', text: 'follow-up question' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'new answer' }],
      },
    ])
  })

  // -----------------------------------------------------------------------
  // afterRun NOT called on error
  // -----------------------------------------------------------------------

  it('afterRun is not called when executeRun throws', async () => {
    const afterSpy = vi.fn((result) => result)

    const config: AgentConfig = {
      ...baseConfig,
      // Use beforeRun to trigger an error inside executeRun's try block,
      // before afterRun would normally run.
      beforeRun: () => { throw new Error('rejected by policy') },
      afterRun: afterSpy,
    }
    const { agent } = buildMockAgent(config, 'should not reach')
    const result = await agent.run('hi')

    expect(result.success).toBe(false)
    expect(result.output).toContain('rejected by policy')
    expect(afterSpy).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // outputSchema + afterRun
  // -----------------------------------------------------------------------

  it('afterRun fires after structured output validation', async () => {
    const schema = z.object({ answer: z.string() })

    const config: AgentConfig = {
      ...baseConfig,
      outputSchema: schema,
      afterRun: (result) => ({ ...result, output: '[post-processed] ' + result.output }),
    }
    // Return valid JSON matching the schema
    const { agent } = buildMockAgent(config, '{"answer":"42"}')
    const result = await agent.run('what is the answer?')

    expect(result.success).toBe(true)
    expect(result.output).toBe('[post-processed] {"answer":"42"}')
    expect(result.structured).toEqual({ answer: '42' })
  })

  // -----------------------------------------------------------------------
  // ctx.agent does not contain hook self-references
  // -----------------------------------------------------------------------

  it('beforeRun context.agent has correct config without hook self-references', async () => {
    let receivedAgent: AgentConfig | undefined

    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: (ctx) => {
        receivedAgent = ctx.agent
        return ctx
      },
    }
    const { agent } = buildMockAgent(config, 'ok')
    await agent.run('test')

    expect(receivedAgent).toBeDefined()
    expect(receivedAgent!.name).toBe('test-agent')
    expect(receivedAgent!.model).toBe('mock-model')
    // Hook functions should be stripped to avoid circular references
    expect(receivedAgent!.beforeRun).toBeUndefined()
    expect(receivedAgent!.afterRun).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Multiple prompt() turns fire hooks each time
  // -----------------------------------------------------------------------

  it('hooks fire on every prompt() call', async () => {
    const beforeSpy = vi.fn((ctx) => ctx)
    const afterSpy = vi.fn((result) => result)

    const config: AgentConfig = {
      ...baseConfig,
      beforeRun: beforeSpy,
      afterRun: afterSpy,
    }
    const { agent } = buildMockAgent(config, 'reply')

    await agent.prompt('turn 1')
    await agent.prompt('turn 2')

    expect(beforeSpy).toHaveBeenCalledTimes(2)
    expect(afterSpy).toHaveBeenCalledTimes(2)
    expect(beforeSpy.mock.calls[0]![0].prompt).toBe('turn 1')
    expect(beforeSpy.mock.calls[1]![0].prompt).toBe('turn 2')
  })
})
