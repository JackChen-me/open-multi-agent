/**
 * Engram Research Team
 *
 * Three agents collaborate on a research topic using Engram shared memory:
 *
 *   1. **Researcher** — explores the topic and commits findings as facts
 *   2. **Fact-checker** — verifies claims, commits corrections, and audits
 *      any auto-resolved conflicts
 *   3. **Writer** — queries settled facts and produces a briefing document
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
 *   npx tsx examples/integrations/with-engram/research-team.ts
 *
 * Examples:
 *   # Anthropic (default)
 *   ANTHROPIC_API_KEY=sk-... ENGRAM_INVITE_KEY=ek_live_... npx tsx examples/integrations/with-engram/research-team.ts
 *
 *   # OpenAI
 *   AGENT_PROVIDER=openai AGENT_MODEL=gpt-4o OPENAI_API_KEY=sk-... ENGRAM_INVITE_KEY=ek_live_... npx tsx examples/integrations/with-engram/research-team.ts
 *
 *   # Gemini
 *   AGENT_PROVIDER=gemini AGENT_MODEL=gemini-2.5-flash GEMINI_API_KEY=... ENGRAM_INVITE_KEY=ek_live_... npx tsx examples/integrations/with-engram/research-team.ts
 *
 *   # Grok
 *   AGENT_PROVIDER=grok AGENT_MODEL=grok-3 XAI_API_KEY=... ENGRAM_INVITE_KEY=ek_live_... npx tsx examples/integrations/with-engram/research-team.ts
 *
 *   # DeepSeek
 *   AGENT_PROVIDER=deepseek AGENT_MODEL=deepseek-v4-flash DEEPSEEK_API_KEY=... ENGRAM_INVITE_KEY=ek_live_... npx tsx examples/integrations/with-engram/research-team.ts
 *
 * Prerequisites:
 *   - API key env var for your chosen provider
 *   - Engram server running at http://localhost:7474
 *   - ENGRAM_INVITE_KEY env var
 */

import {
  Agent,
  ToolExecutor,
  ToolRegistry,
  registerBuiltInTools,
} from '../../../packages/core/src/index.js'
import type { SupportedProvider } from '../../../packages/core/src/index.js'
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
// Shared setup
// ---------------------------------------------------------------------------

const TOPIC = 'the current state of AI agent memory systems'

const engramTools = ['engram_commit', 'engram_query', 'engram_conflicts', 'engram_resolve']

function buildAgent(config: {
  name: string
  systemPrompt: string
}): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  new EngramToolkit().registerAll(registry)
  const executor = new ToolExecutor(registry)

  return new Agent(
    {
      name: config.name,
      model: MODEL,
      provider: PROVIDER,
      tools: engramTools,
      systemPrompt: config.systemPrompt,
    },
    registry,
    executor,
  )
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const researcher = buildAgent({
  name: 'researcher',
  systemPrompt: `You are a research agent investigating: "${TOPIC}".

Your job:
1. Think through the key dimensions of this topic (architectures, open problems,
   leading projects, recent breakthroughs).
2. For each finding, use engram_commit to record it as a shared fact with
   scope="research" and an appropriate confidence level.
3. Commit at least 5 distinct facts covering different aspects.

Be specific and cite concrete systems or papers where possible.`,
})

const factChecker = buildAgent({
  name: 'fact-checker',
  systemPrompt: `You are a fact-checking agent. Your job:

1. Use engram_query with topic="${TOPIC}" to retrieve what the researcher committed.
2. Evaluate each fact for accuracy and completeness.
3. If a fact is wrong or misleading, use engram_commit with operation="update"
   to commit a corrected version in the same scope.
4. After committing corrections, call engram_conflicts to review any
   auto-resolved conflicts. You are auditing the resolutions — do NOT manually
   resolve them unless an auto-resolution is clearly wrong.
5. Summarize your findings at the end.`,
})

const writer = buildAgent({
  name: 'writer',
  systemPrompt: `You are a technical writer. Your job:

1. Use engram_query with topic="${TOPIC}" to retrieve all settled facts.
2. Synthesize the facts into a concise executive briefing (300-500 words).
3. Structure the briefing with clear sections: Overview, Key Systems,
   Open Challenges, and Outlook.
4. Only include claims that are grounded in the queried facts — do not
   fabricate or speculate beyond what the team has verified.
5. Output the briefing as your final response.`,
})

// ---------------------------------------------------------------------------
// Sequential execution
// ---------------------------------------------------------------------------

console.log('Engram Research Team')
console.log('='.repeat(60))
console.log(`Provider: ${PROVIDER}`)
console.log(`Model:    ${MODEL}`)
console.log(`Topic:    ${TOPIC}\n`)

// Step 1: Research
console.log('[1/3] Researcher is exploring the topic...')
const researchResult = await researcher.run(
  `Research "${TOPIC}" and commit your findings to Engram shared memory.`,
)
console.log(`  Done — ${researchResult.toolCalls.length} tool calls, ` +
  `${researchResult.tokenUsage.output_tokens} output tokens\n`)

// Step 2: Fact-check
console.log('[2/3] Fact-checker is verifying claims...')
const checkResult = await factChecker.run(
  `Review and fact-check the research on "${TOPIC}" in Engram shared memory. ` +
  `Commit corrections and audit any auto-resolved conflicts.`,
)
console.log(`  Done — ${checkResult.toolCalls.length} tool calls, ` +
  `${checkResult.tokenUsage.output_tokens} output tokens\n`)

// Step 3: Write briefing
console.log('[3/3] Writer is producing the briefing...')
const writeResult = await writer.run(
  `Query Engram for settled facts on "${TOPIC}" and write an executive briefing.`,
)
console.log(`  Done — ${writeResult.toolCalls.length} tool calls, ` +
  `${writeResult.tokenUsage.output_tokens} output tokens\n`)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log('='.repeat(60))
console.log('EXECUTIVE BRIEFING')
console.log('='.repeat(60))
console.log()
console.log(writeResult.output)
console.log()
console.log('-'.repeat(60))

// Token summary
const agents = [
  { name: 'researcher', result: researchResult },
  { name: 'fact-checker', result: checkResult },
  { name: 'writer', result: writeResult },
]

let totalInput = 0
let totalOutput = 0

console.log('\nToken Usage:')
for (const { name, result } of agents) {
  totalInput += result.tokenUsage.input_tokens
  totalOutput += result.tokenUsage.output_tokens
  console.log(
    `  ${name.padEnd(14)} — input: ${result.tokenUsage.input_tokens}, output: ${result.tokenUsage.output_tokens}`,
  )
}
console.log('-'.repeat(60))
console.log(`  ${'TOTAL'.padEnd(14)} — input: ${totalInput}, output: ${totalOutput}`)

console.log(`\nView shared memory and conflicts: http://localhost:7474/dashboard`)
