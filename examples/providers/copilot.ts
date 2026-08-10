/**
 * Multi-Agent Team Collaboration with GitHub Copilot
 *
 * Three specialized agents (architect, developer, reviewer) collaborate via `runTeam()`
 * to build a minimal Express.js REST API. Routes through GitHub Copilot's OpenAI-compatible
 * endpoint, mixing GPT-4o (architect/reviewer) and Claude Sonnet (developer) in one team.
 *
 * Run:
 *   npx tsx examples/providers/copilot.ts
 *
 * Authentication (one of):
 *   GITHUB_COPILOT_TOKEN env var (preferred)
 *   GITHUB_TOKEN env var (fallback)
 *   Otherwise: an interactive OAuth2 device flow starts on first run and prompts
 *   you to sign in via your browser. Requires an active Copilot subscription.
 *
 * Available models (subset):
 *   gpt-4o              — included, no premium request
 *   claude-sonnet-4.5   — premium, 1x multiplier
 *   claude-sonnet-4.6   — premium, 1x multiplier
 *   See src/llm/copilot.ts for the full model list and premium multipliers.
 */

import { join } from 'node:path'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by
// default; route generated output there so the demo runs without
// disabling the sandbox.
const OUTPUT_DIR = join(process.cwd(), '.agent-workspace', 'copilot-api')

// ---------------------------------------------------------------------------
// Agent definitions (mixing GPT-4o and Claude Sonnet, both via Copilot)
// ---------------------------------------------------------------------------
const architect: AgentConfig = {
  name: 'architect',
  model: 'gpt-4o',
  provider: 'copilot',
  systemPrompt: `You are a software architect with deep experience in Node.js and REST API design.
Your job is to design clear, production-quality API contracts and file/directory structures.
Output concise plans in markdown — no unnecessary prose.`,
  tools: ['bash', 'file_write'],
  maxTurns: 5,
  temperature: 0.2,
}

const developer: AgentConfig = {
  name: 'developer',
  model: 'claude-sonnet-4.5',
  provider: 'copilot',
  systemPrompt: `You are a TypeScript/Node.js developer. You implement what the architect specifies.
Write clean, runnable code with proper error handling. Use the tools to write files and run tests.`,
  tools: ['bash', 'file_read', 'file_write', 'file_edit'],
  maxTurns: 12,
  temperature: 0.1,
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'gpt-4o',
  provider: 'copilot',
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
  const ts = new Date().toISOString().slice(11, 23)
  switch (event.type) {
    case 'agent_start':
      startTimes.set(event.agent ?? '', Date.now())
      console.log(`[${ts}] AGENT START → ${event.agent}`)
      break
    case 'agent_complete': {
      const elapsed = Date.now() - (startTimes.get(event.agent ?? '') ?? Date.now())
      console.log(`[${ts}] AGENT DONE ← ${event.agent} (${elapsed}ms)`)
      break
    }
    case 'task_start':
      console.log(`[${ts}] TASK START ↓ ${event.task}`)
      break
    case 'task_complete':
      console.log(`[${ts}] TASK DONE ↑ ${event.task}`)
      break
    case 'message':
      console.log(`[${ts}] MESSAGE • ${event.agent} → (team)`)
      break
    case 'error':
      console.error(`[${ts}] ERROR ✗ agent=${event.agent} task=${event.task}`)
      if (event.data instanceof Error) console.error(` ${event.data.message}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------
const orchestrator = new OpenMultiAgent({
  defaultModel: 'gpt-4o',
  defaultProvider: 'copilot',
  maxConcurrency: 1,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('api-team', {
  name: 'api-team',
  agents: [architect, developer, reviewer],
  sharedMemory: true,
  maxConcurrency: 1,
})

console.log(`Team "${team.name}" created with agents: ${team.getAgents().map(a => a.name).join(', ')}`)
console.log('\nStarting team run...\n')
console.log('='.repeat(60))

const goal = `Create a minimal Express.js REST API in ${OUTPUT_DIR}/ with:
- GET /health → { status: "ok" }
- GET /users → returns a hardcoded array of 2 user objects
- POST /users → accepts { name, email } body, logs it, returns 201
- Proper error handling middleware
- The server should listen on port 3001
- Include a package.json with the required dependencies`

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

const developerResult = result.agentResults.get('developer')
if (developerResult?.success) {
  console.log('\nDeveloper output (last 600 chars):')
  console.log('─'.repeat(60))
  const out = developerResult.output
  console.log(out.length > 600 ? '...' + out.slice(-600) : out)
  console.log('─'.repeat(60))
}

const reviewerResult = result.agentResults.get('reviewer')
if (reviewerResult?.success) {
  console.log('\nReviewer output:')
  console.log('─'.repeat(60))
  console.log(reviewerResult.output)
  console.log('─'.repeat(60))
}
