/**
 * Engram Team Research (orchestrated)
 *
 * Same research pipeline as research-team.ts, but driven by the orchestrator
 * via `runTeam()` with `EngramMemoryStore` plugged in as the team's
 * `sharedMemoryStore`. This means the orchestrator's built-in shared-memory
 * plumbing (task-result injection, coordinator summaries) flows through
 * Engram automatically — no manual engram_commit/engram_query calls needed
 * for inter-task context.
 *
 * The Engram toolkit tools are still registered so agents can query or audit
 * conflicts when they choose to.
 *
 * Works with every provider the framework supports. Set the provider and model
 * via environment variables:
 *
 *   AGENT_PROVIDER  — anthropic | openai | gemini | grok | copilot | deepseek | minimax | azure-openai
 *   AGENT_MODEL     — model name for the chosen provider
 *
 * Defaults to anthropic / claude-sonnet-4-6 when unset.
 *
 * Run:
 *   npx tsx examples/integrations/with-engram/team-research.ts
 *
 * Prerequisites:
 *   - API key env var for your chosen provider
 *   - Engram server running at http://localhost:7474
 *   - ENGRAM_INVITE_KEY env var
 */

import { OpenMultiAgent } from '../../../packages/core/src/index.js'
import type {
  AgentConfig,
  OrchestratorEvent,
  SupportedProvider,
} from '../../../packages/core/src/index.js'
import { EngramMemoryStore } from './engram-store.js'
import { EngramToolkit } from './engram-toolkit.js'

// ---------------------------------------------------------------------------
// Provider / model configuration
// ---------------------------------------------------------------------------

const PROVIDER = (process.env.AGENT_PROVIDER ?? 'anthropic') as SupportedProvider
const MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-4-6'

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

const envKey = PROVIDER_ENV_KEYS[PROVIDER]
if (envKey && !process.env[envKey]?.trim()) {
  console.error(`Missing ${envKey}: required for provider "${PROVIDER}".`)
  process.exit(1)
}

if (!process.env.ENGRAM_INVITE_KEY?.trim()) {
  console.error('Missing ENGRAM_INVITE_KEY: set your Engram workspace invite key in the environment.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Engram-backed shared memory store
// ---------------------------------------------------------------------------

const engramStore = new EngramMemoryStore()

// ---------------------------------------------------------------------------
// Engram tools via customTools so the orchestrator's per-agent registry
// picks them up (runTeam builds its own registry per agent from built-ins
// plus AgentConfig.customTools — an outer ToolRegistry is never seen).
// ---------------------------------------------------------------------------

const engramTools = new EngramToolkit().getTools()

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const TOPIC = 'the current state of AI agent memory systems'

const researcher: AgentConfig = {
  name: 'researcher',
  model: MODEL,
  provider: PROVIDER,
  systemPrompt: `You are a research agent investigating: "${TOPIC}".

Your job:
1. Think through the key dimensions of this topic (architectures, open problems,
   leading projects, recent breakthroughs).
2. For each finding, use engram_commit to record it as a shared fact with
   scope="research" and an appropriate confidence level.
3. Commit at least 5 distinct facts covering different aspects.

Be specific and cite concrete systems or papers where possible.`,
  customTools: engramTools,
  maxTurns: 10,
}

const factChecker: AgentConfig = {
  name: 'fact-checker',
  model: MODEL,
  provider: PROVIDER,
  systemPrompt: `You are a fact-checking agent. Your job:

1. Use engram_query with topic="${TOPIC}" to retrieve what the researcher committed.
2. Evaluate each fact for accuracy and completeness.
3. If a fact is wrong or misleading, use engram_commit with operation="update"
   to commit a corrected version in the same scope.
4. After committing corrections, call engram_conflicts to review any
   auto-resolved conflicts. You are auditing the resolutions — do NOT manually
   resolve them unless an auto-resolution is clearly wrong.
5. Summarize your findings at the end.`,
  customTools: engramTools,
  maxTurns: 10,
}

const writer: AgentConfig = {
  name: 'writer',
  model: MODEL,
  provider: PROVIDER,
  systemPrompt: `You are a technical writer. Your job:

1. Use engram_query with topic="${TOPIC}" to retrieve all settled facts.
2. Synthesize the facts into a concise executive briefing (300-500 words).
3. Structure the briefing with clear sections: Overview, Key Systems,
   Open Challenges, and Outlook.
4. Only include claims that are grounded in the queried facts — do not
   fabricate or speculate beyond what the team has verified.
5. Output the briefing as your final response.`,
  customTools: engramTools,
  maxTurns: 6,
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)
  switch (event.type) {
    case 'agent_start':
      console.log(`[${ts}] AGENT START → ${event.agent}`)
      break
    case 'agent_complete':
      console.log(`[${ts}] AGENT DONE  ← ${event.agent}`)
      break
    case 'task_start':
      console.log(`[${ts}] TASK START  ↓ ${event.task}`)
      break
    case 'task_complete':
      console.log(`[${ts}] TASK DONE   ↑ ${event.task}`)
      break
    case 'error':
      console.error(`[${ts}] ERROR       ✗ agent=${event.agent} task=${event.task}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

console.log('Engram Team Research (orchestrated)')
console.log('='.repeat(60))
console.log(`Provider: ${PROVIDER}`)
console.log(`Model:    ${MODEL}`)
console.log(`Topic:    ${TOPIC}`)
console.log(`Store:    EngramMemoryStore → http://localhost:7474\n`)

const orchestrator = new OpenMultiAgent({
  defaultModel: MODEL,
  defaultProvider: PROVIDER,
  maxConcurrency: 1,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('engram-research', {
  name: 'engram-research',
  agents: [researcher, factChecker, writer],
  sharedMemory: true,
  sharedMemoryStore: engramStore,
  maxConcurrency: 1,
})

const result = await orchestrator.runTeam(
  team,
  `Research "${TOPIC}". The researcher explores and commits facts, the fact-checker ` +
  `verifies and corrects them (auditing any auto-resolved conflicts), and the writer ` +
  `produces an executive briefing from the settled facts.`,
)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log('RESULTS')
console.log('='.repeat(60))
console.log(`\nSuccess: ${result.success}`)

console.log('\nPer-agent results:')
for (const [name, agentResult] of result.agentResults) {
  const status = agentResult.success ? 'OK' : 'FAILED'
  const tools = agentResult.toolCalls.length
  console.log(`  ${name.padEnd(14)} [${status}] tool_calls=${tools}`)
}

// Print the writer's briefing if available
const writerResult = result.agentResults.get('writer')
if (writerResult?.success) {
  console.log('\n' + '='.repeat(60))
  console.log('EXECUTIVE BRIEFING')
  console.log('='.repeat(60))
  console.log()
  console.log(writerResult.output)
}

// Token summary
console.log('\n' + '-'.repeat(60))
console.log('Token Usage:')
console.log(`  Total — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)

console.log(`\nView shared memory and conflicts: http://localhost:7474/dashboard`)
