import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/agent/agent.js'
import type { OrchestratorEvent, TeamRunResult } from '../src/types.js'
import {
  AgreementHistoryLookupSchema,
  AgreementHistorySchema,
  AgreementSummarySchema,
  COMMISSION_RECOVERY_LIMITS,
  CommissionRecoveryReplanner,
  EvidenceGapSchema,
  InitialEvidenceSchema,
  INITIAL_TASK_TITLES,
  ManualReviewSchema,
  PolicyVersionLookupSchema,
  PolicySummarySchema,
  PolicyVersionSchema,
  RECOVERY_TASK_TITLES,
  ReconciliationResultSchema,
  TransactionEvidenceSchema,
  calculateCommissionCents,
  commissionExitCode,
  diagnoseEvidenceGap,
  isEffectiveOn,
  lookupAgreementHistory,
  lookupPolicyVersion,
  readInitialEvidence,
  reconcileEvidence,
  resolveCommissionOutcome,
  runCommissionReconciliation,
  runInitialReconciliation,
} from '../examples/cookbook/commission-reconciliation-recovery.js'

function recoveredEvidence() {
  const { transaction, agreementSummary } = readInitialEvidence()
  return {
    agreement: AgreementHistorySchema.parse(
      lookupAgreementHistory(agreementSummary.agreementId, 'recovered'),
    ),
    policy: PolicyVersionSchema.parse(
      lookupPolicyVersion(transaction.productId, transaction.transactionDate),
    ),
  }
}

describe('commission reconciliation evidence foundation', () => {
  it('exposes conflicting summary rates but no temporal history on the first pass', () => {
    const initial = readInitialEvidence()
    expect(initial.transaction).toMatchObject({
      policyId: 'POL-002',
      transactionDate: '2026-05-15',
      premiumCents: 10_000_000,
      paidCommissionCents: 500_000,
    })
    expect(initial.policySummary.rateBps).toBe(500)
    expect(initial.agreementSummary.rateBps).toBe(700)
    expect(JSON.stringify(initial)).not.toMatch(/effectiveFrom|effectiveTo|scheduleVersion/)
    expect(diagnoseEvidenceGap(initial)).toMatchObject({
      status: 'INSUFFICIENT_TEMPORAL_EVIDENCE',
      policyId: 'POL-002',
      missing: ['agreement-effective-range', 'schedule-version-on-transaction-date'],
      sourceIds: [
        initial.transaction.sourceId,
        initial.policySummary.sourceId,
        initial.agreementSummary.sourceId,
      ],
    })
  })

  it('rejects temporal fields smuggled into a summary payload', () => {
    const initial = readInitialEvidence()
    expect(AgreementSummarySchema.safeParse({
      ...initial.agreementSummary, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30',
    }).success).toBe(false)
    expect(PolicySummarySchema.safeParse({
      ...initial.policySummary, scheduleVersion: 'WLP-2026-v1',
    }).success).toBe(false)
    expect(InitialEvidenceSchema.safeParse({ ...initial, history: recoveredEvidence() }).success)
      .toBe(false)
  })

  it('only obtains historical scope and dates through the targeted lookups', () => {
    const initial = readInitialEvidence()
    const history = recoveredEvidence()
    expect(history.agreement).toMatchObject({
      effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', rateBps: 700,
    })
    expect(history.policy).toMatchObject({ scheduleVersion: 'WLP-2026-v1', rateBps: 500 })
    expect(history.agreement.sourceId).not.toBe(initial.agreementSummary.sourceId)
    expect(history.policy.sourceId).not.toBe(initial.policySummary.sourceId)
    expect(isEffectiveOn(initial.transaction.transactionDate, history.agreement)).toBe(true)
    expect(diagnoseEvidenceGap(initial, history)).toBeUndefined()
    expect(diagnoseEvidenceGap(readInitialEvidence())?.missing).toHaveLength(2)
  })

  it('keeps the unresolved case insufficient even when the schedule is recovered', () => {
    const initial = readInitialEvidence()
    const policy = recoveredEvidence().policy
    const agreement = lookupAgreementHistory(initial.agreementSummary.agreementId, 'unresolved')
    expect(agreement).toBeNull()
    expect(diagnoseEvidenceGap(initial, { agreement, policy })).toMatchObject({
      status: 'INSUFFICIENT_TEMPORAL_EVIDENCE', missing: ['agreement-effective-range'],
    })
  })

  it('does not mutate fixtures or leak history through a previous lookup', () => {
    const first = readInitialEvidence()
    first.policySummary.rateBps = 9_999
    const history = recoveredEvidence()
    history.agreement.effectiveFrom = '1900-01-01'
    history.policy.scheduleVersion = 'changed'
    expect(readInitialEvidence().policySummary.rateBps).toBe(500)
    expect(recoveredEvidence().agreement.effectiveFrom).toBe('2026-01-01')
    expect(recoveredEvidence().policy.scheduleVersion).toBe('WLP-2026-v1')
    expect(lookupAgreementHistory('AGREEMENT-002', 'unresolved')).toBeNull()
  })

  it('returns no record for unknown agreements, products, or uncovered dates', () => {
    expect(lookupAgreementHistory('unknown-agreement', 'recovered')).toBeNull()
    expect(lookupPolicyVersion('unknown-product', '2026-05-15')).toBeNull()
    expect(lookupPolicyVersion('whole-life-plus', '2025-12-31')).toBeNull()
    expect(lookupPolicyVersion('whole-life-plus', '2027-01-01')).toBeNull()
  })

  it.each(['agreementId', 'agentId', 'productId'] as const)(
    'does not accept agreement history for a different %s', (field) => {
      const history = recoveredEvidence()
      history.agreement[field] = 'unrelated'
      expect(diagnoseEvidenceGap(readInitialEvidence(), history)?.missing)
        .toEqual(['agreement-effective-range'])
    },
  )

  it('does not accept a schedule for a different product or transaction date', () => {
    const history = recoveredEvidence()
    history.policy.productId = 'unrelated'
    expect(diagnoseEvidenceGap(readInitialEvidence(), history)?.missing)
      .toEqual(['schedule-version-on-transaction-date'])
    history.policy.productId = 'whole-life-plus'
    history.policy.effectiveFrom = '2026-06-01'
    expect(diagnoseEvidenceGap(readInitialEvidence(), history)?.missing)
      .toEqual(['schedule-version-on-transaction-date'])
  })

  it('distinguishes a known expired agreement from missing agreement dates', () => {
    const initial = readInitialEvidence()
    initial.transaction.transactionDate = '2026-07-01'
    const history = recoveredEvidence()
    expect(isEffectiveOn(initial.transaction.transactionDate, history.agreement)).toBe(false)
    // No rate is chosen here: the next stage must arbitrate using these known dates.
    expect(diagnoseEvidenceGap(initial, history)).toBeUndefined()
  })

  it('rejects mismatched initial scope and missing source provenance', () => {
    const initial = readInitialEvidence()
    expect(InitialEvidenceSchema.safeParse({
      ...initial, agreementSummary: { ...initial.agreementSummary, agentId: 'someone-else' },
    }).success).toBe(false)
    expect(TransactionEvidenceSchema.safeParse({ ...initial.transaction, sourceId: '' }).success)
      .toBe(false)
    expect(PolicyVersionSchema.safeParse({ ...recoveredEvidence().policy, scheduleVersion: '' }).success)
      .toBe(false)
  })

  it('does not allow a winning rate or amount in an insufficient-evidence result', () => {
    const gap = diagnoseEvidenceGap(readInitialEvidence())!
    expect(EvidenceGapSchema.safeParse(gap).success).toBe(true)
    expect(EvidenceGapSchema.safeParse({ ...gap, missing: [] }).success).toBe(false)
    expect(EvidenceGapSchema.safeParse({ ...gap, expectedRateBps: 700 }).success).toBe(false)
    expect(EvidenceGapSchema.safeParse({ ...gap, expectedCommissionCents: 700_000 }).success)
      .toBe(false)
  })
})

describe('synthetic commission date and money conventions', () => {
  it.each([
    ['2025-12-31', false], ['2026-01-01', true], ['2026-05-15', true],
    ['2026-06-30', true], ['2026-07-01', false],
  ] as const)('checks inclusive agreement applicability on %s', (date, expected) => {
    expect(isEffectiveOn(date, recoveredEvidence().agreement)).toBe(expected)
  })

  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-5-15', '2026-05-15T00:00:00Z'])(
    'rejects invalid or non-date-only input %s', (date) => {
      expect(() => isEffectiveOn(date, recoveredEvidence().agreement)).toThrow()
      expect(() => lookupPolicyVersion('whole-life-plus', date)).toThrow()
      expect(TransactionEvidenceSchema.safeParse({
        ...readInitialEvidence().transaction, transactionDate: date,
      }).success).toBe(false)
    },
  )

  it('accepts leap days and rejects reversed validity ranges', () => {
    expect(isEffectiveOn('2024-02-29', {
      effectiveFrom: '2024-02-01', effectiveTo: '2024-02-29',
    })).toBe(true)
    expect(() => isEffectiveOn('2026-05-15', {
      effectiveFrom: '2026-06-30', effectiveTo: '2026-01-01',
    })).toThrow()
    expect(AgreementHistorySchema.safeParse({
      ...recoveredEvidence().agreement, effectiveFrom: '2026-07-01',
    }).success).toBe(false)
  })

  it.each([
    [10_000_000, 700, 700_000], [10_000_000, 500, 500_000],
    [1, 5_000, 1], [1, 4_999, 0], [0, 700, 0],
    [Number.MAX_SAFE_INTEGER, 10_000, Number.MAX_SAFE_INTEGER],
  ])('calculates %s cents at %s basis points as %s cents', (premium, rate, expected) => {
    expect(calculateCommissionCents(premium, rate)).toBe(expected)
  })

  it.each([
    [-1, 700], [1.5, 700], [Number.MAX_SAFE_INTEGER + 1, 700], [Number.NaN, 700],
    [100, -1], [100, 10_001], [100, 0.5], [100, Number.POSITIVE_INFINITY],
  ])('rejects invalid cents/rate inputs (%s, %s)', (premium, rate) => {
    expect(() => calculateCommissionCents(premium, rate)).toThrow()
  })
})

function taskByTitle(result: TeamRunResult, title: string) {
  const task = result.tasks?.find(task => task.title === title)
  if (!task) throw new Error(`Missing task: ${title}`)
  return task
}

function taskResult(result: TeamRunResult, title: string) {
  const task = taskByTitle(result, title)
  const run = result.taskResults?.get(task.id)
  if (!run) throw new Error(`Task did not run: ${title}`)
  return run
}

describe('commission reconciliation initial DAG', () => {
  it('runs three investigations before reconciliation and never dispatches downstream output', async () => {
    const events: OrchestratorEvent[] = []
    const result = await runInitialReconciliation({ onProgress: event => { events.push(event) } })
    const sources = [
      INITIAL_TASK_TITLES.transaction, INITIAL_TASK_TITLES.policy, INITIAL_TASK_TITLES.agreement,
    ].map(title => taskByTitle(result, title))
    const reconciliation = taskByTitle(result, INITIAL_TASK_TITLES.reconcile)
    const output = taskByTitle(result, INITIAL_TASK_TITLES.output)

    expect(result.success).toBe(false)
    expect(result.tasks).toHaveLength(5)
    expect(new Set(result.tasks?.map(task => task.assignee)).size).toBe(4)
    expect(sources.map(task => task.status)).toEqual(['completed', 'completed', 'completed'])
    expect(reconciliation).toMatchObject({
      status: 'failed',
      dependsOn: sources.map(task => task.id),
      dependencyPayload: 'structured',
      memoryScope: 'dependencies',
      maxRetries: 0,
      metrics: { retries: 0 },
    })
    // Fixed-DAG failure cascades to dependents as failed, not skipped; no output
    // agent ran. A later repair patch will explicitly supersede the old output.
    expect(output).toMatchObject({ status: 'failed', dependsOn: [reconciliation.id] })
    expect(result.taskResults?.size).toBe(4)
    expect(result.taskResults?.has(output.id)).toBe(false)
    expect(result.planRevisions ?? []).toEqual([])
    expect(result.tasks?.every(task => task.recoveredByRevision === undefined
      && task.supersededByRevision === undefined)).toBe(true)

    const reconciliationStart = events.findIndex(event =>
      event.type === 'task_start' && event.task === reconciliation.id)
    expect(reconciliationStart).toBeGreaterThan(-1)
    for (const source of sources) {
      const complete = events.findIndex(event => event.type === 'task_complete' && event.task === source.id)
      expect(complete).toBeGreaterThan(-1)
      expect(complete).toBeLessThan(reconciliationStart)
    }
    expect(events.filter(event => event.type === 'task_start')).toHaveLength(4)
    expect(events.some(event => event.type === 'task_start' && event.task === output.id)).toBe(false)
    expect(events.some(event => event.type === 'task_retry' || event.type === 'plan_revision')).toBe(false)
  })

  it('preserves the valid diagnosis, generated messages, and usage when afterRun marks business failure', async () => {
    const result = await runInitialReconciliation()
    const reconciliation = taskResult(result, INITIAL_TASK_TITLES.reconcile)
    expect(reconciliation.success).toBe(false)
    expect(reconciliation.status?.code).toBe('error')
    expect(reconciliation.error).toBeUndefined()
    expect(EvidenceGapSchema.parse(reconciliation.structured))
      .toEqual(diagnoseEvidenceGap(readInitialEvidence()))
    expect(JSON.parse(reconciliation.output)).toEqual(reconciliation.structured)
    expect(reconciliation.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(reconciliation.messages[0]?.content).toEqual([{ type: 'text', text: reconciliation.output }])
    expect(reconciliation.tokenUsage).toEqual({ input_tokens: 1, output_tokens: 1 })
    expect(result.totalTokenUsage).toEqual({ input_tokens: 4, output_tokens: 4 })
    expect(reconciliation.structured).not.toHaveProperty('expectedRateBps')
    expect(reconciliation.structured).not.toHaveProperty('expectedCommissionCents')
    expect([...result.taskResults!.values()].every(run => run.toolCalls.length === 0)).toBe(true)
  })

  it('isolates root prompts and hands the arbiter only validated direct-dependency evidence', async () => {
    const initial = readInitialEvidence()
    // Even a prior archive lookup must not leak into any first-pass agent.
    recoveredEvidence()
    // Observe the real Agent.run inputs without mocking its implementation.
    // AgentRunResult.messages contains generated messages, not the input prompt.
    const runs = vi.spyOn(Agent.prototype, 'run')
    try {
      const result = await runInitialReconciliation()
      const prompts = runs.mock.calls.map(([input]) => input)
        .filter((input): input is string => typeof input === 'string')
      expect(prompts).toHaveLength(4)
      const promptFor = (title: string): string => {
        const prompt = prompts.find(prompt => prompt.startsWith(`# Task: ${title}\n`))
        if (!prompt) throw new Error(`No agent input for ${title}`)
        return prompt
      }
      const sources = [
        [INITIAL_TASK_TITLES.transaction, initial.transaction],
        [INITIAL_TASK_TITLES.policy, initial.policySummary],
        [INITIAL_TASK_TITLES.agreement, initial.agreementSummary],
      ] as const

      for (const [title, evidence] of sources) {
        const run = taskResult(result, title)
        expect(run.success).toBe(true)
        expect(run.structured).toEqual(evidence)
        const prompt = promptFor(title)
        expect(prompt).toContain(evidence.sourceId)
        for (const [, other] of sources) {
          if (other.sourceId !== evidence.sourceId) expect(prompt).not.toContain(other.sourceId)
        }
        expect(prompt).not.toMatch(/effectiveFrom|effectiveTo|scheduleVersion|WLP-2026-v1/)
      }
      const prompt = promptFor(INITIAL_TASK_TITLES.reconcile)
      expect(prompt.match(/#### Validated structured result/g)).toHaveLength(3)
      expect(prompt).not.toContain('#### Raw output')
      expect(prompt).not.toMatch(/effectiveFrom|effectiveTo|scheduleVersion|WLP-2026-v1/)
      for (const [, evidence] of sources) expect(prompt).toContain(evidence.sourceId)
    } finally {
      runs.mockRestore()
    }
  })

  it('derives its diagnosis from supplied evidence even when summary rates agree', async () => {
    const evidence = readInitialEvidence()
    evidence.transaction.policyId = 'POL-OTHER'
    evidence.transaction.sourceId = 'transactions:POL-OTHER'
    evidence.transaction.premiumCents = 2_000_000
    evidence.policySummary.sourceId = 'policy-summary:other'
    evidence.agreementSummary.sourceId = 'agreement-summary:other'
    evidence.agreementSummary.rateBps = evidence.policySummary.rateBps

    const result = await runInitialReconciliation({ evidence })
    const gap = taskResult(result, INITIAL_TASK_TITLES.reconcile).structured
    expect(gap).toEqual(diagnoseEvidenceGap(evidence))
    expect(gap).toMatchObject({ policyId: 'POL-OTHER' })
    expect(JSON.stringify(gap)).not.toContain('POL-002')
    expect(taskResult(result, INITIAL_TASK_TITLES.transaction).structured).toEqual(evidence.transaction)
    expect(taskResult(result, INITIAL_TASK_TITLES.agreement).structured).toEqual(evidence.agreementSummary)
  })

  it('rejects history injected into first-pass input before dispatch', async () => {
    const initial = readInitialEvidence()
    const evidence = {
      ...initial,
      policySummary: { ...initial.policySummary, scheduleVersion: 'hidden-version' },
    }
    const onProgress = vi.fn()
    await expect(runInitialReconciliation({ evidence, onProgress })).rejects.toThrow()
    expect(onProgress).not.toHaveBeenCalled()
  })
})

describe('commission reconciliation repairable happy path', () => {
  it('applies one four-task revision and preserves truthful original history', async () => {
    const events: OrchestratorEvent[] = []
    const result = await runCommissionReconciliation({
      scenario: 'recovered',
      onProgress: event => { events.push(event) },
    })
    const initialReconciliation = taskByTitle(result, INITIAL_TASK_TITLES.reconcile)
    const oldOutput = taskByTitle(result, INITIAL_TASK_TITLES.output)
    const agreementLookup = taskByTitle(result, RECOVERY_TASK_TITLES.agreementHistory)
    const policyLookup = taskByTitle(result, RECOVERY_TASK_TITLES.policyVersion)
    const replacement = taskByTitle(result, RECOVERY_TASK_TITLES.reconcile)
    const output = taskByTitle(result, RECOVERY_TASK_TITLES.output)

    expect(result.success).toBe(true)
    expect(result.tasks).toHaveLength(9)
    expect(result.taskResults?.size).toBe(8)
    expect(initialReconciliation).toMatchObject({
      status: 'failed', recoveredByRevision: 1, metrics: { retries: 0 },
    })
    expect(EvidenceGapSchema.safeParse(
      result.taskResults?.get(initialReconciliation.id)?.structured,
    ).success).toBe(true)
    expect(oldOutput).toMatchObject({ status: 'skipped', supersededByRevision: 1 })
    expect(result.taskResults?.has(oldOutput.id)).toBe(false)
    for (const task of [agreementLookup, policyLookup, replacement, output]) {
      expect(task).toMatchObject({ status: 'completed', maxRetries: 0 })
    }

    expect(result.planRevisions).toHaveLength(1)
    const revision = result.planRevisions![0]!
    expect(revision).toMatchObject({
      version: 1,
      trigger: 'failure',
      triggerTaskId: initialReconciliation.id,
      supersededTaskIds: [oldOutput.id],
      retargetedTasks: [],
    })
    expect(revision.addedTasks).toEqual({
      'agreement-history': agreementLookup.id,
      'policy-version': policyLookup.id,
      'replacement-reconciliation': replacement.id,
      'replacement-output': output.id,
    })
    expect(agreementLookup.dependsOn).toEqual([
      taskByTitle(result, INITIAL_TASK_TITLES.agreement).id,
    ])
    expect(policyLookup.dependsOn).toEqual([
      taskByTitle(result, INITIAL_TASK_TITLES.transaction).id,
    ])
    expect(replacement.dependsOn).toEqual([
      taskByTitle(result, INITIAL_TASK_TITLES.transaction).id,
      taskByTitle(result, INITIAL_TASK_TITLES.policy).id,
      taskByTitle(result, INITIAL_TASK_TITLES.agreement).id,
      agreementLookup.id,
      policyLookup.id,
    ])
    expect(output.dependsOn).toEqual([replacement.id])

    const planRevisionEvent = events.findIndex(event => event.type === 'plan_revision')
    const firstHistoryStart = events.findIndex(event =>
      event.type === 'task_start'
      && (event.task === agreementLookup.id || event.task === policyLookup.id))
    expect(planRevisionEvent).toBeGreaterThan(-1)
    expect(firstHistoryStart).toBeGreaterThan(planRevisionEvent)
    expect(events.filter(event => event.type === 'plan_revision')).toHaveLength(1)
    expect(events.some(event => event.type === 'task_retry')).toBe(false)
  })

  it('produces the expected agreement override without performing a payment', async () => {
    const result = await runCommissionReconciliation({ scenario: 'recovered' })
    const replacement = ReconciliationResultSchema.parse(
      taskResult(result, RECOVERY_TASK_TITLES.reconcile).structured,
    )
    const output = ReconciliationResultSchema.parse(
      taskResult(result, RECOVERY_TASK_TITLES.output).structured,
    )
    expect(output).toEqual(replacement)
    expect(output).toMatchObject({
      status: 'RECONCILED',
      policyId: 'POL-002',
      selectedRule: 'AGENT_AGREEMENT',
      selectedRuleId: 'AGREEMENT-002',
      selectedRateBps: 700,
      scheduleVersion: 'WLP-2026-v1',
      premiumCents: 10_000_000,
      paidCommissionCents: 500_000,
      expectedCommissionCents: 700_000,
      varianceCents: 200_000,
      disposition: 'UNDERPAID',
    })
    expect(output.sourceIds).toHaveLength(5)
    expect(new Set(output.sourceIds).size).toBe(5)
    expect(output).not.toHaveProperty('paymentAdjusted')
    expect(output).not.toHaveProperty('paymentId')
    expect(result.totalTokenUsage).toEqual({ input_tokens: 8, output_tokens: 8 })
  })

  it('uses the named replanner only at outcome barriers and reacts to the typed initial gap', async () => {
    const replan = vi.spyOn(CommissionRecoveryReplanner.prototype, 'replan')
    try {
      const result = await runCommissionReconciliation({ scenario: 'recovered' })
      expect(new CommissionRecoveryReplanner().name)
        .toBe('commission-temporal-evidence-replanner')
      expect(result.success).toBe(true)
      const triggeringCall = replan.mock.calls.find(([outcome]) =>
        outcome.kind === 'failure' && outcome.task.title === INITIAL_TASK_TITLES.reconcile)
      expect(triggeringCall).toBeDefined()
      expect(EvidenceGapSchema.safeParse(triggeringCall?.[0].result.structured).success).toBe(true)
      expect(replan.mock.calls.some(([outcome]) =>
        outcome.task.title === RECOVERY_TASK_TITLES.reconcile
        && outcome.kind === 'success'
        && outcome.planRevision === 1)).toBe(true)
    } finally {
      replan.mockRestore()
    }
  })

  it('runs targeted archive queries and gives replacement reconciliation only direct evidence', async () => {
    const initial = readInitialEvidence()
    const runs = vi.spyOn(Agent.prototype, 'run')
    try {
      const result = await runCommissionReconciliation({ scenario: 'recovered' })
      const prompts = runs.mock.calls.map(([input]) => input)
        .filter((input): input is string => typeof input === 'string')
      expect(prompts).toHaveLength(8)
      const promptFor = (title: string): string => {
        const prompt = prompts.find(prompt => prompt.startsWith(`# Task: ${title}\n`))
        if (!prompt) throw new Error(`No agent input for ${title}`)
        return prompt
      }

      const initialPrompt = promptFor(INITIAL_TASK_TITLES.reconcile)
      expect(initialPrompt).not.toMatch(/effectiveFrom|effectiveTo|scheduleVersion|WLP-2026-v1/)
      const agreementPrompt = promptFor(RECOVERY_TASK_TITLES.agreementHistory)
      expect(agreementPrompt).toContain(initial.agreementSummary.sourceId)
      expect(agreementPrompt).toContain('## Recovery scenario\n"recovered"')
      expect(agreementPrompt).not.toContain(initial.transaction.sourceId)
      expect(agreementPrompt).not.toContain(initial.policySummary.sourceId)
      const policyPrompt = promptFor(RECOVERY_TASK_TITLES.policyVersion)
      expect(policyPrompt).toContain(initial.transaction.sourceId)
      expect(policyPrompt).not.toContain(initial.policySummary.sourceId)
      expect(policyPrompt).not.toContain(initial.agreementSummary.sourceId)

      const agreement = AgreementHistoryLookupSchema.parse(
        taskResult(result, RECOVERY_TASK_TITLES.agreementHistory).structured,
      )
      const policy = PolicyVersionLookupSchema.parse(
        taskResult(result, RECOVERY_TASK_TITLES.policyVersion).structured,
      )
      const replacementPrompt = promptFor(RECOVERY_TASK_TITLES.reconcile)
      expect(replacementPrompt.match(/#### Validated structured result/g)).toHaveLength(5)
      expect(replacementPrompt).not.toContain('#### Raw output')
      for (const sourceId of [
        initial.transaction.sourceId,
        initial.policySummary.sourceId,
        initial.agreementSummary.sourceId,
        agreement.agreement!.sourceId,
        policy.policy!.sourceId,
      ]) expect(replacementPrompt).toContain(sourceId)
    } finally {
      runs.mockRestore()
    }
  })

  it('derives recovered amounts from caller evidence instead of a fixed expected answer', async () => {
    const evidence = readInitialEvidence()
    evidence.transaction.premiumCents = 2_000_000
    evidence.transaction.paidCommissionCents = 60_000
    evidence.transaction.sourceId = 'transactions:POL-002:adjusted-fixture'
    const result = await runCommissionReconciliation({ evidence, scenario: 'recovered' })
    expect(ReconciliationResultSchema.parse(
      taskResult(result, RECOVERY_TASK_TITLES.output).structured,
    )).toMatchObject({
      premiumCents: 2_000_000,
      paidCommissionCents: 60_000,
      expectedCommissionCents: 140_000,
      varianceCents: 80_000,
      disposition: 'UNDERPAID',
      sourceIds: expect.arrayContaining(['transactions:POL-002:adjusted-fixture']),
    })
  })

  it('falls back to the dated policy schedule when the known agreement is expired', () => {
    const initial = readInitialEvidence()
    initial.transaction.transactionDate = '2026-07-01'
    const history = recoveredEvidence()
    const result = ReconciliationResultSchema.parse(reconcileEvidence(initial, history))
    expect(result).toMatchObject({
      selectedRule: 'POLICY_SCHEDULE',
      selectedRuleId: 'WLP-2026-v1',
      selectedRateBps: 500,
      expectedCommissionCents: 500_000,
      varianceCents: 0,
      disposition: 'MATCHED',
    })
  })
})

describe('commission reconciliation bounded unresolved path', () => {
  it('rejects a second repair at the real revision limit and stops graph growth', async () => {
    const events: OrchestratorEvent[] = []
    const result = await runCommissionReconciliation({
      scenario: 'unresolved',
      onProgress: event => { events.push(event) },
    })
    const initialReconciliation = taskByTitle(result, INITIAL_TASK_TITLES.reconcile)
    const oldOutput = taskByTitle(result, INITIAL_TASK_TITLES.output)
    const agreementLookup = taskByTitle(result, RECOVERY_TASK_TITLES.agreementHistory)
    const policyLookup = taskByTitle(result, RECOVERY_TASK_TITLES.policyVersion)
    const replacement = taskByTitle(result, RECOVERY_TASK_TITLES.reconcile)
    const replacementOutput = taskByTitle(result, RECOVERY_TASK_TITLES.output)

    expect(result.success).toBe(false)
    expect(result.tasks).toHaveLength(9)
    expect(result.taskResults?.size).toBe(7)
    expect(result.planRevisions).toHaveLength(1)
    expect(Object.keys(result.planRevisions![0]!.addedTasks)).toHaveLength(4)
    expect(initialReconciliation).toMatchObject({ status: 'failed', recoveredByRevision: 1 })
    expect(oldOutput).toMatchObject({ status: 'skipped', supersededByRevision: 1 })
    expect(agreementLookup.status).toBe('completed')
    expect(policyLookup.status).toBe('completed')
    expect(replacement).toMatchObject({
      status: 'failed',
      recoveredByRevision: undefined,
      metrics: { retries: 0 },
    })
    expect(replacementOutput.status).toBe('failed')
    expect(result.taskResults?.has(replacementOutput.id)).toBe(false)
    expect(result.tasks?.some(task => task.title === 'Retrieve secondary agreement archive'))
      .toBe(false)

    const warnings = events.filter(event =>
      event.type === 'warning'
      && (event.data as { code?: string }).code === 'RECOVERY_REVISION_LIMIT')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      task: replacement.id,
      data: { code: 'RECOVERY_REVISION_LIMIT', maxPlanRevisions: 1 },
    })
    expect(events.filter(event => event.type === 'plan_revision')).toHaveLength(1)
    expect(events.some(event => event.type === 'task_retry')).toBe(false)
    expect(result.totalTokenUsage).toEqual({ input_tokens: 7, output_tokens: 7 })
  })

  it('retains a null agreement lookup and a typed final evidence gap without guessing', async () => {
    const result = await runCommissionReconciliation({ scenario: 'unresolved' })
    const agreement = AgreementHistoryLookupSchema.parse(
      taskResult(result, RECOVERY_TASK_TITLES.agreementHistory).structured,
    )
    const policy = PolicyVersionLookupSchema.parse(
      taskResult(result, RECOVERY_TASK_TITLES.policyVersion).structured,
    )
    const gap = EvidenceGapSchema.parse(
      taskResult(result, RECOVERY_TASK_TITLES.reconcile).structured,
    )
    expect(agreement).toMatchObject({
      requestedAgreementId: 'AGREEMENT-002', scenario: 'unresolved', agreement: null,
    })
    expect(policy.policy).not.toBeNull()
    expect(gap).toMatchObject({
      status: 'INSUFFICIENT_TEMPORAL_EVIDENCE',
      policyId: 'POL-002',
      missing: ['agreement-effective-range'],
    })
    expect(gap.sourceIds).toContain(policy.policy!.sourceId)
    expect(JSON.stringify(gap)).not.toMatch(
      /selectedRule|selectedRate|expectedCommission|variance|disposition/,
    )
  })

  it('maps bounded failure to manual review outside the failed task graph', async () => {
    const result = await runCommissionReconciliation({ scenario: 'unresolved' })
    const outcome = ManualReviewSchema.parse(resolveCommissionOutcome(result))
    expect(outcome).toMatchObject({
      status: 'MANUAL_REVIEW_REQUIRED',
      policyId: 'POL-002',
      missing: ['agreement-effective-range'],
      attemptedPlanRevisions: 1,
      recoveryLimit: COMMISSION_RECOVERY_LIMITS,
    })
    expect(outcome.nextAction).toContain('human reviewer')
    expect(commissionExitCode(outcome)).toBe(1)
    expect(result.tasks?.some(task => task.title === 'MANUAL_REVIEW_REQUIRED')).toBe(false)
    expect(result.taskResults?.size).toBe(7)
    expect(JSON.stringify(outcome)).not.toMatch(
      /selectedRule|selectedRate|expectedCommission|variance|disposition|paymentAdjusted/,
    )
  })

  it('maps a recovered framework result to reconciliation and exit code zero', async () => {
    const result = await runCommissionReconciliation({ scenario: 'recovered' })
    const outcome = ReconciliationResultSchema.parse(resolveCommissionOutcome(result))
    expect(outcome.status).toBe('RECONCILED')
    expect(outcome.expectedCommissionCents).toBe(700_000)
    expect(commissionExitCode(outcome)).toBe(0)
  })
})
