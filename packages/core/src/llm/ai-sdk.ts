/**
 * @fileoverview {@link AISdkAdapter} — bridge to the Vercel AI SDK (`ai` + `@ai-sdk/*`).
 *
 * When {@link AgentConfig.adapter} is set, {@link Agent} skips {@link createAdapter}
 * and uses this implementation instead. Install the optional peer `ai` and the
 * provider package you need (for example `@ai-sdk/openai`).
 */

import type { JSONSchema7, JSONValue, SharedV2ProviderOptions } from '@ai-sdk/provider'
import type { LanguageModel, ModelMessage } from 'ai'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
  TextBlock,
  TokenUsage,
  ToolUseBlock,
} from '../types.js'
import { normalizeFinishReason } from './openai-common.js'
import { assertValidMessages } from './validate.js'
import {
  reasoningBlockToInlineText,
  resolveReasoningOutboundMaxChars,
  type ReasoningOutboundOptions,
} from './reasoning-fallback.js'
import { toolResultContentParts } from '../tool/result.js'

// ---------------------------------------------------------------------------
// Message conversion — OMA <-> AI SDK ModelMessage
// ---------------------------------------------------------------------------

function collectToolNamesByCallId(messages: readonly LLMMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') map.set(block.id, block.name)
    }
  }
  return map
}

/**
 * Convert framework {@link LLMMessage}s to AI SDK {@link ModelMessage}s.
 * Exported for unit tests and for callers who need to preflight prompts.
 */
export function llmMessagesToAiSdkModelMessages(
  messages: readonly LLMMessage[],
  outboundOptions?: ReasoningOutboundOptions,
): ModelMessage[] {
  const toolNamesByCallId = collectToolNamesByCallId(messages)
  const out: ModelMessage[] = []
  // When `preserveReasoningAsText` is enabled, swap the AI SDK structured
  // reasoning emit for a `<thinking>` text part — honouring the adapter's
  // declared `'never'` capability (see #223 Phase 2). When the flag is off,
  // we preserve the pre-Phase-2 behaviour of passing structured reasoning
  // through to the AI SDK provider, since some providers may handle it.
  const preserveAsText = outboundOptions?.preserveReasoningAsText === true
  const maxChars = resolveReasoningOutboundMaxChars(outboundOptions)

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const acc: Array<
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      for (const block of msg.content) {
        if (block.type === 'text') {
          acc.push({ type: 'text', text: block.text })
        } else if (block.type === 'reasoning') {
          if (preserveAsText) {
            const text = maxChars === undefined
              ? reasoningBlockToInlineText(block)
              : reasoningBlockToInlineText(block, { maxChars })
            if (text.length > 0) acc.push({ type: 'text', text })
          } else {
            // Default-off back-compat path: pass framework reasoning through
            // as AI SDK structured `{ type: 'reasoning' }`. For redacted
            // blocks emit ONLY the `[redacted_thinking]` marker — never the
            // opaque `redactedData` payload (would leak Anthropic-issued
            // encrypted content into the AI SDK provider's request body;
            // hardened upstream in 6b63302).
            const text =
              block.redactedData !== undefined && block.redactedData.length > 0
                ? '[redacted_thinking]'
                : block.text
            acc.push({ type: 'reasoning', text })
          }
        } else if (block.type === 'tool_use') {
          acc.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          })
        }
        // image / tool_result in assistant role are ignored (non-canonical)
      }
      if (acc.length > 0) out.push({ role: 'assistant', content: acc } as ModelMessage)
    } else {
      const toolResults = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      const other = msg.content.filter(b => b.type !== 'tool_result')

      for (const tr of toolResults) {
        const toolName = toolNamesByCallId.get(tr.tool_use_id) ?? 'unknown_tool'
        const richValue: Array<
          | { type: 'text'; text: string }
          | { type: 'file-data'; data: string; mediaType: string; filename?: string }
          | { type: 'file-url'; url: string }
        > = []
        if (typeof tr.content !== 'string') {
          for (const part of toolResultContentParts(tr.content)) {
            if (part.type === 'text') {
              richValue.push({ type: 'text', text: part.text })
            } else if (part.source.type === 'base64') {
              richValue.push({
                type: 'file-data',
                data: part.source.data,
                mediaType: part.source.media_type,
                ...(part.type === 'file' ? { filename: part.filename } : {}),
              })
            } else {
              if (part.type === 'file') {
                richValue.push({
                  type: 'text',
                  text: `[File: ${part.filename}; ${part.source.media_type}]`,
                })
              }
              richValue.push({ type: 'file-url', url: part.source.url })
            }
          }
        }
        const output = typeof tr.content === 'string'
          ? tr.is_error
            ? ({ type: 'error-text', value: tr.content } as const)
            : ({ type: 'text', value: tr.content } as const)
          : ({
              type: 'content',
              value: richValue,
            } as const)
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: tr.tool_use_id,
              toolName,
              output,
            },
          ],
        } as ModelMessage)
      }

      if (other.length === 0) continue

      if (other.length === 1 && other[0]?.type === 'text') {
        out.push({ role: 'user', content: other[0].text })
        continue
      }

      const userParts: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; image: Uint8Array; mediaType?: string }
      > = []
      for (const block of other) {
        if (block.type === 'text') userParts.push({ type: 'text', text: block.text })
        else if (block.type === 'image') {
          const bytes = Buffer.from(block.source.data, 'base64')
          userParts.push({
            type: 'image',
            image: new Uint8Array(bytes),
            mediaType: block.source.media_type,
          })
        } else if (block.type === 'video') {
          throw new Error('This adapter does not support video content blocks')
        }
      }
      if (userParts.length > 0) out.push({ role: 'user', content: userParts } as ModelMessage)
    }
  }

  return out
}

function mapFinishReason(reason: string, hasToolCalls: boolean): string {
  if (hasToolCalls && reason === 'stop') return 'tool_use'
  const mapped =
    reason === 'tool-calls'
      ? 'tool_calls'
      : reason === 'content-filter'
        ? 'content_filter'
        : reason
  return normalizeFinishReason(mapped === 'tool_calls' ? 'tool_calls' : mapped === 'content_filter' ? 'content_filter' : mapped)
}

function usageToOma(u: { inputTokens?: number | undefined; outputTokens?: number | undefined }): TokenUsage {
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
  }
}

function buildLlmResponseFromGenerateText(result: {
  readonly text: string
  readonly reasoningText: string | undefined
  readonly toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>
  readonly finishReason: string
  readonly usage: { inputTokens?: number; outputTokens?: number }
  readonly response: { id?: string; modelId?: string }
}): LLMResponse {
  const content: ContentBlock[] = []
  if (result.reasoningText !== undefined && result.reasoningText.length > 0) {
    content.push({ type: 'reasoning', text: result.reasoningText, provenance: 'ai-sdk' })
  }
  if (result.text.length > 0) {
    content.push({ type: 'text', text: result.text } satisfies TextBlock)
  }
  for (const tc of result.toolCalls) {
    const input =
      tc.input !== null && typeof tc.input === 'object' && !Array.isArray(tc.input)
        ? (tc.input as Record<string, unknown>)
        : {}
    content.push({
      type: 'tool_use',
      id: tc.toolCallId,
      name: tc.toolName,
      input,
    } satisfies ToolUseBlock)
  }

  const hasToolCalls = content.some(b => b.type === 'tool_use')
  return {
    id: result.response.id ?? '',
    content,
    model: result.response.modelId ?? '',
    stop_reason: mapFinishReason(result.finishReason, hasToolCalls),
    usage: usageToOma(result.usage),
  }
}

// ---------------------------------------------------------------------------
// AISdkAdapter
// ---------------------------------------------------------------------------

/**
 * {@link LLMAdapter} implementation backed by the Vercel AI SDK `generateText` /
 * `streamText` APIs. Pass any `LanguageModel` from an `@ai-sdk/*` provider.
 */
export class AISdkAdapter implements LLMAdapter {
  readonly name = 'ai-sdk'

  readonly capabilities = {
    // `'never'` means: this framework cannot natively round-trip a
    // {@link ReasoningBlock} into the AI SDK in a provider-agnostic way —
    // the AI SDK proxies many providers and we can't introspect at
    // IR-conversion time which underlying provider would accept reasoning.
    //
    // When `preserveReasoningAsText` is set, the outbound conversion in
    // `llmMessagesToAiSdkModelMessages` honours this by downgrading to
    // inline `<thinking>` text via the shared helper.
    //
    // When the opt-in is OFF, however, we keep the pre-Phase-2 back-compat
    // behaviour of passing the framework's `ReasoningBlock` through as an
    // AI SDK structured `{ type: 'reasoning' }` part, letting the SDK
    // handle it per-provider. This is a deliberate exception to the
    // `'never'` semantic (which strictly would mean drop-on-default), made
    // to avoid silently changing what existing AI-SDK users see today.
    echoesReasoning: 'never' as const,
  }

  readonly #model: LanguageModel

  constructor(model: LanguageModel) {
    this.#model = model
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    assertValidMessages(messages)
    const { generateText, tool, jsonSchema } = await import('ai')
    const aiMessages = llmMessagesToAiSdkModelMessages(messages, { preserveReasoningAsText: options.preserveReasoningAsText, compressReasoningText: options.compressReasoningText })

    const tools =
      options.tools !== undefined && options.tools.length > 0
        ? Object.fromEntries(
            options.tools.map((def) => [
              def.name,
              tool({
                description: def.description,
                inputSchema: jsonSchema(def.inputSchema as JSONSchema7),
              }),
            ]),
          )
        : undefined

    const result = await generateText({
      // Sampling params first so extraBody can override them. Structural
      // fields (model/messages/system/tools) come after extraBody so users
      // cannot accidentally clobber them via extraBody.
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      ...(options.extraBody as Record<string, unknown> | undefined),
      model: this.#model,
      messages: aiMessages,
      system: options.systemPrompt,
      tools,
      abortSignal: options.abortSignal,
      maxRetries: 0,
      providerOptions: buildProviderOptions(options),
    })

    return buildLlmResponseFromGenerateText(result)
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    assertValidMessages(messages)
    const { streamText, tool, jsonSchema } = await import('ai')
    const aiMessages = llmMessagesToAiSdkModelMessages(messages, { preserveReasoningAsText: options.preserveReasoningAsText, compressReasoningText: options.compressReasoningText })

    const tools =
      options.tools !== undefined && options.tools.length > 0
        ? Object.fromEntries(
            options.tools.map((def) => [
              def.name,
              tool({
                description: def.description,
                inputSchema: jsonSchema(def.inputSchema as JSONSchema7),
              }),
            ]),
          )
        : undefined

    let fullText = ''
    let fullReasoning = ''
    const toolBlocks: ToolUseBlock[] = []
    let finishReason = 'stop'
    let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
    let responseId = ''
    let responseModel = ''

    try {
      const result = streamText({
        // See chat() above for the rationale behind this field ordering.
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        frequencyPenalty: options.frequencyPenalty,
        presencePenalty: options.presencePenalty,
        ...(options.extraBody as Record<string, unknown> | undefined),
        model: this.#model,
        messages: aiMessages,
        system: options.systemPrompt,
        tools,
        abortSignal: options.abortSignal,
        maxRetries: 0,
        providerOptions: buildProviderOptions(options),
      })

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullText += part.text
          yield { type: 'text', data: part.text }
        } else if (part.type === 'reasoning-delta') {
          fullReasoning += part.text
          yield { type: 'reasoning', data: part.text }
        } else if (part.type === 'tool-call') {
          const input =
            part.input !== null && typeof part.input === 'object' && !Array.isArray(part.input)
              ? (part.input as Record<string, unknown>)
              : {}
          const block: ToolUseBlock = {
            type: 'tool_use',
            id: part.toolCallId,
            name: part.toolName,
            input,
          }
          toolBlocks.push(block)
          yield { type: 'tool_use', data: block }
        } else if (part.type === 'error') {
          const err = part.error instanceof Error ? part.error : new Error(String(part.error))
          yield { type: 'error', data: err }
          return
        } else if (part.type === 'finish') {
          finishReason = part.finishReason
          usage = usageToOma(part.totalUsage)
        }
      }

      const meta = await result.response
      responseId = meta.id ?? ''
      responseModel = meta.modelId ?? ''

      // AI SDK v6 types `result.totalUsage` as a `PromiseLike` (no `.catch`),
      // where v5 exposed a full `Promise`. `Promise.resolve()` normalizes both
      // into a real Promise so the rejection guard compiles against either major.
      const totalUsage = await Promise.resolve(result.totalUsage).catch(() => undefined)
      if (totalUsage !== undefined) {
        usage = usageToOma(totalUsage)
      }

      const doneContent: ContentBlock[] = []
      if (fullReasoning.length > 0) doneContent.push({ type: 'reasoning', text: fullReasoning, provenance: 'ai-sdk' })
      if (fullText.length > 0) doneContent.push({ type: 'text', text: fullText })
      doneContent.push(...toolBlocks)

      const hasToolCalls = toolBlocks.length > 0
      const finalResponse: LLMResponse = {
        id: responseId,
        content: doneContent,
        model: responseModel,
        stop_reason: mapFinishReason(finishReason, hasToolCalls),
        usage,
      }

      yield { type: 'done', data: finalResponse }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error }
    }
  }
}

function buildProviderOptions(options: LLMChatOptions): SharedV2ProviderOptions | undefined {
  const out: Record<string, Record<string, JSONValue>> = {}
  if (options.thinking?.effort !== undefined) {
    out['openai'] = { ...(out['openai'] ?? {}), reasoningEffort: options.thinking.effort }
  }
  if (options.parallelToolCalls !== undefined) {
    out['openai'] = { ...(out['openai'] ?? {}), parallelToolCalls: options.parallelToolCalls }
  }
  if (options.minP !== undefined) {
    out['openai'] = { ...(out['openai'] ?? {}), minP: options.minP }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
