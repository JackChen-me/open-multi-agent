/**
 * Local Quantized Model with Tuned Sampling (vLLM / llama-server)
 *
 * Demonstrates the sampling parameters exposed in v1.3+ — `topK`, `minP`,
 * `frequencyPenalty`, `presencePenalty`, `parallelToolCalls`, and the
 * `extraBody` escape hatch — applied to a quantized MoE model served by an
 * OpenAI-compatible local inference server.
 *
 * Why this example exists:
 *   Highly quantized MoE models (e.g. Qwen2.5-MoE @ Q4, DeepSeek-MoE @ Q4)
 *   on consumer hardware tend to fall into repetition loops or hallucinate
 *   tool-call schemas when sampling defaults are too permissive. The knobs
 *   below clamp the distribution and discourage repetition. Cloud OpenAI
 *   users do not need any of these — defaults are tuned for full-precision
 *   models. This is a local-quantized concern.
 *
 * Run:
 *   no_proxy=localhost npx tsx examples/providers/local-quantized.ts
 *
 * Prerequisites — pick one OpenAI-compatible local server:
 *   • vLLM:        `vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ --port 8000`
 *   • llama-server: `llama-server -m model.gguf --port 8080`
 *   • LM Studio, Ollama, etc. — any server that accepts OpenAI chat
 *     completions on a local port.
 *   Then update LOCAL_BASE_URL and LOCAL_MODEL below.
 *
 * Provider compatibility note (per `AgentConfig` JSDoc):
 *   • topP                                 — universal
 *   • topK                                 — Anthropic + OpenAI-compatible local
 *   • minP                                 — OpenAI-compatible local only
 *   • frequencyPenalty / presencePenalty  — OpenAI track only
 *   • parallelToolCalls                    — OpenAI track only; set `false` for
 *                                            local servers that mishandle
 *                                            concurrent tool_call deltas
 *   • extraBody                            — adapter-specific escape hatch
 *
 * Cloud OpenAI rejects `top_k` and `min_p`; this example is not portable to
 * `api.openai.com`.
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Configuration — adjust to your local server
// ---------------------------------------------------------------------------

const LOCAL_BASE_URL = 'http://localhost:8000/v1'    // vLLM default; llama-server: 8080, LM Studio: 1234
const LOCAL_MODEL = 'Qwen/Qwen2.5-7B-Instruct-AWQ'   // any model your local server has loaded

// ---------------------------------------------------------------------------
// Agent — each sampling knob is annotated with the loop / hallucination
// failure mode it counters on quantized models.
// ---------------------------------------------------------------------------

const assistant: AgentConfig = {
  name: 'assistant',
  model: LOCAL_MODEL,
  provider: 'openai',
  baseURL: LOCAL_BASE_URL,
  apiKey: 'local',  // placeholder — local servers ignore this, but the OpenAI SDK requires a non-empty value

  // Standard sampling — sane defaults for instruction-tuned quantized models.
  temperature: 0.7,
  maxTokens: 1024,

  // Nucleus + top-k jointly clamp the candidate pool. On Q4 quants the raw
  // distribution often has long, noisy tails that produce off-topic tokens.
  topP: 0.95,
  topK: 40,

  // Min-p drops any token whose probability is below `minP * max_prob`. Cuts
  // the tail more aggressively than top-k alone. vLLM / llama-server expose
  // this; cloud OpenAI does not.
  minP: 0.05,

  // Frequency penalty discourages repeated tokens — the most common failure
  // mode is the model getting stuck emitting the same tool_call schema or
  // sentence fragment over and over. Value range is -2..2; 0.3 is a mild
  // nudge that does not noticeably hurt fluency.
  frequencyPenalty: 0.3,

  // Presence penalty is usually 0 unless you specifically want to push the
  // model toward novel topics. Left here to make the contract explicit.
  presencePenalty: 0,

  // extraBody: adapter-specific escape hatch. vLLM and llama-server accept a
  // `repetition_penalty` parameter that is not in the OpenAI spec — it
  // multiplies logits of recently emitted tokens. Slightly redundant with
  // frequencyPenalty but operates on logits instead of token counts, so the
  // two compose. Anything you put here is merged into the request body and
  // can override standard sampling fields, but cannot override transport
  // fields (`model`, `messages`, `tools`, `stream`).
  extraBody: {
    repetition_penalty: 1.05,
  },

  systemPrompt: `You are a concise assistant. Answer in one short paragraph.
Do not repeat yourself.`,

  maxTurns: 4,
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: LOCAL_MODEL,
  maxConcurrency: 1,  // most local servers serve one request at a time
})

console.log(`Calling ${LOCAL_MODEL} at ${LOCAL_BASE_URL}`)
console.log('Sampling: topP=0.95 topK=40 minP=0.05 freqPenalty=0.3 + repetition_penalty=1.05\n')

const result = await orchestrator.runAgent(
  assistant,
  'In one paragraph, explain what min-p sampling does and when it helps.',
)

console.log('--- response ---')
console.log(result.output)
console.log()
console.log(`tokens: ${result.tokenUsage.input_tokens} in / ${result.tokenUsage.output_tokens} out`)
