/**
 * Single Agent
 *
 * The simplest possible usage: one agent with bash and file tools, running
 * a coding task. Then shows streaming output using the Agent class directly.
 *
 * Run:
 *   npx tsx examples/basics/single-agent.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { join } from 'node:path'
import { OpenMultiAgent, Agent, ToolRegistry, ToolExecutor, registerBuiltInTools } from '../../packages/core/src/index.js'
import type { OrchestratorEvent } from '../../packages/core/src/types.js'

// Built-in filesystem tools are sandboxed to `<cwd>/.agent-workspace` by
// default; write example output there so the demo runs without disabling
// the sandbox.
const OUTPUT_DIR = join(process.cwd(), '.agent-workspace', 'single-agent')
const GREET_FILE = join(OUTPUT_DIR, 'greet.ts')

// ---------------------------------------------------------------------------
// Part 1: Single agent via OpenMultiAgent (simplest path)
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  onProgress: (event: OrchestratorEvent) => {
    if (event.type === 'agent_start') {
      console.log(`[start]    agent=${event.agent}`)
    } else if (event.type === 'agent_complete') {
      console.log(`[complete] agent=${event.agent}`)
    }
  },
})

console.log('Part 1: runAgent() — single one-shot task\n')

const result = await orchestrator.runAgent(
  {
    name: 'coder',
    model: 'claude-sonnet-4-6',
    systemPrompt: `You are a focused TypeScript developer.
When asked to implement something, write clean, minimal code with no extra commentary.
Use the bash tool to run commands and the file tools to read/write files.`,
    tools: ['bash', 'file_read', 'file_write'],
    maxTurns: 8,
  },
  `Create a small TypeScript utility function in ${GREET_FILE} that:
  1. Exports a function named greet(name: string): string
  2. Returns "Hello, <name>!"
  3. Adds a brief usage comment at the top of the file.
  Then add a default call greet("World") at the bottom and run the file with: npx tsx ${GREET_FILE}`,
)

if (result.success) {
  console.log('\nAgent output:')
  console.log('─'.repeat(60))
  console.log(result.output)
  console.log('─'.repeat(60))
} else {
  console.error('Agent failed:', result.output)
  process.exit(1)
}

console.log('\nToken usage:')
console.log(`  input:  ${result.tokenUsage.input_tokens}`)
console.log(`  output: ${result.tokenUsage.output_tokens}`)
console.log(`  tool calls made: ${result.toolCalls.length}`)

// ---------------------------------------------------------------------------
// Part 2: Streaming via Agent directly
//
// OpenMultiAgent.runAgent() is a convenient wrapper. When you need streaming, use
// the Agent class directly with an injected ToolRegistry + ToolExecutor.
// ---------------------------------------------------------------------------

console.log('\n\nPart 2: Agent.stream() — incremental text output\n')

// Build a registry with all built-in tools registered
const registry = new ToolRegistry()
registerBuiltInTools(registry)
const executor = new ToolExecutor(registry)

const streamingAgent = new Agent(
  {
    name: 'explainer',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a concise technical writer. Keep explanations brief.',
    maxTurns: 3,
  },
  registry,
  executor,
)

process.stdout.write('Streaming: ')

for await (const event of streamingAgent.stream(
  'In two sentences, explain what a TypeScript generic constraint is.',
)) {
  if (event.type === 'text' && typeof event.data === 'string') {
    process.stdout.write(event.data)
  } else if (event.type === 'done') {
    process.stdout.write('\n')
  } else if (event.type === 'error') {
    console.error('\nStream error:', event.data)
  }
}

// ---------------------------------------------------------------------------
// Part 3: Multi-turn conversation via Agent.prompt()
// ---------------------------------------------------------------------------

console.log('\nPart 3: Agent.prompt() — multi-turn conversation\n')

const conversationAgent = new Agent(
  {
    name: 'tutor',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a TypeScript tutor. Give short, direct answers.',
    maxTurns: 2,
    // Keep only the most recent turn in long prompt() conversations.
    contextStrategy: { type: 'sliding-window', maxTurns: 1 },
  },
  new ToolRegistry(), // no tools needed for this conversation
  new ToolExecutor(new ToolRegistry()),
)

const turn1 = await conversationAgent.prompt('What is a type guard in TypeScript?')
console.log('Turn 1:', turn1.output.slice(0, 200))

const turn2 = await conversationAgent.prompt('Give me one concrete code example of what you just described.')
console.log('\nTurn 2:', turn2.output.slice(0, 300))

// History is retained between prompt() calls
console.log(`\nConversation history length: ${conversationAgent.getHistory().length} messages`)

console.log('\nDone.')
