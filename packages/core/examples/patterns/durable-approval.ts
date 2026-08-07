/**
 * Durable Approval: Suspend, Decide, Restore
 *
 * Demonstrates a task-dispatch gate that returns `suspend`, an atomic reviewer
 * decision, and a fresh orchestrator that resumes the exact approved task. The
 * in-memory store keeps this example no-key and deterministic; replace it with
 * FileStore or a database MemoryStore to survive a real process restart.
 *
 * Run:
 *   npx tsx packages/core/examples/patterns/durable-approval.ts
 *
 * Prerequisites:
 *   None. This example makes no model or network request.
 */

import {
  decideApproval,
  InMemoryStore,
  OpenMultiAgent,
} from '../../src/index.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMResponse,
} from '../../src/types.js'

function adapter(output: string): LLMAdapter {
  return {
    name: 'durable-approval-example',
    async chat(_messages, options: LLMChatOptions): Promise<LLMResponse> {
      return {
        id: 'approved-task-result',
        content: [{ type: 'text', text: output }],
        model: options.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream() {
      yield { type: 'done' as const, data: {} }
    },
  }
}

function releaseAgent(output: string): AgentConfig {
  return {
    name: 'release-operator',
    model: 'local-demo',
    adapter: adapter(output),
  }
}

const store = new InMemoryStore()
const first = new OpenMultiAgent({
  onTaskDispatch: async () => ({
    action: 'suspend',
    reason: 'Production release requires a named reviewer.',
  }),
})
const firstTeam = first.createTeam('durable-approval', {
  name: 'durable-approval',
  agents: [releaseAgent('This must not run before approval.')],
  sharedMemory: false,
})

const suspended = await first.runTasks(firstTeam, [{
  title: 'Release build 42',
  description: 'Release the already-tested build to production.',
  assignee: 'release-operator',
  priority: 'critical',
}], { checkpoint: { store } })

if (suspended.status?.code !== 'suspended' || suspended.pendingApprovals?.length !== 1) {
  throw new Error('Expected one durable approval request.')
}

const request = suspended.pendingApprovals[0]!
console.log(`Suspended: ${request.scope} ${request.id}`)
console.log(`Reviewed task: ${request.content.kind === 'task_dispatch' ? request.content.task.title : 'unexpected'}`)

await decideApproval(store, {
  requestId: request.id,
  requestHash: request.requestHash,
  decision: 'approve',
  reviewer: { id: 'release-manager-7', displayName: 'Release Manager' },
})

// Rebuild live dependencies as a restarted process would. This callback would
// reject a new boundary; the exact approved boundary bypasses it once.
const resumed = new OpenMultiAgent({ onTaskDispatch: async () => false })
const resumedTeam = resumed.createTeam('durable-approval', {
  name: 'durable-approval',
  agents: [releaseAgent('Build 42 released.')],
  sharedMemory: false,
})
const result = await resumed.restore(resumedTeam, { checkpoint: { store } })

if (!result.success || result.tasks?.[0]?.status !== 'completed') {
  throw new Error(`Restore failed: ${result.status?.code ?? 'unknown'}`)
}

console.log(`Resumed: ${result.agentResults.get('release-operator')?.output ?? 'missing output'}`)
console.log(`Reviewer: ${result.approvalDecisions?.[0]?.reviewer.id ?? 'missing'}`)
