import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, toolUseMsg, toolResultMsg, imageMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMMessage, LLMResponse, ReasoningBlock, StreamEvent, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock GoogleGenAI
// ---------------------------------------------------------------------------

const mockGenerateContent = vi.hoisted(() => vi.fn())
const mockGenerateContentStream = vi.hoisted(() => vi.fn())
const GoogleGenAIMock = vi.hoisted(() =>
  vi.fn(() => ({
    models: {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    },
  })),
)

vi.mock('@google/genai', () => ({
  GoogleGenAI: GoogleGenAIMock,
  FunctionCallingConfigMode: { AUTO: 'AUTO' },
}))

import { GeminiAdapter } from '../src/llm/gemini.js'
import { UnsupportedContentBlockError, isRetryableError } from '../src/errors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGeminiResponse(parts: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{
      content: { parts },
      finishReason: 'STOP',
      ...overrides,
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }
}

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeminiAdapter (contract)', () => {
  let adapter: GeminiAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new GeminiAdapter('test-key')
  })

  // =========================================================================
  // chat() — message conversion
  // =========================================================================

  describe('chat() message conversion', () => {
    it('converts text messages with correct role mapping', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'Hi' }]))

      await adapter.chat(
        [textMsg('user', 'Hello'), textMsg('assistant', 'Hi')],
        chatOpts(),
      )

      const callArgs = mockGenerateContent.mock.calls[0][0]
      expect(callArgs.contents[0]).toMatchObject({ role: 'user', parts: [{ text: 'Hello' }] })
      expect(callArgs.contents[1]).toMatchObject({ role: 'model', parts: [{ text: 'Hi' }] })
    })

    it('converts tool_use blocks to functionCall parts', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [toolUseMsg('call_1', 'search', { query: 'test' })],
        chatOpts(),
      )

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].functionCall).toEqual({
        id: 'call_1',
        name: 'search',
        args: { query: 'test' },
      })
    })

    it('converts tool_result blocks to functionResponse parts with name lookup', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [
          toolUseMsg('call_1', 'search', { query: 'test' }),
          toolResultMsg('call_1', 'found it'),
        ],
        chatOpts(),
      )

      const resultParts = mockGenerateContent.mock.calls[0][0].contents[1].parts
      expect(resultParts[0].functionResponse).toMatchObject({
        id: 'call_1',
        name: 'search',
        response: { content: 'found it', isError: false },
      })
    })

    it('falls back to tool_use_id as name when no matching tool_use found', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [toolResultMsg('unknown_id', 'data')],
        chatOpts(),
      )

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].functionResponse.name).toBe('unknown_id')
    })

    it('maps rich tool_result media to functionResponse parts', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

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
            is_error: false,
          }],
        }],
        chatOpts(),
      )

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].functionResponse.response).toEqual({
        content: 'Rendered preview',
        isError: false,
      })
      expect(parts[0].functionResponse.parts).toEqual([
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'aW1hZ2U=',
          },
        },
        {
          fileData: {
            mimeType: 'application/pdf',
            fileUri: 'https://example.com/report.pdf',
            displayName: 'report.pdf',
          },
        },
      ])
    })

    it('converts image blocks to inlineData parts', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat([imageMsg('image/png', 'base64data')], chatOpts())

      const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts
      expect(parts[0].inlineData).toEqual({
        mimeType: 'image/png',
        data: 'base64data',
      })
    })

    it('rejects video blocks with a terminal error before sending', async () => {
      // Gemini has native video support upstream; the gap is OMA's mapping.
      // Either way the caller gets a typed terminal failure, not a retry loop.
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

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
      expect(mockGenerateContent).not.toHaveBeenCalled()
      await call.catch((error: unknown) => {
        expect(isRetryableError(error)).toBe(false)
        expect((error as UnsupportedContentBlockError).provider).toContain('Gemini')
      })
    })
  })

  // =========================================================================
  // chat() — tools & config
  // =========================================================================

  describe('chat() tools & config', () => {
    it('converts tools to Gemini format with parametersJsonSchema', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))
      const tool = toolDef('search', 'Search')

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ tools: [tool] }))

      const config = mockGenerateContent.mock.calls[0][0].config
      expect(config.tools[0].functionDeclarations[0]).toEqual({
        name: 'search',
        description: 'Search',
        parametersJsonSchema: tool.inputSchema,
      })
      expect(config.toolConfig).toEqual({
        functionCallingConfig: { mode: 'AUTO' },
      })
    })

    it('passes systemInstruction, maxOutputTokens, temperature', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ systemPrompt: 'Be helpful', temperature: 0.7, maxTokens: 2048 }),
      )

      const config = mockGenerateContent.mock.calls[0][0].config
      expect(config.systemInstruction).toBe('Be helpful')
      expect(config.temperature).toBe(0.7)
      expect(config.maxOutputTokens).toBe(2048)
    })

    it('omits tools/toolConfig when no tools provided', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      const config = mockGenerateContent.mock.calls[0][0].config
      expect(config.tools).toBeUndefined()
      expect(config.toolConfig).toBeUndefined()
    })
  })

  // =========================================================================
  // chat() — response conversion
  // =========================================================================

  describe('chat() response conversion', () => {
    it('converts text parts to TextBlock', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'Hello' }]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello' })
    })

    it('converts functionCall parts to ToolUseBlock with existing id', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { functionCall: { id: 'call_1', name: 'search', args: { q: 'test' } } },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'test' },
      })
    })

    it('fabricates ID when functionCall has no id field', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { functionCall: { name: 'search', args: { q: 'test' } } },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      const block = result.content[0] as ToolUseBlock
      expect(block.type).toBe('tool_use')
      expect(block.id).toMatch(/^gemini-\d+-[a-z0-9]+$/)
      expect(block.name).toBe('search')
    })

    it('maps STOP finishReason to end_turn', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }], { finishReason: 'STOP' }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('end_turn')
    })

    it('maps MAX_TOKENS finishReason to max_tokens', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'trunc' }], { finishReason: 'MAX_TOKENS' }))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('max_tokens')
    })

    it('maps to tool_use when response contains functionCall (even with STOP)', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse(
        [{ functionCall: { id: 'c1', name: 'search', args: {} } }],
        { finishReason: 'STOP' },
      ))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.stop_reason).toBe('tool_use')
    })

    it('handles missing usageMetadata (defaults to 0)', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
    })

    it('handles empty candidates gracefully', async () => {
      mockGenerateContent.mockResolvedValue({ candidates: [{ content: {} }] })

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content).toEqual([])
    })

    it('throws for unsupported message block types', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await expect(adapter.chat([
        {
          role: 'user',
          content: [{ type: 'unsupported' } as never],
        },
      ], chatOpts())).rejects.toThrow('Unhandled content block type')
    })
  })

  // =========================================================================
  // stream()
  // =========================================================================

  describe('stream()', () => {
    it('yields text events for text parts', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          makeGeminiResponse([{ text: 'Hello' }]),
          makeGeminiResponse([{ text: ' world' }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toEqual([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' world' },
      ])
    })

    it('yields tool_use events for functionCall parts', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          makeGeminiResponse([{ functionCall: { id: 'c1', name: 'search', args: { q: 'test' } } }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      expect((toolEvents[0].data as ToolUseBlock).name).toBe('search')
    })

    it('accumulates token counts from usageMetadata', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          { candidates: [{ content: { parts: [{ text: 'Hi' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
          { candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      const response = done!.data as LLMResponse
      expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    })

    it('yields done event with correct stop_reason', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([makeGeminiResponse([{ text: 'ok' }], { finishReason: 'MAX_TOKENS' })]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).stop_reason).toBe('max_tokens')
    })

    it('yields error event when stream throws', async () => {
      mockGenerateContentStream.mockResolvedValue(
        (async function* () { throw new Error('Gemini error') })(),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const errorEvents = events.filter(e => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0].data as Error).message).toBe('Gemini error')
    })

    it('handles chunks with no candidates', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          { candidates: undefined, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } },
          makeGeminiResponse([{ text: 'ok' }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toHaveLength(1)
      expect(textEvents[0].data).toBe('ok')
    })
  })

  // =========================================================================
  // Extended thinking (RFC #200 — reasoning preservation)
  // =========================================================================

  describe('extended thinking', () => {
    // -----------------------------------------------------------------------
    // Incoming: response Part → ContentBlock
    // -----------------------------------------------------------------------

    it('extracts thoughtSignature from a functionCall Part as ToolUseBlock.signature', async () => {
      // thoughtSignature is a top-level field on Part — verified against
      // @google/genai Part schema (NOT nested under functionCall).
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        {
          functionCall: { id: 'fc1', name: 'search', args: { q: 'x' } },
          thoughtSignature: 'gemini-sig-001',
        },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'fc1',
        name: 'search',
        input: { q: 'x' },
        signature: 'gemini-sig-001',
      })
    })

    it('omits signature field when functionCall Part has no thoughtSignature', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { functionCall: { id: 'fc2', name: 'search', args: {} } },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'tool_use',
        id: 'fc2',
        name: 'search',
        input: {},
      })
      expect((result.content[0] as ToolUseBlock).signature).toBeUndefined()
    })

    it('extracts text Part with thought:true as ReasoningBlock', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { text: 'I should look up the weather first.', thought: true },
        { text: 'It is sunny.' },
      ]))

      const result = await adapter.chat([textMsg('user', 'Weather?')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: 'I should look up the weather first.',
        provenance: 'gemini',
      })
      expect(result.content[1]).toEqual({ type: 'text', text: 'It is sunny.' })
    })

    it('streaming yields reasoning event for thought:true text Parts', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          makeGeminiResponse([{ text: 'planning...', thought: true }]),
          makeGeminiResponse([{ text: 'done' }]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const reasoningEvents = events.filter(e => e.type === 'reasoning')
      expect(reasoningEvents).toHaveLength(1)
      expect(reasoningEvents[0].data).toBe('planning...')

      // Phase 1 of #223: stream done payload also stamps provenance.
      const done = events.find(e => e.type === 'done')
      const doneContent = (done!.data as LLMResponse).content
      const reasoningBlock = doneContent.find(b => b.type === 'reasoning')
      expect(reasoningBlock).toEqual({
        type: 'reasoning',
        text: 'planning...',
        provenance: 'gemini',
      })
    })

    it('streaming preserves thoughtSignature on tool_use events', async () => {
      mockGenerateContentStream.mockResolvedValue(
        asyncGen([
          makeGeminiResponse([
            {
              functionCall: { id: 'fc-stream', name: 'search', args: { q: 'a' } },
              thoughtSignature: 'streamed-sig',
            },
          ]),
        ]),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      expect((toolEvents[0].data as ToolUseBlock).signature).toBe('streamed-sig')
    })

    // -----------------------------------------------------------------------
    // Outgoing: ContentBlock → Part
    // -----------------------------------------------------------------------

    it('echoes ToolUseBlock.signature back as a top-level Part.thoughtSignature', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      const messages: LLMMessage[] = [
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'fc1',
            name: 'search',
            input: { q: 'x' },
            signature: 'gemini-sig-001',
          }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'fc1', content: 'res' }],
        },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockGenerateContent.mock.calls[0][0].contents
      const fcPart = sent[0].parts[0]
      // thoughtSignature must be at the Part level — not nested.
      expect(fcPart.thoughtSignature).toBe('gemini-sig-001')
      expect(fcPart.functionCall).toMatchObject({ id: 'fc1', name: 'search', args: { q: 'x' } })
      expect(fcPart.functionCall.thoughtSignature).toBeUndefined()
    })

    it('emits a clean functionCall Part when ToolUseBlock has no signature', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      const messages: LLMMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'fc2', name: 'search', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'fc2', content: 'res' }],
        },
      ]

      await adapter.chat(messages, chatOpts())

      const fcPart = mockGenerateContent.mock.calls[0][0].contents[0].parts[0]
      expect(fcPart.thoughtSignature).toBeUndefined()
    })

    it('drops unsigned ReasoningBlock on outgoing (avoid context inflation)', async () => {
      // Gemini 2.5 thought summaries never carry signatures, and unsigned
      // cross-provider reasoning has no protocol benefit to round-trip —
      // only signed reasoning is echoed back (see "echoes signed
      // ReasoningBlock" test below).
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: 'a previous thought summary',
      }
      const messages: LLMMessage[] = [
        {
          role: 'assistant',
          content: [reasoning, { type: 'text', text: 'reply' }],
        },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockGenerateContent.mock.calls[0][0].contents
      expect(sent[0].parts).toEqual([{ text: 'reply' }])
    })

    it('extracts thoughtSignature on thought-summary text Parts (Gemini 3)', async () => {
      // Gemini 3 may attach thoughtSignature to thought-summary parts. We
      // preserve it on ReasoningBlock.signature so the next turn can echo
      // it back per Gemini docs ("recommend you always pass all signatures
      // back as received").
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([
        { text: 'thought summary text', thought: true, thoughtSignature: 'thought-sig-001' },
      ]))

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: 'thought summary text',
        signature: 'thought-sig-001',
        provenance: 'gemini',
      })
    })

    it('echoes signed ReasoningBlock back as a thought-summary Part with thoughtSignature', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: 'previous thinking',
        signature: 'thought-sig-001',
        provenance: 'gemini',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [reasoning, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockGenerateContent.mock.calls[0][0].contents
      expect(sent[0].parts).toEqual([
        { text: 'previous thinking', thought: true, thoughtSignature: 'thought-sig-001' },
        { text: 'reply' },
      ])
    })

    // -----------------------------------------------------------------------
    // Request param: thinkingConfig forwarding
    // -----------------------------------------------------------------------

    it('forwards thinking config to thinkingConfig with includeThoughts and thinkingBudget', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, budgetTokens: 2048 } }),
      )

      const cfg = mockGenerateContent.mock.calls[0][0].config
      expect(cfg.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 2048,
      })
    })

    it('defaults includeThoughts=true when enabled without explicit budget', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true } }),
      )

      const cfg = mockGenerateContent.mock.calls[0][0].config
      expect(cfg.thinkingConfig).toEqual({ includeThoughts: true })
      expect(cfg.thinkingConfig.thinkingBudget).toBeUndefined()
    })

    it('omits thinkingConfig when thinking is absent or disabled', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      expect(mockGenerateContent.mock.calls[0][0].config.thinkingConfig).toBeUndefined()

      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))
      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: false, budgetTokens: 4096 } }),
      )
      expect(mockGenerateContent.mock.calls[1][0].config.thinkingConfig).toBeUndefined()
    })
  })

  // =========================================================================
  // Phase 2 of #223 — cross-provider <thinking> text fallback (outbound)
  // =========================================================================

  describe('reasoning text fallback (#223 Phase 2)', () => {
    it('default-off: foreign-provenance reasoning is dropped (regression guard)', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))
      const foreign: ReasoningBlock = {
        type: 'reasoning',
        text: 'from anthropic',
        provenance: 'anthropic',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [foreign, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts())

      const sent = mockGenerateContent.mock.calls[0][0].contents
      expect(sent[0].parts).toEqual([{ text: 'reply' }])
    })

    it('preserve=true: foreign-provenance reasoning becomes a text part', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))
      const foreign: ReasoningBlock = {
        type: 'reasoning',
        text: 'from anthropic',
        provenance: 'anthropic',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [foreign, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts({ preserveReasoningAsText: true }))

      const sent = mockGenerateContent.mock.calls[0][0].contents
      expect(sent[0].parts).toEqual([
        { text: '<thinking>from anthropic</thinking>' },
        { text: 'reply' },
      ])
    })

    it('preserve=true: own-provenance signed block still native-echoes', async () => {
      mockGenerateContent.mockResolvedValue(makeGeminiResponse([{ text: 'ok' }]))
      const own: ReasoningBlock = {
        type: 'reasoning',
        text: 'mine',
        signature: 'thought-sig',
        provenance: 'gemini',
      }
      const messages: LLMMessage[] = [
        { role: 'assistant', content: [own, { type: 'text', text: 'reply' }] },
      ]

      await adapter.chat(messages, chatOpts({ preserveReasoningAsText: true }))

      const sent = mockGenerateContent.mock.calls[0][0].contents
      expect(sent[0].parts).toEqual([
        { text: 'mine', thought: true, thoughtSignature: 'thought-sig' },
        { text: 'reply' },
      ])
    })
  })
})
