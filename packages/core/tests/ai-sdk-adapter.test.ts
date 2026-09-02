import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LanguageModel } from 'ai'
import { UnsupportedContentBlockError, isRetryableError } from '../src/errors.js'

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ai')>()
  return {
    ...mod,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
  }
})

import { AISdkAdapter, llmMessagesToAiSdkModelMessages } from '../src/llm/ai-sdk.js'

describe('llmMessagesToAiSdkModelMessages', () => {
  it('maps a simple user text message', () => {
    const out = llmMessagesToAiSdkModelMessages([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ])
    expect(out).toEqual([{ role: 'user', content: 'Hello' }])
  })

  it('splits tool results into tool-role messages before remaining user parts', () => {
    const out = llmMessagesToAiSdkModelMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
          { type: 'text', text: 'Continue.' },
        ],
      },
    ])
    expect(out[0]).toMatchObject({ role: 'assistant' })
    expect(out[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'lookup',
          output: { type: 'text', value: '{"ok":true}' },
        },
      ],
    })
    expect(out[2]).toEqual({ role: 'user', content: 'Continue.' })
  })

  it('marks errored tool results as error-text output', () => {
    const out = llmMessagesToAiSdkModelMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c2', name: 'fail', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'boom', is_error: true }],
      },
    ])
    const toolMsg = out[1] as { role: string; content: Array<{ output: { type: string; value: string } }> }
    expect(toolMsg.role).toBe('tool')
    expect(toolMsg.content[0]?.output).toEqual({ type: 'error-text', value: 'boom' })
  })

  it('maps rich tool results to AI SDK content output without text serialization', () => {
    const out = llmMessagesToAiSdkModelMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c3', name: 'render', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'c3',
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
      },
    ])

    const toolMsg = out[1] as {
      role: string
      content: Array<{ output: { type: string; value: unknown[] } }>
    }
    expect(toolMsg.content[0]?.output).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Rendered preview' },
        { type: 'file-data', data: 'aW1hZ2U=', mediaType: 'image/png' },
        { type: 'text', text: '[File: report.pdf; application/pdf]' },
        { type: 'file-url', url: 'https://example.com/report.pdf' },
      ],
    })
  })

  it('rejects video blocks instead of silently dropping them', () => {
    const convert = () => llmMessagesToAiSdkModelMessages([
      {
        role: 'user',
        content: [
          {
            type: 'video',
            source: { type: 'url', media_type: 'video/mp4', url: 'https://example.com/video.mp4' },
          },
        ],
      },
    ])

    expect(convert).toThrow(UnsupportedContentBlockError)
    // Typed, not a bare Error: the run is failed permanently rather than
    // retried through the backoff ladder on a capability that cannot appear.
    try {
      convert()
      expect.unreachable('conversion should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedContentBlockError)
      expect((error as UnsupportedContentBlockError).blockType).toBe('video')
      expect((error as UnsupportedContentBlockError).provider).toContain('AI SDK')
      expect(isRetryableError(error)).toBe(false)
    }
  })

  it('does not serialize opaque redacted reasoning payloads', () => {
    // Security regression guard (upstream 6b63302): the back-compat default-off
    // path must never leak the opaque `redactedData` blob into the AI SDK
    // request body. We emit ONLY the `[redacted_thinking]` marker.
    const out = llmMessagesToAiSdkModelMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '',
            redactedData: 'opaque-redacted-thinking-payload',
          },
        ],
      },
    ])

    const assistant = out[0] as { role: string; content: Array<{ type: string; text: string }> }
    expect(assistant.content[0]).toEqual({ type: 'reasoning', text: '[redacted_thinking]' })
    expect(JSON.stringify(out)).not.toContain('opaque-redacted-thinking-payload')
  })

  describe('reasoning text fallback (#223 Phase 2)', () => {
    it('default-off: reasoning passes through as AI SDK structured part (back-compat)', () => {
      const out = llmMessagesToAiSdkModelMessages([
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'plan', provenance: 'openai' },
            { type: 'text', text: 'reply' },
          ],
        },
      ])
      const assistant = out[0] as { content: Array<{ type: string; text: string }> }
      expect(assistant.content).toEqual([
        { type: 'reasoning', text: 'plan' },
        { type: 'text', text: 'reply' },
      ])
    })

    it('preserve=true: reasoning becomes a text part wrapped in <thinking>', () => {
      const out = llmMessagesToAiSdkModelMessages(
        [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'plan', provenance: 'openai' },
              { type: 'text', text: 'reply' },
            ],
          },
        ],
        { preserveReasoningAsText: true },
      )
      const assistant = out[0] as { content: Array<{ type: string; text: string }> }
      expect(assistant.content).toEqual([
        { type: 'text', text: '<thinking>plan</thinking>' },
        { type: 'text', text: 'reply' },
      ])
    })

    it('preserve=true: redacted reasoning becomes [redacted] placeholder', () => {
      const out = llmMessagesToAiSdkModelMessages(
        [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '', redactedData: 'opaque', provenance: 'anthropic' },
              { type: 'text', text: 'reply' },
            ],
          },
        ],
        { preserveReasoningAsText: true },
      )
      const assistant = out[0] as { content: Array<{ type: string; text: string }> }
      expect(assistant.content).toEqual([
        { type: 'text', text: '<thinking>[redacted]</thinking>' },
        { type: 'text', text: 'reply' },
      ])
    })
  })
})

describe('AISdkAdapter', () => {
  const dummyModel = { _brand: 'test' } as unknown as LanguageModel

  beforeEach(() => {
    generateTextMock.mockReset()
    streamTextMock.mockReset()
  })

  it('calls generateText and maps the result to LLMResponse', async () => {
    generateTextMock.mockResolvedValue({
      text: 'Hello',
      reasoningText: undefined,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      response: { id: 'gen-1', modelId: 'gpt-test' },
    })

    const adapter = new AISdkAdapter(dummyModel)
    const res = await adapter.chat([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], {
      model: 'gpt-test',
    })

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const arg = generateTextMock.mock.calls[0]![0] as { model: unknown; messages: unknown[]; system?: string }
    expect(arg.model).toBe(dummyModel)
    expect(arg.messages).toEqual([{ role: 'user', content: 'Hi' }])

    expect(res.id).toBe('gen-1')
    expect(res.model).toBe('gpt-test')
    expect(res.stop_reason).toBe('end_turn')
    expect(res.usage).toEqual({ input_tokens: 2, output_tokens: 3 })
    expect(res.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('maps tool-calls finish reason to tool_use', async () => {
    generateTextMock.mockResolvedValue({
      text: '',
      reasoningText: undefined,
      toolCalls: [{ toolCallId: 'tc1', toolName: 'add', input: { a: 1 } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      response: { id: 'r2', modelId: 'gpt-test' },
    })

    const adapter = new AISdkAdapter(dummyModel)
    const res = await adapter.chat([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], {
      model: 'gpt-test',
    })

    expect(res.stop_reason).toBe('tool_use')
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'tc1', name: 'add', input: { a: 1 } },
    ])
  })

  it('lets extraBody override sampling defaults like temperature', async () => {
    generateTextMock.mockResolvedValue({
      text: 'ok',
      reasoningText: undefined,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      response: { id: 'r', modelId: 'm' },
    })

    const adapter = new AISdkAdapter(dummyModel)
    await adapter.chat([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], {
      model: 'm',
      temperature: 0.5,
      extraBody: { temperature: 0.99 },
    })

    const body = generateTextMock.mock.calls[0]![0] as Record<string, unknown>
    expect(body['temperature']).toBe(0.99)
  })

  it('refuses to let extraBody override structural fields (model, messages, tools)', async () => {
    generateTextMock.mockResolvedValue({
      text: 'ok',
      reasoningText: undefined,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      response: { id: 'r', modelId: 'm' },
    })

    const adapter = new AISdkAdapter(dummyModel)
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'real' }] }]
    const tools = [
      {
        name: 'lookup',
        description: 'Look up',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ]

    await adapter.chat(messages, {
      model: 'm',
      systemPrompt: 'real system',
      tools,
      extraBody: {
        model: { spoofed: true },
        messages: [],
        system: 'evil',
        tools: {},
      } as Record<string, unknown>,
    })

    const body = generateTextMock.mock.calls[0]![0] as Record<string, unknown>
    expect(body['model']).toBe(dummyModel)
    expect(body['messages']).toEqual([{ role: 'user', content: 'real' }])
    expect(body['system']).toBe('real system')
    expect(body['tools']).toBeDefined()
    expect(Object.keys(body['tools'] as object)).toEqual(['lookup'])
  })

  it('streams text deltas and a terminal done event', async () => {
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 't1', text: 'Hi' }
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        }
      })(),
      response: Promise.resolve({ id: 's1', modelId: 'stream-model' }),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    })

    const adapter = new AISdkAdapter(dummyModel)
    const events: Array<{ type: string; data?: unknown }> = []
    for await (const ev of adapter.stream([{ role: 'user', content: [{ type: 'text', text: 'Go' }] }], {
      model: 'stream-model',
    })) {
      events.push(ev)
    }

    expect(events.map(e => e.type)).toEqual(['text', 'done'])
    expect(events[0]).toEqual({ type: 'text', data: 'Hi' })
    const done = events[1] as { type: 'done'; data: { content: unknown[]; usage: { input_tokens: number; output_tokens: number } } }
    expect(done.type).toBe('done')
    expect(done.data.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
    })
  })
})
