/**
 * Fan-Out / Aggregate (MapReduce) Pattern
 *
 * Demonstrates:
 * - Fan-out: send the same question to N "analyst" agents in parallel
 * - Aggregate: a "synthesizer" agent reads all analyst outputs and produces
 *   a balanced final report
 * - AgentPool with runParallel() for concurrent fan-out
 * - No tools needed — pure LLM reasoning to keep the focus on the pattern
 *
 * Run:
 *   npx tsx examples/patterns/fan-out-aggregate.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { Agent, AgentPool, ToolRegistry, ToolExecutor, registerBuiltInTools } from '../../packages/core/src/index.js'
import type { AgentConfig, AgentRunResult } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Analysis topic
// ---------------------------------------------------------------------------

const TOPIC = `Should a solo developer build a SaaS product that uses AI agents
for automated customer support? Consider the current state of AI technology,
market demand, competition, costs, and the unique constraints of being a solo
founder with limited time (~6 hours/day of productive work).`

// ---------------------------------------------------------------------------
// Analyst agent configs — three perspectives on the same question
// ---------------------------------------------------------------------------

const optimistConfig: AgentConfig = {
  name: 'optimist',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are an optimistic technology analyst who focuses on
opportunities, upside potential, and emerging trends. You see possibilities
where others see obstacles. Back your optimism with concrete reasoning —
cite market trends, cost curves, and real capabilities. Keep your analysis
to 200-300 words.`,
  maxTurns: 1,
  temperature: 0.4,
}

const skepticConfig: AgentConfig = {
  name: 'skeptic',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a skeptical technology analyst who focuses on risks,
challenges, failure modes, and hidden costs. You stress-test assumptions and
ask "what could go wrong?" Back your skepticism with concrete reasoning —
cite failure rates, technical limitations, and market realities. Keep your
analysis to 200-300 words.`,
  maxTurns: 1,
  temperature: 0.4,
}

const pragmatistConfig: AgentConfig = {
  name: 'pragmatist',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a pragmatic technology analyst who focuses on practical
feasibility, execution complexity, and resource requirements. You care about
what works today, not what might work someday. You think in terms of MVPs,
timelines, and concrete tradeoffs. Keep your analysis to 200-300 words.`,
  maxTurns: 1,
  temperature: 0.4,
}

const synthesizerConfig: AgentConfig = {
  name: 'synthesizer',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a senior strategy advisor who synthesizes multiple
perspectives into a balanced, actionable recommendation. You do not simply
summarise — you weigh the arguments, identify where they agree and disagree,
and produce a clear verdict with next steps. Structure your output as:

1. Key agreements across perspectives
2. Key disagreements and how you weigh them
3. Verdict (go / no-go / conditional go)
4. Recommended next steps (3-5 bullet points)

Keep the final report to 300-400 words.`,
  maxTurns: 1,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Build agents — no tools needed for pure reasoning
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry) // available to grant, but these agents grant none (tools are opt-in) — pure reasoning
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

const optimist = buildAgent(optimistConfig)
const skeptic = buildAgent(skepticConfig)
const pragmatist = buildAgent(pragmatistConfig)
const synthesizer = buildAgent(synthesizerConfig)

// ---------------------------------------------------------------------------
// Set up the pool
// ---------------------------------------------------------------------------

const pool = new AgentPool(3) // 3 analysts can run simultaneously
pool.add(optimist)
pool.add(skeptic)
pool.add(pragmatist)
pool.add(synthesizer)

console.log('Fan-Out / Aggregate (MapReduce) Pattern')
console.log('='.repeat(60))
console.log(`\nTopic: ${TOPIC.replace(/\n/g, ' ').trim()}\n`)

// ---------------------------------------------------------------------------
// Step 1: Fan-out — run all 3 analysts in parallel
// ---------------------------------------------------------------------------

console.log('[Step 1] Fan-out: 3 analysts running in parallel...\n')

const analystResults: Map<string, AgentRunResult> = await pool.runParallel([
  { agent: 'optimist',   prompt: TOPIC },
  { agent: 'skeptic',    prompt: TOPIC },
  { agent: 'pragmatist', prompt: TOPIC },
])

// Print each analyst's output (truncated)
const analysts = ['optimist', 'skeptic', 'pragmatist'] as const
for (const name of analysts) {
  const result = analystResults.get(name)!
  const status = result.success ? 'OK' : 'FAILED'
  console.log(`  ${name} [${status}] — ${result.tokenUsage.output_tokens} output tokens`)
  console.log(`  ${result.output.slice(0, 150).replace(/\n/g, ' ')}...`)
  console.log()
}

// Check all analysts succeeded
for (const name of analysts) {
  if (!analystResults.get(name)!.success) {
    console.error(`Analyst '${name}' failed: ${analystResults.get(name)!.output}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Step 2: Aggregate — synthesizer reads all 3 analyses
// ---------------------------------------------------------------------------

console.log('[Step 2] Aggregate: synthesizer producing final report...\n')

const synthesizerPrompt = `Three analysts have independently evaluated the same question.
Read their analyses below and produce your synthesis report.

--- OPTIMIST ---
${analystResults.get('optimist')!.output}

--- SKEPTIC ---
${analystResults.get('skeptic')!.output}

--- PRAGMATIST ---
${analystResults.get('pragmatist')!.output}

Now synthesize these three perspectives into a balanced recommendation.`

const synthResult = await pool.run('synthesizer', synthesizerPrompt)

if (!synthResult.success) {
  console.error('Synthesizer failed:', synthResult.output)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Final output
// ---------------------------------------------------------------------------

console.log('='.repeat(60))
console.log('SYNTHESIZED REPORT')
console.log('='.repeat(60))
console.log()
console.log(synthResult.output)
console.log()
console.log('-'.repeat(60))

// ---------------------------------------------------------------------------
// Token usage comparison
// ---------------------------------------------------------------------------

console.log('\nToken Usage Summary:')
console.log('-'.repeat(60))

let totalInput = 0
let totalOutput = 0

for (const name of analysts) {
  const r = analystResults.get(name)!
  totalInput += r.tokenUsage.input_tokens
  totalOutput += r.tokenUsage.output_tokens
  console.log(`  ${name.padEnd(12)} — input: ${r.tokenUsage.input_tokens}, output: ${r.tokenUsage.output_tokens}`)
}

totalInput += synthResult.tokenUsage.input_tokens
totalOutput += synthResult.tokenUsage.output_tokens
console.log(`  ${'synthesizer'.padEnd(12)} — input: ${synthResult.tokenUsage.input_tokens}, output: ${synthResult.tokenUsage.output_tokens}`)
console.log('-'.repeat(60))
console.log(`  ${'TOTAL'.padEnd(12)} — input: ${totalInput}, output: ${totalOutput}`)

console.log('\nDone.')
