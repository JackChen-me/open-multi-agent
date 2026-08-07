/**
 * @fileoverview Doubao (ByteDance Volcengine) adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official Volcengine
 * Ark OpenAI-compatible endpoint and ARK_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for Doubao (ByteDance Volcengine Ark) models.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'doubao'
 *   model: 'doubao-seed-1-8-251228' (or any model available to your Ark API key)
 */
export class DoubaoAdapter extends OpenAIAdapter {
  readonly name = 'doubao'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official Volcengine Ark endpoint.
    super(
      apiKey ?? process.env['ARK_API_KEY'],
      baseURL ?? 'https://ark.cn-beijing.volces.com/api/v3',
      egressPolicy,
      'doubao',
    )
  }
}
