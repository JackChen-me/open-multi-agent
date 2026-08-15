/**
 * @fileoverview Hunyuan (Tencent) adapter.
 *
 * Thin wrapper around OpenAIAdapter that defaults to Tencent Hunyuan's current
 * MaaS / TokenHub OpenAI-compatible endpoint, with a HUNYUAN_API_KEY
 * environment variable fallback.
 */

import type { EgressPolicy } from '../types.js'
import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for Tencent Hunyuan models.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'hunyuan'
 *   model: 'hy3-preview' (or any model available to your Hunyuan API key)
 *
 * Tool calling is verified on the hy3-preview, hunyuan-turbos, and
 * hunyuan-functioncall model families.
 *
 * Tencent exposes Hunyuan through two independent OpenAI-compatible surfaces
 * with separate API-key namespaces:
 *   - Tencent MaaS / TokenHub (default): https://tokenhub.tencentmaas.com/v1,
 *     models like `hy3-preview`, `sk-...` keys. This is Tencent's current
 *     platform.
 *   - Legacy Tencent Cloud: https://api.hunyuan.cloud.tencent.com/v1,
 *     models like `hunyuan-turbos-latest`, console keys. Tencent has
 *     announced this platform is being retired (sales stop 2026-06-30, full
 *     shutdown 2026-09-30); target it via `HUNYUAN_BASE_URL` until then.
 * Set `HUNYUAN_BASE_URL` (or pass `baseURL`) to target the legacy endpoint or
 * any future cluster without code changes.
 */
export class HunyuanAdapter extends OpenAIAdapter {
  readonly name = 'hunyuan'

  // Hunyuan's interleaved-thinking mode (hy3-preview with
  // `reasoning_effort: 'low' | 'high'`) requires the prior turn's
  // `reasoning_content` to be backfilled on every follow-up request that
  // continues a tool-calling conversation, otherwise the chain of thought is
  // broken and answer quality degrades. See:
  //   https://cloud.tencent.com/document/product/1823/130930 (Interleaved Thinking)
  //   https://cloud.tencent.com/document/product/1823/132252 (Hunyuan call guide)
  // `'tool-use-only'` makes the OpenAIAdapter base class pass
  // `nativeReasoningEchoProvider: 'hunyuan'` to the message builder, which
  // re-attaches `reasoning_content` on assistant turns of a tool-using
  // conversation that carry a hunyuan-provenance reasoning block. Non-thinking
  // models on this provider (e.g. hunyuan-turbos, hunyuan-functioncall) never
  // emit `reasoning_content`, so the echo is a no-op for them — safe as a
  // family-wide default. (Unlike DeepSeek, Hunyuan does not hard-400 when the
  // field is dropped; the spec frames it as a quality requirement.)
  override readonly capabilities = {
    echoesReasoning: 'tool-use-only' as const,
  }

  constructor(apiKey?: string, baseURL?: string, egressPolicy?: EgressPolicy) {
    // Default to the current Tencent MaaS / TokenHub endpoint; allow override
    // of baseURL (legacy Tencent Cloud endpoint, proxies, or future clusters).
    super(
      apiKey ?? process.env['HUNYUAN_API_KEY'],
      baseURL ?? process.env['HUNYUAN_BASE_URL'] ?? 'https://tokenhub.tencentmaas.com/v1',
      egressPolicy,
      'hunyuan',
    )
  }
}
