/**
 * @fileoverview MiniMax adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official MiniMax
 * OpenAI-compatible endpoint and MINIMAX_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for MiniMax models (MiniMax-M3, M2.7 series, and future models).
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'minimax'
 *   model: 'MiniMax-M3' (or any current MiniMax model name)
 */
export class MiniMaxAdapter extends OpenAIAdapter {
  readonly name = 'minimax'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official MiniMax endpoint.
    super(
      apiKey ?? process.env['MINIMAX_API_KEY'],
      baseURL ?? process.env['MINIMAX_BASE_URL'] ?? 'https://api.minimax.io/v1',
      egressPolicy,
      'minimax',
    )
  }
}
