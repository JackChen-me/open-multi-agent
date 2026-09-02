import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry, defineTool } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type { LLMAdapter, LLMChatOptions, LLMMessage, LLMResponse, TraceEvent } from '../src/types.js'

function textResponse(text: string): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }
}

function toolUseResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{
      type: 'tool_use',
      id: `tu-${Math.random().toString(36).slice(2)}`,
      name: toolName,
      input,
    }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 15, output_tokens: 25 },
  }
}

function buildRegistryAndExecutor(): { registry: ToolRegistry; executor: ToolExecutor } {
  const registry = new ToolRegistry()
  registry.register(
    defineTool({
      name: 'echo',
      description: 'Echo input',
      inputSchema: z.object({ message: z.string() }),
      async execute({ message }) {
        return { data: message }
      },
    }),
  )
  return { registry, executor: new ToolExecutor(registry) }
}

describe('AgentRunner contextStrategy', () => {
  it('keeps baseline behavior when contextStrategy is not set', async () => {
    const calls: LLMMessage[][] = []
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: m.content })))
        return calls.length === 1
          ? toolUseResponse('echo', { message: 'hello' })
          : textResponse('done')
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 4,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toHaveLength(1)
    expect(calls[1]!.length).toBeGreaterThan(calls[0]!.length)
  })

  it('sliding-window truncates old turns and preserves the first user message', async () => {
    const calls: LLMMessage[][] = []
    const responses = [
      toolUseResponse('echo', { message: 't1' }),
      toolUseResponse('echo', { message: 't2' }),
      toolUseResponse('echo', { message: 't3' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: m.content })))
        return responses[idx++]!
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 8,
      contextStrategy: { type: 'sliding-window', maxTurns: 1 },
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'original prompt' }] }])

    const laterCall = calls[calls.length - 1]!
    const firstUserText = laterCall[0]!.content[0]
    expect(firstUserText).toMatchObject({ type: 'text', text: 'original prompt' })
    const flattenedText = laterCall.flatMap(m => m.content.filter(c => c.type === 'text'))
    expect(flattenedText.some(c => c.type === 'text' && c.text.includes('truncated'))).toBe(true)
  })

  it('sliding-window keeps tool_use/tool_result pairs together', async () => {
    // Regression: previously truncateToSlidingWindow sliced by message count
    // (`afterFirst.slice(-maxTurns * 2)`), which could drop an `assistant` block
    // carrying a `tool_use` while keeping the matching `user` `tool_result`.
    // This produces an orphan `tool_use_id` that Anthropic's API rejects.
    const calls: LLMMessage[][] = []
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: m.content })))
        return textResponse('ack')
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 4,
      // maxTurns=2 + a 6-message history is sized so the naive slice(-4)
      // lands on the user_tool_result, leaving its tool_use upstream.
      contextStrategy: { type: 'sliding-window', maxTurns: 2 },
    })

    const history: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'original prompt' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu-1', name: 'echo', input: { message: 'hi' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu-1', content: 'hi' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'response 1' }] },
      { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'response 2' }] },
    ]

    await runner.run(history)

    // Every tool_result reaching the adapter must reference a tool_use that
    // also reached the adapter. Otherwise the API call is invalid.
    const sent = calls[0]!
    const toolUseIds = new Set<string>()
    const toolResultIds: string[] = []
    for (const msg of sent) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolUseIds.add(block.id)
        if (block.type === 'tool_result') toolResultIds.push(block.tool_use_id)
      }
    }
    for (const trId of toolResultIds) {
      expect(toolUseIds.has(trId)).toBe(true)
    }
  })

  it('sliding-window preserves message-pair count for plain conversations', async () => {
    // The bug fix above changes how we slice (turn boundaries instead of raw
    // message count), but `maxTurns` must still mean "message pair count" for
    // plain text histories — i.e. `maxTurns=N` keeps the last `2*N` messages
    // when no tool round-trips are involved. This test pins that contract.
    const calls: LLMMessage[][] = []
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: m.content })))
        return textResponse('ack')
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 4,
      contextStrategy: { type: 'sliding-window', maxTurns: 2 },
    })

    // 7-message plain history. afterFirst = 6 msgs, target = maxTurns*2 = 4.
    // Expected kept slice (excluding the always-preserved first user): last 4.
    const history: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: [{ type: 'text', text: 'q3' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
      { role: 'user', content: [{ type: 'text', text: 'q4' }] },
    ]

    await runner.run(history)

    const sent = calls[0]!
    // Expected: [q1 (firstUser), a2, u3 (with truncation notice), a3, q4]
    // = 1 firstUser + last 4 of afterFirst = 5 messages.
    expect(sent).toHaveLength(5)
    expect(sent[0]!.content[0]).toMatchObject({ type: 'text', text: 'q1' })

    // Confirm the kept slice carries exactly the last 4 messages of the
    // pre-truncation history (a2, q3, a3, q4) — i.e. `maxTurns=2` kept 4 msgs.
    const keptText = sent.slice(1).flatMap(m =>
      m.content
        .filter((c): c is import('../src/types.js').TextBlock => c.type === 'text')
        .map(c => c.text)
    )
    expect(keptText.some(t => t.includes('a2'))).toBe(true)
    expect(keptText.some(t => t === 'q3')).toBe(true)
    expect(keptText.some(t => t.includes('a3'))).toBe(true)
    expect(keptText.some(t => t === 'q4')).toBe(true)
    // q2 and a1 must have been truncated away.
    expect(keptText.every(t => !t.includes('q2'))).toBe(true)
    expect(keptText.every(t => !t.includes('a1'))).toBe(true)

    expect(keptText.some(t => t.includes('truncated'))).toBe(true)
  })

  it('summarize strategy replaces old context and emits summary trace call', async () => {
    const calls: Array<{ messages: LLMMessage[]; options: LLMChatOptions }> = []
    const traces: TraceEvent[] = []
    const responses = [
      toolUseResponse('echo', { message: 'first turn payload '.repeat(20) }),
      toolUseResponse('echo', { message: 'second turn payload '.repeat(20) }),
      textResponse('This is a concise summary.'),
      textResponse('final answer'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages, options) {
        calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content })), options })
        return responses[idx++]!
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 8,
      contextStrategy: { type: 'summarize', maxTokens: 20 },
    })

    const result = await runner.run(
      [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      { onTrace: (e) => { traces.push(e) }, runId: 'run-summary', traceAgent: 'context-agent' },
    )

    const summaryCall = calls.find(c => c.messages.length === 1 && c.options.tools === undefined)
    expect(summaryCall).toBeDefined()
    const llmTraces = traces.filter(t => t.type === 'llm_call')
    expect(llmTraces.some(t => t.type === 'llm_call' && t.phase === 'summary')).toBe(true)

    // Summary adapter usage must count toward RunResult.tokenUsage (maxTokenBudget).
    expect(result.tokenUsage.input_tokens).toBe(15 + 15 + 10 + 10)
    expect(result.tokenUsage.output_tokens).toBe(25 + 25 + 20 + 20)

    // After compaction, summary text is folded into the next user turn (not a
    // standalone user message), preserving user/assistant alternation.
    const turnAfterSummary = calls.find(
      c => c.messages.some(
        m => m.role === 'user' && m.content.some(
          b => b.type === 'text' && b.text.includes('[Conversation summary]'),
        ),
      ),
    )
    expect(turnAfterSummary).toBeDefined()
    const rolesAfterFirstUser = turnAfterSummary!.messages.map(m => m.role).join(',')
    expect(rolesAfterFirstUser).not.toMatch(/^user,user/)
  })

  it('summarize strategy strips image attachments before compression call', async () => {
    // Bug: summarizeMessages serializes oldPortion via JSON.stringify and
    // splices the result into the summary prompt text. ImageBlock.source.data
    // is a base64 string — when present, the entire base64 payload leaks
    // into the compression call, blowing token cost and risking context-limit
    // rejection on the very call meant to *reduce* context.
    const FAKE_IMAGE_DATA = 'A'.repeat(100_000)
    // estimateTokens charges only 64 chars per ImageBlock, so summarize must
    // be triggered by surrounding text. Stuff some text-heavy turns alongside.
    const FILLER = 'lorem ipsum dolor sit amet '.repeat(50)  // ~1.3k chars
    const calls: { messages: LLMMessage[]; options: LLMChatOptions }[] = []
    let callCount = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages, options) {
        calls.push({ messages, options })
        callCount++
        if (callCount === 1) {
          return toolUseResponse('echo', { message: 'x' })
        }
        return textResponse('done')
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 8,
      contextStrategy: { type: 'summarize', maxTokens: 100 },
    })

    const history: LLMMessage[] = [
      // firstUser (preserved as-is, never enters oldPortion)
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      { role: 'assistant', content: [{ type: 'text', text: FILLER }] },
      // Image is on a NON-first user message so it lands in oldPortion
      // (the slice that gets serialised into the summary prompt).
      { role: 'user', content: [
        { type: 'text', text: 'analyze this image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: FAKE_IMAGE_DATA } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: FILLER }] },
      { role: 'user', content: [{ type: 'text', text: FILLER }] },
      { role: 'assistant', content: [{ type: 'text', text: FILLER }] },
    ]

    await runner.run(history)

    // Summary call signature: no tools, exactly one synthesised user message.
    const summaryCall = calls.find(
      c => c.options.tools === undefined && c.messages.length === 1,
    )
    expect(summaryCall).toBeDefined()

    const promptText = summaryCall!.messages[0]!.content
      .filter((b): b is import('../src/types.js').TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')

    // Base64 payload must NOT have leaked into the compression prompt.
    expect(promptText.includes(FAKE_IMAGE_DATA)).toBe(false)
    // Sanity: the prompt should be small. 100k base64 chars + JSON overhead
    // would push it well past 100k chars without the strip.
    expect(promptText.length).toBeLessThan(10_000)
    // The image should still be referenced by some placeholder so the
    // summarizer knows media existed at that point.
    expect(promptText.toLowerCase().includes('image')).toBe(true)
  })

  it('summarize strategy strips video attachments, and the video alone can trigger it', async () => {
    // The image case above needs text FILLER to cross maxTokens because an
    // ImageBlock is charged a flat 64 chars. A VideoBlock is charged its real
    // payload, so the attachment that actually needs compacting is the thing
    // that triggers compaction — no filler turns required.
    const FAKE_VIDEO_DATA = 'A'.repeat(100_000)
    const calls: { messages: LLMMessage[]; options: LLMChatOptions }[] = []
    let callCount = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages, options) {
        calls.push({ messages, options })
        callCount++
        if (callCount === 1) {
          return toolUseResponse('echo', { message: 'x' })
        }
        return textResponse('done')
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 8,
      contextStrategy: { type: 'summarize', maxTokens: 100 },
    })

    const history: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [
        { type: 'text', text: 'analyze this clip' },
        { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: FAKE_VIDEO_DATA } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'looking' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done thinking' }] },
    ]

    await runner.run(history)

    const summaryCall = calls.find(
      c => c.options.tools === undefined && c.messages.length === 1,
    )
    expect(summaryCall).toBeDefined()

    const promptText = summaryCall!.messages[0]!.content
      .filter((b): b is import('../src/types.js').TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')

    expect(promptText.includes(FAKE_VIDEO_DATA)).toBe(false)
    expect(promptText.length).toBeLessThan(10_000)
    expect(promptText).toContain('[video: video/mp4]')
  })

  it('does not drop turns when context strategy shrinks array size', async () => {
    // The core bug from #152: if the strategy replaces the array with fewer messages than it started with,
    // the old `slice()` logic would incorrectly drop newly generated turns.
    const compress = vi.fn((messages: LLMMessage[]) => messages.slice(-1)) // Shrink to 1 message
    const calls: LLMMessage[][] = []
    const responses = [
      toolUseResponse('echo', { message: 'hello' }),
      textResponse('done'),
    ]
    let idx = 0
    const adapter: LLMAdapter = {
      name: 'mock',
      async chat(messages) {
        calls.push(messages.map(m => ({ role: m.role, content: m.content })))
        return responses[idx++]!
      },
      async *stream() {
        /* unused */
      },
    }
    const { registry, executor } = buildRegistryAndExecutor()
    const runner = new AgentRunner(adapter, registry, executor, {
      model: 'mock-model',
      allowedTools: ['echo'],
      maxTurns: 4,
      contextStrategy: {
        type: 'custom',
        compress,
      },
    })

    // Seed with 3 messages
    const initialMessages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'm1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'm2' }] },
      { role: 'user', content: [{ type: 'text', text: 'm3' }] },
    ]

    const result = await runner.run(initialMessages)

    // Three new messages produced: assistant tool_use, user tool_result, assistant text.
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]!.role).toBe('assistant')
    expect(result.messages[1]!.role).toBe('user') // The tool_result
    expect(result.messages[2]!.role).toBe('assistant')
  })

  // ---------------------------------------------------------------------------
  // compact strategy
  // ---------------------------------------------------------------------------

  describe('compact strategy', () => {
    const longText = 'x'.repeat(3000)
    const longToolResult = 'result-data '.repeat(100) // ~1200 chars

    function buildMultiTurnAdapter(
      responseCount: number,
      calls: LLMMessage[][],
    ): LLMAdapter {
      const responses: LLMResponse[] = []
      for (let i = 0; i < responseCount - 1; i++) {
        responses.push(toolUseResponse('echo', { message: `turn-${i}` }))
      }
      responses.push(textResponse('done'))
      let idx = 0
      return {
        name: 'mock',
        async chat(messages) {
          calls.push(messages.map(m => ({ role: m.role, content: m.content })))
          return responses[idx++]!
        },
        async *stream() { /* unused */ },
      }
    }

    /** Build a registry with an echo tool that returns a fixed result string. */
    function buildEchoRegistry(result: string): { registry: ToolRegistry; executor: ToolExecutor } {
      const registry = new ToolRegistry()
      registry.register(
        defineTool({
          name: 'echo',
          description: 'Echo input',
          inputSchema: z.object({ message: z.string() }),
          async execute() {
            return { data: result }
          },
        }),
      )
      return { registry, executor: new ToolExecutor(registry) }
    }

    it('does not activate below maxTokens threshold', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(3, calls)
      const { registry, executor } = buildEchoRegistry('short')
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: { type: 'compact', maxTokens: 999999 },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      // On the 3rd call (turn 3), all previous messages should still be intact
      // because estimated tokens are way below the threshold.
      const lastCall = calls[calls.length - 1]!
      const allToolResults = lastCall.flatMap(m =>
        m.content.filter(b => b.type === 'tool_result'),
      )
      for (const tr of allToolResults) {
        if (tr.type === 'tool_result') {
          expect(tr.content).not.toContain('compacted')
        }
      }
    })

    it('compresses old tool_result blocks when tokens exceed threshold', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(4, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,           // very low to always trigger
          preserveRecentTurns: 1,  // only protect the most recent turn
          minToolResultChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      // On the last call, old tool results should have compact markers.
      const lastCall = calls[calls.length - 1]!
      const toolResults = lastCall.flatMap(m =>
        m.content.filter(b => b.type === 'tool_result'),
      )
      const compacted = toolResults.filter(
        b => b.type === 'tool_result' && b.content.includes('compacted'),
      )
      expect(compacted.length).toBeGreaterThan(0)
      // Marker should include tool name.
      for (const tr of compacted) {
        if (tr.type === 'tool_result') {
          expect(tr.content).toMatch(/\[Tool result: echo/)
        }
      }
    })

    it('preserves the first user message', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(4, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'original prompt' }] }])

      const lastCall = calls[calls.length - 1]!
      const firstUser = lastCall.find(m => m.role === 'user')!
      expect(firstUser.content[0]).toMatchObject({ type: 'text', text: 'original prompt' })
    })

    it('preserves tool_use blocks in old turns', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(4, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      // Every assistant message should still have its tool_use block.
      const lastCall = calls[calls.length - 1]!
      const assistantMsgs = lastCall.filter(m => m.role === 'assistant')
      for (const msg of assistantMsgs) {
        const toolUses = msg.content.filter(b => b.type === 'tool_use')
        // The last assistant message is "done" (text only), others have tool_use.
        if (msg.content.some(b => b.type === 'text' && b.text === 'done')) continue
        expect(toolUses.length).toBeGreaterThan(0)
      }
    })

    it('preserves error tool_result blocks', async () => {
      const calls: LLMMessage[][] = []
      const responses: LLMResponse[] = [
        toolUseResponse('echo', { message: 'will-fail' }),
        toolUseResponse('echo', { message: 'ok' }),
        textResponse('done'),
      ]
      let idx = 0
      const adapter: LLMAdapter = {
        name: 'mock',
        async chat(messages) {
          calls.push(messages.map(m => ({ role: m.role, content: m.content })))
          return responses[idx++]!
        },
        async *stream() { /* unused */ },
      }
      // Tool that fails on first call, succeeds on second.
      let callCount = 0
      const registry = new ToolRegistry()
      registry.register(
        defineTool({
          name: 'echo',
          description: 'Echo input',
          inputSchema: z.object({ message: z.string() }),
          async execute() {
            callCount++
            if (callCount === 1) {
              throw new Error('deliberate error '.repeat(40))
            }
            return { data: longToolResult }
          },
        }),
      )
      const executor = new ToolExecutor(registry)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 50,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      const lastCall = calls[calls.length - 1]!
      const errorResults = lastCall.flatMap(m =>
        m.content.filter(b => b.type === 'tool_result' && b.is_error),
      )
      // Error results should still have their original content (not compacted).
      for (const er of errorResults) {
        if (er.type === 'tool_result') {
          expect(er.content).not.toContain('compacted')
          expect(er.content).toContain('deliberate error')
        }
      }
    })

    it('does not re-compress markers from compressToolResults', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(4, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        compressToolResults: { minChars: 100 },
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 10,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      const lastCall = calls[calls.length - 1]!
      const allToolResults = lastCall.flatMap(m =>
        m.content.filter(b => b.type === 'tool_result'),
      )
      // No result should contain nested markers.
      for (const tr of allToolResults) {
        if (tr.type === 'tool_result') {
          // Should not have a compact marker wrapping another marker.
          const markerCount = (tr.content.match(/\[Tool/g) || []).length
          expect(markerCount).toBeLessThanOrEqual(1)
        }
      }
    })

    it('truncates long assistant text blocks in old turns', async () => {
      const calls: LLMMessage[][] = []
      const responses: LLMResponse[] = [
        // First turn: assistant with long text + tool_use
        {
          id: 'r1',
          content: [
            { type: 'text', text: longText },
            { type: 'tool_use', id: 'tu-1', name: 'echo', input: { message: 'hi' } },
          ],
          model: 'mock-model',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        toolUseResponse('echo', { message: 'turn2' }),
        textResponse('done'),
      ]
      let idx = 0
      const adapter: LLMAdapter = {
        name: 'mock',
        async chat(messages) {
          calls.push(messages.map(m => ({ role: m.role, content: m.content })))
          return responses[idx++]!
        },
        async *stream() { /* unused */ },
      }
      const { registry, executor } = buildEchoRegistry('short')
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minTextBlockChars: 500,
          textBlockExcerptChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      const lastCall = calls[calls.length - 1]!
      // The first assistant message (old zone) should have its text truncated.
      const firstAssistant = lastCall.find(m => m.role === 'assistant')!
      const textBlocks = firstAssistant.content.filter(b => b.type === 'text')
      const truncated = textBlocks.find(
        b => b.type === 'text' && b.text.includes('truncated'),
      )
      expect(truncated).toBeDefined()
      if (truncated && truncated.type === 'text') {
        expect(truncated.text.length).toBeLessThan(longText.length)
        expect(truncated.text).toContain(`${longText.length} chars total`)
      }
    })

    it('keeps recent turns intact within preserveRecentTurns', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(4, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      // The most recent tool_result (last user message with tool_result) should
      // still contain the original long content.
      const lastCall = calls[calls.length - 1]!
      const userMsgs = lastCall.filter(m => m.role === 'user')
      const lastUserWithToolResult = [...userMsgs]
        .reverse()
        .find(m => m.content.some(b => b.type === 'tool_result'))
      expect(lastUserWithToolResult).toBeDefined()
      const recentTr = lastUserWithToolResult!.content.find(b => b.type === 'tool_result')
      if (recentTr && recentTr.type === 'tool_result') {
        expect(recentTr.content).not.toContain('compacted')
        expect(recentTr.content).toContain('result-data')
      }
    })

    it('does not compact when all turns fit in preserveRecentTurns', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(3, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 10, // way more than actual turns
          minToolResultChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      // All tool results should still have original content.
      const lastCall = calls[calls.length - 1]!
      const toolResults = lastCall.flatMap(m =>
        m.content.filter(b => b.type === 'tool_result'),
      )
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          expect(tr.content).not.toContain('compacted')
        }
      }
    })

    it('maintains correct role alternation after compaction', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(5, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 10,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 100,
        },
      })

      await runner.run([{ role: 'user', content: [{ type: 'text', text: 'start' }] }])

      // Check all LLM calls for role alternation.
      for (const callMsgs of calls) {
        for (let i = 1; i < callMsgs.length; i++) {
          expect(callMsgs[i]!.role).not.toBe(callMsgs[i - 1]!.role)
        }
      }
    })

    it('returns ZERO_USAGE (no LLM cost from compaction)', async () => {
      const calls: LLMMessage[][] = []
      const adapter = buildMultiTurnAdapter(4, calls)
      const { registry, executor } = buildEchoRegistry(longToolResult)
      const runner = new AgentRunner(adapter, registry, executor, {
        model: 'mock-model',
        allowedTools: ['echo'],
        maxTurns: 8,
        contextStrategy: {
          type: 'compact',
          maxTokens: 20,
          preserveRecentTurns: 1,
          minToolResultChars: 100,
        },
      })

      const result = await runner.run([
        { role: 'user', content: [{ type: 'text', text: 'start' }] },
      ])

      // Token usage should only reflect the 4 actual LLM calls (no extra from compaction).
      // Each toolUseResponse: input=15, output=25. textResponse: input=10, output=20.
      // 3 tool calls + 1 final = (15*3 + 10) input, (25*3 + 20) output.
      expect(result.tokenUsage.input_tokens).toBe(15 * 3 + 10)
      expect(result.tokenUsage.output_tokens).toBe(25 * 3 + 20)
    })
  })
})
