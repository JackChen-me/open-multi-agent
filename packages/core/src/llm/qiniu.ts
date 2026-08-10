/**
 * @fileoverview Qiniu adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official Qiniu
 * OpenAI-compatible endpoint and QINIU_API_KEY environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for Qiniu models (deepseek-v3 and future models).
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'qiniu'
 *   model: 'deepseek-v3' (or any model available to your Qiniu API key)
 */
export class QiniuAdapter extends OpenAIAdapter {
  readonly name = 'qiniu'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official Qiniu endpoint.
    super(
      apiKey ?? process.env['QINIU_API_KEY'],
      baseURL ?? 'https://api.qnaigc.com/v1',
      egressPolicy,
      'qiniu',
    )
  }
}
