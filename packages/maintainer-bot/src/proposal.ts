import { hashJson, sha256 } from './hash.js'
import type { ReviewBundle } from './review-bundle.js'
import {
  draftPrProposalSchema,
  validationResultSchema,
  type ContextManifest,
  type ControlPlaneRequest,
  type DraftPrProposal,
  type MaintainerConfig,
  type ReviewOutput,
  type ValidationResult,
} from './schema.js'
import type { AppliedEdit } from './workspace.js'
import { allValidationsPassed } from './validation.js'

export interface BuildDraftPrProposalOptions {
  readonly request: ControlPlaneRequest
  readonly config: MaintainerConfig
  readonly manifest: ContextManifest
  readonly appliedEdits: readonly AppliedEdit[]
  readonly validationResults: readonly ValidationResult[]
  readonly reviewBundle: ReviewBundle
  readonly review: ReviewOutput
  readonly implementationSummary: string
  readonly risks: readonly string[]
  readonly skippedChecks?: readonly string[]
  readonly now?: () => Date
}

export function buildDraftPrProposal(options: BuildDraftPrProposalOptions): DraftPrProposal {
  if (!options.manifest.sufficiency.sufficient) {
    throw new Error('Insufficient context cannot produce a Draft PR proposal.')
  }
  if (!allValidationsPassed(options.validationResults)) {
    throw new Error('Validation failure or truncated validation evidence blocks a Draft PR proposal.')
  }
  if (options.review.verdict !== 'approve') {
    throw new Error('Reviewer rejection blocks a Draft PR proposal.')
  }
  const changedFiles = consolidateEdits(options.appliedEdits)
  const validationResults = options.validationResults.map(result => validationResultSchema.parse(result))
  if (changedFiles.length === 0) throw new Error('A Draft PR proposal requires at least one changed file.')
  assertReviewEvidence(options, changedFiles)
  const partial = {
    schemaVersion: 1 as const,
    kind: 'draft_pr' as const,
    eligibleForHostWrite: true as const,
    repository: options.request.issue.repository,
    issueNumber: options.request.issue.number,
    issueRevision: options.manifest.issueRevision,
    baseSha: options.request.baseSha,
    contextManifestHash: options.manifest.manifestHash,
    title: `Draft: fix #${options.request.issue.number} — ${options.request.issue.title}`.slice(0, 240),
    summary: options.implementationSummary,
    acceptanceCriteria: options.request.issue.acceptanceCriteria,
    changedFiles,
    validationResults,
    skippedChecks: [...(options.skippedChecks ?? [])],
    model: options.config.model,
    promptVersion: options.config.promptVersion,
    policyVersion: options.config.policyVersion,
    risks: [...new Set(options.risks)],
    review: options.review,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
  }
  return draftPrProposalSchema.parse({ ...partial, proposalHash: hashJson(partial) })
}

function assertReviewEvidence(
  options: BuildDraftPrProposalOptions,
  changedFiles: DraftPrProposal['changedFiles'],
): void {
  const criteria = options.request.issue.acceptanceCriteria
  assertSameStrings(
    options.review.acceptanceResults.map(result => result.criterion),
    criteria,
    'Reviewer acceptance criteria differ from the authorized issue revision.',
  )
  if (options.review.acceptanceResults.some(result => result.status !== 'pass')) {
    throw new Error('Reviewer approval requires every authorized acceptance criterion to pass.')
  }
  const bundle = options.reviewBundle
  if (
    bundle.issueRevision !== options.manifest.issueRevision
    || bundle.baseSha !== options.request.baseSha
    || bundle.contextManifestHash !== options.manifest.manifestHash
  ) {
    throw new Error('Fresh review bundle does not match the authorized revision, base, or context manifest.')
  }
  assertSameStrings(
    bundle.requirements.acceptanceCriteria,
    criteria,
    'Fresh review acceptance criteria differ from the authorized issue revision.',
  )
  assertSameStrings(
    bundle.changedPaths,
    changedFiles.map(file => file.path),
    'Fresh review changed paths differ from the proposed files.',
  )
  assertSameStrings(
    bundle.currentFiles.map(file => file.path),
    changedFiles.map(file => file.path),
    'Fresh review current-file snapshots differ from the proposed files.',
  )
  if (bundle.diffHash !== sha256(bundle.diff)) throw new Error('Fresh review diff hash is invalid.')
  const normalizedValidationResults = options.validationResults.map(result => validationResultSchema.parse(result))
  if (hashJson(bundle.validationResults) !== hashJson(normalizedValidationResults)) {
    throw new Error('Fresh review validation evidence differs from the proposal evidence.')
  }
  const snapshots = new Map(bundle.currentFiles.map(file => [file.path, file]))
  for (const file of changedFiles) {
    const snapshot = snapshots.get(file.path)
    if (
      snapshot === undefined
      || snapshot.contentHash !== file.afterHash
      || snapshot.contentHash !== sha256(snapshot.content)
    ) {
      throw new Error(`Proposed afterHash differs from the fresh review snapshot: ${file.path}`)
    }
  }
}

function assertSameStrings(actual: readonly string[], expected: readonly string[], message: string): void {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(message)
}

function consolidateEdits(edits: readonly AppliedEdit[]): DraftPrProposal['changedFiles'] {
  const byPath = new Map<string, DraftPrProposal['changedFiles'][number]>()
  for (const edit of edits) {
    const existing = byPath.get(edit.path)
    byPath.set(edit.path, {
      path: edit.path,
      reason: (existing === undefined ? edit.reason : `${existing.reason}; ${edit.reason}`).slice(0, 1_000),
      beforeHash: existing?.beforeHash ?? edit.beforeHash,
      afterHash: edit.afterHash,
    })
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}
