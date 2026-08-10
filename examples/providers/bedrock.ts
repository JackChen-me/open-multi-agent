/**
 * Multi-Agent Team Collaboration with AWS Bedrock
 *
 * AWS Bedrock is a meta-provider: it routes requests to Claude, Llama, Mistral,
 * Cohere, and Titan models through your AWS account using the unified Converse API
 * (Anthropic-shaped schema). This means tool use, streaming, and structured output
 * work the same way regardless of which underlying model family you target.
 *
 * Run:
 *   npx tsx examples/providers/bedrock.ts
 *
 * Prerequisites:
 *   `@aws-sdk/client-bedrock-runtime` is an optional peer dependency — install it first:
 *     npm install @aws-sdk/client-bedrock-runtime
 *
 *   Required environment variables:
 *     AWS_ACCESS_KEY_ID      — your AWS access key
 *     AWS_SECRET_ACCESS_KEY  — your AWS secret key
 *     AWS_REGION             — e.g. us-east-1 (or pass region as the fourth arg to createAdapter)
 *
 *   IAM role credentials and SSO sessions are also picked up automatically via the
 *   AWS SDK default provider chain — no env vars needed in those cases.
 *
 * Model IDs:
 *   Some Claude models require a cross-region inference profile ID rather than the
 *   bare model ID. For example, Claude 3.5 Sonnet v2 in us-east-1 uses:
 *     us.anthropic.claude-3-5-sonnet-20241022-v2:0
 *   instead of:
 *     anthropic.claude-3-5-sonnet-20241022-v2:0
 *   Check the Bedrock console for the exact model ID available in your region.
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

// Claude — cheapest smoke-test model; swap to 'us.anthropic.claude-sonnet-4-6-20250514-v1:0' for higher capability.
// Newer Claude models require a cross-region inference profile prefix (e.g. 'us.') — bare model IDs
// are not supported for on-demand throughput. See the comments at the top of this file.
const HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
// Llama — uncomment to run the same team on Meta's Llama 4 instead:
// const HAIKU_MODEL = 'meta.llama4-maverick-17b-instruct-v1:0'

const researcher: AgentConfig = {
  name: 'researcher',
  model: HAIKU_MODEL,
  provider: 'bedrock',
  systemPrompt: `You are a research assistant. Given a topic, produce a concise 3-bullet
summary of the key facts. Be factual and direct.`,
  maxTurns: 3,
  temperature: 0.2,
}

const writer: AgentConfig = {
  name: 'writer',
  model: HAIKU_MODEL,
  provider: 'bedrock',
  systemPrompt: `You are a technical writer. Using the research provided, write a short
paragraph (3-4 sentences) suitable for a developer blog. Use clear, plain language.`,
  maxTurns: 3,
  temperature: 0.4,
}

const editor: AgentConfig = {
  name: 'editor',
  model: HAIKU_MODEL,
  provider: 'bedrock',
  systemPrompt: `You are a copy editor. Review the draft paragraph and return the final
polished version. Fix grammar, tighten prose, ensure the tone is professional.`,
  maxTurns: 3,
  temperature: 0.1,
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
      console.log(`[${ts}] AGENT DONE  ← ${event.agent} (${elapsed}ms)`)
      break
    }
    case 'task_start':
      console.log(`[${ts}] TASK START  ↓ ${event.task}`)
      break
    case 'task_complete':
      console.log(`[${ts}] TASK DONE   ↑ ${event.task}`)
      break
    case 'error':
      console.error(`[${ts}] ERROR ✗ agent=${event.agent} task=${event.task}`)
      if (event.data instanceof Error) console.error(`  ${event.data.message}`)
      break
  }
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: HAIKU_MODEL,
  defaultProvider: 'bedrock',
  maxConcurrency: 1,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('bedrock-team', {
  name: 'bedrock-team',
  agents: [researcher, writer, editor],
  sharedMemory: true,
  maxConcurrency: 1,
})

console.log(`Team "${team.name}" created with agents: ${team.getAgents().map(a => a.name).join(', ')}`)
console.log('\nStarting team run...\n')
console.log('='.repeat(60))

// Use runTasks() for this fixed 3-stage pipeline so every agent always runs.
// runTeam() short-circuits on short goals and would only invoke the best-match agent.
const tasks = [
  {
    title: 'Research: AWS Bedrock Converse API',
    description: `Produce a concise 3-bullet summary of key facts about AWS Bedrock's Converse API.
Cover: what it is, which model families it supports, and one key developer benefit.`,
    assignee: 'researcher',
  },
  {
    title: 'Write: developer blog paragraph',
    description: `Using the research summary, write a short paragraph (3-4 sentences) suitable for
a developer blog. Use clear, plain language. Do not invent facts beyond the research provided.`,
    assignee: 'writer',
    dependsOn: ['Research: AWS Bedrock Converse API'],
  },
  {
    title: 'Edit: polish the draft paragraph',
    description: `Review the draft paragraph and return the final polished version.
Fix grammar, tighten prose, ensure the tone is professional.`,
    assignee: 'editor',
    dependsOn: ['Write: developer blog paragraph'],
  },
]

const result = await orchestrator.runTasks(team, tasks)

console.log('\n' + '='.repeat(60))
console.log('\nTeam run complete.')
console.log(`Success: ${result.success}`)
console.log(`Total tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)

console.log('\nPer-agent results:')
for (const [agentName, agentResult] of result.agentResults) {
  const status = agentResult.success ? 'OK' : 'FAILED'
  console.log(` ${agentName.padEnd(12)} [${status}]`)
  if (!agentResult.success) console.log(`  Error: ${agentResult.output.slice(0, 120)}`)
}

const editorResult = result.agentResults.get('editor')
if (editorResult?.success) {
  console.log('\nFinal edited output:')
  console.log('─'.repeat(60))
  console.log(editorResult.output)
  console.log('─'.repeat(60))
}
