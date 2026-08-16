/**
 * @fileoverview DeepSeek adapter.
 *
 * Thin wrapper around OpenAIAdapter that hard-codes the official DeepSeek
 * OpenAI-compatible endpoint and DEEPSEEK_API_KEY environment variable fallback.
 */

import type { EgressPolicy, LLMChatOptions, ThinkingConfig } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for DeepSeek V4 models. Both models support a 1M context window.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'deepseek'
 *   model: 'deepseek-v4-flash' (DeepSeek-V4-Flash-0731)
 *     or 'deepseek-v4-pro' (DeepSeek-V4-Pro-0813)
 *
 * V4 models enable thinking by default at `high` effort. Pass
 * `thinking: { enabled: false }` to opt out.
 *
 * Legacy `deepseek-chat` and `deepseek-reasoner` were retired by DeepSeek on
 * 2026-07-24.
 */
export class DeepSeekAdapter extends OpenAIAdapter {
  readonly name = 'deepseek'

  // DeepSeek V4 in thinking mode requires `reasoning_content` to be echoed
  // back on EVERY intermediate assistant message of a tool-calling
  // conversation, including the final synthesis message that has no
  // `tool_calls` of its own. Omitting any of them 400s on the next user
  // turn. See:
  //   https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
  // The `'tool-use-only'` capability tells the OpenAIAdapter base class to
  // pass `nativeReasoningEchoProvider: 'deepseek'` to the message builder,
  // which attaches `reasoning_content` on every assistant message in a
  // tool-calling conversation that carries a deepseek-provenance reasoning
  // block. Non-tool conversations drop reasoning entirely (the spec says
  // it is ignored there but would still bloat context).
  override readonly capabilities = {
    echoesReasoning: 'tool-use-only' as const,
  }

  /**
   * DeepSeek exposes its thinking switch as
   * `thinking: { type: 'enabled' | 'disabled' }`.
   *
   * Keep the field absent when no framework-level thinking config is supplied
   * so DeepSeek's server default still applies. Explicit `extraBody` values
   * remain the final override layer for forward compatibility.
   */
  protected override buildExtraBody(options: LLMChatOptions): Record<string, unknown> | undefined {
    const extraBody = super.buildExtraBody(options)
    if (options.thinking === undefined) return extraBody
    return {
      thinking: {
        type: options.thinking.enabled ? 'enabled' : 'disabled',
      },
      ...extraBody,
    }
  }

  protected override buildReasoningEffort(options: LLMChatOptions): ThinkingConfig['effort'] {
    return options.thinking?.effort
  }

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Allow override of baseURL (for proxies or future changes) but default to official DeepSeek endpoint.
    super(
      apiKey ?? process.env['DEEPSEEK_API_KEY'],
      baseURL ?? 'https://api.deepseek.com/v1',
      egressPolicy,
      'deepseek',
    )
  }
}
