/**
 * Proposer / Judge Consensus Pattern
 *
 * Demonstrates `runConsensus()`: a proposer agent drafts an answer, then a
 * panel of judge agents tries to refute it. If enough judges accept (quorum),
 * the answer is returned as `accepted`. If dissent exceeds the budget, the
 * proposer revises and the loop repeats up to `maxRounds`.
 *
 * This example shows two variations:
 *   1. Basic — default judge prompt, mode `'refute'`, quorum 1 of 2.
 *   2. Custom judgePrompt — per-judge framing via a function so each judge
 *      evaluates from a different angle (security vs. maintainability).
 *
 * Run:
 *   npx tsx examples/patterns/consensus.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const proposer: AgentConfig = {
  name: 'proposer',
  model: 'claude-haiku-4-5-20251001',
  provider: 'anthropic',
  systemPrompt: `You are a senior software architect. When asked to recommend an
approach, give a clear, concise recommendation (150-200 words) with the core
tradeoffs called out. Be direct — state what you recommend and why.`,
  maxTurns: 2,
  temperature: 0.3,
}

const judgeA: AgentConfig = {
  name: 'judge-correctness',
  model: 'claude-haiku-4-5-20251001',
  provider: 'anthropic',
  systemPrompt: `You are a rigorous code reviewer focused on correctness and
edge cases. When evaluating a technical recommendation, look for logical flaws,
incorrect assumptions, or missing failure modes. Be honest: if the proposal is
sound, say so. If not, be specific about what's wrong.`,
  maxTurns: 1,
  temperature: 0.2,
}

const judgeB: AgentConfig = {
  name: 'judge-pragmatism',
  model: 'claude-haiku-4-5-20251001',
  provider: 'anthropic',
  systemPrompt: `You are a pragmatic engineering lead focused on what actually
ships. When evaluating a technical recommendation, look for over-engineering,
unwarranted complexity, or impractical constraints. Be honest: if the proposal
is practical, say so. If not, be specific about what's impractical.`,
  maxTurns: 1,
  temperature: 0.2,
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-haiku-4-5-20251001' })

const team = orchestrator.createTeam('consensus-team', {
  name: 'consensus-team',
  agents: [proposer, judgeA, judgeB],
  sharedMemory: true,
})

const PROMPT = `Should a Node.js API service store user sessions in Redis or in
a signed JWT stored client-side? The service has ~5k DAU, a single-region
deployment, and no existing Redis infrastructure. Recommend one approach with
clear reasoning.`

console.log('Proposer / Judge Consensus Pattern')
console.log('='.repeat(60))
console.log(`\nQuestion: ${PROMPT.replace(/\n/g, ' ').trim()}\n`)

// ---------------------------------------------------------------------------
// Variation 1: default judge prompt, mode 'refute', quorum 1 of 2
// ---------------------------------------------------------------------------

console.log('--- Variation 1: basic (default judgePrompt, mode refute) ---\n')

const result1 = await orchestrator.runConsensus(team, PROMPT, {
  proposer,
  judges: [judgeA, judgeB],
  mode: 'refute',
  quorum: 1,
  maxRounds: 2,
  onDissent: 'revise',
})

console.log(`Verdict:  ${result1.verdict}`)
console.log(`Rounds:   ${result1.rounds}`)
console.log(`Dissent:  ${result1.dissent.length} critique(s)`)
if (result1.dissent.length > 0) {
  for (const d of result1.dissent) {
    console.log(`  • ${d.slice(0, 120).replace(/\n/g, ' ')}`)
  }
}
console.log(`\nAnswer:\n${result1.answer}\n`)

// ---------------------------------------------------------------------------
// Variation 2: per-judge framing via judgePrompt function
//
// Each judge receives a different lens. The function receives the judge's name
// and returns the full prompt to send. This is useful when you want one judge
// to focus on security and another on operational cost rather than both
// applying the same skeptic framing.
// ---------------------------------------------------------------------------

console.log('--- Variation 2: custom judgePrompt per judge ---\n')

const perJudgeLens: Record<string, string> = {
  'judge-correctness': `Evaluate the proposal strictly from a security standpoint.
Does it have authentication, session fixation, or token theft risks?
Reply with JSON: { "accept": true/false, "critique": "..." }`,
  'judge-pragmatism': `Evaluate the proposal strictly from an operational cost
standpoint. Is the infrastructure footprint reasonable for a 5k-DAU service?
Reply with JSON: { "accept": true/false, "critique": "..." }`,
}

const result2 = await orchestrator.runConsensus(team, PROMPT, {
  proposer,
  judges: [judgeA, judgeB],
  quorum: 1,
  maxRounds: 1,
  onDissent: 'keep',
  judgePrompt: (judgeName: string) =>
    perJudgeLens[judgeName] ??
    `Evaluate the proposal. Reply with JSON: { "accept": true/false, "critique": "..." }`,
})

console.log(`Verdict:  ${result2.verdict}`)
console.log(`Rounds:   ${result2.rounds}`)
console.log(`Dissent:  ${result2.dissent.length} critique(s)`)
if (result2.dissent.length > 0) {
  for (const d of result2.dissent) {
    console.log(`  • ${d.slice(0, 120).replace(/\n/g, ' ')}`)
  }
}
console.log(`\nAnswer:\n${result2.answer}\n`)

// ---------------------------------------------------------------------------
// Token summary
// ---------------------------------------------------------------------------

console.log('='.repeat(60))
console.log('Token Usage')
console.log('='.repeat(60))
console.log(
  `  Variation 1 — input: ${result1.tokenUsage.input_tokens}, output: ${result1.tokenUsage.output_tokens}`,
)
console.log(
  `  Variation 2 — input: ${result2.tokenUsage.input_tokens}, output: ${result2.tokenUsage.output_tokens}`,
)
const totalIn = result1.tokenUsage.input_tokens + result2.tokenUsage.input_tokens
const totalOut = result1.tokenUsage.output_tokens + result2.tokenUsage.output_tokens
console.log(`  TOTAL       — input: ${totalIn}, output: ${totalOut}`)
console.log('\nDone.')
