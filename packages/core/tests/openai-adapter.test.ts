import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMResponse, StreamEvent, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock OpenAI SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.hoisted(() => vi.fn())
const OpenAIMock = vi.hoisted(() =>
  vi.fn(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
)

vi.mock('openai', () => ({ default: OpenAIMock, OpenAI: OpenAIMock }))

import { OpenAIAdapter } from '../src/llm/openai.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Hello',
        tool_calls: undefined,
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  }
}

async function* makeChunks(chunks: Array<Record<string, unknown>>) {
  for (const chunk of chunks) yield chunk
}

function textChunk(text: string, finish_reason: string | null = null, usage: Record<string, number> | null = null) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      delta: { content: text },
      finish_reason,
    }],
    usage,
  }
}

function reasoningChunk(reasoning: string, finish_reason: string | null = null, usage: Record<string, number> | null = null) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      delta: { reasoning_content: reasoning },
      finish_reason,
    }],
    usage,
  }
}

function toolCallChunk(index: number, id: string | undefined, name: string | undefined, args: string, finish_reason: string | null = null) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          id,
          function: {
            name,
            arguments: args,
          },
        }],
      },
      finish_reason,
    }],
    usage: null,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new OpenAIAdapter('test-key')
  })

  it('injects a guarded fetch when an egress policy is configured', async () => {
    new OpenAIAdapter('test-key', 'https://api.openai.com/v1', {
      mode: 'allowlist',
      allowedOrigins: ['https://api.openai.com'],
    })
    const init = OpenAIMock.mock.calls.at(-1)?.[0] as { fetch?: typeof globalThis.fetch }

    expect(init.fetch).toEqual(expect.any(Function))
    await expect(init.fetch!('https://other.example/v1')).rejects.toMatchObject({
      code: 'EGRESS_POLICY_DENIED',
      origin: 'https://other.example',
    })
  })

  // =========================================================================
  // chat()
  // =========================================================================

  describe('chat()', () => {
    it('calls SDK with correct parameters and returns LLMResponse', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      const callArgs = mockCreate.mock.calls[0][0]
      expect(callArgs.model).toBe('test-model')
      expect(callArgs.stream).toBe(false)
      expect(callArgs.max_tokens).toBe(1024)

      expect(result).toEqual({
        id: 'chatcmpl-123',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'gpt-4o',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    })

    it('passes tools as OpenAI format', async () => {
      mockCreate.mockResolvedValue(makeCompletion())
      const tool = toolDef('search', 'Search')

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ tools: [tool] }))

      const sentTools = mockCreate.mock.calls[0][0].tools
      expect(sentTools[0]).toEqual({
        type: 'function',
        function: {
          name: 'search',
          description: 'Search',
          parameters: tool.inputSchema,
        },
      })
    })

    it('passes temperature through', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ temperature: 0.3 }))

      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.3)
    })

    it('passes abortSignal to request options', async () => {
      mockCreate.mockResolvedValue(makeCompletion())
      const controller = new AbortController()

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ abortSignal: controller.signal }),
      )

      expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('handles tool_calls in response', async () => {
      mockCreate.mockResolvedValue(makeCompletion({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"test"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }))

      const result = await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ tools: [toolDef('search')] }),
      )

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'test' },
      })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('retains reasoning_content as a reasoning block', async () => {
      mockCreate.mockResolvedValue(makeCompletion({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Final answer',
            reasoning_content: 'step 1 -> step 2',
            tool_calls: undefined,
          },
          finish_reason: 'stop',
        }],
      }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content).toEqual([
        { type: 'reasoning', text: 'step 1 -> step 2', provenance: 'openai' },
        { type: 'text', text: 'Final answer' },
      ])
    })

    it('extracts fallback text tool calls using the requested tool names', async () => {
      // When native tool_calls is empty but text contains tool JSON, the adapter
      // should invoke extractToolCallsFromText with known tool names.
      // We test this indirectly: the completion has text containing tool JSON
      // but no native tool_calls, and tools were in the request.
      mockCreate.mockResolvedValue(makeCompletion({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '{"name":"search","input":{"q":"test"}}',
            tool_calls: undefined,
          },
          finish_reason: 'stop',
        }],
      }))

      const result = await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ tools: [toolDef('search')] }),
      )

      const toolBlocks = result.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      expect(toolBlocks).toHaveLength(1)
      expect(toolBlocks[0]).toEqual({
        type: 'tool_use',
        id: expect.any(String),
        name: 'search',
        input: { q: 'test' },
      })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('propagates SDK errors', async () => {
      mockCreate.mockRejectedValue(new Error('Rate limited'))

      await expect(
        adapter.chat([textMsg('user', 'Hi')], chatOpts()),
      ).rejects.toThrow('Rate limited')
    })
  })

  // =========================================================================
  // stream()
  // =========================================================================

  describe('stream()', () => {
    it('calls SDK with stream: true and include_usage', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        textChunk('Hi', 'stop', { prompt_tokens: 5, completion_tokens: 2 }),
      ]))

      await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const callArgs = mockCreate.mock.calls[0][0]
      expect(callArgs.stream).toBe(true)
      expect(callArgs.stream_options).toEqual({ include_usage: true })
    })

    it('yields text events from content deltas', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        textChunk('Hello'),
        textChunk(' world', 'stop', { prompt_tokens: 5, completion_tokens: 3 }),
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])
    })

    it('yields reasoning events from reasoning_content deltas and retains them in done content', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        reasoningChunk('first thought'),
        reasoningChunk(' then second thought'),
        textChunk('Answer', 'stop'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 8, completion_tokens: 5 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const reasoningEvents = events.filter(e => e.type === 'reasoning')
      expect(reasoningEvents).toEqual([
        { type: 'reasoning', data: 'first thought' },
        { type: 'reasoning', data: ' then second thought' },
      ])

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).content).toEqual([
        { type: 'reasoning', text: 'first thought then second thought', provenance: 'openai' },
        { type: 'text', text: 'Answer' },
      ])
    })

    it('accumulates tool_calls across chunks and emits tool_use after stream', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        toolCallChunk(0, 'call_1', 'search', '{"q":'),
        toolCallChunk(0, undefined, undefined, '"test"}', 'tool_calls'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      const block = toolEvents[0].data as ToolUseBlock
      expect(block).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'test' },
      })
    })

    it('yields done event with usage from final chunk', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        textChunk('Hi', 'stop'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      const response = done!.data as LLMResponse
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 2 })
      expect(response.id).toBe('chatcmpl-123')
      expect(response.model).toBe('gpt-4o')
    })

    it('resolves stop_reason to tool_use when tool blocks present but finish_reason is stop', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        toolCallChunk(0, 'call_1', 'search', '{"q":"x"}', 'stop'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).stop_reason).toBe('tool_use')
    })

    it('handles malformed tool arguments JSON', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        toolCallChunk(0, 'call_1', 'search', '{broken', 'tool_calls'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect((toolEvents[0].data as ToolUseBlock).input).toEqual({})
    })

    it('repairs triple-quoted tool arguments through the shared helper', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        toolCallChunk(0, 'call_1', 'search', '{"query": """hello"""}', 'tool_calls'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect((toolEvents[0].data as ToolUseBlock).input).toEqual({ query: 'hello' })
    })

    it('yields error event on stream failure', async () => {
      mockCreate.mockResolvedValue(
        (async function* () { throw new Error('Stream exploded') })(),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0].data as Error).message).toBe('Stream exploded')
    })

    it('passes abortSignal to stream request options', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        textChunk('Hi', 'stop', { prompt_tokens: 5, completion_tokens: 1 }),
      ]))
      const controller = new AbortController()

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ abortSignal: controller.signal }),
        ),
      )

      expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('handles multiple tool calls', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        toolCallChunk(0, 'call_1', 'search', '{"q":"a"}'),
        toolCallChunk(1, 'call_2', 'read', '{"path":"b"}', 'tool_calls'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(2)
      expect((toolEvents[0].data as ToolUseBlock).name).toBe('search')
      expect((toolEvents[1].data as ToolUseBlock).name).toBe('read')
    })

    it('falls back to extracting tool calls from streamed text when no native tool deltas exist', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        textChunk('```json\n{"name":"search","input":{"query":"fallback"}}\n```', 'stop'),
        { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 6, completion_tokens: 4 } },
      ]))

      const events = await collectEvents(
        adapter.stream(
          [textMsg('user', 'Search for fallback handling')],
          chatOpts({ tools: [toolDef('search')] }),
        ),
      )

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      expect(toolEvents[0].data).toEqual({
        type: 'tool_use',
        id: expect.any(String),
        name: 'search',
        input: { query: 'fallback' },
      })

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).stop_reason).toBe('tool_use')
    })
  })

  // =========================================================================
  // reasoning_effort forwarding (RFC #200 follow-up)
  // =========================================================================

  describe('reasoning_effort forwarding', () => {
    it('forwards thinking.effort as reasoning_effort on chat()', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, effort: 'low' } }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('low')
    })

    it('forwards thinking.effort as reasoning_effort on stream()', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        textChunk('ok', 'stop', { prompt_tokens: 1, completion_tokens: 1 }),
      ]))

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ thinking: { enabled: true, effort: 'high' } }),
        ),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('high')
    })

    it('passes through newer effort values via extraBody (e.g. gpt-5 "minimal")', async () => {
      // Values outside the framework union (gpt-5 'minimal', GPT-5.5
      // 'none') travel via extraBody — the same escape hatch as vLLM-only
      // top_k/min_p.
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ extraBody: { reasoning_effort: 'minimal' } }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('minimal')
    })

    it('ignores the DeepSeek-only max effort', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, effort: 'max' } }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()
    })

    it('omits reasoning_effort when thinking is absent', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()
    })

    it('omits reasoning_effort when thinking.effort is unset', async () => {
      // OpenAI's reasoning surface is qualitative (effort) only; the
      // enabled/budgetTokens fields don't map to OpenAI Chat Completions
      // and are ignored. A caller setting `enabled: true` without `effort`
      // gets no reasoning_effort forwarded — they'd hit OpenAI's server
      // default for reasoning models.
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, budgetTokens: 2048 } }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()
    })

    it('lets extraBody.reasoning_effort override thinking.effort', async () => {
      // Field-ordering contract: sampling params come before extraBody so
      // extraBody can override them. Verify reasoning_effort obeys that
      // contract along with the other sampling fields.
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({
          thinking: { enabled: true, effort: 'low' },
          extraBody: { reasoning_effort: 'high' },
        }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('high')
    })
  })
})
