import { z } from 'zod'
import { evaluateAdmission } from './admission.js'
import type { CommandRunner } from './command.js'
import { renderCommand } from './command.js'
import { hashJson, sha256 } from './hash.js'
import { assertApprovedEditPath, assertPathPolicy } from './paths.js'
import {
  collectCanonicalCandidateDiff,
  collectCurrentFileSnapshots,
  parseChangedPaths,
} from './review-bundle.js'
import { computeRunKey, runRecordSchema, type RunRecord } from './state.js'
import {
  contextManifestSchema,
  controlPlaneRequestSchema,
  draftPrProposalSchema,
  maintainerConfigSchema,
  type ContextManifest,
  type ControlPlaneRequest,
  type DraftPrProposal,
  type MaintainerConfig,
} from './schema.js'

export const REQUIRED_SAFE_OUTPUT_REVALIDATIONS = [
  'issueRevision',
  'baseSha',
  'contextManifest',
  'policyPromptVersions',
  'runRecord',
  'proposalHash',
  'validatedCandidateDiff',
  'validationResults',
  'changedFiles',
  'worktreeHead',
  'worktreeChangedPaths',
  'worktreeAfterHashes',
  'reviewerAcceptance',
] as const

export const ghAwAdapterDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-bot-control-plane-v1'),
  integration: z.literal('github-agentic-workflows-custom-engine'),
  pinPolicy: z.object({
    ghAwReference: z.string().regex(/^[0-9a-f]{40}$/),
    omaMaintainerBotPolicyVersion: z.string().min(1),
    omaMaintainerBotPromptVersion: z.string().min(1),
  }),
  trigger: z.object({
    event: z.literal('issues.labeled'),
    requiredLabel: z.literal('agent-ready'),
    requiredAuthorizerPermission: z.literal('write'),
  }),
  customEngine: z.object({
    command: z.literal('node'),
    args: z.array(z.string()).min(2),
    modelEnvironmentAllowlist: z.array(z.string()),
    modelEnvironmentForbidden: z.array(z.string()).min(1),
  }),
  safeOutput: z.object({
    acceptedKind: z.literal('draft_pr'),
    requireEligibleForHostWrite: z.literal(true),
    hostMustRevalidate: z.array(z.string()).min(1),
    prohibitedActions: z.array(z.string()).min(1),
  }),
}).superRefine((definition, context) => {
  for (const required of REQUIRED_SAFE_OUTPUT_REVALIDATIONS) {
    if (!definition.safeOutput.hostMustRevalidate.includes(required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['safeOutput', 'hostMustRevalidate'],
        message: `hostMustRevalidate must include ${required}`,
      })
    }
  }
})

export type GhAwAdapterDefinition = z.infer<typeof ghAwAdapterDefinitionSchema>

export interface RevalidateSafeOutputOptions {
  readonly repoRoot: string
  readonly runner: CommandRunner
  readonly request: ControlPlaneRequest
  readonly config: MaintainerConfig
  readonly manifest: ContextManifest
  readonly proposal: DraftPrProposal
  readonly record: RunRecord
}

/**
 * Final deterministic boundary for a credential-holding host. It revalidates
 * both the immutable artifacts and the actual worktree that would be committed.
 * It performs no GitHub call and grants no authority for Ready, approval,
 * merge, close, release, or publication actions.
 */
export async function revalidateDraftPrSafeOutput(
  options: RevalidateSafeOutputOptions,
): Promise<DraftPrProposal> {
  const proposal = revalidateDraftPrArtifact(options)
  const head = (await options.runner.run('git', ['rev-parse', 'HEAD'], {
    cwd: options.repoRoot,
  })).stdout.trim()
  if (head !== proposal.baseSha) {
    throw new Error(`Safe output worktree HEAD ${head} differs from proposal base SHA ${proposal.baseSha}.`)
  }
  const status = await options.runner.run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: options.repoRoot },
  )
  const changedPaths = parseChangedPaths(status.stdout)
  for (const path of changedPaths) {
    assertPathPolicy(path, options.config.allowedPaths, options.config.protectedPaths)
    assertApprovedEditPath(path, options.manifest.approvedEditScopes)
  }
  assertSameStrings(
    changedPaths,
    proposal.changedFiles.map(file => file.path),
    'Safe output worktree changed paths differ from the proposal.',
  )
  const snapshots = await collectCurrentFileSnapshots(
    options.repoRoot,
    changedPaths,
    options.config,
  )
  const currentHashes = new Map(snapshots.map(snapshot => [snapshot.path, snapshot.contentHash]))
  for (const file of proposal.changedFiles) {
    if (currentHashes.get(file.path) !== file.afterHash) {
      throw new Error(`Safe output worktree content drifted after review: ${file.path}`)
    }
  }
  const candidateDiff = await collectCanonicalCandidateDiff({
    repoRoot: options.repoRoot,
    baseSha: proposal.baseSha,
    changedPaths,
    statusOutput: status.stdout,
    runner: options.runner,
  })
  if (sha256(candidateDiff) !== proposal.validatedCandidateDiffHash) {
    throw new Error('Safe output worktree candidate diff drifted after validation and review.')
  }
  return proposal
}

/** Pure artifact validation used before the worktree-bound public host gate. */
export function revalidateDraftPrArtifact(
  options: Omit<RevalidateSafeOutputOptions, 'repoRoot' | 'runner'>,
): DraftPrProposal {
  const request = controlPlaneRequestSchema.parse(options.request)
  const config = maintainerConfigSchema.parse(options.config)
  const manifest = contextManifestSchema.parse(options.manifest)
  const proposal = draftPrProposalSchema.parse(options.proposal)
  const record = runRecordSchema.parse(options.record)
  const admission = evaluateAdmission(request)
  if (!admission.mayDevelop || admission.status !== 'AGENT_READY') {
    throw new Error('Safe output no longer has valid agent-ready authorization.')
  }
  if (!manifest.sufficiency.sufficient) throw new Error('Safe output context is insufficient.')
  const { manifestHash, ...manifestWithoutHash } = manifest
  if (manifestHash !== hashJson(manifestWithoutHash)) throw new Error('Safe output context manifest hash is invalid.')
  if (
    record.status !== 'DRAFT_PR_PROPOSAL_READY'
    || record.repository !== request.issue.repository
    || record.issueNumber !== request.issue.number
    || record.issueRevision !== admission.issueRevision
    || record.baseSha !== request.baseSha
    || record.proposalHash !== proposal.proposalHash
    || record.contextManifestHash !== manifest.manifestHash
    || record.runKey !== computeRunKey({
      repository: request.issue.repository,
      issueNumber: request.issue.number,
      issueRevision: admission.issueRevision,
      baseSha: request.baseSha,
    })
  ) {
    throw new Error('Safe output lacks a matching authoritative proposal-ready run record.')
  }
  if (proposal.repository !== request.issue.repository || proposal.issueNumber !== request.issue.number) {
    throw new Error('Safe output targets a different issue or repository.')
  }
  if (
    proposal.issueRevision !== admission.issueRevision
    || proposal.baseSha !== request.baseSha
    || proposal.contextManifestHash !== manifest.manifestHash
    || manifest.repository !== request.issue.repository
    || manifest.issueNumber !== request.issue.number
    || manifest.issueRevision !== admission.issueRevision
    || manifest.baseSha !== request.baseSha
  ) {
    throw new Error('Safe output revision, base SHA, or context manifest changed.')
  }
  if (
    proposal.policyVersion !== config.policyVersion
    || proposal.promptVersion !== config.promptVersion
    || proposal.model !== config.model
    || manifest.policyVersion !== config.policyVersion
    || manifest.promptVersion !== config.promptVersion
  ) {
    throw new Error('Safe output model, policy, or prompt version differs from host configuration.')
  }
  if (hashJson(manifest.validationCommands) !== hashJson(config.validationCommands)) {
    throw new Error('Safe output context manifest validation set differs from host configuration.')
  }
  if (
    JSON.stringify([...manifest.allowedPaths].sort()) !== JSON.stringify([...config.allowedPaths].sort())
    || JSON.stringify([...manifest.protectedPaths].sort()) !== JSON.stringify([...config.protectedPaths].sort())
    || JSON.stringify([...manifest.targetPaths].sort()) !== JSON.stringify([...request.issue.targetPaths].sort())
    || JSON.stringify([...manifest.targetWorkspaces].sort())
      !== JSON.stringify([...request.issue.targetWorkspaces].sort())
    || JSON.stringify([...manifest.approvedEditScopes.map(scope => scope.path)].sort())
      !== JSON.stringify([...request.issue.targetPaths].sort())
  ) {
    throw new Error('Safe output manifest path policy differs from current host configuration or issue scope.')
  }
  for (const scope of manifest.approvedEditScopes) {
    assertPathPolicy(scope.path, config.allowedPaths, config.protectedPaths)
  }
  for (const file of proposal.changedFiles) {
    assertApprovedEditPath(file.path, manifest.approvedEditScopes)
  }
  assertUniqueStrings(proposal.changedFiles.map(file => file.path), 'Safe output proposal contains duplicate changed paths.')
  assertSameStrings(
    proposal.acceptanceCriteria,
    request.issue.acceptanceCriteria,
    'Safe output acceptance criteria differ from the authorized issue revision.',
  )
  if (proposal.review.verdict !== 'approve') throw new Error('Safe output reviewer did not approve the proposal.')
  assertSameStrings(
    proposal.review.acceptanceResults.map(result => result.criterion),
    request.issue.acceptanceCriteria,
    'Safe output reviewer results differ from the authorized acceptance criteria.',
  )
  if (proposal.review.acceptanceResults.some(result => result.status !== 'pass')) {
    throw new Error('Safe output reviewer did not pass every authorized acceptance criterion.')
  }
  const expectedValidations = config.validationCommands
    .map(command => ({
      id: command.id,
      command: renderCommand(command.command, command.args),
      environment: {
        set: Object.entries(command.env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => ({ name, value })),
        unset: [...command.unsetEnv].sort(),
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const actualValidations = proposal.validationResults
    .map(result => ({ id: result.id, command: result.command, environment: result.environment }))
    .sort((a, b) => a.id.localeCompare(b.id))
  assertUniqueStrings(actualValidations.map(result => result.id), 'Safe output contains duplicate validation results.')
  if (JSON.stringify(actualValidations) !== JSON.stringify(expectedValidations)) {
    throw new Error('Safe output does not contain the exact registered validation set.')
  }
  if (proposal.validationResults.some(result => !result.success || result.truncated)) {
    throw new Error('Safe output contains failed or truncated validation evidence.')
  }
  const { proposalHash, ...withoutHash } = proposal
  if (proposalHash !== hashJson(withoutHash)) throw new Error('Safe output proposal hash is invalid.')
  return proposal
}

function assertSameStrings(actual: readonly string[], expected: readonly string[], message: string): void {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(message)
}

function assertUniqueStrings(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message)
}
