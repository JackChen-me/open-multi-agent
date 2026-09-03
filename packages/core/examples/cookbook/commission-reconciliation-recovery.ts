/**
 * Commission Reconciliation: Repairable Evidence Recovery
 *
 * Three source-scoped investigators feed an arbiter through runTasks(). Missing
 * temporal evidence fails the initial reconciliation. A named Replanner then
 * appends targeted history lookups and replacement reconciliation/output tasks.
 * All records and rules are synthetic; deterministic adapters replace model
 * calls, not orchestration. No payment is adjusted.
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/commission-reconciliation-recovery.ts --case recovered
 *   npx tsx packages/core/examples/cookbook/commission-reconciliation-recovery.ts --case unresolved
 *
 * Prerequisites:
 *   None. No API key, network request, or Bash is required.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OpenMultiAgent } from '../../src/index.js'
import type {
  AgentConfig,
  AgentRunResult,
  LLMAdapter,
  LLMMessage,
  OrchestratorEvent,
  PlanPatch,
  Replanner,
  RunTaskSpec,
  TaskOutcome,
  TeamRunResult,
} from '../../src/types.js'

const SourceIdSchema = z.string().min(1)
const DateOnlySchema = z.string().date()
const MoneyCentsSchema = z.number().int().nonnegative().safe()
const RateBpsSchema = z.number().int().min(0).max(10_000)
export const COMMISSION_RECOVERY_LIMITS = {
  maxPlanRevisions: 1,
  maxAddedTasks: 4,
} as const
const effectiveRangeShape = {
  effectiveFrom: DateOnlySchema,
  effectiveTo: DateOnlySchema,
}

function orderedRange(range: { effectiveFrom: string, effectiveTo: string }): boolean {
  return range.effectiveFrom <= range.effectiveTo
}

export const EffectiveRangeSchema = z.object(effectiveRangeShape).strict()
  .refine(orderedRange, { message: 'Effective range must be ordered', path: ['effectiveTo'] })

export const ScenarioSchema = z.enum(['recovered', 'unresolved'])
export type Scenario = z.infer<typeof ScenarioSchema>

export const TransactionEvidenceSchema = z.object({
  sourceId: SourceIdSchema,
  policyId: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  productId: z.string().min(1),
  productName: z.string().min(1),
  transactionDate: DateOnlySchema,
  currency: z.literal('USD'),
  premiumCents: MoneyCentsSchema.positive(),
  appliedRateBps: RateBpsSchema,
  paidCommissionCents: MoneyCentsSchema,
}).strict()

// Strict summary schemas deliberately reject history fields instead of silently
// accepting evidence that the first investigation must not possess.
export const PolicySummarySchema = z.object({
  sourceId: SourceIdSchema,
  productId: z.string().min(1),
  rateBps: RateBpsSchema,
}).strict()

export const AgreementSummarySchema = z.object({
  sourceId: SourceIdSchema,
  agreementId: z.string().min(1),
  agentId: z.string().min(1),
  productId: z.string().min(1),
  rateBps: RateBpsSchema,
}).strict()

export const AgreementHistorySchema = z.object({
  ...AgreementSummarySchema.shape,
  ...effectiveRangeShape,
}).strict().refine(orderedRange, {
  message: 'Effective range must be ordered', path: ['effectiveTo'],
})

export const PolicyVersionSchema = z.object({
  ...PolicySummarySchema.shape,
  scheduleVersion: z.string().min(1),
  ...effectiveRangeShape,
}).strict().refine(orderedRange, {
  message: 'Effective range must be ordered', path: ['effectiveTo'],
})

export const InitialEvidenceSchema = z.object({
  transaction: TransactionEvidenceSchema,
  policySummary: PolicySummarySchema,
  agreementSummary: AgreementSummarySchema,
}).strict().refine(({ transaction, policySummary, agreementSummary }) => {
  return transaction.productId === policySummary.productId
    && transaction.productId === agreementSummary.productId
    && transaction.agentId === agreementSummary.agentId
}, { message: 'Initial evidence must concern the same agent and product' })

export const TemporalEvidenceSchema = z.object({
  agreement: AgreementHistorySchema.nullable(),
  policy: PolicyVersionSchema.nullable(),
}).strict()

export const EvidenceGapSchema = z.object({
  status: z.literal('INSUFFICIENT_TEMPORAL_EVIDENCE'),
  policyId: z.string().min(1),
  missing: z.array(z.enum([
    'agreement-effective-range',
    'schedule-version-on-transaction-date',
  ])).nonempty(),
  sourceIds: z.array(SourceIdSchema).nonempty(),
  reason: z.string().min(1),
}).strict()

export const AgreementHistoryLookupSchema = z.object({
  requestedAgreementId: z.string().min(1),
  scenario: ScenarioSchema,
  agreement: AgreementHistorySchema.nullable(),
}).strict().refine(({ requestedAgreementId, agreement }) => {
  return agreement === null || agreement.agreementId === requestedAgreementId
}, { message: 'Agreement lookup returned a record outside the requested scope' })

export const PolicyVersionLookupSchema = z.object({
  requestedProductId: z.string().min(1),
  transactionDate: DateOnlySchema,
  policy: PolicyVersionSchema.nullable(),
}).strict().refine(({ requestedProductId, transactionDate, policy }) => {
  return policy === null
    || (policy.productId === requestedProductId && isEffectiveOn(transactionDate, policy))
}, { message: 'Policy lookup returned a record outside the requested scope' })

const AgreementAgentOutputSchema = z.union([
  AgreementSummarySchema,
  AgreementHistoryLookupSchema,
])
const PolicyAgentOutputSchema = z.union([PolicySummarySchema, PolicyVersionLookupSchema])

export const ReconciliationResultSchema = z.object({
  status: z.literal('RECONCILED'),
  policyId: z.string().min(1),
  currency: z.literal('USD'),
  selectedRule: z.enum(['AGENT_AGREEMENT', 'POLICY_SCHEDULE']),
  selectedRuleId: z.string().min(1),
  selectedRateBps: RateBpsSchema,
  scheduleVersion: z.string().min(1),
  premiumCents: MoneyCentsSchema.positive(),
  paidCommissionCents: MoneyCentsSchema,
  expectedCommissionCents: MoneyCentsSchema,
  varianceCents: z.number().int().safe(),
  disposition: z.enum(['UNDERPAID', 'OVERPAID', 'MATCHED']),
  sourceIds: z.array(SourceIdSchema).nonempty(),
  explanation: z.string().min(1),
}).strict()

export const ManualReviewSchema = z.object({
  status: z.literal('MANUAL_REVIEW_REQUIRED'),
  policyId: z.string().min(1),
  missing: EvidenceGapSchema.shape.missing,
  sourceIds: z.array(SourceIdSchema).nonempty(),
  attemptedPlanRevisions: z.number().int().positive(),
  recoveryLimit: z.object({
    maxPlanRevisions: z.literal(1),
    maxAddedTasks: z.literal(4),
  }).strict(),
  reason: z.string().min(1),
  nextAction: z.string().min(1),
}).strict()

export const ArbiterOutputSchema = z.union([EvidenceGapSchema, ReconciliationResultSchema])

export type InitialEvidence = z.infer<typeof InitialEvidenceSchema>
export type TemporalEvidence = z.infer<typeof TemporalEvidenceSchema>
export type EvidenceGap = z.infer<typeof EvidenceGapSchema>
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>
export type ManualReview = z.infer<typeof ManualReviewSchema>
export type CommissionOutcome = ReconciliationResult | ManualReview

// These objects are separate sources, not a complete record with fields removed
// just before prompting. Only the history lookups below expose validity/version.
const initialFixtures: InitialEvidence = {
  transaction: {
    sourceId: 'transactions:POL-002',
    policyId: 'POL-002',
    agentId: 'AGENT-002',
    agentName: 'Bob Lee',
    productId: 'whole-life-plus',
    productName: 'Whole Life Plus',
    transactionDate: '2026-05-15',
    currency: 'USD',
    premiumCents: 10_000_000,
    appliedRateBps: 500,
    paidCommissionCents: 500_000,
  },
  policySummary: {
    sourceId: 'commission-policy-summary:whole-life-plus',
    productId: 'whole-life-plus',
    rateBps: 500,
  },
  agreementSummary: {
    sourceId: 'agent-agreement-summary:AGREEMENT-002',
    agreementId: 'AGREEMENT-002',
    agentId: 'AGENT-002',
    productId: 'whole-life-plus',
    rateBps: 700,
  },
}

const agreementHistory = {
  sourceId: 'agent-agreement-history:AGREEMENT-002',
  agreementId: 'AGREEMENT-002',
  agentId: 'AGENT-002',
  productId: 'whole-life-plus',
  rateBps: 700,
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-06-30',
} satisfies z.infer<typeof AgreementHistorySchema>

const policyHistory = {
  sourceId: 'commission-policy-history:WLP-2026-v1',
  productId: 'whole-life-plus',
  rateBps: 500,
  scheduleVersion: 'WLP-2026-v1',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
} satisfies z.infer<typeof PolicyVersionSchema>

/** Return a fresh, validated snapshot containing summaries, never history. */
export function readInitialEvidence(): InitialEvidence {
  return InitialEvidenceSchema.parse(initialFixtures)
}

/** A missing archive record is unknown evidence, not proof of no agreement. */
export function lookupAgreementHistory(
  agreementId: string,
  scenario: Scenario,
): z.infer<typeof AgreementHistorySchema> | null {
  ScenarioSchema.parse(scenario)
  if (scenario === 'unresolved' || agreementId !== agreementHistory.agreementId) return null
  return AgreementHistorySchema.parse(agreementHistory)
}

export function lookupPolicyVersion(
  productId: string,
  transactionDate: string,
): z.infer<typeof PolicyVersionSchema> | null {
  const date = DateOnlySchema.parse(transactionDate)
  if (productId !== policyHistory.productId || !isEffectiveOn(date, policyHistory)) return null
  return PolicyVersionSchema.parse(policyHistory)
}

/** Inclusive date-only comparisons avoid timezone-dependent midnight shifts. */
export function isEffectiveOn(
  transactionDate: string,
  range: z.infer<typeof EffectiveRangeSchema>,
): boolean {
  const date = DateOnlySchema.parse(transactionDate)
  // History records also carry provenance, scope, and rates; validate only the
  // explicit range rather than passing those extra fields to a strict schema.
  const { effectiveFrom, effectiveTo } = EffectiveRangeSchema.parse({
    effectiveFrom: range.effectiveFrom,
    effectiveTo: range.effectiveTo,
  })
  return effectiveFrom <= date && date <= effectiveTo
}

/**
 * Check evidence availability only, without choosing a rate or reconciling.
 * An expired agreement supplies known dates; a missing agreement supplies none.
 */
export function diagnoseEvidenceGap(
  input: InitialEvidence,
  history: TemporalEvidence = { agreement: null, policy: null },
): EvidenceGap | undefined {
  const { transaction, agreementSummary, policySummary } = InitialEvidenceSchema.parse(input)
  const { agreement, policy } = TemporalEvidenceSchema.parse(history)
  const missing: EvidenceGap['missing'][number][] = []

  if (!agreement
    || agreement.agreementId !== agreementSummary.agreementId
    || agreement.agentId !== transaction.agentId
    || agreement.productId !== transaction.productId) {
    missing.push('agreement-effective-range')
  }
  if (!policy
    || policy.productId !== transaction.productId
    || !isEffectiveOn(transaction.transactionDate, policy)) {
    missing.push('schedule-version-on-transaction-date')
  }
  if (missing.length === 0) return undefined

  return EvidenceGapSchema.parse({
    status: 'INSUFFICIENT_TEMPORAL_EVIDENCE',
    policyId: transaction.policyId,
    missing,
    sourceIds: [
      transaction.sourceId, policySummary.sourceId, agreementSummary.sourceId,
      ...(agreement ? [agreement.sourceId] : []),
      ...(policy ? [policy.sourceId] : []),
    ],
    reason: 'Cannot select a commission rule without the required temporal evidence.',
  })
}

/** Synthetic rule: round to the nearest cent, with half cents rounded up. */
export function calculateCommissionCents(premiumCents: number, rateBps: number): number {
  const premium = BigInt(MoneyCentsSchema.parse(premiumCents))
  const rate = BigInt(RateBpsSchema.parse(rateBps))
  // BigInt keeps the intermediate multiplication exact for all safe input cents.
  return Number((premium * rate + 5_000n) / 10_000n)
}

/** Apply the synthetic precedence rule only after both temporal records are known. */
export function reconcileEvidence(
  input: InitialEvidence,
  history: TemporalEvidence,
): EvidenceGap | ReconciliationResult {
  const initial = InitialEvidenceSchema.parse(input)
  const temporal = TemporalEvidenceSchema.parse(history)
  const gap = diagnoseEvidenceGap(initial, temporal)
  if (gap) return gap
  const agreement = AgreementHistorySchema.parse(temporal.agreement)
  const policy = PolicyVersionSchema.parse(temporal.policy)
  const agreementApplies = isEffectiveOn(initial.transaction.transactionDate, agreement)
  const selectedRateBps = agreementApplies ? agreement.rateBps : policy.rateBps
  const expectedCommissionCents = calculateCommissionCents(
    initial.transaction.premiumCents,
    selectedRateBps,
  )
  const varianceCents = expectedCommissionCents - initial.transaction.paidCommissionCents
  const disposition = varianceCents > 0
    ? 'UNDERPAID'
    : varianceCents < 0
      ? 'OVERPAID'
      : 'MATCHED'

  return ReconciliationResultSchema.parse({
    status: 'RECONCILED',
    policyId: initial.transaction.policyId,
    currency: initial.transaction.currency,
    selectedRule: agreementApplies ? 'AGENT_AGREEMENT' : 'POLICY_SCHEDULE',
    selectedRuleId: agreementApplies ? agreement.agreementId : policy.scheduleVersion,
    selectedRateBps,
    scheduleVersion: policy.scheduleVersion,
    premiumCents: initial.transaction.premiumCents,
    paidCommissionCents: initial.transaction.paidCommissionCents,
    expectedCommissionCents,
    varianceCents,
    disposition,
    sourceIds: [
      initial.transaction.sourceId,
      initial.policySummary.sourceId,
      initial.agreementSummary.sourceId,
      agreement.sourceId,
      policy.sourceId,
    ],
    explanation: agreementApplies
      ? 'The effective agent agreement overrides the applicable general policy schedule.'
      : 'The agent agreement is not effective on the transaction date; the applicable policy schedule controls.',
  })
}

export const INITIAL_TASK_TITLES = {
  transaction: 'Investigate transaction',
  policy: 'Investigate policy summary',
  agreement: 'Investigate agreement summary',
  reconcile: 'Reconcile initial evidence',
  output: 'Output initial reconciliation',
} as const

export const RECOVERY_TASK_TITLES = {
  agreementHistory: 'Retrieve agreement history',
  policyVersion: 'Retrieve policy version',
  reconcile: 'Reconcile recovered evidence',
  output: 'Output recovered reconciliation',
} as const

const SECONDARY_ARCHIVE_TASK_TITLE = 'Retrieve secondary agreement archive'

function userPrompt(messages: LLMMessage[]): string {
  return [...messages].reverse().find(message => message.role === 'user')?.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n') ?? ''
}

/** Local substitute for a model: compute from the supplied prompt, not call order. */
function syntheticAdapter(respond: (prompt: string) => unknown): LLMAdapter {
  return {
    name: 'synthetic-commission-evidence',
    async chat(messages, options) {
      return {
        id: 'synthetic-response',
        content: [{ type: 'text', text: JSON.stringify(respond(userPrompt(messages))) }],
        model: options.model,
        stop_reason: 'end_turn',
        // Synthetic accounting units, not measured model tokens or API charges.
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream(messages, options) {
      const response = await this.chat(messages, options)
      for (const block of response.content) {
        if (block.type === 'text') yield { type: 'text' as const, data: block.text }
      }
      yield { type: 'done' as const, data: response }
    },
  }
}

function readSourcePrompt(prompt: string): unknown {
  const json = prompt.match(/^## Source evidence\n([^\n]+)$/m)?.[1]
  if (!json) throw new Error('Expected one source-scoped evidence record.')
  return JSON.parse(json)
}

function readRecoveryScenario(prompt: string): Scenario {
  const scenario = prompt.match(/^## Recovery scenario\n([^\n]+)$/m)?.[1]
  if (!scenario) throw new Error('Expected an explicit recovery scenario.')
  return ScenarioSchema.parse(JSON.parse(scenario))
}

/** Read OMA's structured dependency sections; never fall back to hidden fixtures. */
function readStructuredDependency(prompt: string, title: string): unknown {
  const sections = prompt.matchAll(
    /^### (.+) \(by .+\)\n#### Validated structured result\n([^\n]+)$/gm,
  )
  for (const section of sections) {
    if (section[1] === title) return JSON.parse(section[2]!)
  }
  throw new Error(`Missing validated dependency: ${title}`)
}

function agreementAgentResponse(prompt: string): unknown {
  const title = prompt.match(/^# Task: (.+)$/m)?.[1]
  if (title === INITIAL_TASK_TITLES.agreement) return readSourcePrompt(prompt)
  if (title !== RECOVERY_TASK_TITLES.agreementHistory) {
    throw new Error(`Unexpected agreement task: ${title}`)
  }
  const summary = AgreementSummarySchema.parse(
    readStructuredDependency(prompt, INITIAL_TASK_TITLES.agreement),
  )
  const scenario = readRecoveryScenario(prompt)
  return AgreementHistoryLookupSchema.parse({
    requestedAgreementId: summary.agreementId,
    scenario,
    agreement: lookupAgreementHistory(summary.agreementId, scenario),
  })
}

function policyAgentResponse(prompt: string): unknown {
  const title = prompt.match(/^# Task: (.+)$/m)?.[1]
  if (title === INITIAL_TASK_TITLES.policy) return readSourcePrompt(prompt)
  if (title !== RECOVERY_TASK_TITLES.policyVersion) {
    throw new Error(`Unexpected policy task: ${title}`)
  }
  const transaction = TransactionEvidenceSchema.parse(
    readStructuredDependency(prompt, INITIAL_TASK_TITLES.transaction),
  )
  return PolicyVersionLookupSchema.parse({
    requestedProductId: transaction.productId,
    transactionDate: transaction.transactionDate,
    policy: lookupPolicyVersion(transaction.productId, transaction.transactionDate),
  })
}

function readInitialDependencyEvidence(prompt: string): InitialEvidence {
  return InitialEvidenceSchema.parse({
    transaction: readStructuredDependency(prompt, INITIAL_TASK_TITLES.transaction),
    policySummary: readStructuredDependency(prompt, INITIAL_TASK_TITLES.policy),
    agreementSummary: readStructuredDependency(prompt, INITIAL_TASK_TITLES.agreement),
  })
}

function arbiterResponse(prompt: string): unknown {
  const title = prompt.match(/^# Task: (.+)$/m)?.[1]
  if (title === INITIAL_TASK_TITLES.output) {
    return readStructuredDependency(prompt, INITIAL_TASK_TITLES.reconcile)
  }
  if (title === RECOVERY_TASK_TITLES.output) {
    return readStructuredDependency(prompt, RECOVERY_TASK_TITLES.reconcile)
  }
  const evidence = readInitialDependencyEvidence(prompt)
  if (title === INITIAL_TASK_TITLES.reconcile) {
    // No history lookup is available in the first pass. Valid summaries cannot
    // establish agreement applicability or the schedule version on this date.
    return reconcileEvidence(evidence, { agreement: null, policy: null })
  }
  if (title !== RECOVERY_TASK_TITLES.reconcile) {
    throw new Error(`Unexpected arbiter task: ${title}`)
  }
  const agreementLookup = AgreementHistoryLookupSchema.parse(
    readStructuredDependency(prompt, RECOVERY_TASK_TITLES.agreementHistory),
  )
  const policyLookup = PolicyVersionLookupSchema.parse(
    readStructuredDependency(prompt, RECOVERY_TASK_TITLES.policyVersion),
  )
  return reconcileEvidence(evidence, {
    agreement: agreementLookup.agreement,
    policy: policyLookup.policy,
  })
}

function failOnEvidenceGap(result: AgentRunResult): AgentRunResult {
  if (!result.success || !EvidenceGapSchema.safeParse(result.structured).success) return result
  // Valid JSON can still mean business failure. Do not throw: retain structured
  // diagnosis, messages, and usage for the scheduler and the future replanner.
  return { ...result, success: false }
}

function initialAgents(): AgentConfig[] {
  const base = { model: 'synthetic-local', tools: [], maxTurns: 1 } as const
  return [
    {
      ...base,
      name: 'transaction-analyst',
      systemPrompt: 'Return only the supplied synthetic transaction record as JSON.',
      adapter: syntheticAdapter(readSourcePrompt),
      outputSchema: TransactionEvidenceSchema,
    },
    {
      ...base,
      name: 'policy-analyst',
      systemPrompt: 'Return only the supplied policy summary. Do not infer historical versions.',
      adapter: syntheticAdapter(policyAgentResponse),
      outputSchema: PolicyAgentOutputSchema,
    },
    {
      ...base,
      name: 'agreement-analyst',
      systemPrompt: 'Return only the supplied agreement summary. Do not infer effective dates.',
      adapter: syntheticAdapter(agreementAgentResponse),
      outputSchema: AgreementAgentOutputSchema,
    },
    {
      ...base,
      name: 'arbiter',
      systemPrompt: 'Reconcile only validated dependencies. Missing temporal evidence is not a settlement.',
      adapter: syntheticAdapter(arbiterResponse),
      outputSchema: ArbiterOutputSchema,
      afterRun: failOnEvidenceGap,
    },
  ]
}

function initialTasks(evidence: InitialEvidence): RunTaskSpec[] {
  const sourceTask = (title: string, assignee: string, source: unknown): RunTaskSpec => ({
    title,
    assignee,
    description: `Validate this source record without adding information.\n## Source evidence\n${JSON.stringify(source)}`,
    memoryScope: 'dependencies',
    maxRetries: 0,
  })
  return [
    sourceTask(INITIAL_TASK_TITLES.transaction, 'transaction-analyst', evidence.transaction),
    sourceTask(INITIAL_TASK_TITLES.policy, 'policy-analyst', evidence.policySummary),
    sourceTask(INITIAL_TASK_TITLES.agreement, 'agreement-analyst', evidence.agreementSummary),
    {
      title: INITIAL_TASK_TITLES.reconcile,
      description: 'Check whether the direct evidence supports selecting a commission rule. Report any missing temporal evidence without guessing a rate or amount.',
      assignee: 'arbiter',
      dependsOn: [
        INITIAL_TASK_TITLES.transaction, INITIAL_TASK_TITLES.policy, INITIAL_TASK_TITLES.agreement,
      ],
      memoryScope: 'dependencies',
      dependencyPayload: 'structured',
      maxRetries: 0,
    },
    {
      title: INITIAL_TASK_TITLES.output,
      description: 'Render the validated reconciliation result. Never invent a rate or amount.',
      assignee: 'arbiter',
      dependsOn: [INITIAL_TASK_TITLES.reconcile],
      memoryScope: 'dependencies',
      dependencyPayload: 'structured',
      maxRetries: 0,
    },
  ]
}

/** Deterministic policy that reacts only to the initial arbiter's typed evidence gap. */
export class CommissionRecoveryReplanner implements Replanner {
  readonly name = 'commission-temporal-evidence-replanner'
  private readonly scenario: Scenario

  constructor(scenario: Scenario = 'recovered') {
    this.scenario = ScenarioSchema.parse(scenario)
  }

  replan(outcome: TaskOutcome): PlanPatch | undefined {
    if (outcome.kind !== 'failure') return undefined
    const parsed = EvidenceGapSchema.safeParse(outcome.result.structured)
    if (!parsed.success) return undefined

    // A still-insufficient replacement may justify another source in a larger
    // application. This cookbook proposes that forward work so OMA's real
    // revision limit rejects it before graph mutation; the application then
    // fails closed to manual review.
    if (outcome.task.title === RECOVERY_TASK_TITLES.reconcile
      && outcome.planRevision === 1) {
      const priorLookup = outcome.tasks.find(
        task => task.title === RECOVERY_TASK_TITLES.agreementHistory,
      )
      if (!priorLookup) return undefined
      return {
        reason: 'Targeted recovery still lacks agreement dates; a secondary archive search would require another plan revision.',
        addTasks: [{
          key: 'secondary-agreement-archive',
          title: SECONDARY_ARCHIVE_TASK_TITLE,
          description: 'Search a secondary agreement archive before attempting another reconciliation.',
          assignee: 'agreement-analyst',
          dependsOn: [priorLookup.id],
          memoryScope: 'dependencies',
          dependencyPayload: 'structured',
          maxRetries: 0,
        }],
      }
    }

    if (outcome.task.title !== INITIAL_TASK_TITLES.reconcile
      || outcome.planRevision !== 0) return undefined
    const missing = new Set(parsed.data.missing)
    if (!missing.has('agreement-effective-range')
      || !missing.has('schedule-version-on-transaction-date')) return undefined

    const find = (title: string) => outcome.tasks.find(task => task.title === title)
    const transaction = find(INITIAL_TASK_TITLES.transaction)
    const policy = find(INITIAL_TASK_TITLES.policy)
    const agreement = find(INITIAL_TASK_TITLES.agreement)
    const oldOutput = find(INITIAL_TASK_TITLES.output)
    if (!transaction || !policy || !agreement || !oldOutput) return undefined

    return {
      reason: 'Initial reconciliation lacks temporal evidence; retrieve only the required archive records and replace the blocked branch.',
      supersedePending: [oldOutput.id],
      addTasks: [
        {
          key: 'agreement-history',
          title: RECOVERY_TASK_TITLES.agreementHistory,
          description: `Retrieve the requested agreement's dated archive record. A missing record remains unknown evidence.\n## Recovery scenario\n${JSON.stringify(this.scenario)}`,
          assignee: 'agreement-analyst',
          dependsOn: [agreement.id],
          memoryScope: 'dependencies',
          dependencyPayload: 'structured',
          maxRetries: 0,
        },
        {
          key: 'policy-version',
          title: RECOVERY_TASK_TITLES.policyVersion,
          description: 'Retrieve the policy schedule version effective on the supplied transaction date.',
          assignee: 'policy-analyst',
          dependsOn: [transaction.id],
          memoryScope: 'dependencies',
          dependencyPayload: 'structured',
          maxRetries: 0,
        },
        {
          key: 'replacement-reconciliation',
          title: RECOVERY_TASK_TITLES.reconcile,
          description: 'Reconcile from the original validated evidence and the two targeted archive lookup results. Prefer an effective scoped agreement over the general schedule.',
          assignee: 'arbiter',
          dependsOn: [
            transaction.id,
            policy.id,
            agreement.id,
            'agreement-history',
            'policy-version',
          ],
          memoryScope: 'dependencies',
          dependencyPayload: 'structured',
          maxRetries: 0,
        },
        {
          key: 'replacement-output',
          title: RECOVERY_TASK_TITLES.output,
          description: 'Render the validated recovered reconciliation. This synthetic example does not adjust a payment.',
          assignee: 'arbiter',
          dependsOn: ['replacement-reconciliation'],
          memoryScope: 'dependencies',
          dependencyPayload: 'structured',
          maxRetries: 0,
        },
      ],
    }
  }
}

export interface InitialReconciliationOptions {
  readonly evidence?: InitialEvidence
  readonly onProgress?: (event: OrchestratorEvent) => void
}

/** Execute the real fixed DAG; repairable recovery is deliberately not enabled yet. */
export async function runInitialReconciliation(
  options: InitialReconciliationOptions = {},
): Promise<TeamRunResult> {
  const evidence = InitialEvidenceSchema.parse(options.evidence ?? readInitialEvidence())
  const oma = new OpenMultiAgent({
    defaultModel: 'synthetic-local',
    maxConcurrency: 3,
    onProgress: options.onProgress,
  })
  const team = oma.createTeam('commission-reconciliation', {
    name: 'commission-reconciliation',
    agents: initialAgents(),
    sharedMemory: false,
  })
  return oma.runTasks(team, initialTasks(evidence))
}

export interface CommissionReconciliationOptions extends InitialReconciliationOptions {
  readonly scenario?: Scenario
}

/** Execute the repaired happy path with one bounded, four-task plan revision. */
export async function runCommissionReconciliation(
  options: CommissionReconciliationOptions = {},
): Promise<TeamRunResult> {
  const evidence = InitialEvidenceSchema.parse(options.evidence ?? readInitialEvidence())
  const scenario = ScenarioSchema.parse(options.scenario ?? 'recovered')
  const oma = new OpenMultiAgent({
    defaultModel: 'synthetic-local',
    maxConcurrency: 3,
    onProgress: options.onProgress,
  })
  const team = oma.createTeam('commission-reconciliation-recovery', {
    name: 'commission-reconciliation-recovery',
    agents: initialAgents(),
    sharedMemory: false,
  })
  return oma.runTasks(team, initialTasks(evidence), {
    recovery: {
      mode: 'repairable',
      replanner: new CommissionRecoveryReplanner(scenario),
      ...COMMISSION_RECOVERY_LIMITS,
    },
  })
}

/**
 * Map the framework result to the recipe's business terminal state. This runs
 * after orchestration, outside the failed task graph, so manual review cannot
 * be blocked by the reconciliation task it is describing.
 */
export function resolveCommissionOutcome(result: TeamRunResult): CommissionOutcome {
  const recoveredOutput = result.tasks?.find(task => task.title === RECOVERY_TASK_TITLES.output)
  const recovered = recoveredOutput
    ? ReconciliationResultSchema.safeParse(result.taskResults?.get(recoveredOutput.id)?.structured)
    : undefined
  if (result.success && recovered?.success) return recovered.data

  const replacement = result.tasks?.find(task => task.title === RECOVERY_TASK_TITLES.reconcile)
  const gap = replacement
    ? EvidenceGapSchema.safeParse(result.taskResults?.get(replacement.id)?.structured)
    : undefined
  if (!result.success && gap?.success && (result.planRevisions?.length ?? 0) > 0) {
    return ManualReviewSchema.parse({
      status: 'MANUAL_REVIEW_REQUIRED',
      policyId: gap.data.policyId,
      missing: gap.data.missing,
      sourceIds: gap.data.sourceIds,
      attemptedPlanRevisions: result.planRevisions!.length,
      recoveryLimit: COMMISSION_RECOVERY_LIMITS,
      reason: 'Targeted recovery exhausted the configured plan revision limit without establishing sufficient temporal evidence.',
      nextAction: 'Route the evidence package to a human reviewer; do not select a rule or calculate a settlement.',
    })
  }
  throw new Error('Commission run ended without a validated reconciliation or evidence-gap terminal state.')
}

export function commissionExitCode(outcome: CommissionOutcome): 0 | 1 {
  return outcome.status === 'RECONCILED' ? 0 : 1
}

function scenarioFromArgs(args: readonly string[]): Scenario {
  const index = args.indexOf('--case')
  return ScenarioSchema.parse(index === -1 ? 'recovered' : args[index + 1])
}

// Imports are side-effect free so tests exercise the same functions as the demo.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scenario = scenarioFromArgs(process.argv.slice(2))
  const result = await runCommissionReconciliation({ scenario })
  const outcome = resolveCommissionOutcome(result)
  console.log(JSON.stringify({
    stage: 'repairable-recovery',
    case: scenario,
    note: outcome.status === 'RECONCILED'
      ? 'Synthetic reconciliation only; no payment was adjusted.'
      : 'Recovery stopped at its configured bound and failed closed to human review.',
    success: result.success,
    tasks: result.tasks?.map(task => ({
      title: task.title,
      status: task.status,
      executed: result.taskResults?.has(task.id) ?? false,
    })),
    outcome,
    planRevisions: result.planRevisions ?? [],
    syntheticTokenUsage: result.totalTokenUsage,
  }, null, 2))
  process.exitCode = commissionExitCode(outcome)
}
