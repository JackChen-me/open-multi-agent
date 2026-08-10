/**
 * Team with TencentDB-Agent-Memory (orchestrated)
 *
 * A two-agent team runs via `runTeam()` with {@link TdamMemoryStore} plugged
 * in as the team's `sharedMemoryStore`. One process run demonstrates the full
 * memory loop; running the script a second time demonstrates persistence:
 *
 *   1. **Recall** — pull long-term context for the topic from previous runs
 *      and inject it into both agents' system prompts (empty on the first run)
 *   2. **Run** — the orchestrator's shared-memory writes (task results,
 *      coordinator summaries) are captured into TDAM automatically
 *   3. **Flush** — `endSession()` drains TDAM's L0 → L1 extraction so the
 *      captured material becomes searchable
 *   4. **Verify** — search distilled memories and print what TDAM extracted
 *
 * Works with every provider the framework supports. Set the provider and model
 * via environment variables:
 *
 *   AGENT_PROVIDER  — anthropic | openai | gemini | grok | copilot | deepseek | minimax | azure-openai
 *   AGENT_MODEL     — model name for the chosen provider
 *   AGENT_BASE_URL  — optional; OpenAI-compatible server URL (Ollama, vLLM, …),
 *                     use with AGENT_PROVIDER=openai
 *   AGENT_API_KEY   — optional; key for AGENT_BASE_URL servers (default "local")
 *
 * Defaults to anthropic / claude-sonnet-4-6 when unset.
 *
 * Run:
 *   npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts
 *
 * Examples:
 *   # Anthropic (default)
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts
 *
 *   # Fully local: agents on Ollama, Gateway extraction also on Ollama
 *   AGENT_PROVIDER=openai AGENT_MODEL=qwen3 AGENT_BASE_URL=http://localhost:11434/v1 \
 *     npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts
 *
 * Prerequisites:
 *   - TDAM Hermes Gateway running at http://127.0.0.1:8420 (see README.md)
 *   - API key env var for your chosen provider (not needed for local servers)
 *   - TDAI_GATEWAY_API_KEY env var if the Gateway has Bearer auth enabled
 */

import { OpenMultiAgent } from '../../../packages/core/src/index.js'
import type {
  AgentConfig,
  OrchestratorEvent,
  SupportedProvider,
} from '../../../packages/core/src/index.js'
import { TdamMemoryStore } from './tdam-store.js'
import { TdamToolkit } from './tdam-toolkit.js'

// ---------------------------------------------------------------------------
// Provider / model configuration
// ---------------------------------------------------------------------------

const PROVIDER = (process.env.AGENT_PROVIDER ?? 'anthropic') as SupportedProvider
const MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-4-6'
const BASE_URL = process.env.AGENT_BASE_URL?.trim() || undefined
const API_KEY = BASE_URL ? (process.env.AGENT_API_KEY?.trim() || 'local') : undefined

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
  copilot: 'GITHUB_TOKEN',
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
}

// Hosted providers need their env key; OpenAI-compatible servers passed via
// AGENT_BASE_URL authenticate with AGENT_API_KEY (or none at all).
const envKey = PROVIDER_ENV_KEYS[PROVIDER]
if (!BASE_URL && envKey && !process.env[envKey]?.trim()) {
  console.error(`Missing ${envKey}: required for provider "${PROVIDER}".`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// TDAM-backed shared memory store
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.env.TDAM_GATEWAY_URL ?? 'http://127.0.0.1:8420'

const store = new TdamMemoryStore({
  baseUrl: GATEWAY_URL,
  sessionKey: process.env.TDAM_SESSION_KEY ?? 'oma-memory-demo',
})

const tdamTools = new TdamToolkit({ baseUrl: GATEWAY_URL }).getTools()

// ---------------------------------------------------------------------------
// Gateway health check — fail fast with a pointer to the README
// ---------------------------------------------------------------------------

const TOPIC = 'trade-offs between SQLite and PostgreSQL as storage for AI agent memory'

console.log('Team with TencentDB-Agent-Memory')
console.log('='.repeat(60))
console.log(`Provider: ${PROVIDER}${BASE_URL ? ` (via ${BASE_URL})` : ''}`)
console.log(`Model:    ${MODEL}`)
console.log(`Gateway:  ${GATEWAY_URL}`)
console.log(`Topic:    ${TOPIC}\n`)

try {
  const health = await store.health()
  console.log(
    `Gateway health: ${health.status} (v${health.version}, ` +
    `vectorStore=${health.stores.vectorStore}, embedding=${health.stores.embeddingService})\n`,
  )
} catch {
  console.error(
    `Cannot reach the TDAM Gateway at ${GATEWAY_URL}.\n` +
    'Start it first — see examples/integrations/with-tencentdb-memory/README.md.',
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 1: recall long-term memory from previous runs
// ---------------------------------------------------------------------------

console.log('[1/4] Recalling long-term memory for the topic...')
const recalled = await store.recall(TOPIC)

let memoryContext = ''
if (recalled.context.trim()) {
  memoryContext =
    '\n\n## Long-term memory (distilled from previous sessions)\n' +
    recalled.context
  console.log(
    `  Recalled ${recalled.memory_count ?? 0} memories ` +
    `(strategy: ${recalled.strategy ?? 'n/a'}) — injecting into agent prompts.\n`,
  )
} else {
  console.log('  No long-term memories yet (first run against this Gateway).\n')
}

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const analyst: AgentConfig = {
  name: 'analyst',
  model: MODEL,
  provider: PROVIDER,
  baseURL: BASE_URL,
  apiKey: API_KEY,
  systemPrompt:
    `You are a storage systems analyst investigating: "${TOPIC}".\n\n` +
    'State 4-6 concrete, specific findings (latency characteristics, ' +
    'operational overhead, concurrency behavior, deployment fit for agent ' +
    'workloads). Number each finding and keep it to one or two sentences.' +
    memoryContext,
  maxTurns: 6,
  timeoutMs: 300_000,
}

const writer: AgentConfig = {
  name: 'writer',
  model: MODEL,
  provider: PROVIDER,
  baseURL: BASE_URL,
  apiKey: API_KEY,
  systemPrompt:
    'You are a technical writer. Produce a concise recommendation memo ' +
    `(150-250 words) on "${TOPIC}", grounded in the analyst's findings from ` +
    'shared memory. If long-term memory or the tdam_search_memories tool ' +
    'reveals findings from previous sessions, build on them instead of ' +
    'repeating them.' +
    memoryContext,
  customTools: tdamTools,
  maxTurns: 6,
  timeoutMs: 300_000,
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)
  switch (event.type) {
    case 'task_start':
      console.log(`  [${ts}] TASK START ↓ ${event.task}`)
      break
    case 'task_complete':
      console.log(`  [${ts}] TASK DONE  ↑ ${event.task}`)
      break
    case 'error':
      console.error(`  [${ts}] ERROR      ✗ agent=${event.agent} task=${event.task}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Step 2: run the team — shared-memory writes are captured into TDAM
// ---------------------------------------------------------------------------

console.log('[2/4] Running the team (shared-memory writes auto-capture into TDAM)...')

const orchestrator = new OpenMultiAgent({
  defaultModel: MODEL,
  defaultProvider: PROVIDER,
  defaultBaseURL: BASE_URL,
  defaultApiKey: API_KEY,
  maxConcurrency: 1,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('tdam-memory-demo', {
  name: 'tdam-memory-demo',
  agents: [analyst, writer],
  sharedMemory: true,
  sharedMemoryStore: store,
  maxConcurrency: 1,
})

const result = await orchestrator.runTeam(
  team,
  `Research "${TOPIC}". The analyst produces concrete findings, then the ` +
  'writer turns the findings into a short recommendation memo for an AI ' +
  'agent framework that needs persistent memory storage.',
)

console.log(`\n  Team run ${result.success ? 'succeeded' : 'FAILED'}.`)
const writerResult = result.agentResults.get('writer')
if (writerResult?.success) {
  console.log('\n' + '='.repeat(60))
  console.log('RECOMMENDATION MEMO')
  console.log('='.repeat(60))
  console.log()
  console.log(writerResult.output)
}

// ---------------------------------------------------------------------------
// Step 3: flush extraction so captures become searchable
// ---------------------------------------------------------------------------

const stats = store.captureStats
console.log('\n' + '-'.repeat(60))
console.log(
  `[3/4] Captured ${stats.succeeded}/${stats.attempted} shared-memory writes ` +
  `into TDAM (${stats.l0Recorded} L0 records). Flushing L1 extraction...`,
)
const flushStart = Date.now()
await store.endSession()
console.log(`  Flush complete in ${((Date.now() - flushStart) / 1000).toFixed(1)}s.`)

// ---------------------------------------------------------------------------
// Step 4: verify — search the distilled long-term memories
// ---------------------------------------------------------------------------

console.log('\n[4/4] Searching distilled L1 memories...')
const memories = await store.searchMemories(TOPIC, 5)
console.log(`  ${memories.total} memories match (strategy: ${memories.strategy}).\n`)
if (memories.results.trim()) {
  console.log(memories.results)
}

console.log('\n' + '-'.repeat(60))
console.log('Token Usage:')
console.log(
  `  Total — input: ${result.totalTokenUsage.input_tokens}, ` +
  `output: ${result.totalTokenUsage.output_tokens}`,
)

console.log(
  '\nRun this script again: step 1 will recall what TDAM just distilled, ' +
  'and the agents will start from it.',
)
