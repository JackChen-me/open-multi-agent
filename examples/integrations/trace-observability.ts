/**
 * Trace Observability
 *
 * Demonstrates the `onTrace` callback for lightweight observability. Every LLM
 * call, tool execution, task lifecycle, and agent run emits a structured trace
 * event with timing data and token usage — giving you full visibility into
 * what's happening inside a multi-agent run.
 *
 * Trace events share a `runId` for correlation, so you can reconstruct the
 * full execution timeline. Pipe them into your own logging, OpenTelemetry, or
 * dashboard.
 *
 * Run:
 *   npx tsx examples/integrations/trace-observability.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, TraceEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const researcher: AgentConfig = {
  name: 'researcher',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a research assistant. Provide concise, factual answers.',
  maxTurns: 2,
}

const writer: AgentConfig = {
  name: 'writer',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a technical writer. Summarize research into clear prose.',
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Trace handler — log every span with timing
// ---------------------------------------------------------------------------

/** Truncate long strings for log readability — full payload stays in the event. */
function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s
}

function handleTrace(event: TraceEvent): void {
  const dur = `${event.durationMs}ms`.padStart(7)

  switch (event.type) {
    case 'llm_call':
      console.log(
        `  [LLM]   ${dur}  agent=${event.agent}  model=${event.model}  turn=${event.turn}` +
        `  tokens=${event.tokens.input_tokens}in/${event.tokens.output_tokens}out`,
      )
      break
    case 'tool_call':
      // Truncation here is for log readability only — the full payload remains
      // on `event.input` / `event.output` for downstream consumers (OpenTelemetry,
      // structured log shippers, audit pipelines, etc.).
      console.log(
        `  [TOOL]  ${dur}  agent=${event.agent}  tool=${event.tool}` +
        `  error=${event.isError}` +
        `  input=${truncate(JSON.stringify(event.input))}` +
        `  output=${truncate(event.output)}`,
      )
      break
    case 'task':
      console.log(
        `  [TASK]  ${dur}  task="${event.taskTitle}"  agent=${event.agent}` +
        `  success=${event.success}  retries=${event.retries}`,
      )
      break
    case 'agent':
      console.log(
        `  [AGENT] ${dur}  agent=${event.agent}  turns=${event.turns}` +
        `  tools=${event.toolCalls}  tokens=${event.tokens.input_tokens}in/${event.tokens.output_tokens}out`,
      )
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onTrace: handleTrace,
})

const team = orchestrator.createTeam('trace-demo', {
  name: 'trace-demo',
  agents: [researcher, writer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Tasks — researcher first, then writer summarizes
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Research topic',
    description: 'List 5 key benefits of TypeScript for large codebases. Be concise.',
    assignee: 'researcher',
  },
  {
    title: 'Write summary',
    description: 'Read the research from shared memory and write a 3-sentence summary.',
    assignee: 'writer',
    dependsOn: ['Research topic'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Trace Observability Example')
console.log('='.repeat(60))
console.log('Pipeline: research → write (with full trace output)')
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
