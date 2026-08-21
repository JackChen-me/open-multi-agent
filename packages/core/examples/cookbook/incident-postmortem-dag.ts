/**
 * Incident Postmortem DAG with Parallel Fan-Out
 *
 * Demonstrates DAG task orchestration with three independent root tasks
 * fanning out from t=0, then synthesizing into a final postmortem document.
 *
 *   log-pattern-extractor   |
 *   correlate-deploys       |--> root-cause-hypothesizer --> postmortem-writer
 *   analyze-blast-radius    |
 * departures from that template:
 *   - No FORCE_FAIL / retry-demonstration machinery -- this example's
 *     theme is parallel fan-out + multi-source synthesis, not retry.
 *   - Three parallel root tasks (instead of two), so the parallelism
 *     check asserts that all three start within a 500ms window.
 *   - Final postmortem is also written to disk via os.tmpdir().
 *   - Token cost on claude-sonnet-4-6 is printed alongside token totals.
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/incident-postmortem-dag.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *
 * Local validation hatch:
 *   EXAMPLE_PROVIDER=openrouter switches every agent + the orchestrator
 *   defaults to a free OpenRouter model (openrouter/free)
 *   via the OpenAI-compatible adapter. The framework reads OPENAI_API_KEY
 *   and OPENAI_BASE_URL from env.
 */

import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../src/types.js'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Step 1: Agent configurations (5 agents)
// ---------------------------------------------------------------------------

const logPatternExtractorConfig: AgentConfig = {
  name: 'log-pattern-extractor',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a log analysis specialist. Parse the provided raw backend logs and identify:
- Error clusters (group by error message / endpoint / service)
- The timestamp of the first regression (when error rate clearly departs from baseline)
- Noisy hosts/services/endpoints

Output a JSON object with this shape:
{
  "first_regression_at": "ISO 8601 timestamp",
  "error_clusters": [
    { "service": string, "endpoint": string, "error": string, "count": number, "first_seen": string, "last_seen": string }
  ],
  "noisy_endpoints": [ { "endpoint": string, "error_count": number } ],
  "notes": string
}

Output ONLY valid JSON, no other text.`,
  maxTurns: 1,
  temperature: 0.1,
}

const deployCorrelatorConfig: AgentConfig = {
  name: 'deploy-correlator',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a deploy correlation analyst. Given a list of recent deploys and a window of incident symptoms, identify which deploy(s) most plausibly caused the symptoms based on timing and changed paths.

Output a JSON object:
{
  "ranked_candidates": [
    {
      "sha": string,
      "deployed_at": string,
      "summary": string,
      "confidence": "high" | "medium" | "low",
      "rationale": string
    }
  ],
  "ruled_out": [ { "sha": string, "reason": string } ]
}

Output ONLY valid JSON, no other text.`,
  maxTurns: 1,
  temperature: 0.1,
}

const blastRadiusAnalystConfig: AgentConfig = {
  name: 'blast-radius-analyst',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a blast radius analyst. From the provided logs, estimate user-facing impact.

Output a JSON object:
{
  "affected_endpoints": [ { "endpoint": string, "method": string } ],
  "approximate_failed_requests": number,
  "approximate_total_requests_in_window": number,
  "error_rate_pct": number,
  "impact_window": { "start": string, "end": string },
  "user_facing_severity": "low" | "medium" | "high" | "critical",
  "notes": string
}

Output ONLY valid JSON, no other text.`,
  maxTurns: 1,
  temperature: 0.1,
}

const rootCauseHypothesizerConfig: AgentConfig = {
  name: 'root-cause-hypothesizer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a root cause analyst. Using the log patterns and deploy correlation from the previous tasks (available via shared memory), propose 2-3 ranked root cause hypotheses.

For each hypothesis, include:
- A short title
- Confidence (high / medium / low)
- Supporting evidence (cite specific log clusters and deploy SHAs)
- What you'd check next to confirm or refute it

Output in Markdown format, with hypotheses as numbered ## headings ranked from most to least likely.`,
  maxTurns: 1,
  temperature: 0.2,
}

const postmortemWriterConfig: AgentConfig = {
  name: 'postmortem-writer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a postmortem author. Synthesize a final incident postmortem in Markdown using the log patterns, deploy correlation, blast radius, and root cause hypotheses from the previous tasks (available via shared memory).

Use these top-level sections, in order:
- # Incident Postmortem
- ## Summary
- ## Timeline
- ## Impact
- ## Contributing Factors
- ## Action Items

Keep it tight and factual. Cite specific timestamps, endpoints, and deploy SHAs where they support a claim. Action items should be concrete and assignable.`,
  maxTurns: 1,
  temperature: 0.2,
}

// ---------------------------------------------------------------------------
// Step 2: Task configurations (5 tasks)
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

// Task configs will be created after reading fixture files (see Step 6b)

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
  const t1 = taskStartTimes.get('extract-log-patterns')
  const t2 = taskStartTimes.get('correlate-deploys')
  const t3 = taskStartTimes.get('analyze-blast-radius')

  if (t1 !== undefined && t2 !== undefined && t3 !== undefined) {
    const spread = Math.max(t1, t2, t3) - Math.min(t1, t2, t3)
    console.log('\n=== Parallelism Check ===')
    console.log(`Task 1 (extract-log-patterns) start: ${t1}`)
    console.log(`Task 2 (correlate-deploys) start: ${t2}`)
    console.log(`Task 3 (analyze-blast-radius) start: ${t3}`)
    console.log(`Spread (max - min): ${spread}ms`)

    if (spread >= 500) {
      console.error(
        `ASSERTION FAILED: Tasks 1, 2, 3 start times spread by ${spread}ms (>= 500ms). ` +
          `Expected parallel execution from t=0.`,
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

// Local validation hatch -- flip every agent's provider/model to a free
// OpenRouter model when EXAMPLE_PROVIDER=openrouter. The committed
// AgentConfig values above remain anthropic / claude-sonnet-4-6.
const useOpenRouter = process.env.EXAMPLE_PROVIDER === 'openrouter'
const OPENROUTER_MODEL = 'openrouter/free'

const agentConfigs: AgentConfig[] = [
  logPatternExtractorConfig,
  deployCorrelatorConfig,
  blastRadiusAnalystConfig,
  rootCauseHypothesizerConfig,
  postmortemWriterConfig,
]

const effectiveAgents: AgentConfig[] = useOpenRouter
  ? agentConfigs.map((c) => ({ ...c, provider: 'openai', model: OPENROUTER_MODEL }))
  : agentConfigs

const orchestrator = new OpenMultiAgent({
  defaultModel: useOpenRouter ? OPENROUTER_MODEL : 'claude-sonnet-4-6',
  defaultProvider: useOpenRouter ? 'openai' : 'anthropic',
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('incident-postmortem-team', {
  name: 'incident-postmortem-team',
  agents: effectiveAgents,
  sharedMemory: true,
})

console.log(
  `[mode] provider=${useOpenRouter ? 'openai' : 'anthropic'} ` +
    `model=${useOpenRouter ? OPENROUTER_MODEL : 'claude-sonnet-4-6'}`,
)

// ---------------------------------------------------------------------------
// Step 6: Read fixture files
// ---------------------------------------------------------------------------

const logsText = readFileSync(
  join(__dirname, '..', 'fixtures', 'incident-logs.txt'),
  'utf-8',
)

const deploysText = readFileSync(
  join(__dirname, '..', 'fixtures', 'incident-deploys.json'),
  'utf-8',
)

// ---------------------------------------------------------------------------
// Step 6b: Create task configs with fixture content embedded
// ---------------------------------------------------------------------------

const taskConfigs: TaskConfig[] = [
  {
    title: 'extract-log-patterns',
    description: `Parse the following backend logs and extract structured error patterns.\n\n=== LOGS ===\n${logsText}\n=== END LOGS ===\n\nOutput only valid JSON.`,
    assignee: 'log-pattern-extractor',
  },
  {
    title: 'correlate-deploys',
    description: `Given the recent deploys below, identify which deploy(s) most likely caused the incident symptoms based on timing and changed paths. Symptoms: a sharp regression starting around 14:12 UTC on 2026-04-22, manifesting as 5xx errors. Use the timing alone for now; later tasks will cross-check against logs.\n\n=== DEPLOYS ===\n${deploysText}\n=== END DEPLOYS ===\n\nOutput only valid JSON.`,
    assignee: 'deploy-correlator',
  },
  {
    title: 'analyze-blast-radius',
    description: `Estimate user-facing impact (affected endpoints, approximate failed request count, error rate, severity) from the following logs.\n\n=== LOGS ===\n${logsText}\n=== END LOGS ===\n\nOutput only valid JSON.`,
    assignee: 'blast-radius-analyst',
  },
  {
    title: 'hypothesize-cause',
    description: 'Propose 2-3 ranked root cause hypotheses for the incident, using the log patterns and deploy correlation from the previous tasks. Cite specific log clusters and deploy SHAs.',
    assignee: 'root-cause-hypothesizer',
    dependsOn: ['extract-log-patterns', 'correlate-deploys'],
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoff: 2,
  },
  {
    title: 'write-postmortem',
    description: 'Write the final incident postmortem in Markdown, synthesizing the log patterns, deploy correlation, blast radius, and root cause hypotheses from the previous tasks. Use sections: Summary, Timeline, Impact, Contributing Factors, Action Items.',
    assignee: 'postmortem-writer',
    dependsOn: ['extract-log-patterns', 'correlate-deploys', 'analyze-blast-radius', 'hypothesize-cause'],
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoff: 2,
  },
]

console.log('Incident Postmortem DAG with Parallel Fan-Out')
console.log('='.repeat(60))
console.log(`\nLogs: ${logsText.split('\n').length} lines`)
console.log(`Deploys: ${(JSON.parse(deploysText) as unknown[]).length} entries\n`)

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

    // Cost estimate on claude-sonnet-4-6 -- even when running on OpenRouter,
    // this represents what the same token volume would cost on Anthropic.
    const inputCost = (result.totalTokenUsage.input_tokens / 1_000_000) * 3
    const outputCost = (result.totalTokenUsage.output_tokens / 1_000_000) * 15
    console.log(
      `Estimated cost on claude-sonnet-4-6: ~$${(inputCost + outputCost).toFixed(4)} USD ` +
        `(input @ $3/M, output @ $15/M)`,
    )

    // Output each agent's result
    console.log('\n' + '='.repeat(60))
    console.log('AGENT RESULTS')
    console.log('='.repeat(60))
    for (const [agentName, agentResult] of result.agentResults) {
      console.log(`\n--- ${agentName} ---`)
      console.log(agentResult.success ? agentResult.output : `[FAILED] ${agentResult.output}`)
    }

    if (result.success) {
      console.log('\n--- Final Postmortem ---')
      const writerResult = result.agentResults.get('postmortem-writer')
      const writerOutput = writerResult?.output ?? ''
      if (writerOutput) {
        console.log(writerOutput)
        const outPath = join(tmpdir(), 'incident-postmortem.md')
        writeFileSync(outPath, writerOutput, 'utf-8')
        console.log(`\nPostmortem written to: ${outPath}`)
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
