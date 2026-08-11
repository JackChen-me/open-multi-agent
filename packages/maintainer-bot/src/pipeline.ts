import { mkdir, open, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LLMAdapter, OrchestratorEvent } from '@open-multi-agent/core'
import { evaluateAdmission } from './admission.js'
import { assertModelCredentialIsolation, type CommandRunner } from './command.js'
import { buildContextManifest } from './context.js'
import { assertApprovedEditPath } from './paths.js'
import {
  runFreshReview,
  runMaintainerTriage,
  runPlanningImplementationDag,
  runRepair,
  type TokenUsage,
} from './orchestrator.js'
import { buildDraftPrProposal } from './proposal.js'
import { collectReviewBundle, type ReviewBundle } from './review-bundle.js'
import {
  controlPlaneRequestSchema,
  maintainerConfigSchema,
  type AdmissionDecision,
  type ContextManifest,
  type ControlPlaneRequest,
  type DraftPrProposal,
  type ImplementationOutput,
  type MaintainerConfig,
  type MaintainerState,
  type ModelTriage,
  type ReviewOutput,
  type ValidationResult,
} from './schema.js'
import { computeRunKey, type RunRecord, type RunStateStore } from './state.js'
import { allValidationsPassed, runRegisteredValidations } from './validation.js'
import { applyRestrictedEdits, type AppliedEdit } from './workspace.js'

export interface RunMaintainerBotOptions {
  readonly repoRoot: string
  readonly artifactDir: string
  readonly request: ControlPlaneRequest
  readonly config: MaintainerConfig
  readonly runner: CommandRunner
  readonly stateStore: RunStateStore
  readonly runId: string
  readonly adapter?: LLMAdapter
  readonly apiKey?: string
  readonly dryRun?: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
  readonly abortSignal?: AbortSignal
  readonly requireEvidenceToolCalls?: boolean
  readonly onProgress?: (event: OrchestratorEvent) => void
}

export type MaintainerBotResult =
  | {
      readonly status: Exclude<MaintainerState, 'RUNNING' | 'DRAFT_PR_PROPOSAL_READY' | 'DRAFT_PR_CREATED'>
      readonly admission: AdmissionDecision
      readonly manifest?: ContextManifest
      readonly record?: RunRecord
      readonly detail: string
      readonly tokenUsage: TokenUsage
      readonly estimatedCostUsd: number
    }
  | {
      readonly status: 'AGENT_READY' | 'NEEDS_HUMAN'
      readonly dryRun: true
      readonly admission: AdmissionDecision
      readonly manifest: ContextManifest
      readonly detail: string
      readonly tokenUsage: TokenUsage
      readonly estimatedCostUsd: number
    }
  | {
      readonly status: 'DRAFT_PR_PROPOSAL_READY'
      readonly admission: AdmissionDecision
      readonly manifest: ContextManifest
      readonly proposal: DraftPrProposal
      readonly record: RunRecord
      readonly reviewBundle: ReviewBundle
      readonly tokenUsage: TokenUsage
      readonly estimatedCostUsd: number
    }
  | {
      readonly status: MaintainerState
      readonly duplicate: true
      readonly admission: AdmissionDecision
      readonly record: RunRecord
      readonly detail: string
      readonly tokenUsage: TokenUsage
      readonly estimatedCostUsd: number
    }

export async function runMaintainerBot(
  input: RunMaintainerBotOptions,
): Promise<MaintainerBotResult> {
  const request = controlPlaneRequestSchema.parse(input.request)
  const config = maintainerConfigSchema.parse(input.config)
  const admission = evaluateAdmission(request)
  const zeroUsage = { input_tokens: 0, output_tokens: 0 }
  if (!admission.mayDevelop) {
    return {
      status: admission.status as Exclude<MaintainerState,
        'RUNNING' | 'DRAFT_PR_PROPOSAL_READY' | 'DRAFT_PR_CREATED'>,
      admission,
      detail: admission.reasons.join(' '),
      tokenUsage: zeroUsage,
      estimatedCostUsd: 0,
    }
  }

  const manifest = await buildContextManifest({
    repoRoot: input.repoRoot,
    request,
    admission,
    config,
    runner: input.runner,
    now: input.now,
  })
  if (input.dryRun === true) {
    return {
      status: manifest.sufficiency.sufficient ? 'AGENT_READY' : 'NEEDS_HUMAN',
      dryRun: true,
      admission,
      manifest,
      detail: manifest.sufficiency.sufficient
        ? 'Dry-run admission and context capture succeeded; no state, model, file, validation, or GitHub mutation occurred.'
        : 'Dry-run context capture is insufficient; no mutation occurred.',
      tokenUsage: zeroUsage,
      estimatedCostUsd: 0,
    }
  }

  assertModelCredentialIsolation(input.env ?? process.env)
  if (!input.adapter && !input.apiKey) {
    throw new Error('DEEPSEEK_API_KEY must be passed explicitly to a credential-isolated model run.')
  }
  const claim = await input.stateStore.claim({
    runId: input.runId,
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: admission.issueRevision,
    baseSha: request.baseSha,
    leaseMs: Math.min(config.limits.runTimeoutMs + 60_000, 24 * 60 * 60_000),
  })
  if (!claim.claimed) {
    return {
      status: claim.record.status,
      duplicate: true,
      admission,
      record: claim.record,
      detail: `No model or repository mutation ran: ${claim.reason} issue revision already has an authoritative run record.`,
      tokenUsage: zeroUsage,
      estimatedCostUsd: 0,
    }
  }

  const runKey = computeRunKey({
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: admission.issueRevision,
    baseSha: request.baseSha,
  })
  let record = await input.stateStore.attachContext(input.runId, runKey, manifest.manifestHash)
  await writeArtifact(input.artifactDir, `${runKey}.context.json`, manifest)
  if (!manifest.sufficiency.sufficient) {
    record = await input.stateStore.transition(
      input.runId,
      runKey,
      'NEEDS_HUMAN',
      manifest.sufficiency.errors.join(' '),
    )
    return {
      status: 'NEEDS_HUMAN',
      admission,
      manifest,
      record,
      detail: manifest.sufficiency.errors.join(' '),
      tokenUsage: zeroUsage,
      estimatedCostUsd: 0,
    }
  }

  const deadline = AbortSignal.timeout(config.limits.runTimeoutMs)
  const abortSignal = input.abortSignal === undefined
    ? deadline
    : mergeAbortSignals(input.abortSignal, deadline)
  let usage: TokenUsage = zeroUsage
  let cost = 0
  const appliedEdits: AppliedEdit[] = []
  let implementationSummary = ''
  let risks: string[] = []
  let latestBundle: ReviewBundle | undefined

  try {
    const triage = await runMaintainerTriage({
      config,
      manifest,
      adapter: input.adapter,
      apiKey: input.apiKey,
      abortSignal,
      maxTokenBudget: phaseTokenBudget(config, usage, 'triage'),
      requireEvidenceToolCalls: input.requireEvidenceToolCalls,
      onProgress: input.onProgress,
    })
    usage = addUsage(usage, triage.tokenUsage)
    cost = assertBudgets(config, usage, deadline)
    validateTriageOutput(request, manifest, triage.triage)

    const initial = await runPlanningImplementationDag({
      config,
      manifest,
      triage: triage.triage,
      adapter: input.adapter,
      apiKey: input.apiKey,
      abortSignal,
      maxTokenBudget: phaseTokenBudget(config, usage, 'planning-implementation'),
      requireEvidenceToolCalls: input.requireEvidenceToolCalls,
      onProgress: input.onProgress,
    })
    usage = addUsage(usage, initial.tokenUsage)
    cost = assertBudgets(config, usage, deadline)
    validatePlanningImplementationOutputs(
      request,
      config,
      manifest,
      initial.plan,
      initial.implementation,
    )
    implementationSummary = initial.implementation.summary
    risks = [...initial.plan.risks, ...initial.implementation.risks]
    appliedEdits.push(...await applyRestrictedEdits({
      repoRoot: input.repoRoot,
      implementation: initial.implementation,
      config,
      approvedEditScopes: manifest.approvedEditScopes,
    }))

    let validationResults = await runRegisteredValidations({
      repoRoot: input.repoRoot,
      config,
      runner: input.runner,
      env: input.env,
    })
    latestBundle = await collectReviewBundle({
      repoRoot: input.repoRoot,
      request,
      config,
      manifest,
      validationResults,
      runner: input.runner,
    })
    let reviewed = await runFreshReview({
      config,
      bundle: latestBundle,
      adapter: input.adapter,
      apiKey: input.apiKey,
      abortSignal,
      maxTokenBudget: phaseTokenBudget(config, usage, 'review'),
      requireEvidenceToolCalls: input.requireEvidenceToolCalls,
      onProgress: input.onProgress,
    })
    usage = addUsage(usage, reviewed.tokenUsage)
    cost = assertBudgets(config, usage, deadline)
    let review = reviewed.review

    for (let repairRound = 1;
      shouldRepair(review, validationResults, repairRound, config.limits.maxRepairLoops);
      repairRound += 1) {
      const repair = await runRepair({
        config,
        bundle: latestBundle,
        priorReview: review,
        repairRound,
        adapter: input.adapter,
        apiKey: input.apiKey,
        abortSignal,
        maxTokenBudget: phaseTokenBudget(config, usage, 'repair'),
        requireEvidenceToolCalls: input.requireEvidenceToolCalls,
        onProgress: input.onProgress,
      })
      usage = addUsage(usage, repair.tokenUsage)
      cost = assertBudgets(config, usage, deadline)
      validateRepairOutput(
        repair.implementation,
        initial.plan.files.map(file => file.path),
        manifest,
      )
      if (repair.implementation.edits.length === 0) break
      appliedEdits.push(...await applyRestrictedEdits({
        repoRoot: input.repoRoot,
        implementation: repair.implementation,
        config,
        approvedEditScopes: manifest.approvedEditScopes,
      }))
      implementationSummary = repair.implementation.summary
      risks.push(...repair.implementation.risks)
      validationResults = await runRegisteredValidations({
        repoRoot: input.repoRoot,
        config,
        runner: input.runner,
        env: input.env,
      })
      latestBundle = await collectReviewBundle({
        repoRoot: input.repoRoot,
        request,
        config,
        manifest,
        validationResults,
        runner: input.runner,
      })
      reviewed = await runFreshReview({
        config,
        bundle: latestBundle,
        adapter: input.adapter,
        apiKey: input.apiKey,
        abortSignal,
        maxTokenBudget: phaseTokenBudget(config, usage, 'review'),
        requireEvidenceToolCalls: input.requireEvidenceToolCalls,
        onProgress: input.onProgress,
      })
      usage = addUsage(usage, reviewed.tokenUsage)
      cost = assertBudgets(config, usage, deadline)
      review = reviewed.review
    }

    if (!allValidationsPassed(validationResults) || review.verdict !== 'approve') {
      const detail = failureDetail(validationResults, review)
      record = await input.stateStore.transition(input.runId, runKey, 'NEEDS_HUMAN', detail)
      return {
        status: 'NEEDS_HUMAN',
        admission,
        manifest,
        record,
        detail,
        tokenUsage: usage,
        estimatedCostUsd: cost,
      }
    }
    if (latestBundle === undefined) throw new Error('Approved review is missing its deterministic evidence bundle.')

    const proposal = buildDraftPrProposal({
      request,
      config,
      manifest,
      appliedEdits,
      validationResults,
      reviewBundle: latestBundle,
      review,
      implementationSummary,
      risks,
      skippedChecks: [],
      now: input.now,
    })
    await writeArtifact(input.artifactDir, `${runKey}.draft-pr-proposal.json`, proposal)
    record = await input.stateStore.transition(
      input.runId,
      runKey,
      'DRAFT_PR_PROPOSAL_READY',
      'A deterministic host may create a Draft PR after revalidating the request.',
      proposal.proposalHash,
    )
    return {
      status: 'DRAFT_PR_PROPOSAL_READY',
      admission,
      manifest,
      proposal,
      record,
      reviewBundle: latestBundle,
      tokenUsage: usage,
      estimatedCostUsd: cost,
    }
  } catch (error) {
    const detail = safeErrorMessage(error)
    const failureState = error instanceof NeedsHumanError ? 'NEEDS_HUMAN' : 'FAILED'
    try {
      record = await input.stateStore.transition(input.runId, runKey, failureState, detail)
    } catch {
      // Preserve the original failure. A state persistence error remains visible in the state store logs/files.
    }
    return {
      status: failureState,
      admission,
      manifest,
      record,
      detail,
      tokenUsage: usage,
      estimatedCostUsd: cost,
    }
  }
}

export async function acknowledgeDraftPrCreated(
  store: RunStateStore,
  input: {
    readonly runId: string
    readonly runKey: string
    readonly proposalHash: string
    readonly pullRequestUrl: string
  },
): Promise<RunRecord> {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(input.pullRequestUrl)) {
    throw new Error('Draft PR acknowledgment requires a canonical GitHub pull request URL.')
  }
  const record = await store.get(input.runKey)
  if (record === null || record.proposalHash !== input.proposalHash) {
    throw new Error('Draft PR acknowledgment does not match the authoritative proposal hash.')
  }
  return store.transition(
    input.runId,
    input.runKey,
    'DRAFT_PR_CREATED',
    `Deterministic host acknowledged Draft PR ${input.pullRequestUrl}.`,
  )
}

function validateTriageOutput(
  request: ControlPlaneRequest,
  manifest: ContextManifest,
  triage: ModelTriage,
): void {
  if (triage.verdict !== 'proceed' || triage.uncertainties.length > 0 || triage.manualRiskSignals.length > 0) {
    throw new NeedsHumanError(triageFailureDetail(triage))
  }
  if (
    triage.confirmedIssueRevision !== manifest.issueRevision
    || triage.confirmedIssueRevision !== request.authorization?.issueRevision
  ) {
    throw new NeedsHumanError('Triage issue revision differs from the authorized issue revision.')
  }
  assertSameStrings(triage.confirmedAcceptanceCriteria, request.issue.acceptanceCriteria, 'triage acceptance criteria')
}

function validatePlanningImplementationOutputs(
  request: ControlPlaneRequest,
  config: MaintainerConfig,
  manifest: ContextManifest,
  plan: { acceptanceCriteria: string[]; validationCommandIds: string[]; unresolvedQuestions: string[]; files: Array<{ path: string }> },
  implementation: ImplementationOutput,
): void {
  assertSameStrings(plan.acceptanceCriteria, request.issue.acceptanceCriteria, 'planned acceptance criteria')
  if (plan.unresolvedQuestions.length > 0) throw new NeedsHumanError('Planner left unresolved questions.')
  assertSameStrings(
    plan.validationCommandIds,
    config.validationCommands.map(command => command.id),
    'validation command ids',
  )
  if (implementation.assumptions.length > 0) throw new NeedsHumanError('Implementer returned unresolved assumptions.')
  if (implementation.edits.length === 0) throw new NeedsHumanError('Implementer returned no edits.')
  for (const file of plan.files) assertModelPathScope(file.path, manifest)
  const plannedPaths = new Set(plan.files.map(file => file.path))
  for (const edit of implementation.edits) {
    assertModelPathScope(edit.path, manifest)
    if (!plannedPaths.has(edit.path)) throw new NeedsHumanError(`Implementer edited an unplanned path: ${edit.path}`)
  }
}

function triageFailureDetail(
  triage: { verdict: string; uncertainties: string[]; manualRiskSignals: string[] },
): string {
  const reasons = [
    triage.verdict === 'proceed' ? undefined : `verdict=${triage.verdict}`,
    ...triage.uncertainties.map(value => `uncertainty=${value}`),
    ...triage.manualRiskSignals.map(value => `manual-risk=${value}`),
  ].filter((value): value is string => value !== undefined)
  const detail = `Read-only triage blocked development: ${reasons.join(' | ')}`
  return detail.length <= 8_000 ? detail : `${detail.slice(0, 7_980)} [truncated]`
}

function validateRepairOutput(
  implementation: ImplementationOutput,
  plannedPaths: readonly string[],
  manifest: ContextManifest,
): void {
  if (implementation.assumptions.length > 0) throw new NeedsHumanError('Repair contains unresolved assumptions.')
  const planned = new Set(plannedPaths)
  for (const edit of implementation.edits) {
    assertModelPathScope(edit.path, manifest)
    if (!planned.has(edit.path)) throw new NeedsHumanError(`Repair widened the planned path scope: ${edit.path}`)
  }
}

function assertModelPathScope(path: string, manifest: ContextManifest): void {
  try {
    assertApprovedEditPath(path, manifest.approvedEditScopes)
  } catch (error) {
    throw new NeedsHumanError(error instanceof Error ? error.message : String(error))
  }
}

function shouldRepair(
  review: ReviewOutput,
  validations: readonly ValidationResult[],
  repairRound: number,
  maxRepairLoops: number,
): boolean {
  return repairRound <= maxRepairLoops
    && review.verdict === 'reject'
    && review.repairable
    && (!allValidationsPassed(validations) || review.issues.length > 0)
}

function failureDetail(validations: readonly ValidationResult[], review: ReviewOutput): string {
  const failed = validations.filter(result => !result.success || result.truncated).map(result => result.id)
  const parts = [
    failed.length === 0 ? '' : `Validation failed or was truncated: ${failed.join(', ')}.`,
    review.verdict === 'approve' ? '' : `Reviewer rejected: ${review.issues.join(' ')}`,
  ].filter(Boolean)
  return parts.join(' ') || 'Pipeline did not satisfy the safe-output gate.'
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

function remainingTokens(config: MaintainerConfig, usage: TokenUsage): number {
  const used = usage.input_tokens + usage.output_tokens
  const remaining = config.limits.maxTokenBudget - used
  if (remaining <= 0) throw new NeedsHumanError('Maintainer-bot token budget exhausted.')
  return remaining
}

function phaseTokenBudget(
  config: MaintainerConfig,
  usage: TokenUsage,
  phase: 'triage' | 'planning-implementation' | 'review' | 'repair',
): number {
  const total = config.limits.maxTokenBudget
  const phaseCaps = {
    triage: Math.min(24_000, Math.max(1, Math.floor(total * 0.15))),
    'planning-implementation': Math.min(82_000, Math.max(1, Math.floor(total * 0.52))),
    review: Math.min(28_000, Math.max(1, Math.floor(total * 0.18))),
    repair: Math.min(28_000, Math.max(1, Math.floor(total * 0.18))),
  } as const
  const remaining = remainingTokens(config, usage)
  if (phase === 'repair') {
    const nextReviewReserve = Math.min(phaseCaps.review, Math.max(1, Math.floor(total * 0.12)))
    if (remaining <= nextReviewReserve) {
      throw new NeedsHumanError('Maintainer-bot lacks the reserved token budget for a repair plus fresh review.')
    }
    return Math.min(phaseCaps.repair, remaining - nextReviewReserve)
  }
  return Math.min(phaseCaps[phase], remaining)
}

function assertBudgets(config: MaintainerConfig, usage: TokenUsage, deadline: AbortSignal): number {
  if (usage.input_tokens + usage.output_tokens > config.limits.maxTokenBudget) {
    throw new NeedsHumanError('Maintainer-bot cumulative token budget exceeded.')
  }
  const cost = (
    usage.input_tokens * config.modelPricing.inputPerMillionUsd
    + usage.output_tokens * config.modelPricing.outputPerMillionUsd
  ) / 1_000_000
  if (cost > config.limits.maxCostUsd) {
    throw new NeedsHumanError('Maintainer-bot estimated model cost exceeded the configured USD limit.')
  }
  if (deadline.aborted) throw new NeedsHumanError('Maintainer-bot global wall-clock deadline exceeded.')
  return cost
}

function assertSameStrings(actual: readonly string[], expected: readonly string[], label: string): void {
  const normalizedActual = [...actual].sort()
  const normalizedExpected = [...expected].sort()
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new NeedsHumanError(`${label} differ from the authorized issue revision.`)
  }
}

async function writeArtifact(directory: string, name: string, value: unknown): Promise<void> {
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const destination = resolve(root, name)
  if (!destination.startsWith(`${root}/`)) throw new Error('Artifact path escapes artifact directory.')
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  await rename(temporary, destination)
}

function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason)
  }
  if (a.aborted) forward(a)
  else a.addEventListener('abort', () => forward(a), { once: true })
  if (b.aborted) forward(b)
  else b.addEventListener('abort', () => forward(b), { once: true })
  return controller.signal
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
}

class NeedsHumanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NeedsHumanError'
  }
}
