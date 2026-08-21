/**
 * Binance L2 Market Data Integrity Gate (Per-Task Verify Loop)
 *
 * Demonstrates a provisional market-data decision that must survive two
 * source-specific judges before an interval can enter a backtest:
 *
 *   depth updates ──> depth-sequence-extractor ──┐
 *                                                ├─> integrity-report-proposer
 *   aggregate trades -> trade-activity-extractor ┘              │
 *                                                                v
 *                                            per-task verify, quorum: 2
 *                                        ┌─────────────────────────────┐
 *                                        │ protocol-continuity-judge   │
 *                                        │ backtest-risk-judge         │
 *                                        └─────────────────────────────┘
 *
 * The first report is intentionally provisional: retained depth events are
 * locally continuous, so the proposer emits ACCEPT. Each judge receives a
 * different withheld MOCK source through `judgePrompt: (judge) => string`.
 * They expose a snapshot boundary gap and reconnect risk, forcing a revision
 * to an actionable QUARANTINE report. `quorum: 2` ensures one accepting judge
 * can never short-circuit the other. No `mode` is set because `judgePrompt`
 * replaces the built-in mode instruction.
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/market-data-integrity-verify-loop.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *   Requires Node.js >= 20.
 *
 * Fixtures:
 *   Every file under examples/fixtures/market-data-integrity-verify-loop/ is
 *   MOCK and synthetic. The example makes no exchange or network data request.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OpenMultiAgent } from '../../src/index.js'
import type {
  AgentConfig,
  AgentRunResult,
  ConsensusTrace,
  RunTaskSpec,
  TraceEvent,
} from '../../src/types.js'

// ---------------------------------------------------------------------------
// MOCK fixture loading
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(__dirname, '../fixtures/market-data-integrity-verify-loop')

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureRoot, name), 'utf8')
}

const depthUpdates = readFixture('depth-updates.json')
const aggregateTrades = readFixture('aggregate-trades.json')
const snapshotMetadata = readFixture('snapshot-metadata.json')
const collectorLog = readFixture('collector-log.txt')
const dataQualityPolicy = readFixture('data-quality-policy.md')

const MODEL = process.env['MODEL'] ?? 'claude-sonnet-4-6'
const providerConfig = {
  provider: 'anthropic' as const,
  model: MODEL,
  apiKey: process.env['ANTHROPIC_API_KEY'],
  baseURL: process.env['ANTHROPIC_BASE_URL'],
  tools: [] as const,
}

// ---------------------------------------------------------------------------
// Structured evidence and report contracts
// ---------------------------------------------------------------------------

const DepthSequenceAudit = z.object({
  source_is_mock: z.literal(true),
  symbol: z.string(),
  event_count: z.number().int().nonnegative(),
  first_update_id: z.number().int(),
  final_update_id: z.number().int(),
  retained_sequence_contiguous: z.boolean(),
  crossed_book_observed: z.boolean(),
  invalid_quantity_observed: z.boolean(),
  snapshot_boundary_checked: z.literal(false),
  evidence_limit: z.string(),
})

const TradeActivityAudit = z.object({
  source_is_mock: z.literal(true),
  symbol: z.string(),
  trade_count: z.number().int().nonnegative(),
  first_trade_at: z.string(),
  last_trade_at: z.string(),
  total_quantity: z.number().nonnegative(),
  activity_during_boundary_window: z.boolean(),
  evidence_limit: z.string(),
})

const IntegrityReport = z.object({
  source_is_mock: z.literal(true),
  symbol: z.string(),
  interval: z.object({
    start: z.string(),
    end: z.string(),
  }),
  decision: z.enum(['ACCEPT', 'QUARANTINE', 'REPAIR_REQUIRED']),
  summary: z.string(),
  violated_invariants: z.array(z.object({
    invariant: z.string(),
    source: z.string(),
    evidence: z.string(),
  })),
  affected_ranges: z.array(z.object({
    kind: z.enum(['update_id', 'time']),
    range: z.string(),
    reason: z.string(),
  })),
  supporting_evidence: z.array(z.object({
    source: z.string(),
    finding: z.string(),
  })),
  evidence_limitations: z.array(z.string()),
  recommended_actions: z.array(z.string()),
  revision_notes: z.array(z.string()),
})
type IntegrityReport = z.infer<typeof IntegrityReport>

const JudgeVerdict = z.object({
  accept: z.boolean(),
  critique: z.string(),
})

// Capture both proposer calls to prove that the verify loop changed the
// structured decision rather than merely appending a warning after the fact.
const proposalAttempts: IntegrityReport[] = []

function captureProposal(result: AgentRunResult): AgentRunResult {
  const parsed = IntegrityReport.safeParse(result.structured)
  if (parsed.success) proposalAttempts.push(parsed.data)
  return result
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const depthExtractor: AgentConfig = {
  name: 'depth-sequence-extractor',
  ...providerConfig,
  systemPrompt: `You audit only the provided MOCK Binance-style diff-depth file.
Check continuity between retained events, crossed-book updates, and invalid
quantities. You do not have snapshot metadata, so snapshot_boundary_checked
must be false and you must state that limitation. Return only schema-valid JSON.`,
  outputSchema: DepthSequenceAudit,
  maxTurns: 1,
  maxTokens: 1200,
  temperature: 0,
}

const tradeExtractor: AgentConfig = {
  name: 'trade-activity-extractor',
  ...providerConfig,
  systemPrompt: `You audit only the provided MOCK aggregate-trade file. Report
the event count, time window, summed quantity, and whether trades occurred in
the 2026-08-18T09:30:00.000Z to 09:30:00.210Z boundary window. You cannot infer
depth continuity from trades. Return only schema-valid JSON.`,
  outputSchema: TradeActivityAudit,
  maxTurns: 1,
  maxTokens: 1000,
  temperature: 0,
}

const reportProposer: AgentConfig = {
  name: 'integrity-report-proposer',
  ...providerConfig,
  systemPrompt: `You produce an auditable market-data integrity report.

On the initial call, use only the dependency evidence supplied to the task. If
the retained depth sequence is continuous and contains no direct corruption,
issue a provisional ACCEPT while explicitly listing every unverified boundary
or collector assumption. Do not invent snapshot or reconnect facts.

On a revision call, reviewer critiques are new evidence from source-specific
judges. Address every critique, cite exact source values and affected ranges,
and change the decision when the policy requires it. Preserve each literal
source filename from the critiques in the matching violated_invariants[].source;
in this recipe those filenames are snapshot-metadata.json and collector-log.txt.
A proven boundary gap or an unverified reconnect overlapping active trades must
never remain ACCEPT. Return only schema-valid JSON.`,
  outputSchema: IntegrityReport,
  afterRun: captureProposal,
  maxTurns: 1,
  maxTokens: 2400,
  temperature: 0,
}

const protocolJudge: AgentConfig = {
  name: 'protocol-continuity-judge',
  ...providerConfig,
  systemPrompt: 'You are an independent Binance diff-depth protocol auditor.',
  outputSchema: JudgeVerdict,
  maxTurns: 1,
  maxTokens: 900,
  temperature: 0,
}

const backtestRiskJudge: AgentConfig = {
  name: 'backtest-risk-judge',
  ...providerConfig,
  systemPrompt: 'You are an independent market-data quality and backtest-risk auditor.',
  outputSchema: JudgeVerdict,
  maxTurns: 1,
  maxTokens: 900,
  temperature: 0,
}

const judgeInstructions: Record<string, string> = {
  'protocol-continuity-judge': `Review only snapshot-to-stream continuity using
the MOCK source below. Apply its stated bridge invariant exactly. Reject any
ACCEPT report when the first retained event does not bridge lastUpdateId + 1.
A revised report passes only if it names the exact missing update-ID range,
quarantines the interval, cites the literal filename snapshot-metadata.json in
the matching violated invariant, and recommends rebuilding a verified overlap.
When dissenting, include snapshot-metadata.json verbatim in the critique so the
proposer can preserve it in the revised report.

## Judge-only MOCK source: snapshot-metadata.json
${snapshotMetadata}`,
  'backtest-risk-judge': `Review only backtest contamination risk using the two
MOCK sources below plus the trade activity stated in the proposed report.
Reject any ACCEPT report when a reconnect overlaps active trading and the
collector admits that it skipped the snapshot bridge check. A revised report
passes only if it follows the policy, records the disconnect-to-first-event
window (2026-08-18T09:29:59.940Z to 09:30:00.210Z), and keeps the interval out
of backtests until replacement data is verified. The matching violated
invariant must cite the literal filename collector-log.txt. When dissenting,
include collector-log.txt verbatim in the critique so the proposer can preserve
it in the revised report.

## Judge-only MOCK source: collector-log.txt
${collectorLog}

## Judge-only MOCK source: data-quality-policy.md
${dataQualityPolicy}`,
}

// ---------------------------------------------------------------------------
// Task DAG and verify configuration
// ---------------------------------------------------------------------------

const tasks: RunTaskSpec[] = [
  {
    title: 'extract-depth-sequence',
    description: `Audit this isolated MOCK depth source.\n\n${depthUpdates}`,
    assignee: 'depth-sequence-extractor',
  },
  {
    title: 'extract-trade-activity',
    description: `Audit this isolated MOCK trade source.\n\n${aggregateTrades}`,
    assignee: 'trade-activity-extractor',
  },
  {
    title: 'propose-integrity-report',
    description: `Using only the two structured dependency results, decide
whether the BTCUSDT interval can enter a backtest. Produce the complete
Market Data Integrity Report. This is a provisional thesis: do not assume that
snapshot-boundary or collector-lifecycle evidence was checked unless it appears
in the dependencies.`,
    assignee: 'integrity-report-proposer',
    dependsOn: ['extract-depth-sequence', 'extract-trade-activity'],
    dependencyPayload: 'structured',
    verify: {
      judges: [protocolJudge, backtestRiskJudge],
      quorum: 2,
      maxRounds: 2,
      onDissent: 'revise',
      verdictSchema: JudgeVerdict,
      judgePrompt: (judgeName: string) =>
        judgeInstructions[judgeName] ??
        'Reject because this judge has no source-specific review instruction.',
    },
  },
]

const consensusEvents: ConsensusTrace[] = []

function collectTrace(event: TraceEvent): void {
  if (event.type === 'consensus') consensusEvents.push(event)
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'anthropic',
  defaultModel: MODEL,
  onTrace: collectTrace,
})

const team = orchestrator.createTeam('market-data-integrity-team', {
  name: 'market-data-integrity-team',
  agents: [depthExtractor, tradeExtractor, reportProposer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Execute and prove the intended conflict/revision path
// ---------------------------------------------------------------------------

function expectedPathAssertions(
  report: IntegrityReport,
): Array<{ name: string; pass: boolean }> {
  const roundOneJudges = new Set(
    consensusEvents.filter((event) => event.round === 1).map((event) => event.agent),
  )
  const roundTwoAccepted = new Set(
    consensusEvents
      .filter((event) => event.round === 2 && event.accepted)
      .map((event) => event.agent),
  )
  const missingRangeRecorded = report.affected_ranges.some(
    (item) => item.kind === 'update_id' && item.range.includes('900101') && item.range.includes('900104'),
  )
  const reconnectWindowRecorded = report.affected_ranges.some(
    (item) =>
      item.kind === 'time' &&
      item.range.includes('09:29:59.940') &&
      item.range.includes('09:30:00.210'),
  )
  const evidenceSources = new Set(report.violated_invariants.map((item) => item.source))
  const hasReplacementAction = report.recommended_actions.some((action) =>
    /re-?download|rebuild|replace/i.test(action),
  )

  return [
    {
      name: 'the seeded first proposal is ACCEPT',
      pass: proposalAttempts[0]?.decision === 'ACCEPT',
    },
    {
      name: 'judge dissent revises the proposal to QUARANTINE',
      pass: proposalAttempts.at(-1)?.decision === 'QUARANTINE',
    },
    {
      name: 'both source-specific judges run in round one',
      pass: ['protocol-continuity-judge', 'backtest-risk-judge'].every((judge) =>
        roundOneJudges.has(judge),
      ),
    },
    {
      name: 'both source-specific judges accept the revised report',
      pass: roundTwoAccepted.size === 2,
    },
    {
      name: 'the revised report records the proven 900101-900104 update-ID gap',
      pass: missingRangeRecorded,
    },
    {
      name: 'the revised report records the collector reconnect window',
      pass: reconnectWindowRecorded,
    },
    {
      name: 'the revised report cites snapshot-metadata.json',
      pass: [...evidenceSources].some((source) => source.includes('snapshot-metadata.json')),
    },
    {
      name: 'the revised report cites collector-log.txt',
      pass: [...evidenceSources].some((source) => source.includes('collector-log.txt')),
    },
    {
      name: 'the revised report includes a concrete replacement-data remediation',
      pass: hasReplacementAction,
    },
  ]
}

async function main(): Promise<void> {
  console.log('Binance L2 Market Data Integrity Gate')
  console.log('='.repeat(64))
  console.log('All inputs are MOCK. No exchange connection will be made.\n')

  const result = await orchestrator.runTasks(team, tasks)
  if (!result.success) throw new Error('The market-data integrity workflow failed.')

  const reportTask = result.tasks?.find((task) => task.title === 'propose-integrity-report')
  const reportResult = reportTask ? result.taskResults?.get(reportTask.id) : undefined
  const report = IntegrityReport.parse(reportResult?.structured)

  console.log(`Decision path: ${proposalAttempts.map((item) => item.decision).join(' -> ')}`)
  console.log('\nJudge audit trail:')
  for (const event of consensusEvents) {
    const verdict = event.accepted ? 'ACCEPT' : 'DISSENT'
    console.log(`  round ${event.round} | ${event.agent} | ${verdict}`)
    if (event.dissent) console.log(`    ${event.dissent}`)
  }

  console.log('\nVerified Market Data Integrity Report:')
  console.log(JSON.stringify(report, null, 2))

  console.log('\n## Runtime Assertions\n')
  let hasFailure = false
  for (const assertion of expectedPathAssertions(report)) {
    console.log(`- ${assertion.pass ? 'PASS' : 'FAIL'}: ${assertion.name}`)
    if (!assertion.pass) hasFailure = true
  }

  if (hasFailure) {
    console.error('Runtime assertion failed.')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exitCode = 1
})
