/**
 * Meeting Summarizer (Parallel Post-Processing)
 *
 * Demonstrates:
 * - Fan-out of three specialized agents on the same meeting transcript
 * - Structured output (Zod schemas) for action items and sentiment
 * - Parallel timing check: wall time vs sum of per-agent durations
 * - Aggregator merges into a single Markdown report
 *
 * Run:
 *   npx tsx examples/cookbook/meeting-summarizer.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import { Agent, AgentPool, ToolRegistry, ToolExecutor, registerBuiltInTools } from '../../packages/core/src/index.js'
import type { AgentConfig, AgentRunResult } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Load the transcript fixture
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRANSCRIPT = readFileSync(
  path.join(__dirname, '../fixtures/meeting-transcript.txt'),
  'utf-8',
)

// ---------------------------------------------------------------------------
// Zod schemas for structured agents
// ---------------------------------------------------------------------------

const ActionItemList = z.object({
  items: z.array(
    z.object({
      task: z.string().describe('The action to be taken'),
      owner: z.string().describe('Name of the person responsible'),
      due_date: z.string().optional().describe('ISO date or human-readable due date if mentioned'),
    }),
  ),
})
type ActionItemList = z.infer<typeof ActionItemList>

const SentimentReport = z.object({
  participants: z.array(
    z.object({
      participant: z.string().describe('Name as it appears in the transcript'),
      tone: z.enum(['positive', 'neutral', 'negative', 'mixed']),
      evidence: z.string().describe('Direct quote or brief paraphrase supporting the tone'),
    }),
  ),
})
type SentimentReport = z.infer<typeof SentimentReport>

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const summaryConfig: AgentConfig = {
  name: 'summary',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a meeting note-taker. Given a transcript, produce a
three-paragraph summary:

1. What was discussed (the agenda).
2. Decisions made.
3. Notable context or risk the team should remember.

Plain prose. No bullet points. 200-300 words total.`,
  maxTurns: 1,
  temperature: 0.3,
}

const actionItemsConfig: AgentConfig = {
  name: 'action-items',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You extract action items from meeting transcripts. An action
item is a concrete task with a clear owner. Skip vague intentions ("we should
think about X"). Include due dates only when the speaker named one explicitly.

Return JSON matching the schema.`,
  maxTurns: 1,
  temperature: 0.1,
  outputSchema: ActionItemList,
}

const sentimentConfig: AgentConfig = {
  name: 'sentiment',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You analyze the tone of each participant in a meeting. For
every named speaker, classify their overall tone as positive, neutral,
negative, or mixed, and include one short quote or paraphrase as evidence.

Return JSON matching the schema.`,
  maxTurns: 1,
  temperature: 0.2,
  outputSchema: SentimentReport,
}

const aggregatorConfig: AgentConfig = {
  name: 'aggregator',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a report writer. You receive three pre-computed
analyses of the same meeting: a summary, an action-item list, and a sentiment
report. Your job is to merge them into a single Markdown report.

Output structure — use exactly these four H2 headings, in order:

## Summary
## Action Items
## Sentiment
## Next Steps

Under "Action Items" render a Markdown table with columns: Task, Owner, Due.
Under "Sentiment" render one bullet per participant.
Under "Next Steps" synthesize 3-5 concrete follow-ups based on the other
sections. Do not invent action items that are not grounded in the other data.`,
  maxTurns: 1,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Build agents
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

const summary = buildAgent(summaryConfig)
const actionItems = buildAgent(actionItemsConfig)
const sentiment = buildAgent(sentimentConfig)
const aggregator = buildAgent(aggregatorConfig)

const pool = new AgentPool(3) // three specialists can run concurrently
pool.add(summary)
pool.add(actionItems)
pool.add(sentiment)
pool.add(aggregator)

console.log('Meeting Summarizer (Parallel Post-Processing)')
console.log('='.repeat(60))
console.log(`\nTranscript: ${TRANSCRIPT.split('\n')[0]}`)
console.log(`Length: ${TRANSCRIPT.split(/\s+/).length} words\n`)

// ---------------------------------------------------------------------------
// Step 1: Parallel fan-out with per-agent timing
// ---------------------------------------------------------------------------

console.log('[Step 1] Running 3 agents in parallel...\n')

const specialists = ['summary', 'action-items', 'sentiment'] as const

// Kick off all three concurrently and record each one's own wall duration.
// Sum-of-per-agent beats a separate serial pass: half the LLM cost, and the
// sum is the work parallelism saved.
const parallelStart = performance.now()
const timed = await Promise.all(
  specialists.map(async (name) => {
    const t = performance.now()
    const result = await pool.run(name, TRANSCRIPT)
    return { name, result, durationMs: performance.now() - t }
  }),
)
const parallelElapsed = performance.now() - parallelStart

const byName = new Map<string, AgentRunResult>()
const serialSum = timed.reduce((acc, r) => {
  byName.set(r.name, r.result)
  return acc + r.durationMs
}, 0)

for (const { name, result, durationMs } of timed) {
  const status = result.success ? 'OK' : 'FAILED'
  console.log(
    `  ${name.padEnd(14)} [${status}] — ${Math.round(durationMs)}ms, ${result.tokenUsage.output_tokens} out tokens`,
  )
}
console.log()

for (const { name, result } of timed) {
  if (!result.success) {
    console.error(`Specialist '${name}' failed: ${result.output}`)
    process.exit(1)
  }
}

const actionData = byName.get('action-items')!.structured as ActionItemList | undefined
const sentimentData = byName.get('sentiment')!.structured as SentimentReport | undefined

if (!actionData || !sentimentData) {
  console.error('Structured output missing: action-items or sentiment failed schema validation')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 2: Parallelism assertion
// ---------------------------------------------------------------------------

console.log('[Step 2] Parallelism check')
console.log(`  Parallel wall time: ${Math.round(parallelElapsed)}ms`)
console.log(`  Serial sum (per-agent): ${Math.round(serialSum)}ms`)
console.log(`  Speedup: ${(serialSum / parallelElapsed).toFixed(2)}x\n`)

if (parallelElapsed >= serialSum * 0.7) {
  console.error(
    `ASSERTION FAILED: parallel wall time (${Math.round(parallelElapsed)}ms) is not ` +
      `less than 70% of serial sum (${Math.round(serialSum)}ms). Expected substantial ` +
      `speedup from fan-out.`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 3: Aggregate into Markdown report
// ---------------------------------------------------------------------------

console.log('[Step 3] Aggregating into Markdown report...\n')

const aggregatorPrompt = `Merge the three analyses below into a single Markdown report.

--- SUMMARY (prose) ---
${byName.get('summary')!.output}

--- ACTION ITEMS (JSON) ---
${JSON.stringify(actionData, null, 2)}

--- SENTIMENT (JSON) ---
${JSON.stringify(sentimentData, null, 2)}

Produce the Markdown report per the system instructions.`

const reportResult = await pool.run('aggregator', aggregatorPrompt)

if (!reportResult.success) {
  console.error('Aggregator failed:', reportResult.output)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Final output
// ---------------------------------------------------------------------------

console.log('='.repeat(60))
console.log('MEETING REPORT')
console.log('='.repeat(60))
console.log()
console.log(reportResult.output)
console.log()
console.log('-'.repeat(60))

// ---------------------------------------------------------------------------
// Token usage summary
// ---------------------------------------------------------------------------

console.log('\nToken Usage Summary:')
console.log('-'.repeat(60))

let totalInput = 0
let totalOutput = 0
for (const { name, result } of timed) {
  totalInput += result.tokenUsage.input_tokens
  totalOutput += result.tokenUsage.output_tokens
  console.log(
    `  ${name.padEnd(14)} — input: ${result.tokenUsage.input_tokens}, output: ${result.tokenUsage.output_tokens}`,
  )
}
totalInput += reportResult.tokenUsage.input_tokens
totalOutput += reportResult.tokenUsage.output_tokens
console.log(
  `  ${'aggregator'.padEnd(14)} — input: ${reportResult.tokenUsage.input_tokens}, output: ${reportResult.tokenUsage.output_tokens}`,
)
console.log('-'.repeat(60))
console.log(`  ${'TOTAL'.padEnd(14)} — input: ${totalInput}, output: ${totalOutput}`)

console.log('\nDone.')
