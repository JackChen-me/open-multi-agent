import { describe, expect, it } from 'vitest'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
} from '@open-multi-agent/core'
import { PreflightBudgetAdapter, serializeModelRequest } from '../src/model-budget.js'

describe('model request preflight budget', () => {
  it('rejects an oversized next request before provider.chat is called', async () => {
    const provider = new RecordingAdapter()
    const guarded = new PreflightBudgetAdapter(provider, 1_000)
    const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(12_000) }] }]
    await expect(guarded.chat(messages, { model: 'fixture', maxTokens: 100 }))
      .rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXCEEDED' })
    expect(provider.calls).toBe(0)
  })

  it('measures the actual provider-facing serialized request and reserves output', async () => {
    const provider = new RecordingAdapter()
    const estimates: number[] = []
    const guarded = new PreflightBudgetAdapter(provider, 10_000, estimate => {
      estimates.push(estimate.serializedChars)
      expect(estimate.reservedOutputTokens).toBe(200)
    })
    const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'bounded request' }] }]
    const options = { model: 'fixture', maxTokens: 200, systemPrompt: 'policy' }
    await guarded.chat(messages, options)
    expect(estimates).toEqual([serializeModelRequest(messages, options).length])
    expect(provider.calls).toBe(1)
  })
})

class RecordingAdapter implements LLMAdapter {
  readonly name = 'recording'
  calls = 0

  async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    this.calls += 1
    return {
      id: 'recording',
      content: [{ type: 'text', text: '{}' }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    yield { type: 'done', data: await this.chat(messages, options) }
  }
}
