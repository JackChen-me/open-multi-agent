/**
 * Task Retry with Exponential Backoff
 *
 * Demonstrates `maxRetries`, `retryDelayMs`, and `retryBackoff` on task config.
 * When a task fails, the framework automatically retries with exponential
 * backoff. The `onProgress` callback receives `task_retry` events so you can
 * log retry attempts in real time.
 *
 * Scenario: a two-step pipeline where the first task (data fetch) is configured
 * to retry on failure, and the second task (analysis) depends on it.
 *
 * Run:
 *   npx tsx examples/patterns/task-retry.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const fetcher: AgentConfig = {
  name: 'fetcher',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a data-fetching agent. When given a topic, produce a short
JSON summary with 3-5 key facts. Output ONLY valid JSON, no markdown fences.
Example: {"topic":"...", "facts":["fact1","fact2","fact3"]}`,
  maxTurns: 2,
}

const analyst: AgentConfig = {
  name: 'analyst',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a data analyst. Read the fetched data from shared memory
and produce a brief analysis (3-4 sentences) highlighting trends or insights.`,
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Progress handler — watch for task_retry events
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)

  switch (event.type) {
    case 'task_start':
      console.log(`[${ts}] TASK START    "${event.task}" (agent: ${event.agent})`)
      break
    case 'task_complete':
      console.log(`[${ts}] TASK DONE     "${event.task}"`)
      break
    case 'task_retry': {
      const d = event.data as { attempt: number; maxAttempts: number; error: string; nextDelayMs: number }
      console.log(`[${ts}] TASK RETRY    "${event.task}" — attempt ${d.attempt}/${d.maxAttempts}, next in ${d.nextDelayMs}ms`)
      console.log(`               error: ${d.error.slice(0, 120)}`)
      break
    }
    case 'error':
      console.log(`[${ts}] ERROR         "${event.task}" agent=${event.agent}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('retry-demo', {
  name: 'retry-demo',
  agents: [fetcher, analyst],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Tasks — fetcher has retry config, analyst depends on it
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Fetch data',
    description: 'Fetch key facts about the adoption of TypeScript in open-source projects as of 2024. Output a JSON object with a "topic" and "facts" array.',
    assignee: 'fetcher',
    // Retry config: up to 2 retries, 500ms base delay, 2x backoff (500ms, 1000ms)
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoff: 2,
  },
  {
    title: 'Analyze data',
    description: 'Read the fetched data from shared memory and produce a 3-4 sentence analysis of TypeScript adoption trends.',
    assignee: 'analyst',
    dependsOn: ['Fetch data'],
    // No retry — if analysis fails, just report the error
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Task Retry Example')
console.log('='.repeat(60))
console.log('Pipeline: fetch (with retry) → analyze')
console.log(`Retry config: maxRetries=2, delay=500ms, backoff=2x`)
console.log('='.repeat(60))
console.log()

const result = await orchestrator.runTasks(team, tasks)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log(`Overall success: ${result.success}`)
console.log(`Tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)

for (const [name, r] of result.agentResults) {
  const icon = r.success ? 'OK  ' : 'FAIL'
  console.log(`  [${icon}] ${name}`)
  console.log(`         ${r.output.slice(0, 200)}`)
}
