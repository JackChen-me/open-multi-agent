import {
  TokenBudgetExceededError,
  type LLMAdapter,
  type LLMChatOptions,
  type LLMMessage,
  type LLMResponse,
  type LLMStreamOptions,
  type StreamEvent,
} from '@open-multi-agent/core'

export interface ModelRequestEstimate {
  readonly serializedChars: number
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
  readonly tokensUsedBeforeCall: number
  readonly budget: number
}

export class PreflightBudgetAdapter implements LLMAdapter {
  readonly name: string
  readonly capabilities: LLMAdapter['capabilities']
  private tokensUsed = 0

  constructor(
    private readonly inner: LLMAdapter,
    private readonly budget: number,
    private readonly onEstimate?: (estimate: ModelRequestEstimate) => void,
  ) {
    // Preserve provider identity so native reasoning provenance round-trips
    // exactly as it would through the unwrapped adapter.
    this.name = inner.name
    this.capabilities = inner.capabilities
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    this.assertRequestFits(messages, options)
    const response = await this.inner.chat(messages, options)
    this.recordUsage(response)
    return response
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    this.assertRequestFits(messages, options)
    for await (const event of this.inner.stream(messages, options)) {
      if (event.type === 'done') this.recordUsage(event.data as LLMResponse)
      yield event
    }
  }

  private assertRequestFits(messages: LLMMessage[], options: LLMChatOptions): void {
    const serializedChars = serializeModelRequest(messages, options).length
    // Three UTF-16 characters per token deliberately overestimates typical
    // English/code prompts while remaining deterministic and tokenizer-free.
    const estimatedInputTokens = Math.ceil(serializedChars / 3)
    const reservedOutputTokens = options.maxTokens ?? 4_096
    const estimate = {
      serializedChars,
      estimatedInputTokens,
      reservedOutputTokens,
      tokensUsedBeforeCall: this.tokensUsed,
      budget: this.budget,
    }
    this.onEstimate?.(estimate)
    const projected = this.tokensUsed + estimatedInputTokens + reservedOutputTokens
    if (projected > this.budget) {
      throw new TokenBudgetExceededError(`preflight-budget:${this.name}`, projected, this.budget)
    }
  }

  private recordUsage(response: LLMResponse): void {
    this.tokensUsed += response.usage.input_tokens + response.usage.output_tokens
  }
}

export function serializeModelRequest(messages: LLMMessage[], options: LLMChatOptions): string {
  return JSON.stringify({
    model: options.model,
    messages,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    frequencyPenalty: options.frequencyPenalty,
    presencePenalty: options.presencePenalty,
    topP: options.topP,
    topK: options.topK,
    minP: options.minP,
    parallelToolCalls: options.parallelToolCalls,
    extraBody: options.extraBody,
    thinking: options.thinking,
    preserveReasoningAsText: options.preserveReasoningAsText,
    compressReasoningText: options.compressReasoningText,
  })
}
