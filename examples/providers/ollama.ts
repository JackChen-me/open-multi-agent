/**
 * Local Model + Cloud Model Team (Ollama + Claude)
 *
 * Demonstrates mixing a local model served by Ollama with a cloud model
 * (Claude) in the same task pipeline. The key technique is using
 * `provider: 'openai'` with a custom `baseURL` pointing at Ollama's
 * OpenAI-compatible endpoint.
 *
 * This pattern works with ANY OpenAI-compatible local server:
 * - Ollama        → http://localhost:11434/v1
 * - vLLM          → http://localhost:8000/v1
 * - LM Studio     → http://localhost:1234/v1
 * - llama.cpp     → http://localhost:8080/v1
 * Just change the baseURL and model name below.
 *
 * Run:
 *   npx tsx examples/providers/ollama.ts
 *
 * Prerequisites:
 *   1. Ollama installed and running: https://ollama.com
 *   2. Pull the model: ollama pull llama3.1
 *   3. ANTHROPIC_API_KEY env var must be set.
 */

import { join } from 'node:path'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent, Task } from '../../packages/core/src/types.js'

// Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by
// default; route generated output there so the demo runs without
// disabling the sandbox.
const OUTPUT_DIR = join(process.cwd(), '.agent-workspace', 'local-model-demo')

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Coder — uses Claude (Anthropic) for high-quality code generation.
 */
const coder: AgentConfig = {
  name: 'coder',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a senior TypeScript developer. Write clean, well-typed,
production-quality code. Use the tools to write files to ${OUTPUT_DIR}/.
Always include brief JSDoc comments on exported functions.`,
  tools: ['bash', 'file_write'],
  maxTurns: 6,
}

/**
 * Reviewer — uses a local Ollama model via the OpenAI-compatible API.
 * The apiKey is required by the OpenAI SDK but Ollama ignores it,
 * so we pass the placeholder string 'ollama'.
 */
const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'llama3.1',
  provider: 'openai', // 'openai' here means "OpenAI-compatible protocol", not the OpenAI cloud
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  systemPrompt: `You are a code reviewer. You read source files and produce a structured review.
Your review MUST include these sections:
- Summary (2-3 sentences)
- Strengths (bullet list)
- Issues (bullet list — or "None found" if the code is clean)
- Verdict: SHIP or NEEDS WORK

Be specific and constructive. Reference line numbers or function names when possible.`,
  tools: ['file_read'],
  maxTurns: 4,
  timeoutMs: 120_000, // 2 min — local models can be slow
}

// ---------------------------------------------------------------------------
// Progress handler
// ---------------------------------------------------------------------------

const taskTimes = new Map<string, number>()

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)

  switch (event.type) {
    case 'task_start': {
      taskTimes.set(event.task ?? '', Date.now())
      const task = event.data as Task | undefined
      console.log(`[${ts}] TASK READY    "${task?.title ?? event.task}" → ${task?.assignee ?? '?'}`)
      break
    }
    case 'task_complete': {
      const elapsed = Date.now() - (taskTimes.get(event.task ?? '') ?? Date.now())
      console.log(`[${ts}] TASK DONE     task=${event.task} in ${elapsed}ms`)
      break
    }
    case 'agent_start':
      console.log(`[${ts}] AGENT START   ${event.agent}`)
      break
    case 'agent_complete':
      console.log(`[${ts}] AGENT DONE    ${event.agent}`)
      break
    case 'error':
      console.error(`[${ts}] ERROR         ${event.agent ?? ''}  task=${event.task ?? '?'}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrator + Team
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  maxConcurrency: 2,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('local-cloud-team', {
  name: 'local-cloud-team',
  agents: [coder, reviewer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Task pipeline: code → review
// ---------------------------------------------------------------------------

const tasks: Array<{
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
}> = [
  {
    title: 'Write: retry utility',
    description: `Write a small but complete TypeScript utility to ${OUTPUT_DIR}/retry.ts.

The module should export:
1. A \`RetryOptions\` interface with: maxRetries (number), delayMs (number),
   backoffFactor (optional number, default 2), shouldRetry (optional predicate
   taking the error and returning boolean).
2. An async \`retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>\`
   function that retries \`fn\` with exponential backoff.
3. A convenience \`withRetry\` wrapper that returns a new function with retry
   behaviour baked in.

Include JSDoc comments. No external dependencies — use only Node built-ins.
After writing the file, also create a small test script at ${OUTPUT_DIR}/retry-test.ts
that exercises the happy path and a failure case, then run it with \`npx tsx\`.`,
    assignee: 'coder',
  },
  {
    title: 'Review: retry utility',
    description: `Read the files at ${OUTPUT_DIR}/retry.ts and ${OUTPUT_DIR}/retry-test.ts.

Produce a structured code review covering:
- Summary (2-3 sentences describing the module)
- Strengths (bullet list)
- Issues (bullet list — be specific about what and why)
- Verdict: SHIP or NEEDS WORK`,
    assignee: 'reviewer',
    dependsOn: ['Write: retry utility'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Local + Cloud model team')
console.log(`  coder    → Claude (${coder.model}) via Anthropic API`)
console.log(`  reviewer → Ollama (${reviewer.model}) at ${reviewer.baseURL}`)
console.log()
console.log('Pipeline: coder writes code → local model reviews it')
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
  const provider = name === 'coder' ? 'anthropic' : 'ollama (local)'
  const tools = r.toolCalls.map(c => c.toolName).join(', ')
  console.log(`  [${icon}] ${name.padEnd(10)} (${provider.padEnd(16)})  tools: ${tools || '(none)'}`)
}

// Print the reviewer's output
const review = result.agentResults.get('reviewer')
if (review?.success) {
  console.log('\nCode review (from local model):')
  console.log('─'.repeat(60))
  console.log(review.output)
  console.log('─'.repeat(60))
}
