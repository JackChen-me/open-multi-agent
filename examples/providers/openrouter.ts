/**
 * Multi-Agent Team Collaboration with OpenRouter
 *
 * Three specialized agents (architect, developer, reviewer) collaborate via `runTeam()`
 * to build a minimal Express.js REST API. Every agent uses OpenRouter through the
 * framework's OpenAI-compatible adapter.
 *
 * Run:
 *   npx tsx examples/providers/openrouter.ts
 *
 * Prerequisites:
 *   OPENROUTER_API_KEY environment variable must be set.
 *
 * Optional:
 *   OPENROUTER_MODEL overrides the default model. OpenRouter model names use
 *   provider/model slugs, such as `openai/gpt-4o-mini`.
 */

import { join } from 'node:path'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by
// default; route generated output there so the demo runs without
// disabling the sandbox.
const OUTPUT_DIR = join(process.cwd(), '.agent-workspace', 'openrouter-api')

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini'

if (!OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY environment variable must be set.')
}

const openRouterConfig = {
  provider: 'openai', // OpenRouter speaks the OpenAI-compatible Chat Completions API.
  baseURL: OPENROUTER_BASE_URL,
  apiKey: OPENROUTER_API_KEY,
  model: OPENROUTER_MODEL,
} satisfies Pick<AgentConfig, 'provider' | 'baseURL' | 'apiKey' | 'model'>

// ---------------------------------------------------------------------------
// Agent definitions (all using OpenRouter via the OpenAI-compatible adapter)
// ---------------------------------------------------------------------------
const architect: AgentConfig = {
  name: 'architect',
  ...openRouterConfig,
  systemPrompt: `You are a software architect with deep experience in Node.js and REST API design.
Your job is to design clear, production-quality API contracts and file/directory structures.
Output concise plans in markdown — no unnecessary prose.`,
  tools: ['bash', 'file_write'],
  maxTurns: 5,
  temperature: 0.2,
}

const developer: AgentConfig = {
  name: 'developer',
  ...openRouterConfig,
  systemPrompt: `You are a TypeScript/Node.js developer. You implement what the architect specifies.
Write clean, runnable code with proper error handling. Use the tools to write files and run tests.
Do not leave long-running foreground processes active; validate with one-shot commands or start and stop servers explicitly.`,
  tools: ['bash', 'file_read', 'file_write', 'file_edit'],
  maxTurns: 12,
  temperature: 0.1,
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  ...openRouterConfig,
  systemPrompt: `You are a senior code reviewer. Review code for correctness, security, and clarity.
Provide a structured review with: LGTM items, suggestions, and any blocking issues.
Read files using the tools before reviewing.`,
  tools: ['bash', 'file_read', 'grep'],
  maxTurns: 5,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------
const startTimes = new Map<string, number>()

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  switch (event.type) {
    case 'agent_start':
      startTimes.set(event.agent ?? '', Date.now())
      console.log(`[${ts}] AGENT START -> ${event.agent}`)
      break
    case 'agent_complete': {
      const elapsed = Date.now() - (startTimes.get(event.agent ?? '') ?? Date.now())
      console.log(`[${ts}] AGENT DONE <- ${event.agent} (${elapsed}ms)`)
      break
    }
    case 'task_start':
      console.log(`[${ts}] TASK START v ${event.task}`)
      break
    case 'task_complete':
      console.log(`[${ts}] TASK DONE ^ ${event.task}`)
      break
    case 'message':
      console.log(`[${ts}] MESSAGE * ${event.agent} -> (team)`)
      break
    case 'error':
      console.error(`[${ts}] ERROR x agent=${event.agent} task=${event.task}`)
      if (event.data instanceof Error) console.error(` ${event.data.message}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------
const orchestrator = new OpenMultiAgent({
  defaultModel: OPENROUTER_MODEL,
  defaultProvider: 'openai',
  defaultBaseURL: OPENROUTER_BASE_URL,
  defaultApiKey: OPENROUTER_API_KEY,
  maxConcurrency: 1, // sequential for readable output
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('api-team', {
  name: 'api-team',
  agents: [architect, developer, reviewer],
  sharedMemory: true,
  maxConcurrency: 1,
})

console.log(`Team "${team.name}" created with agents: ${team.getAgents().map(a => a.name).join(', ')}`)
console.log(`Using OpenRouter model: ${OPENROUTER_MODEL}`)
console.log('\nStarting team run...\n')
console.log('='.repeat(60))

const goal = `Create a minimal Express.js REST API in ${OUTPUT_DIR}/ with:
- GET /health -> { status: "ok" }
- GET /users -> returns a hardcoded array of 2 user objects
- POST /users -> accepts { name, email } body, logs it, returns 201
- Proper error handling middleware
- The server should listen on port 3001
- Include a package.json with the required dependencies
- Include a test or verification script that can be run without leaving a server process running
- Do not start a foreground server as the final step`

const result = await orchestrator.runTeam(team, goal)

console.log('\n' + '='.repeat(60))

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('\nTeam run complete.')
console.log(`Success: ${result.success}`)
console.log(`Total tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)

console.log('\nPer-agent results:')
for (const [agentName, agentResult] of result.agentResults) {
  const status = agentResult.success ? 'OK' : 'FAILED'
  const tools = agentResult.toolCalls.length
  console.log(` ${agentName.padEnd(12)} [${status}] tool_calls=${tools}`)
  if (!agentResult.success) {
    console.log(` Error: ${agentResult.output.slice(0, 120)}`)
  }
}

// Sample outputs
const developerResult = result.agentResults.get('developer')
if (developerResult?.success) {
  console.log('\nDeveloper output (last 600 chars):')
  console.log('-'.repeat(60))
  const out = developerResult.output
  console.log(out.length > 600 ? '...' + out.slice(-600) : out)
  console.log('-'.repeat(60))
}

const reviewerResult = result.agentResults.get('reviewer')
if (reviewerResult?.success) {
  console.log('\nReviewer output:')
  console.log('-'.repeat(60))
  console.log(reviewerResult.output)
  console.log('-'.repeat(60))
}
