/**
 * Gemma 4 Local (100% Local, Zero API Cost)
 *
 * Demonstrates both execution modes with a fully local Gemma 4 model via
 * Ollama. No cloud API keys needed — everything runs on your machine.
 *
 * Part 1 — runTasks(): explicit task pipeline (researcher → summarizer)
 * Part 2 — runTeam(): auto-orchestration where Gemma 4 acts as coordinator,
 *           decomposes the goal into tasks, and synthesises the final result
 *
 * This is the hardest test for a local model — runTeam() requires it to
 * produce valid JSON for task decomposition AND do tool-calling for execution.
 * Gemma 4 e2b (5.1B params) handles both reliably.
 *
 * Run:
 *   no_proxy=localhost npx tsx examples/providers/gemma4-local.ts
 *
 * Prerequisites:
 *   1. Ollama >= 0.20.0 installed and running: https://ollama.com
 *   2. Pull the model: ollama pull gemma4:e2b
 *      (or gemma4:e4b for better quality on machines with more RAM)
 *   3. No API keys needed!
 *
 * Note: The no_proxy=localhost prefix is needed if you have an HTTP proxy
 * configured, since the OpenAI SDK would otherwise route Ollama requests
 * through the proxy.
 */

import { join } from 'node:path'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent, Task } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Configuration — change this to match your Ollama setup
// ---------------------------------------------------------------------------

// See available tags at https://ollama.com/library/gemma4
const OLLAMA_MODEL = 'gemma4:e2b'      // or 'gemma4:e4b', 'gemma4:26b'
const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
// Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by
// default; route generated output there so the demo runs without
// disabling the sandbox.
const OUTPUT_DIR = join(process.cwd(), '.agent-workspace', 'gemma4-demo')
const AUTO_REPORT_DIR = join(process.cwd(), '.agent-workspace', 'gemma4-auto')

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const researcher: AgentConfig = {
  name: 'researcher',
  model: OLLAMA_MODEL,
  provider: 'openai',
  baseURL: OLLAMA_BASE_URL,
  apiKey: 'ollama', // placeholder — Ollama ignores this, but the OpenAI SDK requires a non-empty value
  systemPrompt: `You are a system researcher. Use bash to run non-destructive,
read-only commands (uname -a, sw_vers, df -h, uptime, etc.) and report results.
Use file_write to save reports when asked.`,
  tools: ['bash', 'file_write'],
  maxTurns: 8,
}

const summarizer: AgentConfig = {
  name: 'summarizer',
  model: OLLAMA_MODEL,
  provider: 'openai',
  baseURL: OLLAMA_BASE_URL,
  apiKey: 'ollama',
  systemPrompt: `You are a technical writer. Read files and produce concise,
structured Markdown summaries. Use file_write to save reports when asked.`,
  tools: ['file_read', 'file_write'],
  maxTurns: 4,
}

// ---------------------------------------------------------------------------
// Progress handler
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23)
  switch (event.type) {
    case 'task_start': {
      const task = event.data as Task | undefined
      console.log(`[${ts}] TASK START    "${task?.title ?? event.task}" → ${task?.assignee ?? '?'}`)
      break
    }
    case 'task_complete':
      console.log(`[${ts}] TASK DONE     "${event.task}"`)
      break
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

// ═══════════════════════════════════════════════════════════════════════════
// Part 1: runTasks() — Explicit task pipeline
// ═══════════════════════════════════════════════════════════════════════════

console.log('Part 1: runTasks() — Explicit Pipeline')
console.log('='.repeat(60))
console.log(`  model       → ${OLLAMA_MODEL} via Ollama`)
console.log(`  pipeline    → researcher gathers info → summarizer writes summary`)
console.log()

const orchestrator1 = new OpenMultiAgent({
  defaultModel: OLLAMA_MODEL,
  maxConcurrency: 1, // local model serves one request at a time
  onProgress: handleProgress,
})

const team1 = orchestrator1.createTeam('explicit', {
  name: 'explicit',
  agents: [researcher, summarizer],
  sharedMemory: true,
})

const tasks = [
  {
    title: 'Gather system information',
    description: `Use bash to run system info commands (uname -a, sw_vers, sysctl, df -h, uptime).
Then write a structured Markdown report to ${OUTPUT_DIR}/system-report.md with sections:
OS, Hardware, Disk, and Uptime.`,
    assignee: 'researcher',
  },
  {
    title: 'Summarize the report',
    description: `Read the file at ${OUTPUT_DIR}/system-report.md.
Produce a concise one-paragraph executive summary of the system information.`,
    assignee: 'summarizer',
    dependsOn: ['Gather system information'],
  },
]

const start1 = Date.now()
const result1 = await orchestrator1.runTasks(team1, tasks)

console.log(`\nSuccess: ${result1.success}  Time: ${((Date.now() - start1) / 1000).toFixed(1)}s`)
console.log(`Tokens — input: ${result1.totalTokenUsage.input_tokens}, output: ${result1.totalTokenUsage.output_tokens}`)

const summary = result1.agentResults.get('summarizer')
if (summary?.success) {
  console.log('\nSummary (from local Gemma 4):')
  console.log('-'.repeat(60))
  console.log(summary.output)
  console.log('-'.repeat(60))
}

// ═══════════════════════════════════════════════════════════════════════════
// Part 2: runTeam() — Auto-orchestration (Gemma 4 as coordinator)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n\nPart 2: runTeam() — Auto-Orchestration')
console.log('='.repeat(60))
console.log(`  coordinator  → auto-created by runTeam(), also Gemma 4`)
console.log(`  goal         → given in natural language, framework plans everything`)
console.log()

const orchestrator2 = new OpenMultiAgent({
  defaultModel: OLLAMA_MODEL,
  defaultProvider: 'openai',
  defaultBaseURL: OLLAMA_BASE_URL,
  defaultApiKey: 'ollama',
  maxConcurrency: 1,
  onProgress: handleProgress,
})

const team2 = orchestrator2.createTeam('auto', {
  name: 'auto',
  agents: [researcher, summarizer],
  sharedMemory: true,
})

const goal = `Check this machine's Node.js version, npm version, and OS info,
then write a short Markdown summary report to ${AUTO_REPORT_DIR}/report.md`

const start2 = Date.now()
const result2 = await orchestrator2.runTeam(team2, goal)

console.log(`\nSuccess: ${result2.success}  Time: ${((Date.now() - start2) / 1000).toFixed(1)}s`)
console.log(`Tokens — input: ${result2.totalTokenUsage.input_tokens}, output: ${result2.totalTokenUsage.output_tokens}`)

const coordResult = result2.agentResults.get('coordinator')
if (coordResult?.success) {
  console.log('\nFinal synthesis (from local Gemma 4 coordinator):')
  console.log('-'.repeat(60))
  console.log(coordResult.output)
  console.log('-'.repeat(60))
}

console.log('\nAll processing done locally. $0 API cost.')
