import { describe, expect, it, vi } from 'vitest'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
} from '../src/types.js'

const mocks = vi.hoisted(() => ({ createAdapter: vi.fn() }))

vi.mock('../src/llm/adapter.js', () => ({ createAdapter: mocks.createAdapter }))

import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'

describe('semantic routing default adapter resolution', () => {
  it('creates the profiler adapter from the default provider as the final fallback', async () => {
    const defaultRoutingChat = vi.fn(
      async (_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> => ({
        id: 'default-routing-profile',
        content: [{
          type: 'text',
          text: JSON.stringify({
            evidenceSources: 'single',
            independentReview: 'none',
            conflictingObjectives: false,
            sideEffectIntent: 'none',
            permissionIsolation: 'none',
            decomposable: false,
            parallelizable: false,
            complexity: 'low',
            confidence: 0.95,
            reasons: ['One simple task.'],
          }),
        }],
        model: options.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    )
    mocks.createAdapter.mockResolvedValue({
      name: 'default-routing-adapter',
      chat: defaultRoutingChat,
      async *stream() { /* unused */ },
    } satisfies LLMAdapter)
    const agentAdapter: LLMAdapter = {
      name: 'worker-adapter',
      async chat(): Promise<LLMResponse> {
        return {
          id: 'worker-response',
          content: [{ type: 'text', text: 'hello' }],
          model: 'worker-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
      async *stream() { /* unused */ },
    }
    const oma = new OpenMultiAgent({
      defaultProvider: 'openai',
      defaultModel: 'default-routing-model',
      executionRouting: { strategy: 'hybrid' },
    })
    const team = oma.createTeam('default-adapter', {
      name: 'default-adapter',
      agents: [{
        name: 'alpha',
        model: 'worker-model',
        adapter: agentAdapter,
      }],
    })

    const result = await oma.runTeam(team, 'Say hello')

    expect(mocks.createAdapter).toHaveBeenCalledWith('openai', undefined, undefined)
    expect(JSON.stringify(defaultRoutingChat.mock.calls[0]?.[0])).toContain('Say hello')
    expect(result.semanticRoutingAssessment).toMatchObject({
      recommendation: 'single',
      actualMode: 'single',
    })
  })
})
