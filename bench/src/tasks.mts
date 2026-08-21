/**
 * The two benchmark tasks, both lifted from `packages/core/examples/cookbook/`.
 *
 * - `contract-review`  — the favourable case: four roles, a real fan-out, and a
 *   compliance review that is independent of the summary it is merged with.
 * - `meeting-report`   — the boundary case: one document in, one report out.
 *   A single competent agent can do it in one pass, so the multi-agent version
 *   pays for four calls and three copies of the transcript to buy parallelism
 *   the task does not obviously need.
 *
 * Group A runs the example's roles through `runTasks()`. Groups B and C run one
 * agent whose system prompt is the same roles concatenated in DAG order, so both
 * groups are asked for the identical deliverable from the identical input.
 */

import { z } from 'zod'
import type { AgentConfig, ModelRoutingPolicy, RunTaskSpec, TeamRunResult } from '../../packages/core/src/index.js'
import type { BenchConfig } from './config.mts'
import { assertLiteral, readFixture, systemPromptOf } from './prompts.mts'

const CONTRACT_EXAMPLE = 'packages/core/examples/cookbook/contract-review-dag.ts'
const MEETING_EXAMPLE = 'packages/core/examples/cookbook/meeting-summarizer.ts'
const CONTRACT_FIXTURE = 'packages/core/examples/fixtures/sample-contract.txt'
const MEETING_FIXTURE = 'packages/core/examples/fixtures/meeting-transcript.txt'

export interface BuildContext {
  readonly runId: string
  readonly config: BenchConfig
  /**
   * Unique per invocation. Run ids are deterministic (`task-group-rN`), so a
   * salt built from the run id alone repeats across invocations and lets a
   * re-run inherit the previous attempt's provider-side prompt cache. The
   * nonce makes every invocation's prompts new.
   */
  readonly nonce?: string
  /**
   * Which wiring of the DAG to build.
   *
   * - `as-published` reproduces the cookbook example exactly.
   * - `fixed-merge` gives the terminal synthesis task access to the source
   *   material, not only to the derived artefacts of the tasks before it.
   *
   * The second exists because the 2026-08-18 run's judge repeatedly faulted
   * group A for a compliance table that contradicted its own risk section — the
   * signature of a merge step with no ground truth to arbitrate against. Both
   * variants are reported; the fix was designed after seeing that result and is
   * labelled as such wherever it appears.
   */
  readonly variant?: DagVariant
}

export type DagVariant = 'as-published' | 'fixed-merge'

export const DAG_VARIANTS: Record<DagVariant, string> = {
  'as-published': 'The cookbook example\'s task graph, unchanged.',
  'fixed-merge':
    'The terminal synthesis task additionally receives the source material: `notify` also depends on '
    + '`extract-clauses`, and `aggregate` carries the transcript in its own description. One wiring change '
    + 'per task, no prompt text altered.',
}

export interface BenchTaskDefinition {
  readonly id: string
  readonly label: string
  /** What this task is in the experiment: the case OMA should win, or the case it might not. */
  readonly hypothesis: 'favourable' | 'boundary'
  readonly sourceExample: string
  readonly fixture: string
  readonly agentCount: number
  readonly deliverable: string
  /** Fixed before any run; quoted verbatim into the judge prompt and REPORT.md. */
  readonly rubric: readonly string[]
  buildTeamAgents(ctx: BuildContext): AgentConfig[]
  buildTasks(ctx: BuildContext): RunTaskSpec[]
  routing(config: BenchConfig): ModelRoutingPolicy
  /** Which model each role actually ran on, for the CSV's per-role model column. */
  roleModels(config: BenchConfig): Record<string, string>
  buildSingleAgent(ctx: BuildContext, model: string): { config: AgentConfig; input: string }
  finalOutput(result: TeamRunResult): string
}

/** Cache-busting prefix; see REPORT.md "Controlled variables". */
function salt(ctx: BuildContext): string {
  if (!ctx.config.cacheBusting) return ''
  return `[bench ${ctx.nonce ? `${ctx.nonce} ` : ''}${ctx.runId}]\n`
}

function agent(ctx: BuildContext, name: string, model: string, systemPrompt: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    model,
    provider: ctx.config.provider,
    systemPrompt: `${salt(ctx)}${systemPrompt}`,
    maxTurns: ctx.config.maxTurns,
    temperature: ctx.config.temperature,
    thinking: ctx.config.thinking,
    ...extra,
  }
}

/**
 * Group B/C prompt: every role's instructions, in DAG order, under its own
 * heading, closed by the terminal role's output spec. No task content is
 * introduced that group A was not also given.
 */
function composeSingleAgentPrompt(
  ctx: BuildContext,
  roles: ReadonlyArray<{ name: string; prompt: string }>,
  deliverable: string,
): string {
  const sections = roles.map((role, index) => `## Role ${index + 1} — ${role.name}\n\n${role.prompt}`)
  return [
    `${salt(ctx)}You are one agent doing, end to end, the work that a ${roles.length}-role pipeline performs.`,
    'Carry out every role below in order, using each role\'s output as the next role\'s input.',
    '',
    ...sections,
    '',
    '## Final deliverable',
    '',
    deliverable,
    '',
    'Emit only the final deliverable. Do not emit the intermediate role outputs.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Task 1 — contract review (favourable)
// ---------------------------------------------------------------------------

const CONTRACT_ROLES = ['extractor', 'compliance-checker', 'summarizer', 'notifier'] as const

const contractReview: BenchTaskDefinition = {
  id: 'contract-review',
  label: 'Contract review DAG',
  hypothesis: 'favourable',
  sourceExample: CONTRACT_EXAMPLE,
  fixture: CONTRACT_FIXTURE,
  agentCount: 4,
  deliverable:
    'A Markdown contract review report with these sections: Executive Summary, '
    + 'Compliance Results, Risk Details, Recommended Actions.',
  rubric: [
    'Clause coverage: every substantive clause in the contract is accounted for somewhere in the report.',
    'Compliance accuracy: compliance verdicts are supported by the contract text, with no invented obligations.',
    'Risk identification: genuinely risky or one-sided terms are named, not just listed neutrally.',
    'Actionability: recommended actions are specific enough for a reviewer to act on.',
    'Structure: the four required sections are present, in order, and populated.',
  ],

  buildTeamAgents(ctx) {
    const strong = ctx.config.models.strong
    return [
      agent(ctx, 'extractor', strong, systemPromptOf(CONTRACT_EXAMPLE, 'extractor')),
      agent(ctx, 'compliance-checker', strong, systemPromptOf(CONTRACT_EXAMPLE, 'compliance-checker')),
      agent(ctx, 'summarizer', strong, systemPromptOf(CONTRACT_EXAMPLE, 'summarizer')),
      agent(ctx, 'notifier', strong, systemPromptOf(CONTRACT_EXAMPLE, 'notifier')),
    ]
  },

  buildTasks(ctx) {
    const contractText = readFixture(CONTRACT_FIXTURE)
    // `fixed-merge` adds extract-clauses as a third dependency of notify, so the
    // report writer can see the clause text its two inputs were derived from.
    const notifyDependsOn = ctx.variant === 'fixed-merge'
      ? ['extract-clauses', 'compliance-check', 'summary']
      : ['compliance-check', 'summary']
    return [
      {
        title: 'extract-clauses',
        description: `Extract all clauses from the following contract text into structured JSON.\n\n=== CONTRACT TEXT ===\n${contractText}\n=== END CONTRACT ===\n\nOutput only valid JSON array.`,
        assignee: 'extractor',
      },
      {
        title: 'compliance-check',
        description: assertLiteral(
          CONTRACT_EXAMPLE,
          'Check each clause for regulatory and operational compliance. Using the clause list from Task 1 above.',
        ),
        assignee: 'compliance-checker',
        dependsOn: ['extract-clauses'],
      },
      {
        title: 'summary',
        description: assertLiteral(
          CONTRACT_EXAMPLE,
          'Generate executive summary of the contract. Using the clause list from Task 1 above.',
        ),
        assignee: 'summarizer',
        dependsOn: ['extract-clauses'],
      },
      {
        title: 'notify',
        description: assertLiteral(
          CONTRACT_EXAMPLE,
          'Generate final markdown report with all analysis results',
        ),
        assignee: 'notifier',
        dependsOn: notifyDependsOn,
      },
    ]
  },

  routing(config) {
    // Deterministic tier policy: mechanical extraction and first-draft prose run
    // on the cheap tier; the judgement call and the final synthesis run on the
    // strong tier. Fixed before any run and never tuned against results.
    return {
      rules: [
        { match: { agent: 'extractor' }, route: { model: config.models.cheap } },
        { match: { agent: 'summarizer' }, route: { model: config.models.cheap } },
        { match: { agent: 'compliance-checker' }, route: { model: config.models.strong } },
        { match: { agent: 'notifier' }, route: { model: config.models.strong } },
      ],
    }
  },

  roleModels(config) {
    return {
      extractor: config.models.cheap,
      'compliance-checker': config.models.strong,
      summarizer: config.models.cheap,
      notifier: config.models.strong,
    }
  },

  buildSingleAgent(ctx, model) {
    const contractText = readFixture(CONTRACT_FIXTURE)
    const roles = CONTRACT_ROLES.map((name) => ({ name, prompt: systemPromptOf(CONTRACT_EXAMPLE, name) }))
    return {
      config: {
        name: 'single-agent',
        model,
        provider: ctx.config.provider,
        systemPrompt: composeSingleAgentPrompt(ctx, roles, contractReview.deliverable),
        maxTurns: ctx.config.maxTurns,
        temperature: ctx.config.temperature,
        thinking: ctx.config.thinking,
      },
      input: `=== CONTRACT TEXT ===\n${contractText}\n=== END CONTRACT ===\n\nGenerate final markdown report with all analysis results`,
    }
  },

  finalOutput(result) {
    return result.agentResults.get('notifier')?.output ?? ''
  },
}

// ---------------------------------------------------------------------------
// Task 2 — meeting report (boundary)
// ---------------------------------------------------------------------------

// Structural re-declaration of the Zod schemas in meeting-summarizer.ts. The
// prompt text still comes from the example; only the schema shape is restated.
const ActionItemList = z.object({
  items: z.array(
    z.object({
      task: z.string().describe('The action to be taken'),
      owner: z.string().describe('Name of the person responsible'),
      due_date: z.string().optional().describe('ISO date or human-readable due date if mentioned'),
    }),
  ),
})

const SentimentReport = z.object({
  participants: z.array(
    z.object({
      participant: z.string().describe('Name as it appears in the transcript'),
      tone: z.enum(['positive', 'neutral', 'negative', 'mixed']),
      evidence: z.string().describe('Direct quote or brief paraphrase supporting the tone'),
    }),
  ),
})

const MEETING_ROLES = ['summary', 'action-items', 'sentiment', 'aggregator'] as const

const meetingReport: BenchTaskDefinition = {
  id: 'meeting-report',
  label: 'Meeting report',
  hypothesis: 'boundary',
  sourceExample: MEETING_EXAMPLE,
  fixture: MEETING_FIXTURE,
  agentCount: 4,
  deliverable:
    'A single Markdown report using exactly these four H2 headings, in order: '
    + '## Summary, ## Action Items, ## Sentiment, ## Next Steps. Under "Action Items" render a '
    + 'Markdown table with columns: Task, Owner, Due. Under "Sentiment" render one bullet per '
    + 'participant. Under "Next Steps" synthesize 3-5 concrete follow-ups grounded in the other sections.',
  rubric: [
    'Structure: exactly the four required H2 headings, in order, with the Action Items table columns as specified.',
    'Action item accuracy: every action item is a concrete task with the correct owner from the transcript; vague intentions are excluded.',
    'Sentiment grounding: each named speaker is classified and the evidence is traceable to the transcript.',
    'Summary faithfulness: the summary reflects what was actually discussed and decided.',
    'No invention: nothing in the report is absent from the transcript.',
  ],

  buildTeamAgents(ctx) {
    const strong = ctx.config.models.strong
    return [
      agent(ctx, 'summary', strong, systemPromptOf(MEETING_EXAMPLE, 'summary')),
      agent(ctx, 'action-items', strong, systemPromptOf(MEETING_EXAMPLE, 'action-items'), { outputSchema: ActionItemList }),
      agent(ctx, 'sentiment', strong, systemPromptOf(MEETING_EXAMPLE, 'sentiment'), { outputSchema: SentimentReport }),
      agent(ctx, 'aggregator', strong, systemPromptOf(MEETING_EXAMPLE, 'aggregator')),
    ]
  },

  buildTasks(ctx) {
    const transcript = readFixture(MEETING_FIXTURE)
    // The example hands the raw transcript to each specialist, so each of the
    // three parallel tasks carries its own copy. That duplication is a real
    // cost of the multi-agent shape, not a harness artefact.
    return [
      { title: 'summary', description: transcript, assignee: 'summary' },
      { title: 'action-items', description: transcript, assignee: 'action-items' },
      { title: 'sentiment', description: transcript, assignee: 'sentiment' },
      {
        title: 'aggregate',
        description: [
          assertLiteral(MEETING_EXAMPLE, 'Merge the three analyses below into a single Markdown report.'),
          ...(ctx.variant === 'fixed-merge'
            ? ['', '=== TRANSCRIPT ===', transcript, '=== END TRANSCRIPT ===']
            : []),
          '',
          assertLiteral(MEETING_EXAMPLE, 'Produce the Markdown report per the system instructions.'),
        ].join('\n'),
        assignee: 'aggregator',
        dependsOn: ['summary', 'action-items', 'sentiment'],
        // Default 'output' payload: the aggregator receives each dependency's
        // text, which for the two schema-bound specialists is their validated
        // JSON — the same thing the example hands it. 'both' would demand a
        // structured result from the prose summary task, which has no schema.
        dependencyPayload: 'output',
      },
    ]
  },

  routing(config) {
    return {
      rules: [
        { match: { agent: 'summary' }, route: { model: config.models.cheap } },
        { match: { agent: 'action-items' }, route: { model: config.models.cheap } },
        { match: { agent: 'sentiment' }, route: { model: config.models.cheap } },
        { match: { agent: 'aggregator' }, route: { model: config.models.strong } },
      ],
    }
  },

  roleModels(config) {
    return {
      summary: config.models.cheap,
      'action-items': config.models.cheap,
      sentiment: config.models.cheap,
      aggregator: config.models.strong,
    }
  },

  buildSingleAgent(ctx, model) {
    const transcript = readFixture(MEETING_FIXTURE)
    const roles = MEETING_ROLES.map((name) => ({ name, prompt: systemPromptOf(MEETING_EXAMPLE, name) }))
    return {
      config: {
        name: 'single-agent',
        model,
        provider: ctx.config.provider,
        systemPrompt: composeSingleAgentPrompt(ctx, roles, meetingReport.deliverable),
        maxTurns: ctx.config.maxTurns,
        temperature: ctx.config.temperature,
        thinking: ctx.config.thinking,
      },
      input: `${transcript}\n\nProduce the Markdown report per the system instructions.`,
    }
  },

  finalOutput(result) {
    return result.agentResults.get('aggregator')?.output ?? ''
  },
}

export const BENCH_TASKS: Readonly<Record<string, BenchTaskDefinition>> = {
  'contract-review': contractReview,
  'meeting-report': meetingReport,
}

export function taskById(id: string): BenchTaskDefinition {
  const task = BENCH_TASKS[id]
  if (!task) throw new Error(`bench: unknown task "${id}". Known: ${Object.keys(BENCH_TASKS).join(', ')}`)
  return task
}
