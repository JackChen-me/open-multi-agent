import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, toolUseMsg, toolResultMsg, imageMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMMessage, LLMResponse, ReasoningBlock, StreamEvent, ToolUseBlock } from '../src/types.js'
import { UnsupportedContentBlockError, UnsupportedToolResultContentError, isRetryableError } from '../src/errors.js'

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.hoisted(() => vi.fn())
const mockStream = vi.hoisted(() => vi.fn())
const AnthropicMock = vi.hoisted(() =>
  vi.fn(() => ({
    messages: {
      create: mockCreate,
      stream: mockStream,
    },
  })),
)

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock, Anthropic: AnthropicMock }))

import { AnthropicAdapter } from '../src/llm/anthropic.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test123',
    content: [{ type: 'text', text: 'Hello' }],
    model: 'claude-sonnet-4',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  }
}

function makeStreamMock(events: Array<Record<string, unknown>>, finalMsg: Record<string, unknown>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event
    },
    finalMessage: vi.fn().mockResolvedValue(finalMsg),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new AnthropicAdapter('test-key')
  })

  it('injects a guarded fetch when an egress policy is configured', async () => {
    new AnthropicAdapter('test-key', 'https://api.anthropic.com', {
      mode: 'allowlist',
      allowedOrigins: ['https://api.anthropic.com'],
    })
    const init = AnthropicMock.mock.calls.at(-1)?.[0] as { fetch?: typeof globalThis.fetch }

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
    it('converts a text message and returns LLMResponse', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      // Verify the SDK was called with correct shape
      const callArgs = mockCreate.mock.calls[0]
      expect(callArgs[0]).toMatchObject({
        model: 'test-model',
        max_tokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      })

      // Verify response transformation
      expect(result).toEqual({
        id: 'msg_test123',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    })

    it('converts tool_use blocks to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [toolUseMsg('call_1', 'search', { query: 'test' })],
        chatOpts(),
      )

      const sentMessages = mockCreate.mock.calls[0][0].messages
      expect(sentMessages[0].content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { query: 'test' },
      })
    })

    it('converts tool_result blocks to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [toolResultMsg('call_1', 'result data', false)],
        chatOpts(),
      )

      const sentMessages = mockCreate.mock.calls[0][0].messages
      expect(sentMessages[0].content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'result data',
        is_error: false,
      })
    })

    it('maps rich tool_result images and PDF files without dropping either', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Rendered preview' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
              },
              {
                type: 'file',
                filename: 'report.pdf',
                source: {
                  type: 'url',
                  media_type: 'application/pdf',
                  url: 'https://example.com/report.pdf',
                },
              },
            ],
          }],
        }],
        chatOpts(),
      )

      const sentContent = mockCreate.mock.calls[0][0].messages[0].content
      expect(sentContent[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'text', text: 'Rendered preview' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
          },
          { type: 'text', text: '[File attachment follows: report.pdf]' },
        ],
        is_error: undefined,
      })
      expect(sentContent[1]).toEqual({
        type: 'document',
        title: 'report.pdf',
        source: { type: 'url', url: 'https://example.com/report.pdf' },
      })
    })

    it('fails explicitly for a rich file type Anthropic cannot carry', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await expect(adapter.chat(
        [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{
              type: 'file',
              filename: 'notes.txt',
              source: { type: 'base64', media_type: 'text/plain', data: 'bm90ZXM=' },
            }],
          }],
        }],
        chatOpts(),
      )).rejects.toThrow(UnsupportedToolResultContentError)
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('rejects video blocks with a terminal error before sending', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      const call = adapter.chat(
        [{
          role: 'user',
          content: [{
            type: 'video',
            source: { type: 'base64', media_type: 'video/mp4', data: 'dmlkZW8=' },
          }],
        }],
        chatOpts(),
      )

      await expect(call).rejects.toThrow(UnsupportedContentBlockError)
      expect(mockCreate).not.toHaveBeenCalled()
      await call.catch((error: unknown) => {
        expect(isRetryableError(error)).toBe(false)
        expect((error as UnsupportedContentBlockError).blockType).toBe('video')
      })
    })

    it('converts image blocks to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat([imageMsg('image/png', 'base64data')], chatOpts())

      const sentMessages = mockCreate.mock.calls[0][0].messages
      expect(sentMessages[0].content[0]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'base64data',
        },
      })
    })

    it('passes system prompt as top-level parameter', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ systemPrompt: 'You are helpful.' }),
      )

      expect(mockCreate.mock.calls[0][0].system).toBe('You are helpful.')
    })

    it('converts tools to Anthropic format', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const tool = toolDef('search', 'Search the web')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ tools: [tool] }),
      )

      const sentTools = mockCreate.mock.calls[0][0].tools
      expect(sentTools[0]).toEqual({
        name: 'search',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      })
    })

    it('passes temperature through', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ temperature: 0.5 }),
      )

      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.5)
    })

    it('passes abortSignal to SDK request options', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const controller = new AbortController()

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ abortSignal: controller.signal }),
      )

      expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('defaults max_tokens to 4096 when unset', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        { model: 'test-model' },
      )

      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(4096)
    })

    it('converts tool_use response blocks from Anthropic', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({
        content: [
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
        ],
        stop_reason: 'tool_use',
      }))

      const result = await adapter.chat([textMsg('user', 'search')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'test' },
      })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('maps thinking blocks to reasoning content', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({
        content: [{ type: 'thinking', thinking: 'hmm...' }],
      }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: 'hmm...',
        provenance: 'anthropic',
      })
    })

    it('defaults stop_reason to end_turn when null', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({ stop_reason: null }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('end_turn')
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
    it('yields text events from text_delta', async () => {
      const streamObj = makeStreamMock(
        [
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        ],
        makeAnthropicResponse({ content: [{ type: 'text', text: 'Hello world' }] }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])
    })

    it('yields reasoning events from thinking_delta and retains them in done content', async () => {
      const streamObj = makeStreamMock(
        [
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step 1' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' -> step 2' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
        ],
        makeAnthropicResponse({
          content: [
            { type: 'thinking', thinking: 'step 1 -> step 2' },
            { type: 'text', text: 'Answer' },
          ],
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const reasoningEvents = events.filter(e => e.type === 'reasoning')
      expect(reasoningEvents).toEqual([
        { type: 'reasoning', data: 'step 1' },
        { type: 'reasoning', data: ' -> step 2' },
      ])

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).content).toEqual([
        { type: 'reasoning', text: 'step 1 -> step 2', provenance: 'anthropic' },
        { type: 'text', text: 'Answer' },
      ])
    })

    it('accumulates tool input JSON and emits tool_use on content_block_stop', async () => {
      const streamObj = makeStreamMock(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'search' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"qu' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'ery":"test"}' },
          },
          { type: 'content_block_stop', index: 0 },
        ],
        makeAnthropicResponse({
          content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } }],
          stop_reason: 'tool_use',
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      const block = toolEvents[0].data as ToolUseBlock
      expect(block).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { query: 'test' },
      })
    })

    it('handles malformed tool JSON gracefully (defaults to empty object)', async () => {
      const streamObj = makeStreamMock(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'broken' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{invalid' },
          },
          { type: 'content_block_stop', index: 0 },
        ],
        makeAnthropicResponse({
          content: [{ type: 'tool_use', id: 'call_1', name: 'broken', input: {} }],
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect((toolEvents[0].data as ToolUseBlock).input).toEqual({})
    })

    it('yields done event with complete LLMResponse', async () => {
      const final = makeAnthropicResponse({
        content: [{ type: 'text', text: 'Done' }],
      })
      const streamObj = makeStreamMock([], final)
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      const response = doneEvents[0].data as LLMResponse
      expect(response.id).toBe('msg_test123')
      expect(response.content).toEqual([{ type: 'text', text: 'Done' }])
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('yields error event when stream throws', async () => {
      const streamObj = {
        [Symbol.asyncIterator]: async function* () {
          throw new Error('Stream failed')
        },
        finalMessage: vi.fn(),
      }
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0].data as Error).message).toBe('Stream failed')
    })

    it('passes system prompt and tools to stream call', async () => {
      const streamObj = makeStreamMock([], makeAnthropicResponse())
      mockStream.mockReturnValue(streamObj)
      const tool = toolDef('search')

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ systemPrompt: 'Be helpful', tools: [tool] }),
        ),
      )

      const callArgs = mockStream.mock.calls[0][0]
      expect(callArgs.system).toBe('Be helpful')
      expect(callArgs.tools[0].name).toBe('search')
    })

    it('passes abortSignal to stream request options', async () => {
      const streamObj = makeStreamMock([], makeAnthropicResponse())
      mockStream.mockReturnValue(streamObj)
      const controller = new AbortController()

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ abortSignal: controller.signal }),
        ),
      )

      expect(mockStream.mock.calls[0][1]).toEqual({ signal: controller.signal })
    })

    it('handles multiple tool calls in one stream', async () => {
      const streamObj = makeStreamMock(
        [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'search' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c2', name: 'read' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
          { type: 'content_block_stop', index: 1 },
        ],
        makeAnthropicResponse({
          content: [
            { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'a' } },
            { type: 'tool_use', id: 'c2', name: 'read', input: { path: 'b' } },
          ],
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(2)
      expect((toolEvents[0].data as ToolUseBlock).name).toBe('search')
      expect((toolEvents[1].data as ToolUseBlock).name).toBe('read')
    })
  })

  // =========================================================================
  // Extended thinking (RFC #200 — reasoning preservation)
  // =========================================================================

  describe('extended thinking', () => {
    // -----------------------------------------------------------------------
    // Incoming: response → ReasoningBlock
    // -----------------------------------------------------------------------

    it('extracts signature from thinking response blocks', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({
        content: [
          { type: 'thinking', thinking: 'reasoning text', signature: 'sig-abc-123' },
          { type: 'text', text: 'final answer' },
        ],
      }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: 'reasoning text',
        signature: 'sig-abc-123',
        provenance: 'anthropic',
      })
      expect(result.content[1]).toEqual({ type: 'text', text: 'final answer' })
    })

    it('extracts redacted_thinking response blocks as ReasoningBlock with redactedData', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse({
        content: [
          { type: 'redacted_thinking', data: 'opaque-encrypted-payload' },
          { type: 'text', text: 'answer' },
        ],
      }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: '',
        redactedData: 'opaque-encrypted-payload',
        provenance: 'anthropic',
      })
    })

    it('extracts signature from streamed final message', async () => {
      const streamObj = makeStreamMock(
        [
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step 1' } },
        ],
        makeAnthropicResponse({
          content: [
            { type: 'thinking', thinking: 'step 1', signature: 'streamed-sig' },
            { type: 'text', text: 'done' },
          ],
        }),
      )
      mockStream.mockReturnValue(streamObj)

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).content[0]).toEqual({
        type: 'reasoning',
        text: 'step 1',
        signature: 'streamed-sig',
        provenance: 'anthropic',
      })
    })

    // -----------------------------------------------------------------------
    // Outgoing: ReasoningBlock → request param
    // -----------------------------------------------------------------------

    it('echoes thinking block (with signature) back as a thinking block param', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: 'previous reasoning',
        signature: 'echo-sig-789',
        provenance: 'anthropic',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [reasoning, { type: 'tool_use', id: 't1', name: 's', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([
        { type: 'thinking', thinking: 'previous reasoning', signature: 'echo-sig-789' },
        { type: 'tool_use', id: 't1', name: 's', input: {} },
      ])
    })

    it('echoes redacted_thinking back as a redacted_thinking block param', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: '',
        redactedData: 'opaque-payload',
        provenance: 'anthropic',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [reasoning, { type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque-payload' })
    })

    it('drops reasoning blocks lacking signature and redactedData', async () => {
      // Cross-provider reasoning (e.g. carried over from a Gemini turn) has
      // no Anthropic signature and would be rejected by the API; dropping is
      // safer than letting the request fail.
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      const messages: LLMMessage[] = [
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'unsigned reasoning' },
          { type: 'text', text: 'reply' },
        ] },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([{ type: 'text', text: 'reply' }])
    })

    // -----------------------------------------------------------------------
    // Request param: thinking config forwarding
    // -----------------------------------------------------------------------

    it('forwards thinking config to chat() request', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ maxTokens: 4096, thinking: { enabled: true, budgetTokens: 2048 } }),
      )

      expect(mockCreate.mock.calls[0][0].thinking).toEqual({
        type: 'enabled',
        budget_tokens: 2048,
      })
    })

    it('forwards thinking config to stream() request', async () => {
      const streamObj = makeStreamMock([], makeAnthropicResponse())
      mockStream.mockReturnValue(streamObj)

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ maxTokens: 8192, thinking: { enabled: true, budgetTokens: 4096 } }),
        ),
      )

      expect(mockStream.mock.calls[0][0].thinking).toEqual({
        type: 'enabled',
        budget_tokens: 4096,
      })
    })

    it('defaults budget_tokens to 1024 when enabled without explicit value', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      // maxTokens must exceed the 1024 default budget — the API enforces
      // budget_tokens < max_tokens.
      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ maxTokens: 4096, thinking: { enabled: true } }),
      )

      expect(mockCreate.mock.calls[0][0].thinking).toEqual({
        type: 'enabled',
        budget_tokens: 1024,
      })
    })

    it('omits thinking field when config is absent or disabled', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      expect(mockCreate.mock.calls[0][0].thinking).toBeUndefined()

      mockCreate.mockResolvedValue(makeAnthropicResponse())
      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: false, budgetTokens: 2048 } }),
      )
      expect(mockCreate.mock.calls[1][0].thinking).toBeUndefined()
    })

    it('throws when thinking.budgetTokens is below the 1024 minimum', async () => {
      await expect(
        adapter.chat(
          [textMsg('user', 'Hi')],
          chatOpts({ maxTokens: 4096, thinking: { enabled: true, budgetTokens: 500 } }),
        ),
      ).rejects.toThrow(/budgetTokens must be >= 1024/)
    })

    it('throws when thinking.budgetTokens >= maxTokens', async () => {
      await expect(
        adapter.chat(
          [textMsg('user', 'Hi')],
          chatOpts({ maxTokens: 4096, thinking: { enabled: true, budgetTokens: 4096 } }),
        ),
      ).rejects.toThrow(/budgetTokens \(4096\) must be < maxTokens \(4096\)/)
    })

    it('throws when default 1024 budget collides with maxTokens=1024', async () => {
      // Regression for owner's #205 review: a caller passing
      // `thinking.enabled = true` with the default maxTokens 1024 (or the
      // SDK default 4096 plus an explicit small maxTokens) would otherwise
      // hit a runtime 400 from Anthropic. We catch it before the request.
      await expect(
        adapter.chat(
          [textMsg('user', 'Hi')],
          chatOpts({ maxTokens: 1024, thinking: { enabled: true } }),
        ),
      ).rejects.toThrow(/budgetTokens \(1024\) must be < maxTokens \(1024\)/)
    })
  })

  // =========================================================================
  // Phase 2 of #223 — cross-provider <thinking> text fallback (outbound)
  // =========================================================================

  describe('reasoning text fallback (#223 Phase 2)', () => {
    it('default-off: foreign-provenance reasoning is dropped (regression guard)', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const foreign: ReasoningBlock = {
        type: 'reasoning',
        text: 'from openai',
        provenance: 'openai',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [foreign, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([{ type: 'text', text: 'reply' }])
    })

    it('preserve=true: foreign-provenance reasoning becomes a text block', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const foreign: ReasoningBlock = {
        type: 'reasoning',
        text: 'from openai',
        provenance: 'openai',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [foreign, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts({ preserveReasoningAsText: true }))

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([
        { type: 'text', text: '<thinking>from openai</thinking>' },
        { type: 'text', text: 'reply' },
      ])
    })

    it('preserve=true: own-provenance signed block still native-echoes (no fallback)', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const own: ReasoningBlock = {
        type: 'reasoning',
        text: 'mine',
        signature: 'sig',
        provenance: 'anthropic',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [own, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts({ preserveReasoningAsText: true }))

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([
        { type: 'thinking', thinking: 'mine', signature: 'sig' },
        { type: 'text', text: 'reply' },
      ])
    })

    it('preserve=true: own-provenance unsigned block falls back to text (no signature to echo)', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const own: ReasoningBlock = {
        type: 'reasoning',
        text: 'mine but unsigned',
        provenance: 'anthropic',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [own, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts({ preserveReasoningAsText: true }))

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([
        { type: 'text', text: '<thinking>mine but unsigned</thinking>' },
        { type: 'text', text: 'reply' },
      ])
    })

    it('preserve=true: foreign redacted block uses [redacted] placeholder', async () => {
      mockCreate.mockResolvedValue(makeAnthropicResponse())
      const foreign: ReasoningBlock = {
        type: 'reasoning',
        text: '',
        redactedData: 'opaque',
        provenance: 'openai',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [foreign, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts({ preserveReasoningAsText: true }))

      const sent = mockCreate.mock.calls[0][0].messages
      expect(sent[0].content).toEqual([
        { type: 'text', text: '<thinking>[redacted]</thinking>' },
        { type: 'text', text: 'reply' },
      ])
    })
  })
})
