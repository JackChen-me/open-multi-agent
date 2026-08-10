/**
 * Pin and Replay a Coordinator Plan
 *
 * Demonstrates `planOnly` + `createPlanArtifact` + `runFromPlan`: let the
 * coordinator decompose a goal once, serialize that plan to a diffable JSON
 * artifact, then replay the exact same task graph later WITHOUT invoking the
 * coordinator again. Task ids, dependencies, assignees, descriptions, and
 * execution config (memoryScope, retry settings) are preserved, so the replayed
 * graph matches the reviewed one instead of being re-decomposed by an LLM.
 *
 * Scenario: a research + writing team. We decompose the goal once, persist the
 * plan to disk, then rebuild it from the saved file and replay it.
 *
 * Run:
 *   npx tsx examples/patterns/plan-replay.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, PlanArtifact } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const researcher: AgentConfig = {
  name: 'researcher',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You research a topic and produce a concise, factual brief.',
  maxTurns: 2,
}

const writer: AgentConfig = {
  name: 'writer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You turn a research brief into a short, well-structured guide.',
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-sonnet-4-6' })

const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [researcher, writer],
  sharedMemory: true,
})

const goal =
  'First research the benefits of TypeScript strict mode, then write a short adoption guide based on the findings.'

// ---------------------------------------------------------------------------
// Step 1 — decompose once (planOnly: coordinator runs, no agents execute yet)
// ---------------------------------------------------------------------------

console.log('Plan Replay Example')
console.log('='.repeat(60))
console.log('Step 1: decompose the goal (planOnly — coordinator only)')

const preview = await orchestrator.runTeam(team, goal, { planOnly: true })

// ---------------------------------------------------------------------------
// Step 2 — serialize to a diffable artifact and persist it
//
// `createPlanArtifact` returns a plain JSON-serializable object. Persist it
// however you like (here: a temp file; in practice, commit it to version
// control so the plan is reviewable and diffable).
// ---------------------------------------------------------------------------

const plan = orchestrator.createPlanArtifact(preview)
const planPath = join(tmpdir(), 'oma-plan.json')
writeFileSync(planPath, JSON.stringify(plan, null, 2))

console.log(`\nStep 2: saved a ${plan.tasks.length}-task plan to ${planPath}`)
for (const task of plan.tasks) {
  const deps = task.dependsOn?.length ? ` (after: ${task.dependsOn.join(', ')})` : ''
  console.log(`  - ${task.title} -> ${task.assignee ?? 'auto-assigned'}${deps}`)
}

// ---------------------------------------------------------------------------
// Step 3 — replay the saved plan WITHOUT the coordinator
// ---------------------------------------------------------------------------

console.log('\nStep 3: replay from the saved artifact (no coordinator call)')

const saved = JSON.parse(readFileSync(planPath, 'utf8')) as PlanArtifact
const result = await orchestrator.runFromPlan(team, saved)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log(`Replay success:      ${result.success}`)
console.log(`Coordinator invoked: ${result.agentResults.has('coordinator')}`) // false (plan replayed as-is)
console.log(`Tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)

for (const task of result.tasks ?? []) {
  console.log(`  [${task.status}] ${task.title} (${task.assignee ?? 'unassigned'})`)
}
