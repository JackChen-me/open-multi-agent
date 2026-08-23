/**
 * @fileoverview LLM adapter factory.
 *
 * Re-exports the {@link LLMAdapter} interface and provides a
 * {@link createAdapter} factory that returns the correct concrete
 * implementation based on the requested provider.
 *
 * @example
 * ```ts
 * import { createAdapter } from './adapter.js'
 *
 * const anthropic = createAdapter('anthropic')
 * const openai    = createAdapter('openai', process.env.OPENAI_API_KEY)
 * const gemini    = createAdapter('gemini', process.env.GEMINI_API_KEY)
 * ```
 */

export type {
  LLMAdapter,
  LLMChatOptions,
  LLMStreamOptions,
  LLMToolDef,
  LLMMessage,
  LLMResponse,
  StreamEvent,
  TokenUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  VideoBlock,
} from '../types.js'

import type { EgressPolicy, LLMAdapter } from '../types.js'
import {
  assertEgressAllowed,
  normalizeEgressPolicy,
  rejectUnresolvedEgressTarget,
  rejectUnsupportedEgress,
} from './egress.js'

/**
 * The set of LLM providers supported out of the box.
 * Additional providers can be integrated by implementing {@link LLMAdapter}
 * directly and bypassing this factory, or via {@link AISdkAdapter} from
 * `@open-multi-agent/core/ai-sdk` (optional peer `ai`).
 */
export type SupportedProvider = 'anthropic' | 'azure-openai' | 'bedrock' | 'copilot' | 'deepseek' | 'doubao' | 'grok' | 'hunyuan' | 'minimax' | 'mimo' | 'openai' | 'gemini' | 'qiniu'

const PROVIDER_DEFAULT_BASE_URLS: Partial<Record<SupportedProvider, string>> = {
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  grok: 'https://api.x.ai/v1',
  hunyuan: 'https://tokenhub.tencentmaas.com/v1',
  minimax: 'https://api.minimax.io/v1',
  mimo: 'https://api.xiaomimimo.com/v1',
  openai: 'https://api.openai.com/v1',
  qiniu: 'https://api.qnaigc.com/v1',
}

function configuredProviderBaseURL(
  provider: Exclude<SupportedProvider, 'bedrock' | 'copilot' | 'gemini'>,
  baseURL: string | undefined,
): string {
  if (baseURL !== undefined) return baseURL
  const envURL = provider === 'anthropic'
    ? process.env['ANTHROPIC_BASE_URL']
    : provider === 'openai'
      ? process.env['OPENAI_BASE_URL']
      : provider === 'azure-openai'
        ? process.env['AZURE_OPENAI_ENDPOINT']
        : provider === 'minimax'
          ? process.env['MINIMAX_BASE_URL']
          : provider === 'mimo'
            ? process.env['MIMO_BASE_URL']
            : provider === 'hunyuan'
              ? process.env['HUNYUAN_BASE_URL']
              : undefined
  if (envURL !== undefined) return envURL
  const fallback = PROVIDER_DEFAULT_BASE_URLS[provider]
  if (fallback === undefined) {
    rejectUnresolvedEgressTarget(
      provider,
      'set AgentConfig.baseURL or the provider-specific endpoint environment variable.',
    )
  }
  return fallback
}

function prepareProviderBaseURL(
  provider: SupportedProvider,
  baseURL: string | undefined,
  policy: EgressPolicy | undefined,
  apiKey: string | undefined,
): string | undefined {
  if (policy === undefined) return baseURL
  if (provider === 'bedrock') {
    rejectUnsupportedEgress(
      policy,
      provider,
      'the AWS SDK credential chain and request handler can open endpoints not exposed by the current OMA adapter config.',
    )
    return undefined
  }
  if (provider === 'gemini') {
    rejectUnsupportedEgress(
      policy,
      provider,
      'the current Google GenAI SDK path uses module-global fetch and does not expose a request transport hook to OMA.',
    )
    return undefined
  }
  if (provider === 'copilot') {
    assertEgressAllowed(policy, 'https://api.githubcopilot.com', provider)
    assertEgressAllowed(policy, 'https://api.github.com', provider)
    const hasGithubToken = apiKey !== undefined
      || process.env['GITHUB_COPILOT_TOKEN'] !== undefined
      || process.env['GITHUB_TOKEN'] !== undefined
    if (!hasGithubToken) {
      assertEgressAllowed(policy, 'https://github.com', provider)
    }
    return undefined
  }
  const target = configuredProviderBaseURL(provider, baseURL)
  assertEgressAllowed(policy, target, provider)
  return target
}

/**
 * Instantiate the appropriate {@link LLMAdapter} for the given provider.
 *
 * API keys fall back to the standard environment variables when not supplied
 * explicitly:
 * - `anthropic`    → `ANTHROPIC_API_KEY`
 * - `azure-openai` → `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`
 * - `openai`       → `OPENAI_API_KEY`
 * - `gemini`       → `GEMINI_API_KEY` / `GOOGLE_API_KEY`
 * - `grok`         → `XAI_API_KEY`
 * - `minimax`      → `MINIMAX_API_KEY`
 * - `mimo`         → `MIMO_API_KEY`, optional `MIMO_BASE_URL`
 * - `deepseek`     → `DEEPSEEK_API_KEY`
 * - `doubao`       → `ARK_API_KEY`
 * - `hunyuan`      → `HUNYUAN_API_KEY`, optional `HUNYUAN_BASE_URL`
 *                     (defaults to the Tencent MaaS / TokenHub endpoint)
 * - `qiniu`        → `QINIU_API_KEY`
 * - `bedrock`      → no API key; credentials via AWS SDK default provider chain
 *                     (env vars, shared config, IAM role). Pass `region` (4th arg)
 *                     or set `AWS_REGION`; falls back to `'us-east-1'`.
 * - `copilot`      → `GITHUB_COPILOT_TOKEN` / `GITHUB_TOKEN`, or interactive
 *                     OAuth2 device flow if neither is set
 *
 * Adapters are imported lazily so that projects using only one provider
 * are not forced to install the SDK for the other.
 *
 * @param provider - Which LLM provider to target.
 * @param apiKey   - Optional API key override; falls back to env var. Not used for `bedrock`.
 * @param baseURL  - Optional base URL for OpenAI-compatible APIs (Ollama, vLLM, etc.). Not used for `bedrock`.
 * @param region   - Optional AWS region for `bedrock`; falls back to `AWS_REGION` env var, then `'us-east-1'`. Ignored by all other providers.
 * @param egressPolicy - Optional framework-owned LLM egress restriction.
 * @throws {Error} When the provider string is not recognised.
 */
export async function createAdapter(
  provider: SupportedProvider,
  apiKey?: string,
  baseURL?: string,
  region?: string,
  egressPolicy?: EgressPolicy,
): Promise<LLMAdapter> {
  const policy = normalizeEgressPolicy(egressPolicy)
  const policyBaseURL = prepareProviderBaseURL(provider, baseURL, policy, apiKey)
  switch (provider) {
    case 'anthropic': {
      const { AnthropicAdapter } = await import('./anthropic.js')
      return new AnthropicAdapter(apiKey, policyBaseURL, policy)
    }
    case 'copilot': {
      if (baseURL) {
        console.warn('[open-multi-agent] baseURL is not supported for the copilot provider and will be ignored.')
      }
      const { CopilotAdapter } = await import('./copilot.js')
      return new CopilotAdapter({ apiKey, egressPolicy: policy })
    }
    case 'gemini': {
      const { GeminiAdapter } = await import('./gemini.js')
      return new GeminiAdapter(apiKey)
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('./openai.js')
      return new OpenAIAdapter(apiKey, policyBaseURL, policy, provider)
    }
    case 'grok': {
      const { GrokAdapter } = await import('./grok.js')
      return new GrokAdapter(apiKey, policyBaseURL, policy)
    }
    case 'minimax': {
      const { MiniMaxAdapter } = await import('./minimax.js')
      return new MiniMaxAdapter(apiKey, policyBaseURL, policy)
    }
    case 'mimo': {
      const { MiMoAdapter } = await import('./mimo.js')
      return new MiMoAdapter(apiKey, policyBaseURL, policy)
    }
    case 'deepseek': {
      const { DeepSeekAdapter } = await import('./deepseek.js')
      return new DeepSeekAdapter(apiKey, policyBaseURL, policy)
    }
    case 'doubao': {
      const { DoubaoAdapter } = await import('./doubao.js')
      return new DoubaoAdapter(apiKey, policyBaseURL, policy)
    }
    case 'hunyuan': {
      const { HunyuanAdapter } = await import('./hunyuan.js')
      return new HunyuanAdapter(apiKey, policyBaseURL, policy)
    }
    case 'qiniu': {
      const { QiniuAdapter } = await import('./qiniu.js')
      return new QiniuAdapter(apiKey, policyBaseURL, policy)
    }
    case 'azure-openai': {
      // For azure-openai, the `baseURL` parameter serves as the Azure endpoint URL.
      // To override the API version, set AZURE_OPENAI_API_VERSION env var.
      const { AzureOpenAIAdapter } = await import('./azure-openai.js')
      return new AzureOpenAIAdapter(apiKey, policyBaseURL, undefined, policy)
    }
    case 'bedrock': {
      if (baseURL) console.warn('[open-multi-agent] baseURL is ignored for bedrock; pass region as the fourth arg or set AWS_REGION.')
      const { BedrockAdapter } = await import('./bedrock.js')
      return new BedrockAdapter(region)
    }
    default: {
      // The `never` cast here makes TypeScript enforce exhaustiveness.
      const _exhaustive: never = provider
      throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`)
    }
  }
}
