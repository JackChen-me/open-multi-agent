/**
 * External coding agents over ACP (Agent Client Protocol)
 *
 * A hybrid team: LLM-backed agents plan and review, while an *external* coding
 * agent (a local CLI driven over ACP) writes the code — all in one OMA task DAG
 * with shared memory, cascade-on-failure, and unified token accounting. The
 * coordinator decomposes the goal and routes the coding work to the ACP agent
 * because of its roster description; the LLM reviewer then audits what it wrote.
 *
 * The ACP agent is declared with `backend: { kind: 'acp', ... }` instead of a
 * model. OMA spawns it, exchanges JSON-RPC over stdio, and turns each prompt
 * turn into a normal agent result — so it behaves like any other team member.
 *
 * Run:
 *   npx tsx packages/core/examples/integrations/external-agent-acp.ts
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY                     one key for the whole team: the LLM
 *                                           planner + reviewer AND the Claude Code coder
 *   - @agentclientprotocol/sdk installed    (the optional ACP peer)
 *   - Node.js with `npx` on PATH. The coder runs Claude Code over ACP via the
 *     official adapter `npx @agentclientprotocol/claude-agent-acp` (auto-downloaded
 *     on first run). Swap `command`/`args` below for any other ACP agent — e.g.
 *     Gemini CLI (`gemini --acp`) or Codex (`codex-acp`). See docs/external-agents.md.
 */

import { OpenMultiAgent } from '../../src/index.js'

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error('Missing ANTHROPIC_API_KEY: needed for the planner/reviewer and the Claude Code coder.')
  process.exit(1)
}

// The directory the coding agent is allowed to read and edit. Point this at a
// scratch project you trust the external agent with.
const projectDir = process.env.OMA_ACP_PROJECT_DIR ?? process.cwd()

const oma = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  defaultProvider: 'anthropic',
  maxConcurrency: 3,
  onProgress: (event) => {
    if (event.type === 'task_complete') {
      console.log(`✓ ${event.agent} finished task ${event.task}`)
    }
  },
})

const team = oma.createTeam('hybrid-dev', {
  name: 'hybrid-dev',
  agents: [
    {
      name: 'planner',
      systemPrompt:
        'You break a software task into a short, concrete implementation plan. ' +
        'You do not write code yourself.',
    },
    {
      // External coding agent — no model; runs Claude Code as a local subprocess
      // over ACP, via the official Claude Agent SDK adapter.
      name: 'coder',
      systemPrompt:
        'Writes and edits code in the project by running Claude Code. ' +
        'Assign all file-editing and code-writing work here.',
      backend: {
        kind: 'acp',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp'],
        cwd: projectDir,
        // OMA runs autonomously, so tool prompts are auto-approved within `cwd`.
        // Use 'reject' or a function to gate specific actions.
        permission: 'auto-approve',
      },
    },
    {
      name: 'reviewer',
      systemPrompt:
        'You review a code change for correctness and clarity and summarize the diff, ' +
        'calling out risks. You do not edit files.',
    },
  ],
  sharedMemory: true,
})

const result = await oma.runTeam(
  team,
  'Add a `slugify(text)` utility (lowercase, spaces and punctuation to single hyphens) ' +
    'with a couple of unit tests, then review the change.',
)

console.log('\n=== Final output ===\n')
console.log(result.agentResults.get('coordinator')?.output ?? '(no synthesis)')
console.log('\nTotal tokens:', result.totalTokenUsage)
