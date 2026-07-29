/**
 * Narrative Puzzle Hint Arbitration (Multi-Source Conflict Resolution + Safety Veto)
 *
 * Demonstrates:
 * - Five agents in a three-tier architecture: upstream parallel → dependent synthesis → external veto
 * - Three source-isolated upstream agents reading different MOCK fixtures:
 *   - Mechanic Agent: game state analysis (structured puzzle progress, no player-facing text)
 *   - Lore Agent: diegetic hint framing in the game world's narrative voice
 *   - Community Agent: empirically effective hint proposal based on player behavior analytics
 * - A downstream Arbiter that receives only structured upstream outputs, detects cross-source
 *   conflicts, and generates a compromise hint following priority chain safety > immersion > progress
 * - An external Safety Agent that performs independent semantic review on the Arbiter's draft
 *   and issues a binary veto when the hint reveals or materially narrows toward a protected
 *   puzzle linkage — the veto sits outside the generation loop so hard constraints cannot be
 *   overridden downstream
 * - Runtime conflict scenario (Piano-Mirror): Lore demands metaphorical framing, Community
 *   demands directness, and the Arbiter's compromise is vetoed because it compresses the
 *   search space enough to defeat the designed discovery moment
 * - Zod-validated structured output and simple runtime assertions
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/narrative-puzzle-hint-arbitration.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *   Requires Node.js >= 20.
 *
 * Fixtures:
 *   All fixtures under examples/fixtures/narrative-puzzle-hint-arbitration/ are MOCK.
 *   They are shaped like realistic source types (game save, lore wiki, platform analytics,
 *   designer policy) but do not contain real game artifacts. The scenario is fictional and
 *   constructed solely for demonstration of the multi-agent conflict resolution pattern.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import { Agent, ToolExecutor, ToolRegistry } from '../../src/index.js'
import type { AgentConfig, AgentRunResult } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(__dirname, '../fixtures/narrative-puzzle-hint-arbitration')

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureRoot, name), 'utf-8')
}

const extractedGameState = readFixture('extracted-game-state.json')
const loreCorpus = readFixture('lore-corpus.md')
const communityAggregates = readFixture('community-aggregates.json')
const designerConstraints = readFixture('designer-constraints.json')

const MODEL = process.env['MODEL'] ?? 'claude-sonnet-4-6'
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY']
const ANTHROPIC_BASE_URL = process.env['ANTHROPIC_BASE_URL']

const providerConfig = {
  provider: 'anthropic' as const,
  model: MODEL,
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL,
  tools: [] as const,
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const MechanicAudit = z.object({
  source_is_mock: z.boolean(),
  room: z.string(),
  inventory: z.array(z.string()),
  scene_flags: z.record(z.boolean()),
  puzzle_states: z.array(z.object({
    puzzle_id: z.string(),
    status: z.enum(['solved', 'partial', 'unsolved']),
    progress_summary: z.string(),
  })),
  interactions_completed: z.array(z.string()),
  interactions_remaining: z.array(z.string()),
  solution_step_diffs: z.array(z.string()),
  unexamined_objects: z.array(z.string()),
})
type MechanicAudit = z.infer<typeof MechanicAudit>

const LoreAudit = z.object({
  source_is_mock: z.boolean(),
  narrative_context: z.string(),
  character_voice: z.string(),
  voice_rules: z.array(z.string()),
  proposed_diegetic_framing: z.string(),
  framing_type: z.enum(['metaphor', 'allegory', 'environmental_clue', 'direct_instruction']),
  consistency_notes: z.string(),
  puzzle_correctness_asserted: z.boolean(),
})
type LoreAudit = z.infer<typeof LoreAudit>

const CommunityAudit = z.object({
  source_is_mock: z.boolean(),
  stuck_points: z.array(z.object({
    puzzle_id: z.string(),
    stuck_rate: z.number(),
    common_misconception: z.string(),
  })),
  effective_hint_patterns: z.array(z.object({
    framing: z.string(),
    effectiveness_rating: z.string(),
    spoiler_risk: z.string(),
  })),
  representative_player_quotes: z.array(z.string()),
  proposed_hint_framing: z.string(),
  full_solution_disclosed: z.boolean(),
})
type CommunityAudit = z.infer<typeof CommunityAudit>

const HintDraft = z.object({
  conflict_detected: z.boolean(),
  conflicts: z.array(z.string()),
  lore_proposal_summary: z.string(),
  community_proposal_summary: z.string(),
  compromise_hint: z.string(),
  hint_type: z.enum(['metaphor', 'direct', 'compromise', 'fallback']),
  priority_chain_applied: z.string(),
  rationale: z.string(),
})
type HintDraft = z.infer<typeof HintDraft>

const SafetyReview = z.object({
  source_is_mock: z.boolean(),
  hint_under_review: z.string(),
  puzzle_id_targeted: z.string(),
  protected_linkage_revealed: z.boolean(),
  search_space_sufficiently_compressed: z.boolean(),
  spoiler_sensitivity_level: z.string(),
  max_allowed_directionality: z.string(),
  veto_triggered: z.boolean(),
  veto_reason: z.string(),
  fallback_hint: z.string(),
  fallback_hint_type: z.string(),
})
type SafetyReview = z.infer<typeof SafetyReview>

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const mechanicConfig: AgentConfig = {
  name: 'mechanic-agent',
  ...providerConfig,
  systemPrompt: `You are a game state analyst for a point-and-click adventure game.

You read only the provided MOCK game save state. Extract:
- Current room and inventory
- Scene flags (what has been interacted with)
- Puzzle states: which are solved, partial, or unsolved, with progress details
- Abstract solution step diffs: what remains to be done (e.g., "2 of 4 piano notes remain")
- Unexamined objects the player has not yet interacted with

You must NEVER produce player-facing text. Your output is purely structural data
that downstream agents will use to make hint decisions.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown,
no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: MechanicAudit,
}

const loreConfig: AgentConfig = {
  name: 'lore-agent',
  ...providerConfig,
  systemPrompt: `You are a diegetic hint designer for a narrative puzzle game.

You read only the provided MOCK lore corpus. Tier 1 is official in-game text.
Tier 2 is community-accepted factual lore. Tier 3 (community theory) is excluded
from your input.

You embody The Performer — a character who communicates only through music,
metaphor, and theatrical imagery. The Performer's voice rules:
- NEVER give direct instructions (no "click", "move", "use", "look at")
- NEVER name objects explicitly in connection with each other
- NEVER reference game mechanics or UI elements
- NEVER assert whether a puzzle solution is correct or incorrect
- Guidance must feel like a line from a poem or a stage direction

Given the current game state summary, propose a single diegetic hint in The
Performer's voice. The hint should guide without instructing.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown,
no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: LoreAudit,
}

const communityConfig: AgentConfig = {
  name: 'community-agent',
  ...providerConfig,
  systemPrompt: `You are a community analytics agent for a puzzle game.

You read only the provided MOCK platform analytics — stuck rates, effective hint
patterns, and representative player quotes.

Your job:
- Identify where players get stuck and why
- Analyze which hint framings have empirically reduced stuck duration
- Propose a hint framing based on what has actually worked for other players
- Flag spoiler risk for each proposed framing

You must NOT output full solution sequences. You must NOT disclose complete puzzle
answers. Your proposed hint should be influenced by empirical effectiveness data.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown,
no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 2000,
  temperature: 0.1,
  outputSchema: CommunityAudit,
}

const arbiterConfig: AgentConfig = {
  name: 'hint-arbiter',
  ...providerConfig,
  systemPrompt: `You are the downstream arbiter for an immersive puzzle hint system.

You receive only structured outputs from three source-isolated agents:
- Mechanic: game state analysis (what is solved, what remains)
- Lore agent: a diegetic hint proposal in the game world's narrative voice
- Community agent: an empirically effective hint proposal based on player behavior

You cannot access the original fixtures. Your tasks:
1. Detect conflicts between the Lore proposal (immersive, metaphorical) and the
   Community proposal (direct, empirically effective).
2. Apply the priority chain: safety > immersion > progress.
3. Generate a compromise hint that balances narrative immersion with practical
   usefulness for stuck players.
4. Surface all conflicts explicitly in your output.

The fundamental tension: Lore preserves the game's designed discovery moment but
may not help frustrated players. Community helps players but may break narrative
voice and reveal intended surprises.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown,
no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 3000,
  temperature: 0.1,
  outputSchema: HintDraft,
}

const safetyConfig: AgentConfig = {
  name: 'safety-agent',
  ...providerConfig,
  systemPrompt: `You are an independent safety reviewer for a puzzle hint system.

You receive two inputs:
1. A MOCK designer constraint policy — rules about spoiler sensitivity, allowed
   hint types, and protected object linkages for each puzzle.
2. A hint draft produced by the Arbiter.

Your job is binary semantic review:
- Does the hint draft explicitly reveal a protected object linkage?
- Does the hint compress the search space so aggressively that a frustrated player
  would brute-force the connection within 1-2 additional attempts?
- Does the hint violate any prohibited_hint_types for the targeted puzzle?

If ANY constraint is violated — even indirectly — set veto_triggered to true,
explain the reason, and provide a fallback hint: a vague atmospheric room
description with no puzzle-relevant directional cue, plus a system-level nudge
to inspect unexamined objects.

If the hint is safe, set veto_triggered to false and pass the hint through unchanged.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown,
no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 2000,
  temperature: 0.1,
  outputSchema: SafetyReview,
}

// ---------------------------------------------------------------------------
// Build agents
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  // Source isolation is enforced at runtime: fixtures are injected into prompts,
  // and audit agents receive an empty tool registry with tools: [].
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

const mechanicAgent = buildAgent(mechanicConfig)
const loreAgent = buildAgent(loreConfig)
const communityAgent = buildAgent(communityConfig)
const hintArbiter = buildAgent(arbiterConfig)
const safetyAgent = buildAgent(safetyConfig)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runTimed(
  name: string,
  agent: Agent,
  prompt: string,
): Promise<{ name: string, result: AgentRunResult, elapsedMs: number }> {
  const start = performance.now()
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`  [RUN] ${name} started... attempt ${attempt}/${maxAttempts}`)
    const result = await agent.run(prompt)
    const elapsedMs = performance.now() - start

    if (result.success && result.structured) {
      console.log(`  [DONE] ${name} finished in ${Math.round(elapsedMs)}ms`)
      return { name, result, elapsedMs }
    }

    const outputPreview = result.output ? result.output.slice(0, 240).replace(/\s+/g, ' ') : '<empty output>'
    console.warn(`  [RETRY] ${name} failed structured output on attempt ${attempt}/${maxAttempts}: ${outputPreview}`)
  }

  const result = await agent.run(prompt)
  const elapsedMs = performance.now() - start
  console.log(`  [DONE] ${name} finished in ${Math.round(elapsedMs)}ms`)
  return { name, result, elapsedMs }
}

function requireStructured<T>(name: string, result: AgentRunResult): T {
  if (!result.success) {
    console.error(`${name} failed: ${result.output}`)
    process.exit(1)
  }

  if (!result.structured) {
    console.error(`${name} did not return structured output`)
    process.exit(1)
  }

  return result.structured as T
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

console.log('Narrative Puzzle Hint Arbitration — Multi-Source Conflict Resolution + Safety Veto')
console.log('='.repeat(88))
console.log(`Model backend: anthropic-compatible (${MODEL})`)
console.log('All fixtures are MOCK. The Piano-Mirror scenario is fictional.')
console.log('Expected conflict: Lore demands metaphor, Community demands directness, Safety vetoes compromise.\n')

async function main(): Promise<void> {
  // -----------------------------------------------------------------------
  // Phase 1: Source-isolated upstream audits
  // -----------------------------------------------------------------------

  console.log('[Phase 1] Source-isolated upstream audits\n')

  const phase1Start = performance.now()
  const upstreamRuns: Array<{ name: string, result: AgentRunResult, elapsedMs: number }> = []

  upstreamRuns.push(await runTimed(
    'mechanic-agent',
    mechanicAgent,
    `Analyze this MOCK game save state. Use only this input.\n\n${extractedGameState}`,
  ))

  upstreamRuns.push(await runTimed(
    'lore-agent',
    loreAgent,
    `You are The Performer. Use only this lore corpus (Tier 1 and Tier 2 only).
Propose a diegetic hint for the current game state described below.

LORE CORPUS:
${loreCorpus}

CURRENT GAME STATE SUMMARY:
The player is in the theatre room. The piano sequence is partial (2 of 4 notes played).
The mirror has not been interacted with. The candle has been lit, revealing an inscription.
The player has a handkerchief and a pawn in inventory.

Propose a single hint in The Performer's voice.`,
  ))

  upstreamRuns.push(await runTimed(
    'community-agent',
    communityAgent,
    `Analyze these MOCK platform analytics and propose a hint framing.
Use only this input.

${communityAggregates}`,
  ))

  const phase1Elapsed = performance.now() - phase1Start

  const upstreamMap = new Map(upstreamRuns.map((run) => [run.name, run.result]))

  const mechanicAudit = requireStructured<MechanicAudit>('mechanic-agent', upstreamMap.get('mechanic-agent')!)
  const loreAudit = requireStructured<LoreAudit>('lore-agent', upstreamMap.get('lore-agent')!)
  const communityAudit = requireStructured<CommunityAudit>('community-agent', upstreamMap.get('community-agent')!)

  console.log('\n[Phase 1 Summary]')
  for (const run of upstreamRuns) {
    const status = run.result.success ? 'OK' : 'FAILED'
    console.log(`  ${run.name.padEnd(25)} [${status}] ${Math.round(run.elapsedMs)}ms, ${run.result.tokenUsage.output_tokens} out tokens`)
  }
  console.log(`  Phase 1 wall time: ${Math.round(phase1Elapsed)}ms\n`)

  // -----------------------------------------------------------------------
  // Phase 2: Arbiter — receives structured upstream outputs only
  // -----------------------------------------------------------------------

  console.log('[Phase 2] Arbiter — conflict detection and hint draft\n')

  const arbiterPrompt = `You are given structured outputs from three source-isolated agents.
You cannot access the original fixtures. Detect conflicts and produce a hint draft.

MECHANIC AUDIT (game state):
${JSON.stringify(mechanicAudit, null, 2)}

LORE AUDIT (diegetic hint proposal):
${JSON.stringify(loreAudit, null, 2)}

COMMUNITY AUDIT (empirical hint proposal):
${JSON.stringify(communityAudit, null, 2)}

Rules:
- Surface the conflict between Lore's metaphorical framing and Community's direct framing.
- Attempt a compromise following priority chain: safety > immersion > progress.
- The compromise should be a hint that a player would actually receive in-game.
- Return one JSON object matching the schema, no markdown.`

  const arbiterStart = performance.now()
  const arbiterResult = await hintArbiter.run(arbiterPrompt)
  const arbiterElapsed = performance.now() - arbiterStart

  const hintDraft = requireStructured<HintDraft>('hint-arbiter', arbiterResult)

  console.log(`  Arbiter [OK] ${Math.round(arbiterElapsed)}ms, ${arbiterResult.tokenUsage.output_tokens} out tokens\n`)

  // -----------------------------------------------------------------------
  // Phase 3: Safety — external veto on the Arbiter's draft
  // -----------------------------------------------------------------------

  console.log('[Phase 3] Safety — external veto review\n')

  const safetyPrompt = `Review this hint draft against the designer constraints.

DESIGNER CONSTRAINTS:
${designerConstraints}

HINT DRAFT FROM ARBITER:
${JSON.stringify(hintDraft, null, 2)}

Determine whether the hint violates any constraint. If it does, veto it and
provide a fallback. If it is safe, approve it.`

  const safetyStart = performance.now()
  const safetyResult = await safetyAgent.run(safetyPrompt)
  const safetyElapsed = performance.now() - safetyStart

  const safetyReview = requireStructured<SafetyReview>('safety-agent', safetyResult)

  console.log(`  Safety [OK] ${Math.round(safetyElapsed)}ms, ${safetyResult.tokenUsage.output_tokens} out tokens\n`)

  // -----------------------------------------------------------------------
  // Runtime assertions
  // -----------------------------------------------------------------------

  const asserts = [
    {
      name: 'Arbiter should detect conflict between Lore and Community',
      pass: hintDraft.conflict_detected === true,
    },
    {
      name: 'Arbiter should surface explicit conflicts',
      pass: hintDraft.conflicts.length > 0,
    },
    {
      name: 'Lore agent should not assert puzzle correctness',
      pass: loreAudit.puzzle_correctness_asserted === false,
    },
    {
      name: 'Community agent should not disclose full solution',
      pass: communityAudit.full_solution_disclosed === false,
    },
    {
      name: 'Safety should trigger veto on the Piano-Mirror compromise',
      pass: safetyReview.veto_triggered === true,
    },
    {
      name: 'Safety fallback should be atmospheric when veto is triggered',
      pass: !safetyReview.veto_triggered || safetyReview.fallback_hint_type.toLowerCase().includes('atmospheric'),
    },
  ]

  console.log('='.repeat(88))
  console.log('HINT DRAFT FROM ARBITER')
  console.log('='.repeat(88))
  console.log(JSON.stringify(hintDraft, null, 2))
  console.log()

  console.log('='.repeat(88))
  console.log('SAFETY REVIEW')
  console.log('='.repeat(88))
  console.log(JSON.stringify(safetyReview, null, 2))
  console.log()

  console.log('## Runtime Assertions\n')
  let hasFailure = false
  for (const assertion of asserts) {
    console.log(`- ${assertion.pass ? 'PASS' : 'FAIL'}: ${assertion.name}`)
    if (!assertion.pass) hasFailure = true
  }

  const allRuns = [...upstreamRuns, { name: 'hint-arbiter', result: arbiterResult, elapsedMs: arbiterElapsed }, { name: 'safety-agent', result: safetyResult, elapsedMs: safetyElapsed }]

  const totalOutputTokens = allRuns.reduce((sum, run) => sum + run.result.tokenUsage.output_tokens, 0)
  const totalInputTokens = allRuns.reduce((sum, run) => sum + run.result.tokenUsage.input_tokens, 0)

  console.log('\n## Token Usage\n')
  console.log(`Input tokens: ${totalInputTokens}`)
  console.log(`Output tokens: ${totalOutputTokens}`)
  console.log('Estimated cost depends on the selected provider/model; this example prints token usage for transparency.')

  console.log('\n' + '='.repeat(88))

  if (hasFailure) {
    console.error('Runtime assertion failed.')
    process.exit(1)
  }

  console.log('Narrative puzzle hint arbitration example complete.\n')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Production source adapter sketch
// ---------------------------------------------------------------------------
//
// This example intentionally uses committed MOCK fixtures so the demo is
// deterministic, safe, and runnable. A production version could replace fixtures
// with source adapters:
//
//   Mechanic: parse binary save files or query the game engine's runtime state API
//   Lore: load from game CMS with versioned narrative content
//   Community: scheduled crawlers against Bilibili / TapTap APIs or equivalent
//   Safety: live designer-authored policy service
//
// The three-tier architecture (upstream parallel → arbiter → external veto)
// would remain the same.
