/**
 * Explicit Task Pipeline with Dependencies
 *
 * Demonstrates how to define tasks with explicit dependency chains
 * (design → implement → test → review) using runTasks(). The TaskQueue
 * automatically blocks downstream tasks until their dependencies complete.
 * Prompt context is dependency-scoped by default: each task sees only its own
 * description plus direct dependency results (not unrelated team outputs).
 *
 * Run:
 *   npx tsx packages/core/examples/basics/task-pipeline.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set (default provider). To use any
 *   other built-in provider, set OMA_PROVIDER and OMA_MODEL plus that
 *   provider's key, for example:
 *     OMA_PROVIDER=deepseek OMA_MODEL=deepseek-chat DEEPSEEK_API_KEY=...
 *     OMA_PROVIDER=openai OMA_MODEL=gpt-5.4 OPENAI_API_KEY=...
 *   See docs/providers.md for the full provider and env var list.
 */

import { join } from 'node:path'
import { OpenMultiAgent, type SupportedProvider } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent, Task } from '../../src/types.js'

// Defaults to Claude. Any built-in provider works: set OMA_PROVIDER and
// OMA_MODEL plus that provider's API key (see docs/providers.md).
const provider = (process.env.OMA_PROVIDER ?? 'anthropic') as SupportedProvider
const model = process.env.OMA_MODEL ?? 'claude-sonnet-4-6'

// Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by
// default; pipeline output lives under that root so the demo runs without
// disabling the sandbox.
const OUTPUT_DIR = join(process.cwd(), '.agent-workspace', 'pipeline-output')
const SRC_DIR = join(OUTPUT_DIR, 'src')
const SPEC_FILE = join(OUTPUT_DIR, 'design-spec.md')

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const designer: AgentConfig = {
  name: 'designer',
  provider,
  model,
  systemPrompt: `You are a software designer. Your output is always a concise technical spec
in markdown. Focus on interfaces, data shapes, and file structure. Be brief.`,
  tools: ['file_write'],
  maxTurns: 4,
}

const implementer: AgentConfig = {
  name: 'implementer',
  provider,
  model,
  systemPrompt: `You are a TypeScript developer. Read the design spec written by the designer,
then implement it. Write all files to ${OUTPUT_DIR}/. Use the tools.`,
  tools: ['bash', 'file_read', 'file_write'],
  maxTurns: 10,
}

const tester: AgentConfig = {
  name: 'tester',
  provider,
  model,
  systemPrompt: `You are a QA engineer. Read the implemented files and run them to verify correctness.
Report: what passed, what failed, and any bugs found.`,
  tools: ['bash', 'file_read', 'grep'],
  maxTurns: 6,
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  provider,
  model,
  systemPrompt: `You are a code reviewer. Read all files and produce a brief structured review.
Sections: Summary, Strengths, Issues (if any), Verdict (SHIP / NEEDS WORK).`,
  tools: ['file_read', 'grep'],
  maxTurns: 4,
}

// ---------------------------------------------------------------------------
// Progress handler — shows dependency blocking/unblocking
// ---------------------------------------------------------------------------

const taskTimes = new Map<string, number>()

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)

  switch (event.type) {
    case 'task_start': {
      taskTimes.set(event.task ?? '', Date.now())
      const task = event.data as Task | undefined
      console.log(`[${ts}] TASK READY    "${task?.title ?? event.task}" (assignee: ${task?.assignee ?? 'any'})`)
      break
    }
    case 'task_complete': {
      const elapsed = Date.now() - (taskTimes.get(event.task ?? '') ?? Date.now())
      const task = event.data as Task | undefined
      console.log(`[${ts}] TASK DONE     "${task?.title ?? event.task}" in ${elapsed}ms`)
      break
    }
    case 'agent_start':
      console.log(`[${ts}] AGENT START   ${event.agent}`)
      break
    case 'agent_complete':
      console.log(`[${ts}] AGENT DONE    ${event.agent}`)
      break
    case 'error': {
      const task = event.data as Task | undefined
      console.error(`[${ts}] ERROR         ${event.agent ?? ''}  task="${task?.title ?? event.task}"`)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Build the pipeline
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultProvider: provider,
  defaultModel: model,
  maxConcurrency: 2, // allow test + review to potentially run in parallel later
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('pipeline-team', {
  name: 'pipeline-team',
  agents: [designer, implementer, tester, reviewer],
  sharedMemory: true,
})

// Task IDs — use stable strings so dependsOn can reference them
// (IDs will be generated by the framework; we capture the returned Task objects)

const tasks: Array<{
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
}> = [
  {
    title: 'Design: URL shortener data model',
    description: `Design a minimal in-memory URL shortener service.
Write a markdown spec to ${SPEC_FILE} covering:
- TypeScript interfaces for Url and ShortenRequest
- The shortening algorithm (hash approach is fine)
- API contract: POST /shorten, GET /:code
Keep the spec under 30 lines.`,
    assignee: 'designer',
    // no dependencies — this is the root task
  },
  {
    title: 'Implement: URL shortener',
    description: `Read the design spec at ${SPEC_FILE}.
Implement the URL shortener in ${SRC_DIR}/:
- shortener.ts: core logic (shorten, resolve functions)
- server.ts: tiny HTTP server using Node's built-in http module (no Express)
  - POST /shorten  body: { url: string } → { code: string, short: string }
  - GET  /:code    → redirect (301) or 404
- index.ts: entry point that starts the server on port 3002
No external dependencies beyond Node built-ins.`,
    assignee: 'implementer',
    dependsOn: ['Design: URL shortener data model'],
  },
  {
    title: 'Test: URL shortener',
    description: `Run the URL shortener implementation:
1. Start the server: node ${SRC_DIR}/index.ts (or tsx)
2. POST a URL to shorten it using curl
3. Verify the GET redirect works
4. Report what passed and what (if anything) failed.
Kill the server after testing.`,
    assignee: 'tester',
    dependsOn: ['Implement: URL shortener'],
  },
  {
    title: 'Review: URL shortener',
    description: `Read all .ts files in ${SRC_DIR}/ and the design spec.
Produce a structured code review with sections:
- Summary (2 sentences)
- Strengths (bullet list)
- Issues (bullet list, or "None" if clean)
- Verdict: SHIP or NEEDS WORK`,
    assignee: 'reviewer',
    dependsOn: ['Implement: URL shortener'], // runs in parallel with Test after Implement completes
    // Optional override: reviewers can opt into full shared memory when needed.
    // Remove this line to keep strict dependency-only context.
    memoryScope: 'all',
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Starting 4-stage task pipeline...\n')
console.log('Pipeline: design → implement → test + review (parallel)')
console.log('='.repeat(60))

const result = await orchestrator.runTasks(team, tasks)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log('Pipeline complete.\n')
console.log(`Overall success: ${result.success}`)
console.log(`Tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)

console.log('\nPer-agent summary:')
for (const [name, r] of result.agentResults) {
  const icon = r.success ? 'OK  ' : 'FAIL'
  const toolCount = r.toolCalls.map(c => c.toolName).join(', ')
  console.log(`  [${icon}] ${name.padEnd(14)}  tools used: ${toolCount || '(none)'}`)
}

// Print the reviewer's verdict
const review = result.agentResults.get('reviewer')
if (review?.success) {
  console.log('\nCode review:')
  console.log('─'.repeat(60))
  console.log(review.output)
  console.log('─'.repeat(60))
}
