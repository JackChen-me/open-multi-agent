/**
 * @fileoverview Grok (xAI) adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official xAI endpoint
 * and XAI_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for Grok models (grok-4 series and future models).
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'grok'
 *   model: 'grok-4' (or any current Grok model name)
 */
export class GrokAdapter extends OpenAIAdapter {
  readonly name = 'grok'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official xAI endpoint.
    super(
      apiKey ?? process.env['XAI_API_KEY'],
      baseURL ?? 'https://api.x.ai/v1',
      egressPolicy,
      'grok',
    )
  }
}
