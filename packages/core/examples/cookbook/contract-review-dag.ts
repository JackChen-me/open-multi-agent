/**
 * Contract Review DAG with Step-Level Retry
 *
 * Demonstrates DAG task orchestration with step-level retry using runTasks().
 * Scenario: contract review pipeline with 4 tasks forming a DAG:
 *
 *   [Task 1: extract-clauses]
 *          ├──→ [Task 2: compliance-check] ────┐
 *          │                                    ├──→ [Task 4: notify] → Markdown
 *          └──→ [Task 3: summary] ──────────────┘
 *
 * Key features:
 * - DAG dependencies with parallel execution (Task 2 and 3 run concurrently)
 * - Step-level retry on Task 2/3/4 with exponential backoff
 * - FORCE_FAIL=task2 env var triggers Task 2 failure on first attempt
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/contract-review-dag.ts
 *   FORCE_FAIL=task2 npx tsx packages/core/examples/cookbook/contract-review-dag.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../src/types.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Attempt counter for FORCE_FAIL mechanism (closure-based per agent)
// ---------------------------------------------------------------------------
const attemptCounter = new Map<string, number>()

function getAndIncrementAttempt(agentName: string): number {
  const count = (attemptCounter.get(agentName) ?? 0) + 1
  attemptCounter.set(agentName, count)
  return count
}

// ---------------------------------------------------------------------------
// Step 1: Agent configurations (4 agents)
// ---------------------------------------------------------------------------

const extractorConfig: AgentConfig = {
  name: 'extractor',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a contract clause extraction specialist. Extract all clauses from the provided contract text and output as a JSON array.

Each object must have:
- id: clause number (string)
- title: clause title
- content: full clause text
- riskLevel: "low" | "medium" | "high"

Output ONLY valid JSON, no other text.`,
  maxTurns: 1,
  temperature: 0.1,
}

const complianceCheckerConfig: AgentConfig = {
  name: 'compliance-checker',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a contract compliance auditor. Review each clause for regulatory and operational compliance.

For each clause, output:
- clauseId: clause number
- isCompliant: true/false
- issues: array of issues found (empty array if none)
- riskCategory: "none" | "regulatory" | "operational" | "legal"

Output ONLY valid JSON array, no other text.`,
  maxTurns: 1,
  temperature: 0.1,
  beforeRun: (context) => {
    const attempt = getAndIncrementAttempt('compliance-checker')

    // Only trigger FORCE_FAIL on first attempt (attempt=1)
    if (attempt === 1 && process.env.FORCE_FAIL === 'task2') {
      throw new Error('[FORCE_FAIL_TRIGGERED]')
    }
    return context
  },
}

const summarizerConfig: AgentConfig = {
  name: 'summarizer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a contract summary specialist. Generate an executive summary from the extracted clause list.

Include:
- Contract overview (main areas covered)
- Key clause summary (3-5 most important points)
- Risk callouts (highlight high-risk clauses)
- Recommended next steps

Output in Markdown format.`,
  maxTurns: 1,
  temperature: 0.2,
}

const notifierConfig: AgentConfig = {
  name: 'notifier',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a report writer. Combine the compliance check results and summary into a final contract review report.

Include:
- Executive Summary
- Compliance Results
- Risk Details
- Recommended Actions

Output in Markdown format.`,
  maxTurns: 1,
  temperature: 0.2,
}

// ---------------------------------------------------------------------------
// Step 2: Task configurations (4 tasks)
// ---------------------------------------------------------------------------

interface TaskConfig {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}

// Task configs will be created after reading contract text

// ---------------------------------------------------------------------------
// Step 3: Progress tracking
// ---------------------------------------------------------------------------

interface TaskTiming {
  startTime: number
  endTime?: number
}

const taskTimings = new Map<string, TaskTiming>()
const taskStartTimes = new Map<string, number>()

function handleProgress(event: OrchestratorEvent): void {
  const ts = new Date().toISOString()

  switch (event.type) {
    case 'task_start': {
      const task = event.data as { id: string; title: string } | undefined
      if (task) {
        const now = Date.now()
        taskTimings.set(task.id, { startTime: now })
        taskStartTimes.set(task.title, now)  // Use title as key for easier verification
        console.log(`[${ts}] task_start: ${task.title}`)
      }
      break
    }

    case 'task_complete': {
      const task = event.data as { id: string; title: string } | undefined
      if (task) {
        const timing = taskTimings.get(task.id)
        if (timing) {
          timing.endTime = Date.now()
          const duration = timing.endTime - timing.startTime
          console.log(`[${ts}] task_complete: ${task.title} (${duration}ms)`)
        }
      }
      break
    }

    case 'task_retry':
      console.log(`[${ts}] task_retry:`, JSON.stringify(event.data))
      break

    case 'task_skipped':
      console.log(`[${ts}] task_skipped: ${event.task}`)
      break

    case 'agent_start':
      if (event.agent) {
        console.log(`[${ts}] agent_start: ${event.agent}`)
      }
      break

    case 'agent_complete':
      if (event.agent) {
        console.log(`[${ts}] agent_complete: ${event.agent}`)
      }
      break

    case 'message':
      if (typeof event.data === 'string') {
        console.log(`[${ts}] message: ${event.data}`)
      }
      break

    case 'error':
      console.log(`[${ts}] error:`, JSON.stringify(event.data))
      break

    default:
      break
  }
}

// ---------------------------------------------------------------------------
// Step 4: Parallelism verification
// ---------------------------------------------------------------------------

function verifyParallelism(): void {
  const t2Start = taskStartTimes.get('compliance-check')
  const t3Start = taskStartTimes.get('summary')

  if (t2Start !== undefined && t3Start !== undefined) {
    const diff = Math.abs(t2Start - t3Start)
    console.log('\n=== Parallelism Check ===')
    console.log(`Task 2 (compliance-check) start: ${t2Start}`)
    console.log(`Task 3 (summary) start: ${t3Start}`)
    console.log(`Time difference: ${diff}ms`)

    if (diff >= 500) {
      console.error(
        `ASSERTION FAILED: Task 2 and Task 3 start times differ by ${diff}ms (>= 500ms). ` +
          `Expected parallel execution after Task 1 completes.`,
      )
      process.exit(1)
    }
    console.log(`Parallel execution (< 500ms): YES`)
    console.log('========================\n')
  } else {
    console.log('\n=== Parallelism Check: Unable to verify (missing timing data) ===\n')
  }
}

// ---------------------------------------------------------------------------
// Step 5: Orchestrator and Team configuration
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'claude-sonnet-4-6',
  defaultProvider: 'anthropic',
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('contract-review-team', {
  name: 'contract-review-team',
  agents: [extractorConfig, complianceCheckerConfig, summarizerConfig, notifierConfig],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Step 6: Read contract text
// ---------------------------------------------------------------------------

const contractText = readFileSync(
  join(__dirname, '..', 'fixtures', 'sample-contract.txt'),
  'utf-8',
)

// ---------------------------------------------------------------------------
// Step 6b: Create task configs with contract text
// ---------------------------------------------------------------------------

const taskConfigs: TaskConfig[] = [
  {
    title: 'extract-clauses',
    description: `Extract all clauses from the following contract text into structured JSON.\n\n=== CONTRACT TEXT ===\n${contractText}\n=== END CONTRACT ===\n\nOutput only valid JSON array.`,
    assignee: 'extractor',
  },
  {
    title: 'compliance-check',
    description: 'Check each clause for regulatory and operational compliance. Using the clause list from Task 1 above.',
    assignee: 'compliance-checker',
    dependsOn: ['extract-clauses'],
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoff: 2,
  },
  {
    title: 'summary',
    description: 'Generate executive summary of the contract. Using the clause list from Task 1 above.',
    assignee: 'summarizer',
    dependsOn: ['extract-clauses'],
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoff: 2,
  },
  {
    title: 'notify',
    description: 'Generate final markdown report with all analysis results',
    assignee: 'notifier',
    dependsOn: ['compliance-check', 'summary'],
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoff: 2,
  },
]

console.log('Contract Review DAG with Step-Level Retry')
console.log('='.repeat(60))
console.log(`\nContract: ${contractText.split('\n')[0]}`)
console.log(`Length: ${contractText.split(/\s+/).length} words\n`)
console.log(`FORCE_FAIL mode: ${process.env.FORCE_FAIL === 'task2' ? 'ENABLED (task2)' : 'disabled'}\n`)

// ---------------------------------------------------------------------------
// Step 7: Run the DAG
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    console.log('[Orchestration] Starting DAG execution...\n')

    const result = await orchestrator.runTasks(team, taskConfigs)

    // Verify parallelism
    verifyParallelism()

    console.log('\n' + '='.repeat(60))
    console.log('FINAL RESULT')
    console.log('='.repeat(60))
    console.log(`Success: ${result.success}`)
    console.log(`Total tasks: ${result.tasks?.length ?? taskConfigs.length}`)
    console.log(`Total token usage: ${result.totalTokenUsage.input_tokens} input, ${result.totalTokenUsage.output_tokens} output`)

    // Output each agent's result
    console.log('\n' + '='.repeat(60))
    console.log('AGENT RESULTS')
    console.log('='.repeat(60))
    for (const [agentName, agentResult] of result.agentResults) {
      console.log(`\n--- ${agentName} ---`)
      console.log(agentResult.success ? agentResult.output : `[FAILED] ${agentResult.output}`)
    }

    if (result.success) {
      console.log('\n--- Final Report ---')
      const notifierResult = result.agentResults.get('notifier')
      if (notifierResult?.output) {
        console.log(notifierResult.output)
      }
    } else {
      console.log('\nWorkflow failed.')
      for (const task of result.tasks ?? []) {
        if (task.status === 'failed') {
          console.log(`  - ${task.title}: failed`)
        }
      }
    }

    console.log('\n' + '='.repeat(60))
    console.log('Done.')
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

main()
