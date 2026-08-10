/**
 * Synchronous agent handoff via `delegate_to_agent`
 *
 * During `runTeam` / `runTasks`, pool agents register the built-in
 * `delegate_to_agent` tool so one specialist can run a sub-prompt on another
 * roster agent and read the answer in the same conversation turn.
 *
 * Whitelist `delegate_to_agent` in `tools` when you want the model to see it;
 * standalone `runAgent()` does not register this tool by default.
 *
 * Run:
 *   npx tsx examples/patterns/agent-handoff.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig } from '../../packages/core/src/types.js'

const researcher: AgentConfig = {
  name: 'researcher',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt:
    'You answer factual questions briefly. When the user asks for a second opinion ' +
    'from the analyst, use delegate_to_agent to ask the analyst agent, then summarize both views.',
  tools: ['delegate_to_agent'],
  maxTurns: 6,
}

const analyst: AgentConfig = {
  name: 'analyst',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: 'You give short, skeptical analysis of claims. Push back when evidence is weak.',
  tools: [],
  maxTurns: 4,
}

async function main(): Promise<void> {
  const orchestrator = new OpenMultiAgent({ maxConcurrency: 2 })
  const team = orchestrator.createTeam('handoff-demo', {
    name: 'handoff-demo',
    agents: [researcher, analyst],
    sharedMemory: true,
  })

  const goal =
    'In one paragraph: state a simple fact about photosynthesis. ' +
    'Then ask the analyst (via delegate_to_agent) for a one-sentence critique of overstated claims in popular science. ' +
    'Merge both into a final short answer.'

  const result = await orchestrator.runTeam(team, goal)
  console.log('Success:', result.success)
  for (const [name, ar] of result.agentResults) {
    console.log(`\n--- ${name} ---\n${ar.output.slice(0, 2000)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
