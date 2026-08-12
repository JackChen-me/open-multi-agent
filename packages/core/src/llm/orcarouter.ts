/**
 * @fileoverview OrcaRouter adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the OrcaRouter
 * OpenAI-compatible endpoint and ORCAROUTER_API_KEY environment variable
 * fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for OrcaRouter models.
 *
 * OrcaRouter is an OpenAI-compatible aggregation gateway that fronts 190+
 * models (Anthropic, OpenAI, Google, DeepSeek, Qwen, …) behind a single
 * endpoint and API key. Model names use the `provider/model` namespace, e.g.
 * `anthropic/claude-haiku-4.5` or `orcarouter/auto`.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'orcarouter'
 *   model: 'anthropic/claude-haiku-4.5' (or any OrcaRouter-routed model name)
 */
export class OrcaRouterAdapter extends OpenAIAdapter {
  readonly name = 'orcarouter'

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to
    // the official OrcaRouter endpoint.
    super(
      apiKey ?? process.env['ORCAROUTER_API_KEY'],
      baseURL ?? 'https://api.orcarouter.ai/v1',
      egressPolicy,
      'orcarouter',
    )
  }
}
