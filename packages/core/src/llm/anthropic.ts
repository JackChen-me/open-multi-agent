/**
 * @fileoverview Anthropic Claude adapter implementing {@link LLMAdapter}.
 *
 * Converts between the framework's internal {@link ContentBlock} types and the
 * Anthropic SDK's wire format, handling tool definitions, system prompts, and
 * both batch and streaming response paths.
 *
 * API key resolution order:
 *   1. `apiKey` constructor argument
 *   2. `ANTHROPIC_API_KEY` environment variable
 *
 * @example
 * ```ts
 * import { AnthropicAdapter } from './anthropic.js'
 *
 * const adapter = new AnthropicAdapter()
 * const response = await adapter.chat(messages, {
 *   model: 'claude-opus-4-6',
 *   maxTokens: 1024,
 * })
 * ```
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  MessageStreamParams,
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ThinkingConfigParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages/messages.js'

import type {
  ContentBlock,
  ImageBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  ReasoningBlock,
  LLMToolDef,
  StreamEvent,
  TextBlock,
  ThinkingConfig,
  ToolResultContentPart,
  ToolResultBlock,
  ToolUseBlock,
  VideoBlock,
  EgressPolicy,
} from '../types.js'
import {
  reasoningBlockToInlineText,
  resolveReasoningOutboundMaxChars,
  type ReasoningOutboundOptions,
} from './reasoning-fallback.js'
import { assertValidMessages } from './validate.js'
import { createEgressFetch } from './egress.js'
import { UnsupportedToolResultContentError } from '../errors.js'
import { toolResultContentParts } from '../tool/result.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a single framework {@link ContentBlock} into an Anthropic
 * {@link ContentBlockParam} suitable for the `messages` array, or `null`
 * when the block has no faithful representation on the wire (e.g. a
 * reasoning block from another provider that lacks an Anthropic signature
 * AND the user hasn't opted into the text fallback).
 *
 * `tool_result` blocks are only valid inside `user`-role messages, which is
 * handled by {@link toAnthropicMessages} based on role context.
 */
function toAnthropicImageParam(
  part: Extract<ToolResultContentPart, { type: 'image' }>,
): ImageBlockParam {
  const mediaType = part.source.media_type
  if (
    mediaType !== 'image/jpeg'
    && mediaType !== 'image/png'
    && mediaType !== 'image/gif'
    && mediaType !== 'image/webp'
  ) {
    throw new UnsupportedToolResultContentError(
      'Anthropic Messages',
      `image:${mediaType}`,
      'supported image media types are JPEG, PNG, GIF, and WebP',
    )
  }
  return {
    type: 'image',
    source: part.source.type === 'base64'
      ? { type: 'base64', media_type: mediaType, data: part.source.data }
      : { type: 'url', url: part.source.url },
  }
}

function toAnthropicContentBlockParams(
  block: ContentBlock,
  outboundOptions: ReasoningOutboundOptions | undefined,
): ContentBlockParam[] {
  switch (block.type) {
    case 'reasoning': {
      // Anthropic strictly validates the signature on echoed thinking
      // blocks, so we only round-trip blocks that originated here:
      //   - `redactedData` -> `redacted_thinking` (opaque, signature lives inside)
      //   - `signature`    -> `thinking` block with text + signature
      // For foreign-provenance or unsigned reasoning, fall back to plain
      // `<thinking>` text when the user opts in (see #223 Phase 2), or
      // drop silently (today's default) when opt-in is off.
      const ownProvenance = block.provenance === 'anthropic'
      if (ownProvenance && block.redactedData !== undefined) {
        const param: RedactedThinkingBlockParam = {
          type: 'redacted_thinking',
          data: block.redactedData,
        }
        return [param]
      }
      if (ownProvenance && block.signature !== undefined) {
        const param: ThinkingBlockParam = {
          type: 'thinking',
          thinking: block.text,
          signature: block.signature,
        }
        return [param]
      }
      if (outboundOptions?.preserveReasoningAsText !== true) return []
      const maxChars = resolveReasoningOutboundMaxChars(outboundOptions)
      const text = maxChars === undefined
        ? reasoningBlockToInlineText(block)
        : reasoningBlockToInlineText(block, { maxChars })
      if (text.length === 0) return []
      const param: TextBlockParam = { type: 'text', text }
      return [param]
    }
    case 'text': {
      const param: TextBlockParam = { type: 'text', text: block.text }
      return [param]
    }
    case 'tool_use': {
      const param: ToolUseBlockParam = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
      return [param]
    }
    case 'tool_result': {
      if (typeof block.content === 'string') {
        const param: ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        }
        return [param]
      }

      const resultContent: Array<TextBlockParam | ImageBlockParam> = []
      const documents: DocumentBlockParam[] = []
      for (const part of toolResultContentParts(block.content)) {
        if (part.type === 'text') {
          resultContent.push({ type: 'text', text: part.text })
        } else if (part.type === 'image') {
          resultContent.push(toAnthropicImageParam(part))
        } else {
          if (part.source.media_type !== 'application/pdf') {
            throw new UnsupportedToolResultContentError(
              'Anthropic Messages',
              `file:${part.source.media_type}`,
              'tool-result file parts are supported here only for PDF documents',
            )
          }
          resultContent.push({ type: 'text', text: `[File attachment follows: ${part.filename}]` })
          documents.push({
            type: 'document',
            title: part.filename,
            source: part.source.type === 'base64'
              ? {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: part.source.data,
                }
              : { type: 'url', url: part.source.url },
          })
        }
      }
      const param: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: resultContent,
        is_error: block.is_error,
      }
      return [param, ...documents]
    }
    case 'image': {
      // Anthropic only accepts a subset of MIME types; we pass them through
      // trusting the caller to supply a valid media_type value.
      const param: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.media_type as
            | 'image/jpeg'
            | 'image/png'
            | 'image/gif'
            | 'image/webp',
          data: block.source.data,
        },
      }
      return [param]
    }
    case 'video':
      throw new Error('This adapter does not support video content blocks')
    default: {
      // Exhaustiveness guard — TypeScript will flag this at compile time if a
      // new variant is added to ContentBlock without updating this switch.
      const _exhaustive: never = block
      throw new Error(`Unhandled content block type: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * Convert framework messages into Anthropic's `MessageParam[]` format.
 *
 * The Anthropic API requires strict user/assistant alternation. We do not
 * enforce that here — the caller is responsible for producing a valid
 * conversation history.
 */
function toAnthropicMessages(
  messages: LLMMessage[],
  outboundOptions: ReasoningOutboundOptions | undefined,
): MessageParam[] {
  return messages.map((msg): MessageParam => ({
    role: msg.role,
    content: msg.content.flatMap(block => toAnthropicContentBlockParams(block, outboundOptions)),
  }))
}

/**
 * Convert framework {@link LLMToolDef}s into Anthropic's `Tool` objects.
 *
 * The `inputSchema` on {@link LLMToolDef} is already a plain JSON Schema
 * object, so we just need to reshape the wrapper.
 */
function toAnthropicTools(tools: readonly LLMToolDef[]): AnthropicTool[] {
  return tools.map((t): AnthropicTool => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      ...(t.inputSchema as Record<string, unknown>),
    },
  }))
}

/**
 * Convert an Anthropic SDK `ContentBlock` into a framework {@link ContentBlock}.
 *
 * We only map the subset of SDK types that the framework exposes. Unknown
 * variants are converted to a text block carrying a stringified
 * representation so data is never silently dropped.
 */
function fromAnthropicContentBlock(
  block: Anthropic.Messages.ContentBlock,
): ContentBlock {
  switch (block.type) {
    case 'thinking': {
      // `signature` is required by the API to continue a multi-turn extended
      // thinking conversation. Carry it on the framework block so the next
      // turn can echo the original reasoning back unchanged.
      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: block.thinking,
        signature: block.signature,
        provenance: 'anthropic',
      }
      return reasoning
    }
    case 'redacted_thinking': {
      // Anthropic returns redacted thinking when its safety system replaces
      // the raw reasoning text with an opaque encrypted payload. The block
      // must still be echoed back on subsequent turns, so we carry the
      // payload via `redactedData` and leave `text` empty.
      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: '',
        redactedData: block.data,
        provenance: 'anthropic',
      }
      return reasoning
    }
    case 'text': {
      const text: TextBlock = { type: 'text', text: block.text }
      return text
    }
    case 'tool_use': {
      const toolUse: ToolUseBlock = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }
      return toolUse
    }
    default: {
      // Graceful degradation for SDK types we don't model.
      const fallback: TextBlock = {
        type: 'text',
        text: `[unsupported block type: ${(block as { type: string }).type}]`,
      }
      return fallback
    }
  }
}

/**
 * Convert the framework's {@link ThinkingConfig} into Anthropic's
 * `thinking` request param. Returns `undefined` when the caller hasn't
 * opted in, leaving the field absent from the request payload.
 *
 * Validates against the API's two `budget_tokens` constraints:
 *   1. `budget_tokens >= 1024` (SDK-documented minimum, smaller budgets
 *      yield no useful reasoning)
 *   2. `budget_tokens < max_tokens` (docs: "budget_tokens must be set to a
 *      value less than max_tokens"). Throws early with a clear message
 *      rather than letting Anthropic return a 400.
 *
 * Defaults `budgetTokens` to 1024 when enabled without an explicit value;
 * combined with the second constraint, this means a caller passing
 * `thinking.enabled = true` MUST also set `maxTokens > 1024`.
 *
 * Model compatibility: emits `{type: 'enabled', budget_tokens}` which is
 * supported by Claude Sonnet 3.7 and all Claude 4.x models up to and
 * including 4.6 (deprecated on 4.6 in favor of `adaptive`). Claude Opus 4.7+
 * accepts only `{type: 'adaptive'}` and rejects this shape with HTTP 400.
 * Adaptive thinking support is tracked as a follow-up to RFC #200's phase 1.
 *
 * The `interleaved-thinking-2025-05-14` beta header (which would relax the
 * `budget_tokens < max_tokens` rule for Claude 4.x manual mode) is not yet
 * wired up — see RFC #200 phase 2.
 */
function toAnthropicThinkingParam(
  thinking: ThinkingConfig | undefined,
  maxTokens: number,
): ThinkingConfigParam | undefined {
  if (thinking === undefined || !thinking.enabled) return undefined
  const budget = thinking.budgetTokens ?? 1024
  if (budget < 1024) {
    throw new Error(
      `[anthropic] thinking.budgetTokens must be >= 1024 (got ${budget}); ` +
      `the Anthropic API enforces this minimum.`,
    )
  }
  if (budget >= maxTokens) {
    throw new Error(
      `[anthropic] thinking.budgetTokens (${budget}) must be < maxTokens (${maxTokens}); ` +
      `the Anthropic API rejects requests where budget_tokens >= max_tokens. ` +
      `Either lower thinking.budgetTokens or raise maxTokens.`,
    )
  }
  return {
    type: 'enabled',
    budget_tokens: budget,
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the Anthropic Claude API.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 * The underlying SDK client is stateless across requests.
 */
export class AnthropicAdapter implements LLMAdapter {
  readonly name = 'anthropic'

  readonly capabilities = {
    echoesReasoning: 'own-issued' as const,
  }

  readonly #client: Anthropic

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    this.#client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
      baseURL,
      ...(egressPolicy !== undefined
        ? { fetch: createEgressFetch(egressPolicy, this.name) }
        : {}),
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Throws an `Anthropic.APIError` on non-2xx responses. Callers should catch
   * and handle these (e.g. rate limits, context window exceeded).
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    assertValidMessages(messages)
    const anthropicMessages = toAnthropicMessages(messages, options)
    const effectiveMaxTokens = options.maxTokens ?? 4096

    const response = await this.#client.messages.create(
      {
        // Sampling params first so extraBody can override them. Structural
        // fields (model/messages/system/tools/thinking) come after extraBody
        // so users cannot accidentally clobber them via extraBody.
        max_tokens: effectiveMaxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        top_k: options.topK,
        ...options.extraBody,
        model: options.model,
        messages: anthropicMessages,
        system: options.systemPrompt,
        tools: options.tools ? toAnthropicTools(options.tools) : undefined,
        thinking: toAnthropicThinkingParam(options.thinking, effectiveMaxTokens),
        // Cast covers arbitrary `extraBody` keys not declared by the SDK.
      } as MessageCreateParamsNonStreaming,
      {
        signal: options.abortSignal,
      },
    )

    const content = response.content.map(fromAnthropicContentBlock)

    return {
      id: response.id,
      content,
      model: response.model,
      stop_reason: response.stop_reason ?? 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    }
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s as they
   * arrive from the API.
   *
   * Sequence guarantees:
   * - Zero or more `text` events containing incremental deltas
   * - Zero or more `reasoning` events containing incremental thinking deltas
   * - Zero or more `tool_use` events when the model calls a tool (emitted once
   *   per tool use, after input JSON has been fully assembled)
   * - Exactly one terminal event: `done` (with the complete {@link LLMResponse}
   *   as `data`) or `error` (with an `Error` as `data`)
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    assertValidMessages(messages)
    const anthropicMessages = toAnthropicMessages(messages, options)
    const effectiveMaxTokens = options.maxTokens ?? 4096

    // MessageStream gives us typed events and handles SSE reconnect internally.
    const stream = this.#client.messages.stream(
      {
        // See chat() above for the rationale behind this field ordering.
        max_tokens: effectiveMaxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        top_k: options.topK,
        ...options.extraBody,
        model: options.model,
        messages: anthropicMessages,
        system: options.systemPrompt,
        tools: options.tools ? toAnthropicTools(options.tools) : undefined,
        thinking: toAnthropicThinkingParam(options.thinking, effectiveMaxTokens),
      } as MessageStreamParams,
      {
        signal: options.abortSignal,
      },
    )

    // Accumulate tool-use input JSON as it streams in.
    // key = content block index, value = partially assembled input JSON string
    const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>()

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block
            if (block.type === 'tool_use') {
              toolInputBuffers.set(event.index, {
                id: block.id,
                name: block.name,
                json: '',
              })
            }
            break
          }

          case 'content_block_delta': {
            const delta = event.delta

            switch (delta.type) {
              case 'text_delta': {
                const textEvent: StreamEvent = { type: 'text', data: delta.text }
                yield textEvent
                break
              }
              case 'thinking_delta': {
                const reasoningEvent: StreamEvent = { type: 'reasoning', data: delta.thinking }
                yield reasoningEvent
                break
              }
              case 'input_json_delta': {
                const buf = toolInputBuffers.get(event.index)
                if (buf !== undefined) {
                  buf.json += delta.partial_json
                }
                break
              }
              default:
                break
            }
            break
          }

          case 'content_block_stop': {
            const buf = toolInputBuffers.get(event.index)
            if (buf !== undefined) {
              // Parse the accumulated JSON and emit a tool_use event.
              let parsedInput: Record<string, unknown> = {}
              try {
                const parsed: unknown = JSON.parse(buf.json)
                if (
                  parsed !== null &&
                  typeof parsed === 'object' &&
                  !Array.isArray(parsed)
                ) {
                  parsedInput = parsed as Record<string, unknown>
                }
              } catch {
                // Malformed JSON from the model — surface as an empty object
                // rather than crashing the stream.
              }

              const toolUseBlock: ToolUseBlock = {
                type: 'tool_use',
                id: buf.id,
                name: buf.name,
                input: parsedInput,
              }
              const toolUseEvent: StreamEvent = { type: 'tool_use', data: toolUseBlock }
              yield toolUseEvent
              toolInputBuffers.delete(event.index)
            }
            break
          }

          // message_start, message_delta, message_stop — we handle the final
          // response via stream.finalMessage() below rather than piecemeal.
          default:
            break
        }
      }

      // Await the fully assembled final message (token counts, stop_reason, etc.)
      const finalMessage = await stream.finalMessage()
      const content = finalMessage.content.map(fromAnthropicContentBlock)

      const finalResponse: LLMResponse = {
        id: finalMessage.id,
        content,
        model: finalMessage.model,
        stop_reason: finalMessage.stop_reason ?? 'end_turn',
        usage: {
          input_tokens: finalMessage.usage.input_tokens,
          output_tokens: finalMessage.usage.output_tokens,
        },
      }

      const doneEvent: StreamEvent = { type: 'done', data: finalResponse }
      yield doneEvent
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const errorEvent: StreamEvent = { type: 'error', data: error }
      yield errorEvent
    }
  }
}

// Re-export types that consumers of this module commonly need alongside the adapter.
export type {
  ContentBlock,
  ImageBlock,
  VideoBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
}
