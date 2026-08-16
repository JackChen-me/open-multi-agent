# Providers

`open-multi-agent` keeps the agent config shape stable across hosted, cloud, and local providers. Change `provider`, `model`, and the relevant credential; the rest of your team definition stays the same.

To restrict connections opened by enforceable built-in LLM adapters, see the
[framework-owned LLM egress policy](egress-policy.md). That policy deliberately
does not claim to sandbox tools, subprocesses, MCP servers, or application-owned
exporters.

The supported runtime is Node.js 20 or newer; Node.js 22 or 24 is recommended.
Node.js 20 is upstream-EOL and retained only as a migration compatibility
window. OMA will remove Node.js 20 support in its next major release, no earlier
than 2026-10-31. Core uses OpenAI SDK v6 for OpenAI and OpenAI-compatible Chat
Completions endpoints.

```typescript
const agent = {
  name: 'my-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant.',
}
```

## Built-In Provider Shortcuts

The framework ships a wired-in provider name for each of these. Set `provider` and the env var, and the adapter handles the endpoint.

> Under the hood, Anthropic, Gemini, and Bedrock use provider-specific APIs. The other built-in shortcuts are pre-configured wrappers around OpenAI-compatible endpoints; same wire format as the OpenAI-compatible table below, with the `baseURL` already supplied.

| Provider | Config | Env var | Example model | Notes |
|----------|--------|---------|---------------|-------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Native Anthropic SDK. |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | `gemini-2.5-pro` | Native Google GenAI SDK. Requires `npm install @google/genai`. |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` | |
| Azure OpenAI | `provider: 'azure-openai'` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` | `gpt-4` | Optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`. |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_COPILOT_TOKEN` (falls back to `GITHUB_TOKEN`) | `gpt-4o` | Custom token-exchange flow on top of OpenAI protocol. |
| Grok (xAI) | `provider: 'grok'` | `XAI_API_KEY` | `grok-4` | OpenAI-compatible; endpoint is `api.x.ai/v1`. |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | OpenAI-compatible Chat Completions. `deepseek-v4-flash` resolves to DeepSeek-V4-Flash-0731 and `deepseek-v4-pro` to DeepSeek-V4-Pro-0813. Both support 1M context, 384K max output, and enable thinking by default at `high` effort (opt out with `thinking: { enabled: false }`). Both endpoints also offer DeepSeek's native Responses API, while OMA's built-in adapter uses Chat Completions. Legacy `deepseek-chat` / `deepseek-reasoner` were retired on 2026-07-24. |
| Doubao (Volcengine) | `provider: 'doubao'` | `ARK_API_KEY` | `doubao-seed-1-8-251228` | OpenAI-compatible. ByteDance Volcengine Ark endpoint `https://ark.cn-beijing.volces.com/api/v3`. See [`providers/doubao`](../packages/core/examples/providers/doubao.ts). |
| Hunyuan (Tencent MaaS / TokenHub) | `provider: 'hunyuan'` | `HUNYUAN_API_KEY` | `hy3-preview` | OpenAI-compatible. Default endpoint `https://tokenhub.tencentmaas.com/v1` (Tencent's current platform; `sk-...` keys, Hunyuan 3 models). Tool calling verified on `hy3-preview`. See [`providers/hunyuan`](../packages/core/examples/providers/hunyuan.ts). |
| Hunyuan (legacy Tencent Cloud) | `provider: 'hunyuan'` + `HUNYUAN_BASE_URL` | `HUNYUAN_API_KEY` | `hunyuan-turbos-latest` | Legacy endpoint `https://api.hunyuan.cloud.tencent.com/v1` (console.cloud.tencent.com/hunyuan key; separate key namespace). Tencent has announced this platform is being retired (sales stop 2026-06-30, full shutdown 2026-09-30). Set `HUNYUAN_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1` to target it until then. Tool calling verified on `hunyuan-turbos` and `hunyuan-functioncall`. |
| MiniMax (global) | `provider: 'minimax'` | `MINIMAX_API_KEY` | `MiniMax-M3` | OpenAI-compatible. |
| MiniMax (China) | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | `MiniMax-M3` | Set `MINIMAX_BASE_URL=https://api.minimaxi.com/v1`. |
| MiMo | `provider: 'mimo'` | `MIMO_API_KEY` (+ optional `MIMO_BASE_URL`) | `mimo-v2.5-pro` | OpenAI-compatible. Defaults to pay-as-you-go endpoint `https://api.xiaomimimo.com/v1`; Token Plan keys (`tp-...`) require the cluster base URL from your subscription page, such as `https://token-plan-cn.xiaomimimo.com/v1`. Supports reasoning/tool-call loops through the built-in MiMo adapter. See [`providers/mimo`](../packages/core/examples/providers/mimo.ts). |
| Qiniu | `provider: 'qiniu'` | `QINIU_API_KEY` | `deepseek-v3` | OpenAI-compatible. Endpoint `https://api.qnaigc.com/v1`; multiple model families, see [Qiniu AI docs](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api). |
| AWS Bedrock | `provider: 'bedrock'` | none (AWS SDK credential chain) | `anthropic.claude-3-5-haiku-20241022-v1:0` | No API key. Set `AWS_REGION` or pass `region` as the 4th arg to `createAdapter`. Credentials come from env vars, shared config, or IAM role. Newer Claude models can require a cross-region inference profile prefix such as `us.`. Also supports Llama, Mistral, and Cohere. See [`providers/bedrock`](../packages/core/examples/providers/bedrock.ts). Requires `npm install @aws-sdk/client-bedrock-runtime`. |

## OpenAI-Compatible Providers

No bundled shortcut is needed when a server speaks OpenAI Chat Completions. Use `provider: 'openai'` and point `baseURL` at the service.

| Service | Config | Env var | Example model | Notes |
|---------|--------|---------|---------------|-------|
| Ollama (local) | `provider: 'openai'` + `baseURL: 'http://localhost:11434/v1'` | none | `llama3.1` | |
| vLLM (local) | `provider: 'openai'` + `baseURL` | none | server-loaded | |
| LM Studio (local) | `provider: 'openai'` + `baseURL` | none | server-loaded | |
| llama.cpp server (local) | `provider: 'openai'` + `baseURL` | none | server-loaded | |
| OpenRouter | `provider: 'openai'` + `baseURL: 'https://openrouter.ai/api/v1'` + `apiKey` | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` | |
| Groq | `provider: 'openai'` + `baseURL: 'https://api.groq.com/openai/v1'` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | |
| Mistral | `provider: 'openai'` + `baseURL: 'https://api.mistral.ai/v1'` | `MISTRAL_API_KEY` | `mistral-large-latest` | See [`providers/mistral`](../packages/core/examples/providers/mistral.ts). |
| MiMo | `provider: 'openai'` + `baseURL: 'https://api.xiaomimimo.com/v1'` | `MIMO_API_KEY` | `mimo-v2.5-pro` | Prefer the built-in `mimo` provider when using tool-calling agent loops. Token Plan users should set their `token-plan-*.xiaomimimo.com/v1` base URL. |
| Zhipu GLM | `provider: 'openai'` + `baseURL: 'https://open.bigmodel.cn/api/paas/v4'` | `ZHIPU_API_KEY` | `glm-4-plus` | See [`providers/zhipu`](../packages/core/examples/providers/zhipu.ts). |
| Qwen (DashScope) | `provider: 'openai'` + `baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'` | `DASHSCOPE_API_KEY` | `qwen-plus` | See [`providers/qwen`](../packages/core/examples/providers/qwen.ts). |
| Moonshot AI (Kimi) | `provider: 'openai'` + `baseURL: 'https://api.moonshot.ai/v1'` | `MOONSHOT_API_KEY` | `kimi-k2.5` | See [`providers/moonshot`](../packages/core/examples/providers/moonshot.ts). |
| LiteLLM (proxy) | `provider: 'openai'` + `baseURL: 'http://localhost:4000/v1'` + `apiKey` | `LITELLM_API_KEY` (if proxy auth enabled) | any model on your proxy | [LiteLLM](https://github.com/BerriAI/litellm) unifies 100+ providers (OpenAI, Anthropic, Azure, Bedrock, Vertex, etc.) behind one OpenAI-compatible endpoint. Run `litellm --config config.yaml` and point `baseURL` at the proxy. |

Other services can be connected the same way if they implement the OpenAI Chat Completions API, but they are not listed as verified providers here. For services where the key is not `OPENAI_API_KEY`, pass it explicitly via `apiKey`; otherwise the `openai` adapter falls back to `OPENAI_API_KEY`.

### Sponsor listing

[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan) is a paid sponsor of `open-multi-agent`; sponsorship does not affect technical decisions or model recommendations. It is reachable through the same OpenAI-compatible path (`provider: 'openai'` + `baseURL: 'https://api.atlascloud.ai/v1'` + `apiKey`) and is listed here as a sponsor rather than an OMA-verified provider. See the [Atlas Cloud setup guide](providers-atlascloud.md).

OMA registers JSON-schema `function` tools. If an OpenAI-compatible response
contains the separate `custom` tool-call variant, the adapter raises
`UnsupportedToolCallError` instead of dropping the call or presenting an empty
successful turn.

## Budget ceilings and governed runs

Token accounting is provider-independent. Cost accounting remains
application-owned because provider prices, cached-token rules, regions, and
contract rates vary. Configure `estimateCost` once, then place a ceiling on the
orchestrator or on an individual team run:

```typescript
const orchestrator = new OpenMultiAgent({
  maxCostBudget: 1,
  estimateCost: (usage, context) => priceTable[context.model](usage),
})

const result = await orchestrator.runTeam(team, goal, {
  governanceIntent: 'required',
  requiredRoles: ['reviewer', 'security'],
  maxCostBudget: 0.25,
})
```

When both scopes set a ceiling, the lower value wins. The same applies to
`maxTokenBudget`. A required run that exhausts the effective ceiling before its
required execution facts are complete reports
`governanceConclusion: 'unsatisfied'` and `governanceReason: 'budget'`; it is
not presented as a clean governance success. An application `mode`
wins over the required topology, but an unmet floor is disclosed as
`unsatisfied` / `overridden` with the `governance-overridden` flag. Automatic
routing has the lowest priority.

For `governanceIntent: 'preferred'`, set
`preferredUnderBudget: 'degrade'` to choose Single whenever an effective
ceiling applies. The result carries `review-skipped-due-to-budget`, while the
soft preference remains `not-applicable` to the required-governance verdict.
The default is `attempt`, preserving existing behavior.

These controls do **not** run a preflight price or latency estimator.
`estimateCost` converts usage after each provider response, and Token/cost
checks still happen at existing turn/task boundaries, so a run can overshoot by
one model turn. `preferredUnderBudget: 'degrade'` is an application-declared
policy choice, not a prediction that a particular plan would exceed budget.

## Vercel AI SDK (optional)

The AI SDK model is an opaque application-supplied transport. When
`egressPolicy` is configured, OMA rejects `AISdkAdapter` before invocation
rather than claiming it can constrain the model's requests. Use the provider's
own transport controls or an infrastructure firewall when the bridge needs an
egress boundary; see [framework-owned LLM egress policy](egress-policy.md).

The AI SDK bridge routes an agent through [any AI SDK provider](https://ai-sdk.dev/providers) instead of the built-in `provider` factory. Install the optional peers with `npm i ai @ai-sdk/<provider>`; the peer range accepts AI SDK 5, 6, and 7, and AI SDK 7 requires Node.js >= 22.

Pass `adapter: new AISdkAdapter(model)` on `AgentConfig`. When `adapter` is set, `provider`, `apiKey`, `baseURL`, and `region` are ignored for that agent. Mixed teams work as usual: only agents with `adapter` use the AI SDK.

```typescript
import { openai } from '@ai-sdk/openai'
import { AISdkAdapter } from '@open-multi-agent/core/ai-sdk'
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent()
await oma.runAgent(
  {
    name: 'researcher',
    model: 'gpt-4o',
    adapter: new AISdkAdapter(openai('gpt-4o')),
    systemPrompt: 'You are a researcher.',
  },
  'What are the latest AI trends?',
)
```

The coordinator accepts the same hook via `runTeam(team, goal, { coordinator: { adapter: new AISdkAdapter(...) } })`. For a full application, see [`integrations/with-vercel-ai-sdk`](../packages/core/examples/integrations/with-vercel-ai-sdk/).

## Extended Thinking / Reasoning

One `thinking` config on `AgentConfig` maps to each provider's native reasoning setting:

```typescript
const agent = {
  name: 'deep-reasoner',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  systemPrompt: 'Reason carefully before answering.',
  thinking: { enabled: true, budgetTokens: 8_000 },
}
```

- `budgetTokens` maps to Anthropic `thinking.budget_tokens` and Gemini `thinkingConfig.thinkingBudget`.
- `effort` (`'low' | 'medium' | 'high'`) maps to OpenAI-compatible `reasoning_effort`. Values outside the framework union (such as `'minimal'` or `'none'`) can be passed via `extraBody: { reasoning_effort: '<value>' }`.
- DeepSeek additionally maps `enabled` to `thinking: { type: 'enabled' | 'disabled' }` and accepts `effort: 'max'`. DeepSeek V4 enables thinking by default at `high` effort when no framework-level thinking config is supplied. Other built-in OpenAI-family adapters ignore the DeepSeek-only `max` value. Explicit `extraBody` values take precedence.
- Adapters ignore fields they don't recognise, so one config is safe across a mixed-provider team.

Reasoning is streamed as `reasoning` events. Preserving reasoning across a provider switch is opt-in via `preserveReasoningAsText`; see [context management](context-management.md) and [`patterns/cross-provider-reasoning`](../packages/core/examples/patterns/cross-provider-reasoning.ts).

## Local Model Tool-Calling

The framework supports tool-calling with local models served by Ollama, vLLM, LM Studio, or llama.cpp. Tool-calling is handled natively through the OpenAI-compatible API.

Verified local models include Gemma 4, Llama 3.1, Qwen 3, Mistral, and Phi-4. Ollama publishes its tool-capable models at [ollama.com/search?c=tools](https://ollama.com/search?c=tools).

If a local model returns tool calls as text instead of the `tool_calls` wire format, the framework automatically extracts them from the text output. This helps with thinking models or misconfigured local servers.

Use `timeoutMs` on `AgentConfig` for slow local inference:

```typescript
const localAgent = {
  name: 'local',
  model: 'llama3.1',
  provider: 'openai',
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  tools: ['bash', 'file_read'],
  timeoutMs: 120_000,
}
```

Highly quantized MoE models on consumer hardware can fall into repetition loops or hallucinate tool-call schemas under default sampling. `AgentConfig` exposes `topK`, `minP`, `frequencyPenalty`, `presencePenalty`, `parallelToolCalls`, and `extraBody` for server-specific knobs such as vLLM's `repetition_penalty`. See [`providers/local-quantized`](../packages/core/examples/providers/local-quantized.ts) for a complete setup.

## Troubleshooting

- Model not calling tools? Confirm it appears in Ollama's [Tools category](https://ollama.com/search?c=tools).
- Using Ollama? Update to the latest version with `ollama update`.
- Proxy interfering with local servers? Use `no_proxy=localhost`.
