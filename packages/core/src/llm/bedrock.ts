/**
 * @fileoverview AWS Bedrock LLM adapter implementing {@link LLMAdapter}.
 *
 * Uses the Converse / ConverseStream APIs from `@aws-sdk/client-bedrock-runtime`
 * (the unified Anthropic-shaped schema) so the same adapter works across Claude,
 * Llama, Mistral, Cohere, and Titan model families without per-model shims.
 *
 * Region resolution order:
 *   1. `region` constructor argument
 *   2. `AWS_REGION` environment variable
 *   3. `'us-east-1'` (hard fallback)
 *
 * AWS credentials are resolved via the SDK default provider chain:
 * env vars → shared config file → EC2/ECS/Lambda IAM role.
 *
 * @example
 * ```ts
 * import { BedrockAdapter } from './bedrock.js'
 *
 * const adapter = new BedrockAdapter('us-east-1')
 * const response = await adapter.chat(messages, {
 *   model: 'anthropic.claude-3-5-haiku-20241022-v1:0',
 *   maxTokens: 1024,
 * })
 * ```
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime'
import type {
  ContentBlock as BedrockContentBlock,
  ConversationRole,
  Message as BedrockMessage,
  ToolResultContentBlock as BedrockToolResultContentBlock,
  ToolConfiguration,
  InferenceConfiguration,
} from '@aws-sdk/client-bedrock-runtime'

import type {
  ContentBlock,
  ImageBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  ReasoningBlock,
  StreamEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  VideoBlock,
} from '../types.js'
import {
  reasoningBlockToInlineText,
  resolveReasoningOutboundMaxChars,
  type ReasoningOutboundOptions,
} from './reasoning-fallback.js'
import { assertValidMessages } from './validate.js'
import { UnsupportedToolResultContentError } from '../errors.js'
import { toolResultContentParts } from '../tool/result.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MEDIA_TYPE_TO_FORMAT: Record<string, 'jpeg' | 'png' | 'gif' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const DOCUMENT_MEDIA_TYPE_TO_FORMAT: Record<string, 'csv' | 'doc' | 'docx' | 'html' | 'md' | 'pdf' | 'txt' | 'xls' | 'xlsx'> = {
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/html': 'html',
  'text/markdown': 'md',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

function base64ToUint8Array(b64: string): Uint8Array {
  return Buffer.from(b64, 'base64')
}

function bedrockDocumentName(filename: string): string {
  const neutral = filename
    .replace(/[^A-Za-z0-9 ()\[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return neutral || 'tool result'
}

function toBedrockToolResultContent(
  content: Extract<ContentBlock, { type: 'tool_result' }>['content'],
): BedrockToolResultContentBlock[] {
  if (typeof content === 'string') return [{ text: content }]

  return toolResultContentParts(content).map((part): BedrockToolResultContentBlock => {
    if (part.type === 'text') return { text: part.text }
    if (part.source.type === 'url') {
      throw new UnsupportedToolResultContentError(
        'Amazon Bedrock Converse',
        `${part.type}-url`,
        'tool-result media references must be supplied as inline base64 data',
      )
    }
    if (part.type === 'image') {
      const format = MEDIA_TYPE_TO_FORMAT[part.source.media_type]
      if (!format) {
        throw new UnsupportedToolResultContentError(
          'Amazon Bedrock Converse',
          `image:${part.source.media_type}`,
          'supported image media types are JPEG, PNG, GIF, and WebP',
        )
      }
      return {
        image: {
          format,
          source: { bytes: base64ToUint8Array(part.source.data) },
        },
      }
    }

    const format = DOCUMENT_MEDIA_TYPE_TO_FORMAT[part.source.media_type]
    if (!format) {
      throw new UnsupportedToolResultContentError(
        'Amazon Bedrock Converse',
        `file:${part.source.media_type}`,
        'the media type has no Bedrock document format mapping',
      )
    }
    return {
      document: {
        format,
        name: bedrockDocumentName(part.filename),
        source: { bytes: base64ToUint8Array(part.source.data) },
      },
    }
  })
}

/**
 * Convert a single framework {@link ContentBlock} into a Bedrock
 * {@link BedrockContentBlock} for the messages array.
 *
 * Reasoning blocks with Bedrock provenance and a signature are echoed
 * natively via `reasoningContent.reasoningText.{text,signature}`. Redacted
 * blocks with Bedrock provenance are echoed via `reasoningContent.redactedContent`.
 * All other reasoning blocks (foreign provenance, no signature) fall back to
 * the cross-provider `<thinking>` text path when `preserveReasoningAsText` is
 * set, or are dropped silently.
 */
function toBedrockContentBlock(
  block: ContentBlock,
  outboundOptions: ReasoningOutboundOptions | undefined,
): BedrockContentBlock | null {
  switch (block.type) {
    case 'text':
      return { text: block.text }

    case 'tool_use':
      // DocumentType is not publicly exported from the SDK; cast the whole block.
      return {
        toolUse: { toolUseId: block.id, name: block.name, input: block.input },
      } as BedrockContentBlock

    case 'tool_result': {
      return {
        toolResult: {
          toolUseId: block.tool_use_id,
          content: toBedrockToolResultContent(block.content),
          status: block.is_error ? 'error' : 'success',
        },
      }
    }

    case 'image': {
      const format = MEDIA_TYPE_TO_FORMAT[block.source.media_type] ?? 'png'
      return {
        image: {
          format,
          source: { bytes: base64ToUint8Array(block.source.data) },
        },
      }
    }

    case 'reasoning': {
      if (block.provenance === 'bedrock') {
        if (block.redactedData !== undefined) {
          return {
            reasoningContent: { redactedContent: base64ToUint8Array(block.redactedData) },
          } as unknown as BedrockContentBlock
        }
        if (block.signature !== undefined) {
          return {
            reasoningContent: { reasoningText: { text: block.text, signature: block.signature } },
          } as unknown as BedrockContentBlock
        }
      }
      if (outboundOptions?.preserveReasoningAsText !== true) return null
      const maxChars = resolveReasoningOutboundMaxChars(outboundOptions)
      const text = maxChars === undefined
        ? reasoningBlockToInlineText(block)
        : reasoningBlockToInlineText(block, { maxChars })
      if (text.length === 0) return null
      return { text }
    }

    case 'video':
      throw new Error('This adapter does not support video content blocks')

    default: {
      const _exhaustive: never = block
      throw new Error(`Unhandled content block type: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * Convert framework messages into Bedrock `Message[]`.
 *
 * System prompt is passed separately via `options.systemPrompt` and handled
 * in `chat()`/`stream()` — it never appears as a message role in the framework.
 * Reasoning blocks are routed via {@link toBedrockContentBlock}'s fallback —
 * see #223 for the cross-provider preservation design.
 */
function toBedrockMessages(
  messages: LLMMessage[],
  outboundOptions: ReasoningOutboundOptions | undefined,
): BedrockMessage[] {
  const bedrockMessages: BedrockMessage[] = []

  for (const msg of messages) {
    const content: BedrockContentBlock[] = []
    for (const block of msg.content) {
      const converted = toBedrockContentBlock(block, outboundOptions)
      if (converted !== null) content.push(converted)
    }
    if (content.length > 0) {
      bedrockMessages.push({ role: msg.role as ConversationRole, content })
    }
  }

  return bedrockMessages
}

function toBedrockTools(tools: readonly LLMToolDef[]): ToolConfiguration {
  // Tool is a discriminated union with a required $unknown variant; cast to satisfy it.
  const bedrockTools = tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.inputSchema as Record<string, unknown> },
    },
  })) as unknown as ToolConfiguration['tools']
  return { tools: bedrockTools }
}

/**
 * Convert a Bedrock response {@link BedrockContentBlock} into a framework
 * {@link ContentBlock}.
 *
 * `toolUse.input` arrives as a parsed object in chat() responses.
 */
function fromBedrockContentBlock(block: BedrockContentBlock): ContentBlock | null {
  if (block.text !== undefined) {
    const text: TextBlock = { type: 'text', text: block.text }
    return text
  }
  if (block.toolUse !== undefined) {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: block.toolUse.toolUseId ?? '',
      name: block.toolUse.name ?? '',
      input: (block.toolUse.input as Record<string, unknown>) ?? {},
    }
    return toolUse
  }
  if (block.reasoningContent !== undefined) {
    const r = block.reasoningContent as { reasoningText?: { text?: string; signature?: string }; redactedContent?: Uint8Array }
    if (r.redactedContent !== undefined) {
      const reasoning: ReasoningBlock = {
        type: 'reasoning',
        text: '',
        redactedData: Buffer.from(r.redactedContent).toString('base64'),
        provenance: 'bedrock',
      }
      return reasoning
    }
    const reasoning: ReasoningBlock = {
      type: 'reasoning',
      text: r.reasoningText?.text ?? '',
      ...(r.reasoningText?.signature !== undefined ? { signature: r.reasoningText.signature } : {}),
      provenance: 'bedrock',
    }
    return reasoning
  }
  return null
}

function buildInferenceConfig(options: LLMChatOptions): InferenceConfiguration | undefined {
  const cfg: InferenceConfiguration = {}
  if (options.maxTokens !== undefined) cfg.maxTokens = options.maxTokens ?? 4096
  if (options.temperature !== undefined) cfg.temperature = options.temperature
  if (options.topP !== undefined) cfg.topP = options.topP
  return Object.keys(cfg).length > 0 ? cfg : undefined
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by AWS Bedrock Converse / ConverseStream APIs.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class BedrockAdapter implements LLMAdapter {
  readonly name = 'bedrock'

  readonly capabilities = {
    echoesReasoning: 'own-issued' as const,
  }

  readonly #client: BedrockRuntimeClient

  constructor(region?: string) {
    const resolvedRegion = region ?? process.env['AWS_REGION'] ?? 'us-east-1'
    this.#client = new BedrockRuntimeClient({ region: resolvedRegion })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    assertValidMessages(messages)
    const bedrockMessages = toBedrockMessages(messages, options)
    const system = options.systemPrompt ? [{ text: options.systemPrompt }] : undefined

    const input: ConstructorParameters<typeof ConverseCommand>[0] = {
      modelId: options.model,
      messages: bedrockMessages,
      system,
      toolConfig: options.tools ? toBedrockTools(options.tools) : undefined,
      inferenceConfig: buildInferenceConfig(options) ?? { maxTokens: 4096 },
    }

    if (options.topK !== undefined || options.extraBody) {
      input.additionalModelRequestFields = {
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.extraBody as Record<string, unknown> | undefined),
      }
    }

    const response = await this.#client.send(new ConverseCommand(input), {
      abortSignal: options.abortSignal,
    })

    const rawContent = response.output?.message?.content ?? []
    const content = rawContent
      .map(fromBedrockContentBlock)
      .filter((b): b is ContentBlock => b !== null)

    return {
      id: response.$metadata.requestId ?? '',
      content,
      model: options.model,
      stop_reason: (response.stopReason as string) ?? 'end_turn',
      usage: {
        input_tokens: response.usage?.inputTokens ?? 0,
        output_tokens: response.usage?.outputTokens ?? 0,
      },
    }
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    assertValidMessages(messages)
    const bedrockMessages = toBedrockMessages(messages, options)
    const system = options.systemPrompt ? [{ text: options.systemPrompt }] : undefined

    const input: ConstructorParameters<typeof ConverseStreamCommand>[0] = {
      modelId: options.model,
      messages: bedrockMessages,
      system,
      toolConfig: options.tools ? toBedrockTools(options.tools) : undefined,
      inferenceConfig: buildInferenceConfig(options) ?? { maxTokens: 4096 },
    }

    if (options.topK !== undefined || options.extraBody) {
      input.additionalModelRequestFields = {
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.extraBody as Record<string, unknown> | undefined),
      }
    }

    // Accumulate tool-use input JSON deltas; keyed by content block index.
    const toolBuffers = new Map<number, { toolUseId: string; name: string; json: string }>()
    // Accumulate reasoning text, signature, and redactedContent deltas; keyed
    // by content block index. Each index becomes one ReasoningBlock in the
    // final `done` payload, matching what `chat()` produces for the same
    // response shape.
    const reasoningBuffers = new Map<number, { text: string; signature?: string; redactedContent?: Uint8Array }>()
    // Accumulated content blocks for the done event.
    const accumulatedContent: ContentBlock[] = []
    let stopReason = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0
    const requestId = ''

    try {
      const response = await this.#client.send(new ConverseStreamCommand(input), {
        abortSignal: options.abortSignal,
      })

      for await (const event of response.stream ?? []) {
        if (event.contentBlockStart?.start?.toolUse) {
          const { toolUseId, name } = event.contentBlockStart.start.toolUse
          const index = event.contentBlockStart.contentBlockIndex ?? 0
          toolBuffers.set(index, { toolUseId: toolUseId ?? '', name: name ?? '', json: '' })
        }

        if (event.contentBlockDelta?.delta) {
          const delta = event.contentBlockDelta.delta
          const index = event.contentBlockDelta.contentBlockIndex ?? 0

          if (delta.text !== undefined) {
            const textEvent: StreamEvent = { type: 'text', data: delta.text }
            yield textEvent
            accumulatedContent.push({ type: 'text', text: delta.text })
          } else if (delta.toolUse?.input !== undefined) {
            const buf = toolBuffers.get(index)
            if (buf) buf.json += delta.toolUse.input
          } else if ((delta as { reasoningContent?: { text?: string } }).reasoningContent?.text !== undefined) {
            const text = (delta as { reasoningContent: { text: string } }).reasoningContent.text
            const reasoningEvent: StreamEvent = { type: 'reasoning', data: text }
            yield reasoningEvent
            const buf = reasoningBuffers.get(index) ?? { text: '' }
            buf.text += text
            reasoningBuffers.set(index, buf)
          } else if ((delta as { reasoningContent?: { signature?: string } }).reasoningContent?.signature !== undefined) {
            const sig = (delta as { reasoningContent: { signature: string } }).reasoningContent.signature
            const buf = reasoningBuffers.get(index) ?? { text: '' }
            buf.signature = sig
            reasoningBuffers.set(index, buf)
          } else if ((delta as { reasoningContent?: { redactedContent?: Uint8Array } }).reasoningContent?.redactedContent !== undefined) {
            const redactedContent = (delta as { reasoningContent: { redactedContent: Uint8Array } }).reasoningContent.redactedContent
            const buf = reasoningBuffers.get(index) ?? { text: '' }
            buf.redactedContent = redactedContent
            reasoningBuffers.set(index, buf)
          }
        }

        if (event.contentBlockStop !== undefined) {
          const index = event.contentBlockStop.contentBlockIndex ?? 0
          const reasoningBuf = reasoningBuffers.get(index)
          if (reasoningBuf) {
            const reasoningBlock: ReasoningBlock = {
              type: 'reasoning',
              text: reasoningBuf.text,
              ...(reasoningBuf.signature !== undefined ? { signature: reasoningBuf.signature } : {}),
              ...(reasoningBuf.redactedContent !== undefined
                ? { redactedData: Buffer.from(reasoningBuf.redactedContent).toString('base64') }
                : {}),
              provenance: 'bedrock',
            }
            accumulatedContent.push(reasoningBlock)
            reasoningBuffers.delete(index)
          }
          const buf = toolBuffers.get(index)
          if (buf) {
            let parsedInput: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(buf.json || '{}')
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsedInput = parsed as Record<string, unknown>
              }
            } catch {
              // malformed JSON → empty object
            }
            const toolUseBlock: ToolUseBlock = {
              type: 'tool_use',
              id: buf.toolUseId,
              name: buf.name,
              input: parsedInput,
            }
            accumulatedContent.push(toolUseBlock)
            const toolUseEvent: StreamEvent = { type: 'tool_use', data: toolUseBlock }
            yield toolUseEvent
            toolBuffers.delete(index)
          }
        }

        if (event.messageStop) {
          stopReason = (event.messageStop.stopReason as string) ?? 'end_turn'
        }

        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? 0
          outputTokens = event.metadata.usage.outputTokens ?? 0
        }
      }

      // Safety net: if Bedrock ever omits a contentBlockStop for a reasoning
      // block, flush whatever we buffered so the done payload still matches
      // what chat() would have returned for the same response.
      for (const [, buf] of reasoningBuffers) {
        accumulatedContent.push({
          type: 'reasoning',
          text: buf.text,
          ...(buf.signature !== undefined ? { signature: buf.signature } : {}),
          ...(buf.redactedContent !== undefined
            ? { redactedData: Buffer.from(buf.redactedContent).toString('base64') }
            : {}),
          provenance: 'bedrock',
        })
      }
      reasoningBuffers.clear()

      const finalResponse: LLMResponse = {
        id: requestId,
        content: accumulatedContent,
        model: options.model,
        stop_reason: stopReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
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

export type { ContentBlock, ImageBlock, VideoBlock, LLMAdapter, LLMChatOptions, LLMMessage, LLMResponse, LLMStreamOptions, LLMToolDef, StreamEvent, TextBlock, ToolResultBlock, ToolUseBlock }
