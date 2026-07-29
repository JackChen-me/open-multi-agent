/**
 * Competitive Monitoring (Multi-Source Aggregation with Contradiction Detection)
 *
 * Demonstrates:
 * - Three parallel source agents extract feed data from local JSON fixtures
 * - Each agent processes claims with { claim, date, source_url, confidence }
 * - Aggregator cross-checks claims across sources, identifies duplicates, flags contradictions
 * - Structured markdown report output
 * - Timing validation: parallel execution must be <70% of serial sum
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/competitive-monitoring.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *   Requires Node.js >= 20.
 *
 * Fixtures:
 *   - examples/fixtures/competitive-monitoring/twitter.json (10 claims)
 *   - examples/fixtures/competitive-monitoring/reddit.json (10 claims)
 *   - examples/fixtures/competitive-monitoring/news.json (10 claims)
 *
 * Intentional contradictions in fixtures (for aggregator to detect):
 *   - Competitor X product launch date: 04-15 (Twitter), 04-14 (Reddit), 04-16 (News)
 *   - Performance improvement claims: 60% (Twitter) vs 55% (News)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import { Agent, ToolExecutor, ToolRegistry, registerBuiltInTools } from '../../src/index.js'
import type { AgentConfig, AgentRunResult } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface Claim {
  claim: string
  date: string
  source_url: string
  confidence: number
}

function loadFixture(name: 'twitter' | 'reddit' | 'news'): Claim[] {
  const filePath = path.join(__dirname, '../fixtures/competitive-monitoring', `${name}.json`)
  const data = readFileSync(filePath, 'utf-8')
  return JSON.parse(data) as Claim[]
}

const twitterData = loadFixture('twitter')
const redditData = loadFixture('reddit')
const newsData = loadFixture('news')

// ---------------------------------------------------------------------------
// Zod schemas for structured extraction
// ---------------------------------------------------------------------------

const ClaimData = z.object({
  claims: z.array(
    z.object({
      claim: z.string().describe('The specific claim or news item'),
      date: z.string().describe('ISO date or date the claim was made'),
      source_url: z.string().describe('URL or source reference'),
      confidence: z.number().min(0).max(1).describe('Confidence 0.0-1.0'),
    }),
  ),
})
type ClaimData = z.infer<typeof ClaimData>

const AggregatedReport = z.object({
  verified_claims: z.array(
    z.object({
      claim: z.string(),
      sources: z.string().describe('Comma-separated list of source names'),
      consolidation: z.string().describe('How claims were merged/consolidated'),
      avg_confidence: z.number(),
      first_reported: z.string().describe('Earliest date across sources'),
    }),
  ),
  contradictions: z.array(
    z.object({
      claim_topic: z.string().describe('The general topic with conflicting claims'),
      variant_a: z.string().describe('One version of the claim'),
      variant_b: z.string().describe('Conflicting version'),
      source_a: z.string(),
      source_b: z.string(),
      severity: z.enum(['minor', 'moderate', 'critical']),
    }),
  ),
  summary: z.string().describe('High-level summary of monitoring findings'),
})
type AggregatedReport = z.infer<typeof AggregatedReport>

function confidenceLabel(value: number): 'high' | 'medium' | 'low' {
  if (value >= 0.8) return 'high'
  if (value >= 0.6) return 'medium'
  return 'low'
}

function severityLabel(value: AggregatedReport['contradictions'][number]['severity']): string {
  if (value === 'critical') return 'CRITICAL'
  if (value === 'moderate') return 'MODERATE'
  return 'MINOR'
}

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const twitterConfig: AgentConfig = {
  name: 'twitter-monitor',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a social media monitor analyzing Twitter/X feed data.
You receive raw JSON fixture data. Extract and validate each claim.
Focus on:
- Product announcements and updates
- Funding news and partnerships
- Market movements and competitive intelligence

Return JSON matching the schema, validating dates and confidence scores.`,
  maxTurns: 1,
  maxTokens: 800,
  temperature: 0.2,
  outputSchema: ClaimData,
}

const redditConfig: AgentConfig = {
  name: 'reddit-monitor',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a community sentiment analyzer monitoring Reddit discussions.
You receive raw JSON fixture data about tech industry claims.
Extract insights but note that:
- Community opinions may be speculative or unverified
- Confidence scores may be lower due to anecdotal nature
- Flag claims that contradict official sources

Return JSON matching the schema.`,
  maxTurns: 1,
  maxTokens: 800,
  temperature: 0.2,
  outputSchema: ClaimData,
}

const newsConfig: AgentConfig = {
  name: 'news-monitor',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a tech news analyst monitoring official press releases and news sources.
You receive raw JSON fixture data from reputable news outlets.
Extract and validate claims with focus on:
- Official product announcements
- Verified funding and acquisition data
- Industry analyst reports
- Conference announcements

Return JSON matching the schema.`,
  maxTurns: 1,
  maxTokens: 800,
  temperature: 0.2,
  outputSchema: ClaimData,
}

const aggregatorConfig: AgentConfig = {
  name: 'aggregator',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a competitive intelligence analyst synthesizing multi-source monitoring data.
You receive claim extractions from Twitter, Reddit, and News monitors.

Your tasks:
1. Deduplicate claims that are the same across sources, accounting for slight wording differences.
2. Flag contradictions when the same topic has different dates, numbers, or factual assertions.
3. Average confidence across sources for merged claims.
4. Return JSON matching the AggregatedReport schema.

Use only the provided claims. Be thorough about contradictions, even if the differences seem minor.`,
  maxTurns: 1,
  maxTokens: 1200,
  temperature: 0.3,
  outputSchema: AggregatedReport,
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

const twitterMonitor = buildAgent(twitterConfig)
const redditMonitor = buildAgent(redditConfig)
const newsMonitor = buildAgent(newsConfig)
const aggregator = buildAgent(aggregatorConfig)

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

console.log('Competitive Monitoring - Multi-Source Aggregation with Contradiction Detection')
console.log('='.repeat(80))
console.log('Model backend: Anthropic')
console.log(`Local fixtures: Twitter (${twitterData.length}), Reddit (${redditData.length}), News (${newsData.length}) claims`)
console.log('Expected contradictions: Competitor X launch dates, performance improvement numbers\n')

const globalStartTime = performance.now()

const twitterPrompt = `Extract claims from this Twitter feed.
Rules:
- Use only claims from the input.
- Return a single JSON object matching the schema, no markdown and no extra text.
Input:
${JSON.stringify(twitterData)}`

const redditPrompt = `Extract claims from this Reddit feed.
Rules:
- Use only claims from the input.
- Return a single JSON object matching the schema, no markdown and no extra text.
Input:
${JSON.stringify(redditData)}`

const newsPrompt = `Extract claims from this News feed.
Rules:
- Use only claims from the input.
- Return a single JSON object matching the schema, no markdown and no extra text.
Input:
${JSON.stringify(newsData)}`

// ---------------------------------------------------------------------------
// Phase 1: Parallel fan-out - three monitors
// ---------------------------------------------------------------------------

console.log('[Phase 1] Parallel monitoring: Twitter, Reddit, News\n')

async function runTimed(
  name: string,
  agent: Agent,
  prompt: string,
): Promise<{ result: AgentRunResult, elapsedMs: number }> {
  const start = performance.now()
  console.log(`  [RUN] ${name} monitor started...`)
  const result = await agent.run(prompt)
  const elapsedMs = performance.now() - start
  console.log(`  [DONE] ${name} monitor finished in ${Math.round(elapsedMs)}ms`)
  return {
    result,
    elapsedMs,
  }
}

const monitorStartTime = performance.now()
const monitorRuns = await Promise.all([
  runTimed('Twitter', twitterMonitor, twitterPrompt),
  runTimed('Reddit', redditMonitor, redditPrompt),
  runTimed('News', newsMonitor, newsPrompt),
])
const monitorTime = performance.now() - monitorStartTime

const [twitterRun, redditRun, newsRun] = monitorRuns
const twitterResult = twitterRun.result
const redditResult = redditRun.result
const newsResult = newsRun.result

const monitorDurations = [
  { name: 'Twitter', time: twitterRun.elapsedMs, result: twitterResult },
  { name: 'Reddit', time: redditRun.elapsedMs, result: redditResult },
  { name: 'News', time: newsRun.elapsedMs, result: newsResult },
]

for (const monitor of monitorDurations) {
  const status = monitor.result.success ? 'OK' : 'FAILED'
  console.log(
    `  ${monitor.name.padEnd(10)} [${status}] - ${Math.round(monitor.time)}ms, ${monitor.result.tokenUsage.output_tokens} out tokens`,
  )
}
console.log()

for (const [name, result] of [
  ['twitter-monitor', twitterResult],
  ['reddit-monitor', redditResult],
  ['news-monitor', newsResult],
] as const) {
  if (!result.success) {
    console.error(`Monitor '${name}' failed: ${result.output}`)
    process.exit(1)
  }
}

const serialMonitorTime = monitorDurations.reduce((sum, monitor) => sum + monitor.time, 0)
console.log(`  Parallel wall time: ${Math.round(monitorTime)}ms`)
console.log(`  Sequential serial sum: ${Math.round(serialMonitorTime)}ms`)
console.log(`  Parallel speedup: ${(serialMonitorTime / monitorTime).toFixed(2)}x\n`)

const twitterClaims = twitterResult.structured as ClaimData | undefined
const redditClaims = redditResult.structured as ClaimData | undefined
const newsClaims = newsResult.structured as ClaimData | undefined

if (!twitterClaims || !redditClaims || !newsClaims) {
  console.error('Structured output missing from one or more monitors')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Phase 2: Aggregate
// ---------------------------------------------------------------------------

console.log('[Phase 2] Aggregation: Cross-check, merge, detect contradictions\n')

const aggregatorPrompt = `You have three monitoring reports. Merge and analyze:

TWITTER CLAIMS (${twitterClaims.claims.length} items):
${JSON.stringify(twitterClaims.claims, null, 2)}

REDDIT CLAIMS (${redditClaims.claims.length} items):
${JSON.stringify(redditClaims.claims, null, 2)}

NEWS CLAIMS (${newsClaims.claims.length} items):
${JSON.stringify(newsClaims.claims, null, 2)}

Now:
1. Find duplicate or similar claims across sources and merge them.
2. Identify contradictions for the same topic when dates, numbers, or facts differ.
3. Calculate average confidence for each merged claim.
4. Return one JSON object matching the AggregatedReport schema.
5. Use only facts present in the provided claims.
6. Do not output markdown, code fences, or explanations.`

const aggregatorStartTime = performance.now()
const aggregatorResult = await aggregator.run(aggregatorPrompt)
const aggregatorTime = performance.now() - aggregatorStartTime

if (!aggregatorResult.success) {
  console.error(`Aggregator failed: ${aggregatorResult.output}`)
  process.exit(1)
}

const report = aggregatorResult.structured as AggregatedReport | undefined
if (!report) {
  console.error('Structured output missing from aggregator')
  process.exit(1)
}

console.log(
  `  Aggregator [OK] - ${Math.round(aggregatorTime)}ms, ${aggregatorResult.tokenUsage.output_tokens} out tokens\n`,
)

// ---------------------------------------------------------------------------
// Output markdown report
// ---------------------------------------------------------------------------

const totalTime = performance.now() - globalStartTime

console.log('='.repeat(80))
console.log('COMPETITIVE INTELLIGENCE REPORT')
console.log('='.repeat(80))
console.log()

console.log('## Summary\n')
console.log(report.summary)
console.log()

console.log('## Verified Claims\n')
if (report.verified_claims.length === 0) {
  console.log('_No claims verified across multiple sources._\n')
} else {
  for (const vc of report.verified_claims) {
    console.log(`**${vc.claim}**`)
    console.log(`  - Sources: ${vc.sources}`)
    console.log(`  - Confidence: ${(vc.avg_confidence * 100).toFixed(0)}% [${confidenceLabel(vc.avg_confidence)}]`)
    console.log(`  - First reported: ${vc.first_reported}`)
    console.log(`  - Consolidation: ${vc.consolidation}`)
    console.log()
  }
}

console.log('## Contradictions\n')
if (report.contradictions.length === 0) {
  console.log('_No contradictions detected._\n')
} else {
  for (const contradiction of report.contradictions) {
    console.log(`- **${contradiction.claim_topic}** [${severityLabel(contradiction.severity)}]`)
    console.log(`  - Version A (${contradiction.source_a}): ${contradiction.variant_a}`)
    console.log(`  - Version B (${contradiction.source_b}): ${contradiction.variant_b}`)
    console.log()
  }
}

// ---------------------------------------------------------------------------
// Timing validation
// ---------------------------------------------------------------------------

console.log('## Timing Analysis\n')

const totalSourceTokens =
  twitterResult.tokenUsage.output_tokens +
  redditResult.tokenUsage.output_tokens +
  newsResult.tokenUsage.output_tokens

console.log(`Total execution time: ${Math.round(totalTime)}ms`)
console.log(`  - Parallel monitoring: ${Math.round(monitorTime)}ms`)
console.log(`  - Aggregation: ${Math.round(aggregatorTime)}ms`)
console.log()

console.log(`Serial sum of monitors: ${Math.round(serialMonitorTime)}ms`)
console.log(`Parallel actual: ${Math.round(monitorTime)}ms`)
console.log(`Speedup: ${(serialMonitorTime / monitorTime).toFixed(2)}x`)
console.log()

const threshold = serialMonitorTime * 0.7
const assertion = monitorTime < threshold

console.log('Parallel speedup assertion (must be <70% of serial):')
console.log(`  ${Math.round(monitorTime)}ms < ${Math.round(threshold)}ms? ${assertion ? 'PASS' : 'FAIL'}`)

if (!assertion) {
  console.warn('\nWarning: Parallel execution did not achieve 70% reduction vs serial sum.')
  console.warn('This may indicate insufficient parallelism or overhead.')
}

console.log()
console.log(`Total tokens: ${totalSourceTokens + aggregatorResult.tokenUsage.output_tokens}`)
console.log('='.repeat(80))

if (!assertion) {
  process.exit(1)
}

console.log('\nCompetitive monitoring complete.\n')

// ---------------------------------------------------------------------------
// Real API variant (commented out by default)
// ---------------------------------------------------------------------------

// To use live feeds instead of committed JSON fixtures, replace the fixture
// loaders above with your own source adapters, for example:
//
// const twitterData = await fetchTwitterFeed(...)
// const redditData = await fetchRedditPosts(...)
// const newsData = await fetchNewsArticles(...)
//
// The extraction and aggregation stages can stay unchanged so the example keeps
// demonstrating the same fan-out + contradiction-detection workflow.
