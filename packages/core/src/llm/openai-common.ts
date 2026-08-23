/**
 * @fileoverview Shared OpenAI wire-format conversion helpers.
 *
 * Both the OpenAI and Copilot adapters use the OpenAI Chat Completions API
 * format. This module contains the common conversion logic so it isn't
 * duplicated across adapters.
 */

import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMMessage,
  LLMResponse,
  LLMToolDef,
  ReasoningBlock,
  TextBlock,
  ThinkingConfig,
  ToolResultContentPart,
  ToolUseBlock,
} from '../types.js'
import { UnsupportedToolCallError, UnsupportedToolResultContentError } from '../errors.js'
import { extractToolCallsFromText } from '../tool/text-tool-extractor.js'
import { toolResultContentParts } from '../tool/result.js'
import { reasoningBlockToInlineText, resolveReasoningOutboundMaxChars, type ReasoningOutboundOptions } from './reasoning-fallback.js'

// ---------------------------------------------------------------------------
// Framework → OpenAI
// ---------------------------------------------------------------------------

/**
 * Limit the shared reasoning-effort union to values declared by the pinned
 * OpenAI SDK. DeepSeek supports the additional `max` value and opts into it
 * in its adapter override.
 */
export function toOpenAISdkReasoningEffort(
  effort: ThinkingConfig['effort'],
): Exclude<ThinkingConfig['effort'], 'max'> {
  return effort === 'max' ? undefined : effort
}

/**
 * Convert a framework {@link LLMToolDef} to an OpenAI {@link ChatCompletionTool}.
 */
export function toOpenAITool(tool: LLMToolDef): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }
}

function extractReasoningText(value: unknown): string {
  if (typeof value === 'string') return value

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part === null || typeof part !== 'object') return ''

        const record = part as Record<string, unknown>
        if (typeof record['text'] === 'string') return record['text']
        if (typeof record['content'] === 'string') return record['content']
        if (typeof record['reasoning_content'] === 'string') return record['reasoning_content']
        return ''
      })
      .join('')
  }

  return ''
}

export function getOpenAIReasoningText(source: unknown): string {
  if (source === null || typeof source !== 'object') return ''
  return extractReasoningText((source as Record<string, unknown>)['reasoning_content'])
}

/**
 * Determine whether a framework message contains any `tool_result` content
 * blocks, which must be serialised as separate OpenAI `tool`-role messages.
 */
function hasToolResults(msg: LLMMessage): boolean {
  return msg.content.some((b) => b.type === 'tool_result')
}

type OpenAIUserContentPart = OpenAI.Chat.ChatCompletionContentPart | {
  type: 'video_url'
  video_url: { url: string }
}

function toOpenAIToolAttachmentPart(part: Exclude<ToolResultContentPart, { type: 'text' }>): OpenAIUserContentPart {
  if (part.type === 'image') {
    return {
      type: 'image_url',
      image_url: {
        url: part.source.type === 'base64'
          ? `data:${part.source.media_type};base64,${part.source.data}`
          : part.source.url,
      },
    }
  }

  if (part.source.type === 'url') {
    throw new UnsupportedToolResultContentError(
      'OpenAI-compatible Chat Completions',
      'file-url',
      'file content parts accept inline base64 data, not remote URLs',
    )
  }
  return {
    type: 'file',
    file: {
      filename: part.filename,
      file_data: `data:${part.source.media_type};base64,${part.source.data}`,
    },
  }
}

/**
 * Convert framework {@link LLMMessage}s into OpenAI
 * {@link ChatCompletionMessageParam} entries.
 *
 * `tool_result` blocks are expanded into top-level `tool`-role messages
 * because OpenAI uses a dedicated role for tool results rather than embedding
 * them inside user-content arrays.
 *
 * For mixed user messages (tool_result + text/image), the tool messages are
 * emitted FIRST so they sit immediately after the assistant's `tool_calls`.
 * The OpenAI Chat Completions API requires every assistant `tool_calls` block
 * to be answered by tool-role messages before any subsequent user-role
 * message; inserting a user message between them produces a 400 error
 * ("messages with role 'tool' must be a response to a preceding message
 * with 'tool_calls'"). This path is exercised in practice by the agent
 * runner's loop-detection warning injection (see {@link AgentRunner}, which
 * appends a text warning to a tool_result message when a loop is detected).
 */
export function toOpenAIMessages(
  messages: LLMMessage[],
  outboundOptions?: ReasoningOutboundOptions,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  // Per DeepSeek V4 thinking-mode spec, when a conversation involves any
  // tool call, ALL intermediate assistant messages must echo
  // `reasoning_content` — not just the one that emitted the tool_use.
  // Omitting reasoning on the final synthesis turn (tool_calls=None) 400s
  // on the next user message. We approximate "tool-calling conversation"
  // as "any tool_use anywhere in history"; non-tool conversations skip
  // the echo entirely (per spec, reasoning would be ignored but still
  // bloat context). See:
  //   https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
  const conversationHasToolUse = messages.some((m) =>
    m.content.some((b) => b.type === 'tool_use'),
  )

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const assistantMsg = toOpenAIAssistantMessage(msg, outboundOptions, conversationHasToolUse)
      if (assistantMsg !== null) {
        result.push(assistantMsg)
      }
    } else {
      // user role
      if (!hasToolResults(msg)) {
        result.push(toOpenAIUserMessage(msg))
      } else {
        // Emit tool messages first to satisfy OpenAI's strict ordering rule.
        const attachmentParts: OpenAIUserContentPart[] = []
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const parts = toolResultContentParts(block.content)
            const textParts = parts
              .filter((part): part is Extract<ToolResultContentPart, { type: 'text' }> => part.type === 'text')
              .map((part): OpenAI.Chat.ChatCompletionContentPartText => ({ type: 'text', text: part.text }))
            const mediaParts = parts.filter(
              (part): part is Exclude<ToolResultContentPart, { type: 'text' }> => part.type !== 'text',
            )
            if (mediaParts.length > 0) {
              textParts.push({
                type: 'text',
                text: `[${mediaParts.length} tool-result attachment(s) follow in the next user message.]`,
              })
              attachmentParts.push({
                type: 'text',
                text: `Attachments for tool call ${block.tool_use_id}:`,
              })
              attachmentParts.push(...mediaParts.map(toOpenAIToolAttachmentPart))
            }
            const toolMsg: ChatCompletionToolMessageParam = {
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : textParts,
            }
            result.push(toolMsg)
          }
        }

        const nonToolBlocks = msg.content.filter((b) => b.type !== 'tool_result')
        if (attachmentParts.length > 0) {
          attachmentParts.push(...toOpenAIUserContentParts({ role: 'user', content: nonToolBlocks }))
          result.push({
            role: 'user',
            content: attachmentParts as unknown as ChatCompletionUserMessageParam['content'],
          })
        } else if (nonToolBlocks.length > 0) {
          result.push(toOpenAIUserMessage({ role: 'user', content: nonToolBlocks }))
        }
      }
    }
  }

  return result
}

/**
 * Convert a `user`-role framework message into an OpenAI user message.
 * Image blocks are converted to the OpenAI image_url content part format.
 */
function toOpenAIUserMessage(msg: LLMMessage): ChatCompletionUserMessageParam {
  if (msg.content.length === 1 && msg.content[0]?.type === 'text') {
    return { role: 'user', content: msg.content[0].text }
  }

  return {
    role: 'user',
    content: toOpenAIUserContentParts(msg) as unknown as ChatCompletionUserMessageParam['content'],
  }
}

function toOpenAIUserContentParts(msg: LLMMessage): OpenAIUserContentPart[] {
  const parts: OpenAIUserContentPart[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      })
    } else if (block.type === 'video') {
      parts.push({
        type: 'video_url',
        video_url: {
          url: block.source.type === 'base64'
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url,
        },
      })
    }
    // tool_result blocks are handled by the caller (toOpenAIMessages); skip here.
  }

  return parts
}

/**
 * Convert an `assistant`-role framework message into an OpenAI assistant message.
 * `tool_use` blocks become `tool_calls`; `text` blocks become message content.
 */
function toOpenAIAssistantMessage(
  msg: LLMMessage,
  outboundOptions?: ReasoningOutboundOptions,
  conversationHasToolUse = false,
): ChatCompletionAssistantMessageParam | null {
  const toolCalls: ChatCompletionMessageToolCall[] = []
  const textParts: string[] = []
  const pendingThinkingParts: string[] = []
  const echoProvider = outboundOptions?.nativeReasoningEchoProvider
  const enableReasoningReplay = outboundOptions?.preserveReasoningAsText === true
  const resolvedMaxChars = resolveReasoningOutboundMaxChars(outboundOptions)
  // Collected only when an `echoProvider` is configured. Emitted as a
  // `reasoning_content` field on the assistant payload below, gated by
  // `conversationHasToolUse` (DeepSeek V4 rule: applies to every assistant
  // message in a tool-calling conversation, including the final synthesis
  // message that has no tool_calls of its own).
  const echoEligibleReasoning: string[] = []

  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    } else if (block.type === 'reasoning') {
      // Path A: native echo (adapter wired with nativeReasoningEchoProvider
      // and the block's provenance matches). The block is queued for
      // attachment as `reasoning_content`; gating by tool_use happens after
      // the loop so we don't emit it on non-tool turns.
      if (echoProvider !== undefined && block.provenance === echoProvider) {
        const isRedacted = typeof block.redactedData === 'string' && block.redactedData.length > 0
        if (!isRedacted && block.text.length > 0) {
          echoEligibleReasoning.push(block.text)
        }
        // Either way, don't double-emit via the text-replay path below.
        continue
      }
      // Path B: `<thinking>` text fallback for foreign-provenance blocks
      // (or any block when this adapter doesn't support native echo) when
      // `preserveReasoningAsText` is on. OpenAI-family adapters are
      // capability `'never'` by default, so every reasoning block hits this
      // branch in plain OpenAI use; DeepSeek (`'tool-use-only'`) hits this
      // only for foreign-provenance blocks since its own-provenance ones
      // are claimed by Path A above.
      if (enableReasoningReplay) {
        const serialized = resolvedMaxChars === undefined
          ? reasoningBlockToInlineText(block)
          : reasoningBlockToInlineText(block, { maxChars: resolvedMaxChars })
        if (serialized.length > 0) {
          pendingThinkingParts.push(serialized)
        }
      }
    } else if (block.type === 'text') {
      if (pendingThinkingParts.length > 0) {
        textParts.push(`${pendingThinkingParts.join('')}${block.text}`)
        pendingThinkingParts.length = 0
      } else {
        textParts.push(block.text)
      }
    }
  }

  if (pendingThinkingParts.length > 0) {
    textParts.push(pendingThinkingParts.join(''))
  }

  if (toolCalls.length === 0 && textParts.length === 0) {
    return null
  }

  const assistantMsg: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : null,
  }

  if (toolCalls.length > 0) {
    assistantMsg.tool_calls = toolCalls
  }

  // DeepSeek V4 (thinking mode) returns 400 on follow-up requests if any
  // intermediate assistant message in a tool-calling conversation drops
  // `reasoning_content` — including the final synthesis message that has
  // no tool_calls of its own. The gate is on the whole conversation, not
  // this single message. Non-tool conversations skip the attachment (per
  // spec, reasoning is ignored there but would still bloat context).
  //
  // The field is not declared on the upstream SDK type, so we attach it
  // via an indexed cast; the SDK serialises arbitrary own properties.
  if (conversationHasToolUse && echoEligibleReasoning.length > 0) {
    const reasoningContent = echoEligibleReasoning.join('')
    ;(assistantMsg as ChatCompletionAssistantMessageParam & { reasoning_content?: string })
      .reasoning_content = reasoningContent
  }

  return assistantMsg
}

// ---------------------------------------------------------------------------
// OpenAI → Framework
// ---------------------------------------------------------------------------

/**
 * Repair malformed single-string tool-call arguments after `JSON.parse` fails.
 * Local models frequently break single-parameter tools with unescaped quotes or
 * Python-style triple quotes (`"""`/`'''`). Returns the repaired argument object,
 * or null when the input doesn't match the single-parameter `{"name": value}` shape.
 */
export function repairToolArgs(raw: string): Record<string, unknown> | null {
  const args = raw.trim()
  const match = args.match(/\{\s*"([^"]+)"\s*:\s*([\s\S]*?)\s*\}$/)
  if (match) {
    const paramName = match[1]!
    let val = match[2]!.trim()
    if (val.startsWith('"""') && val.endsWith('"""')) val = val.slice(3, -3)
    else if (val.startsWith("'''") && val.endsWith("'''")) val = val.slice(3, -3)
    else if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    return { [paramName]: val }
  }
  return null
}

/**
 * Convert an OpenAI {@link ChatCompletion} into a framework {@link LLMResponse}.
 *
 * Takes only the first choice (index 0), consistent with how the framework
 * is designed for single-output agents.
 *
 * @param completion      - The raw OpenAI completion.
 * @param knownToolNames  - Optional whitelist of tool names. When the model
 *                          returns no `tool_calls` but the text contains JSON
 *                          that looks like a tool call, the fallback extractor
 *                          uses this list to validate matches. Pass the names
 *                          of tools sent in the request for best results.
 * @param provenance      - Optional adapter-name string stamped onto any
 *                          extracted {@link ReasoningBlock}, so downstream
 *                          outbound paths can distinguish native-echo eligible
 *                          blocks from foreign ones (see #223). Each
 *                          OpenAI-family adapter should pass its own
 *                          {@link LLMAdapter.name}.
 */
export function fromOpenAICompletion(
  completion: ChatCompletion,
  knownToolNames?: string[],
  provenance?: string,
): LLMResponse {
  const choice = completion.choices?.[0]
  if (choice === undefined) {
    throw new Error('OpenAI returned a completion with no choices')
  }

  const content: ContentBlock[] = []
  const message = choice.message

  const reasoningText = getOpenAIReasoningText(message)
  if (reasoningText.length > 0) {
    const reasoningBlock: ReasoningBlock = provenance !== undefined
      ? { type: 'reasoning', text: reasoningText, provenance }
      : { type: 'reasoning', text: reasoningText }
    content.push(reasoningBlock)
  }

  if (message.content !== null && message.content !== undefined) {
    const textBlock: TextBlock = { type: 'text', text: message.content }
    content.push(textBlock)
  }

  for (const toolCall of message.tool_calls ?? []) {
    if (toolCall.type !== 'function') {
      throw new UnsupportedToolCallError(provenance ?? 'openai', toolCall.type)
    }

    let parsedInput: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(toolCall.function.arguments)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedInput = parsed as Record<string, unknown>
      }
    } catch {
      const repaired = repairToolArgs(toolCall.function.arguments)
      if (repaired) parsedInput = repaired
    }

    const toolUseBlock: ToolUseBlock = {
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parsedInput,
    }
    content.push(toolUseBlock)
  }

  // ---------------------------------------------------------------------------
  // Fallback: extract tool calls from text when native tool_calls is empty.
  //
  // Some local models (Ollama thinking models, misconfigured vLLM) return tool
  // calls as plain text instead of using the tool_calls wire format.  When we
  // have text but no tool_calls, try to extract them from the text.
  // ---------------------------------------------------------------------------
  const hasNativeToolCalls = (message.tool_calls ?? []).length > 0
  if (
    !hasNativeToolCalls &&
    knownToolNames !== undefined &&
    knownToolNames.length > 0 &&
    message.content !== null &&
    message.content !== undefined &&
    message.content.length > 0
  ) {
    const extracted = extractToolCallsFromText(message.content, knownToolNames)
    if (extracted.length > 0) {
      content.push(...extracted)
    }
  }

  const hasToolUseBlocks = content.some(b => b.type === 'tool_use')
  const rawStopReason = choice.finish_reason ?? 'stop'
  // If we extracted tool calls from text but the finish_reason was 'stop',
  // correct it to 'tool_use' so the agent runner continues the loop.
  const stopReason = hasToolUseBlocks && rawStopReason === 'stop'
    ? 'tool_use'
    : normalizeFinishReason(rawStopReason)

  return {
    id: completion.id,
    content,
    model: completion.model,
    stop_reason: stopReason,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

/**
 * Normalize an OpenAI `finish_reason` string to the framework's canonical
 * stop-reason vocabulary.
 *
 * Mapping:
 * - `'stop'`           → `'end_turn'`
 * - `'tool_calls'`     → `'tool_use'`
 * - `'length'`         → `'max_tokens'`
 * - `'content_filter'` → `'content_filter'`
 * - anything else      → passed through unchanged
 */
export function normalizeFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':           return 'end_turn'
    case 'tool_calls':     return 'tool_use'
    case 'length':         return 'max_tokens'
    case 'content_filter': return 'content_filter'
    default:               return reason
  }
}

/**
 * Prepend a system message when `systemPrompt` is provided, then append the
 * converted conversation messages.
 */
export function buildOpenAIMessageList(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
  outboundOptions?: ReasoningOutboundOptions,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    result.push({ role: 'system', content: systemPrompt })
  }

  result.push(...toOpenAIMessages(messages, outboundOptions))
  return result
}
