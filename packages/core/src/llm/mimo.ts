/**
 * @fileoverview MiMo adapter.
 *
 * Thin wrapper around OpenAIAdapter that configures MiMo's official
 * OpenAI-compatible endpoint and MIMO_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for MiMo models.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'mimo'
 *   model: 'mimo-v2.5-pro' (or any model available to your MiMo API key)
 */
export class MiMoAdapter extends OpenAIAdapter {
  readonly name = 'mimo'

  // MiMo thinking mode follows the same OpenAI-compatible reasoning_content
  // replay contract as DeepSeek for multi-turn tool-calling conversations.
  override readonly capabilities = {
    echoesReasoning: 'tool-use-only' as const,
  }

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (Token Plan clusters, proxies, or future changes)
    // but default to the official pay-as-you-go MiMo endpoint.
    super(
      apiKey ?? process.env['MIMO_API_KEY'],
      baseURL ?? process.env['MIMO_BASE_URL'] ?? 'https://api.xiaomimimo.com/v1',
      egressPolicy,
      'mimo',
    )
  }
}
