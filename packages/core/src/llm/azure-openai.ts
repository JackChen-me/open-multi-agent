/**
 * @fileoverview Azure OpenAI adapter implementing {@link LLMAdapter}.
 *
 * Azure OpenAI uses regional deployment endpoints and API versioning that differ
 * from standard OpenAI:
 *
 * - Endpoint: `https://{resource-name}.openai.azure.com`
 * - API version: Query parameter (e.g., `?api-version=2024-10-21`)
 * - Model/Deployment: Users deploy models with custom names; the `model` field
 *   in agent config should contain the Azure deployment name, not the underlying
 *   model name (e.g., `model: 'my-gpt4-deployment'`)
 *
 * The OpenAI SDK provides an `AzureOpenAI` client class that handles these
 * Azure-specific requirements. This adapter uses that client while reusing all
 * message conversion logic from `openai-common.ts`.
 *
 * Environment variable resolution order:
 *   1. Constructor arguments
 *   2. `AZURE_OPENAI_API_KEY` environment variable
 *   3. `AZURE_OPENAI_ENDPOINT` environment variable
 *   4. `AZURE_OPENAI_API_VERSION` environment variable (defaults to '2024-10-21')
 *   5. `AZURE_OPENAI_DEPLOYMENT` as an optional fallback when `model` is blank
 *
 * Note: Azure introduced a next-generation v1 API (August 2025) that uses the standard
 * OpenAI() client with baseURL set to `{endpoint}/openai/v1/` and requires no api-version.
 * That path is not yet supported by this adapter. To use it, pass `provider: 'openai'`
 * with `baseURL: 'https://{resource}.openai.azure.com/openai/v1/'` in your agent config.
 *
 * @example
 * ```ts
 * import { AzureOpenAIAdapter } from './azure-openai.js'
 *
 * const adapter = new AzureOpenAIAdapter()
 * const response = await adapter.chat(messages, {
 *   model: 'my-gpt4-deployment',  // Azure deployment name, not 'gpt-4'
 *   maxTokens: 1024,
 * })
 * ```
 */

import { AzureOpenAI } from 'openai'
import type {
  ChatCompletionChunk,
} from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from '../types.js'

import {
  toOpenAITool,
  fromOpenAICompletion,
  normalizeFinishReason,
  buildOpenAIMessageList,
  toOpenAISdkReasoningEffort,
} from './openai-common.js'
import { assertValidMessages } from './validate.js'
import { extractToolCallsFromText } from '../tool/text-tool-extractor.js'

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const DEFAULT_AZURE_OPENAI_API_VERSION = '2024-10-21'

function resolveAzureDeploymentName(model: string): string {
  const explicitModel = model.trim()
  if (explicitModel.length > 0) return explicitModel

  const fallbackDeployment = process.env['AZURE_OPENAI_DEPLOYMENT']?.trim()
  if (fallbackDeployment !== undefined && fallbackDeployment.length > 0) {
    return fallbackDeployment
  }

  throw new Error(
    'Azure OpenAI deployment is required. Set agent model to your deployment name, or set AZURE_OPENAI_DEPLOYMENT.',
  )
}

/**
 * LLM adapter backed by Azure OpenAI Chat Completions API.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class AzureOpenAIAdapter implements LLMAdapter {
  readonly name: string = 'azure-openai'

  readonly capabilities = {
    // Azure OpenAI Chat Completions follows the OpenAI wire contract: no
    // reasoning input accepted. Falls back via shared helper in Phase 2.
    echoesReasoning: 'never' as const,
  }

  readonly #client: AzureOpenAI

  /**
   * @param apiKey - Azure OpenAI API key (falls back to AZURE_OPENAI_API_KEY env var)
   * @param endpoint - Azure endpoint URL (falls back to AZURE_OPENAI_ENDPOINT env var)
   * @param apiVersion - API version string (falls back to AZURE_OPENAI_API_VERSION, defaults to '2024-10-21')
   */
  constructor(apiKey?: string, endpoint?: string, apiVersion?: string) {
    this.#client = new AzureOpenAI({
      apiKey: apiKey ?? process.env['AZURE_OPENAI_API_KEY'],
      endpoint: endpoint ?? process.env['AZURE_OPENAI_ENDPOINT'],
      apiVersion: apiVersion ?? process.env['AZURE_OPENAI_API_VERSION'] ?? DEFAULT_AZURE_OPENAI_API_VERSION,
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Throws an `AzureOpenAI.APIError` on non-2xx responses. Callers should catch and
   * handle these (e.g. rate limits, context length exceeded, deployment not found).
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    assertValidMessages(messages)
    const deploymentName = resolveAzureDeploymentName(options.model)
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt, { preserveReasoningAsText: options.preserveReasoningAsText, compressReasoningText: options.compressReasoningText })

    const completion = await this.#client.chat.completions.create(
      {
        // Sampling params first so extraBody can override them. Structural
        // fields (model/messages/tools/stream) come after extraBody so users
        // cannot accidentally clobber them via extraBody.
        // `top_k` / `min_p` deliberately omitted — vLLM-only, not accepted
        // by Azure OpenAI's hosted endpoint.
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        top_p: options.topP,
        parallel_tool_calls: options.parallelToolCalls,
        reasoning_effort: toOpenAISdkReasoningEffort(options.thinking?.effort),
        ...options.extraBody,
        model: deploymentName,
        messages: openAIMessages,
        tools: options.tools ? options.tools.map(toOpenAITool) : undefined,
        stream: false,
      },
      {
        signal: options.abortSignal,
      },
    )

    const toolNames = options.tools?.map(t => t.name)
    return fromOpenAICompletion(completion, toolNames, this.name)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s incrementally.
   *
   * Sequence guarantees match {@link OpenAIAdapter.stream}:
   * - Zero or more `text` events
   * - Zero or more `tool_use` events (emitted once per tool call, after
   *   arguments have been fully assembled)
   * - Exactly one terminal event: `done` or `error`
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    assertValidMessages(messages)
    const deploymentName = resolveAzureDeploymentName(options.model)
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt, { preserveReasoningAsText: options.preserveReasoningAsText, compressReasoningText: options.compressReasoningText })

    // We request usage in the final chunk so we can include it in the `done` event.
    const streamResponse = await this.#client.chat.completions.create(
      {
        // See chat() above for the field-ordering rationale and the
        // `top_k` / `min_p` exclusion.
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        top_p: options.topP,
        parallel_tool_calls: options.parallelToolCalls,
        reasoning_effort: toOpenAISdkReasoningEffort(options.thinking?.effort),
        ...options.extraBody,
        model: deploymentName,
        messages: openAIMessages,
        tools: options.tools ? options.tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        signal: options.abortSignal,
      },
    )

    // Accumulate state across chunks.
    let completionId = ''
    let completionModel = ''
    let finalFinishReason: string = 'stop'
    let inputTokens = 0
    let outputTokens = 0

    // tool_calls are streamed piecemeal; key = tool call index
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >()

    // Full text accumulator for the `done` response.
    let fullText = ''

    try {
      for await (const chunk of streamResponse) {
        completionId = chunk.id
        completionModel = chunk.model

        // Usage is only populated in the final chunk when stream_options.include_usage is set.
        if (chunk.usage !== null && chunk.usage !== undefined) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }

        const choice: ChatCompletionChunk.Choice | undefined = chunk.choices?.[0]
        if (choice === undefined) continue

        const delta = choice.delta

        // --- text delta ---
        if (delta.content !== null && delta.content !== undefined) {
          fullText += delta.content
          const textEvent: StreamEvent = { type: 'text', data: delta.content }
          yield textEvent
        }

        // --- tool call delta ---
        for (const toolCallDelta of delta.tool_calls ?? []) {
          const idx = toolCallDelta.index

          if (!toolCallBuffers.has(idx)) {
            toolCallBuffers.set(idx, {
              id: toolCallDelta.id ?? '',
              name: toolCallDelta.function?.name ?? '',
              argsJson: '',
            })
          }

          const buf = toolCallBuffers.get(idx)
          // buf is guaranteed to exist: we just set it above.
          if (buf !== undefined) {
            if (toolCallDelta.id) buf.id = toolCallDelta.id
            if (toolCallDelta.function?.name) buf.name = toolCallDelta.function.name
            if (toolCallDelta.function?.arguments) {
              buf.argsJson += toolCallDelta.function.arguments
            }
          }
        }

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finalFinishReason = choice.finish_reason
        }
      }

      // Emit accumulated tool_use events after the stream ends.
      const finalToolUseBlocks: ToolUseBlock[] = []
      for (const buf of toolCallBuffers.values()) {
        let parsedInput: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(buf.argsJson)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedInput = parsed as Record<string, unknown>
          }
        } catch {
          // Malformed JSON — surface as empty object.
        }

        const toolUseBlock: ToolUseBlock = {
          type: 'tool_use',
          id: buf.id,
          name: buf.name,
          input: parsedInput,
        }
        finalToolUseBlocks.push(toolUseBlock)
        const toolUseEvent: StreamEvent = { type: 'tool_use', data: toolUseBlock }
        yield toolUseEvent
      }

      // Build the complete content array for the done response.
      const doneContent: ContentBlock[] = []
      if (fullText.length > 0) {
        const textBlock: TextBlock = { type: 'text', text: fullText }
        doneContent.push(textBlock)
      }
      doneContent.push(...finalToolUseBlocks)

      // Fallback: extract tool calls from text when streaming produced no
      // native tool_calls (same logic as fromOpenAICompletion).
      if (finalToolUseBlocks.length === 0 && fullText.length > 0 && options.tools) {
        const toolNames = options.tools.map(t => t.name)
        const extracted = extractToolCallsFromText(fullText, toolNames)
        if (extracted.length > 0) {
          doneContent.push(...extracted)
          for (const block of extracted) {
            yield { type: 'tool_use', data: block } satisfies StreamEvent
          }
        }
      }

      const hasToolUseBlocks = doneContent.some(b => b.type === 'tool_use')
      const resolvedStopReason = hasToolUseBlocks && finalFinishReason === 'stop'
        ? 'tool_use'
        : normalizeFinishReason(finalFinishReason)

      const finalResponse: LLMResponse = {
        id: completionId,
        content: doneContent,
        model: completionModel,
        stop_reason: resolvedStopReason,
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

