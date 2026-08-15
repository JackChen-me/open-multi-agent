import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FileRunStateStore,
  acknowledgeDraftPrCreated,
  computeRunKey,
  contextManifestSchema,
  draftPrProposalSchema,
  evaluateAdmission,
  runRecordSchema,
  type CommandRunner,
} from '@open-multi-agent/maintainer-bot'
import type { GitHubClient } from './github.js'
import { sameGitHubAppWriterIdentity, verifyGitHubAppWriter } from './app-auth.js'
import { buildProductionConfig, deterministicBranchName } from './policy.js'
import { sanitizePublicLine } from './public-output.js'
import { buildControlPlaneRequest, ControlPlaneBuildError } from './request.js'
import {
  activationContextSchema,
  engineResultSchema,
  githubLabelEventSchema,
  statusMetadataSchema,
  type ActivationContext,
  type ActivationStatus,
  type EngineResult,
  type GitHubAppWriterContract,
  type GitHubAppWriterIdentity,
  type ProductionPolicy,
  type StatusMetadata,
} from './schema.js'
import {
  decideClaim,
  findTrustedStatusComment,
  isActionsRunActive,
  upsertStatusComment,
} from './status.js'
import { isMatchingBotDraftPullRequest, writeDraftPullRequest } from './writer.js'

export interface PrepareActivationOptions {
  readonly event: unknown
  readonly github: GitHubClient
  readonly runner: CommandRunner
  readonly repoRoot: string
  readonly policy: ProductionPolicy
  readonly eventId: string
  readonly receivedAt: string
  readonly claimId: string
  readonly actionsRunId: number
  readonly runUrl: string
  readonly baseShaHint: string
  readonly eventSnapshotMatched: boolean
  readonly writerContract: GitHubAppWriterContract
  readonly removedBootstrapCommentCount: number
}

export async function prepareActivation(options: PrepareActivationOptions): Promise<ActivationContext> {
  const event = githubLabelEventSchema.parse(options.event)
  const repository = event.repository.full_name
  const issueNumber = event.issue.number
  const writerIdentity = await verifyGitHubAppWriter({
    github: options.github,
    repository,
    contract: options.writerContract,
  })
  if (!options.eventSnapshotMatched) {
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      'The Issue changed between the labeled event and the first trusted GitHub snapshot. Revalidate the material Issue revision before applying agent-ready again.',
      null,
      null,
    )
  }
  let request
  try {
    request = await buildControlPlaneRequest({
      event,
      github: options.github,
      policy: options.policy,
      eventId: options.eventId,
      receivedAt: options.receivedAt,
      writerIdentity,
      removedBootstrapCommentCount: options.removedBootstrapCommentCount,
    })
  } catch (error) {
    if (!(error instanceof ControlPlaneBuildError)) throw error
    return terminalPreparation(options, writerIdentity, error.publicStatus, error.reasons.join(' '), null, null)
  }
  if (request.baseSha !== options.baseShaHint) {
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      'The checked-out base SHA differs from the current trusted default-branch SHA.',
      request.authorization?.issueRevision ?? null,
      null,
    )
  }
  const localHead = (await options.runner.run('git', ['rev-parse', 'HEAD'], { cwd: options.repoRoot })).stdout.trim()
  const localStatus = (await options.runner.run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: options.repoRoot },
  )).stdout.trim()
  if (localHead !== request.baseSha || localStatus.length > 0) {
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      'The isolated runner checkout is not clean at the fixed default-branch base SHA.',
      request.authorization?.issueRevision ?? null,
      null,
    )
  }

  const admission = evaluateAdmission(request)
  if (!admission.mayDevelop) {
    return terminalPreparation(
      options,
      writerIdentity,
      publicStatusForAdmission(admission.status),
      admission.reasons.join(' '),
      admission.issueRevision,
      null,
      admission,
    )
  }
  let config
  try {
    config = buildProductionConfig(options.policy, request.issue.targetPaths)
  } catch (error) {
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      error instanceof Error ? error.message : String(error),
      admission.issueRevision,
      null,
      admission,
    )
  }
  const runKey = computeRunKey({
    repository,
    issueNumber,
    issueRevision: admission.issueRevision,
    baseSha: request.baseSha,
  })
  const branch = deterministicBranchName(options.policy, issueNumber, admission.issueRevision)
  const comments = await options.github.listIssueComments(repository, issueNumber)
  const trusted = await findTrustedStatusComment({
    github: options.github,
    comments,
    identity: writerIdentity,
    repository,
    issueNumber,
  })
  let existingRunActive = false
  if (trusted !== null && trusted.metadata.actionsRunId !== options.actionsRunId) {
    const existingRun = await options.github.getActionsRun(repository, trusted.metadata.actionsRunId)
    existingRunActive = isActionsRunActive(existingRun?.status)
  }
  const runningMetadata = statusMetadataSchema.parse({
    version: 2,
    repository,
    issueNumber,
    status: 'RUNNING',
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    baseSha: request.baseSha,
    issueRevision: admission.issueRevision,
    runKey,
    branch,
    pullRequestUrl: null,
    updatedAt: options.receivedAt,
  })
  const pulls = await options.github.listPullRequestsForHead(repository, branch)
  if (pulls.length > 0) {
    const repositoryMetadata = await options.github.getRepository(repository)
    const matching = pulls.length === 1
      && isMatchingBotDraftPullRequest(
        pulls[0]!,
        runKey,
        repositoryMetadata.defaultBranch,
        request.baseSha,
        branch,
        writerIdentity,
      )
    if (matching) {
      const metadata = statusMetadataSchema.parse({
        ...runningMetadata,
        status: 'DRAFT_PR_CREATED',
        pullRequestUrl: pulls[0]!.html_url,
      })
      const comment = await upsertStatusComment({
        github: options.github,
        identity: writerIdentity,
        repository,
        issueNumber,
        comments,
        metadata,
        detail: 'A matching trusted BOT Draft PR already exists; no model run, branch, push, or second PR was created.',
      })
      return activationContextSchema.parse({
        schemaVersion: 1,
        shouldRun: false,
        claimId: options.claimId,
        actionsRunId: options.actionsRunId,
        runUrl: options.runUrl,
        commentId: comment.id,
        branch,
        writerIdentity,
        removedBootstrapCommentCount: options.removedBootstrapCommentCount,
        request,
        config,
        admission,
        status: 'DRAFT_PR_CREATED',
        detail: 'A matching trusted BOT Draft PR already exists.',
      })
    }
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      'The deterministic head branch is associated with conflicting or untrusted pull request state.',
      admission.issueRevision,
      runKey,
      admission,
      branch,
    )
  }
  if (await options.github.getBranchSha(repository, branch) !== null) {
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      'The deterministic remote branch exists without a matching trusted open Draft PR.',
      admission.issueRevision,
      runKey,
      admission,
      branch,
    )
  }
  const claim = decideClaim({ existing: trusted?.metadata ?? null, candidate: runningMetadata, existingRunActive })
  if (claim.kind !== 'claimed') {
    if (claim.kind === 'duplicate') {
      const restored = await upsertStatusComment({
        github: options.github,
        identity: writerIdentity,
        repository,
        issueNumber,
        comments,
        metadata: trusted!.metadata,
        detail: `${claim.detail} Candidate Actions run ${options.runUrl} performed no model or writer action.`,
      })
      return activationContextSchema.parse({
        schemaVersion: 1,
        shouldRun: false,
        claimId: options.claimId,
        actionsRunId: options.actionsRunId,
        runUrl: options.runUrl,
        commentId: restored.id,
        branch: trusted!.metadata.branch,
        writerIdentity,
        removedBootstrapCommentCount: options.removedBootstrapCommentCount,
        request,
        config,
        admission,
        status: trusted!.metadata.status,
        detail: sanitizePublicLine(claim.detail),
      })
    }
    if (claim.kind === 'concurrent') {
      const restored = await upsertStatusComment({
        github: options.github,
        identity: writerIdentity,
        repository,
        issueNumber,
        comments,
        metadata: trusted!.metadata,
        detail: `${claim.detail} Candidate Actions run ${options.runUrl} performed no model or writer action.`,
      })
      return activationContextSchema.parse({
        schemaVersion: 1,
        shouldRun: false,
        claimId: options.claimId,
        actionsRunId: options.actionsRunId,
        runUrl: options.runUrl,
        commentId: restored.id,
        branch: trusted!.metadata.branch,
        writerIdentity,
        removedBootstrapCommentCount: options.removedBootstrapCommentCount,
        request,
        config,
        admission,
        status: 'NEEDS_HUMAN',
        detail: sanitizePublicLine(claim.detail),
      })
    }
    return terminalPreparation(
      options,
      writerIdentity,
      'NEEDS_HUMAN',
      claim.detail,
      admission.issueRevision,
      runKey,
      admission,
      branch,
    )
  }

  const comment = await upsertStatusComment({
    github: options.github,
    identity: writerIdentity,
    repository,
    issueNumber,
    comments,
    metadata: runningMetadata,
    detail: 'Deterministic admission, authorization, fixed revision/base, production scope, and durable claim checks passed. The credential-isolated OMA engine is running.',
  })
  return activationContextSchema.parse({
    schemaVersion: 1,
    shouldRun: true,
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    commentId: comment.id,
    branch,
    writerIdentity,
    removedBootstrapCommentCount: options.removedBootstrapCommentCount,
    request,
    config,
    admission,
    status: 'RUNNING',
    detail: 'The credential-isolated OMA engine is running.',
  })
}

export async function finalizeActivation(options: {
  readonly activation: ActivationContext
  readonly engineResult: EngineResult
  readonly originalEvent: unknown
  readonly github: GitHubClient
  readonly runner: CommandRunner
  readonly githubAppToken: string
  readonly writerContract: GitHubAppWriterContract
  readonly repoRoot: string
  readonly policy: ProductionPolicy
  readonly stateDir: string
  readonly artifactDir: string
  readonly finalizedAt: string
}): Promise<ActivationContext> {
  const activation = activationContextSchema.parse(options.activation)
  const engine = engineResultSchema.parse(options.engineResult)
  if (!activation.shouldRun) return activation
  if (activation.request === null || activation.config === null || activation.admission === null) {
    throw new Error('Runnable activation is missing request, configuration, or admission evidence.')
  }
  const request = activation.request
  const writerIdentity = await verifyGitHubAppWriter({
    github: options.github,
    repository: request.issue.repository,
    contract: options.writerContract,
  })
  if (!sameGitHubAppWriterIdentity(writerIdentity, activation.writerIdentity)) {
    throw new Error('The verified GitHub App writer identity changed between prepare and finalize.')
  }
  const runKey = computeRunKey({
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: activation.admission.issueRevision,
    baseSha: request.baseSha,
  })
  if (engine.status !== 'DRAFT_PR_PROPOSAL_READY' || engine.exitCode !== 0) {
    const status = engine.status === 'FAILED' ? 'FAILED' : 'NEEDS_HUMAN'
    return updateTerminalActivation(options, activation, status, engine.detail, runKey)
  }

  let currentRequest
  try {
    currentRequest = await buildControlPlaneRequest({
      event: options.originalEvent,
      github: options.github,
      policy: options.policy,
      eventId: request.eventId,
      receivedAt: request.receivedAt,
      writerIdentity,
      removedBootstrapCommentCount: activation.removedBootstrapCommentCount,
    })
  } catch (error) {
    const detail = error instanceof ControlPlaneBuildError ? error.reasons.join(' ') : 'Final GitHub revalidation failed.'
    return updateTerminalActivation(options, activation, 'NEEDS_HUMAN', detail, runKey)
  }
  const currentAdmission = evaluateAdmission(currentRequest)
  if (
    !currentAdmission.mayDevelop
    || currentAdmission.status !== 'AGENT_READY'
    || currentRequest.baseSha !== request.baseSha
    || currentRequest.authorization?.issueRevision !== request.authorization?.issueRevision
    || !currentRequest.issue.labels.includes(options.policy.agentReadyLabel)
    || currentRequest.issue.state !== 'open'
  ) {
    return updateTerminalActivation(
      options,
      activation,
      'NEEDS_HUMAN',
      'Issue state, label, material revision, authorizer permission, or default-branch base changed before the writer gate.',
      runKey,
    )
  }
  const comments = await options.github.listIssueComments(request.issue.repository, request.issue.number)
  const trusted = await findTrustedStatusComment({
    github: options.github,
    comments,
    identity: writerIdentity,
    repository: request.issue.repository,
    issueNumber: request.issue.number,
  })
  if (
    trusted === null
    || trusted.comment.id !== activation.commentId
    || trusted.metadata.status !== 'RUNNING'
    || trusted.metadata.claimId !== activation.claimId
    || trusted.metadata.runKey !== runKey
    || trusted.metadata.baseSha !== request.baseSha
    || trusted.metadata.issueRevision !== activation.admission.issueRevision
  ) {
    return updateTerminalActivation(
      options,
      activation,
      'NEEDS_HUMAN',
      'The authoritative trusted BOT status claim changed before the writer gate.',
      runKey,
    )
  }

  const manifest = contextManifestSchema.parse(JSON.parse(await readFile(join(options.artifactDir, `${runKey}.context.json`), 'utf8')))
  const proposal = draftPrProposalSchema.parse(JSON.parse(await readFile(join(options.artifactDir, `${runKey}.draft-pr-proposal.json`), 'utf8')))
  const record = runRecordSchema.parse(JSON.parse(await readFile(join(options.stateDir, `${runKey}.json`), 'utf8')))
  try {
    const repository = await options.github.getRepository(request.issue.repository)
    const result = await writeDraftPullRequest({
      repoRoot: options.repoRoot,
      runner: options.runner,
      github: options.github,
      githubAppToken: options.githubAppToken,
      writerIdentity,
      policy: options.policy,
      request: currentRequest,
      config: activation.config,
      manifest,
      proposal,
      record,
      runUrl: activation.runUrl,
      defaultBranch: repository.defaultBranch,
    })
    const store = new FileRunStateStore(options.stateDir)
    await acknowledgeDraftPrCreated(store, {
      runId: activation.claimId,
      runKey,
      proposalHash: proposal.proposalHash,
      pullRequestUrl: result.pullRequest.html_url,
    })
    const finalComments = await options.github.listIssueComments(request.issue.repository, request.issue.number)
    const metadata = statusMetadataSchema.parse({
      version: 2,
      repository: request.issue.repository,
      issueNumber: request.issue.number,
      status: 'DRAFT_PR_CREATED',
      claimId: activation.claimId,
      actionsRunId: activation.actionsRunId,
      runUrl: activation.runUrl,
      baseSha: request.baseSha,
      issueRevision: activation.admission.issueRevision,
      runKey,
      branch: result.branch,
      pullRequestUrl: result.pullRequest.html_url,
      updatedAt: options.finalizedAt,
    })
    const comment = await upsertStatusComment({
      github: options.github,
      identity: writerIdentity,
      repository: request.issue.repository,
      issueNumber: request.issue.number,
      comments: finalComments,
      metadata,
      detail: result.idempotent
        ? 'A matching open Draft PR already existed; no duplicate PR was created.'
        : 'Every deterministic gate passed and the host created one Draft PR. Human review is required.',
    })
    return activationContextSchema.parse({
      ...activation,
      shouldRun: false,
      commentId: comment.id,
      branch: result.branch,
      status: 'DRAFT_PR_CREATED',
      detail: result.idempotent ? 'Matching Draft PR reused.' : 'Draft PR created.',
    })
  } catch (error) {
    return updateTerminalActivation(
      options,
      activation,
      'NEEDS_HUMAN',
      `Final safe-output or deterministic writer gate stopped: ${error instanceof Error ? error.message : String(error)}`,
      runKey,
    )
  }
}

async function terminalPreparation(
  options: PrepareActivationOptions,
  writerIdentity: GitHubAppWriterIdentity,
  status: ActivationStatus,
  detail: string,
  issueRevision: string | null,
  runKey: string | null,
  admission: ReturnType<typeof evaluateAdmission> | null = null,
  branch: string | null = null,
): Promise<ActivationContext> {
  const event = githubLabelEventSchema.parse(options.event)
  const comments = await options.github.listIssueComments(event.repository.full_name, event.issue.number)
  const metadata = statusMetadataSchema.parse({
    version: 2,
    repository: event.repository.full_name,
    issueNumber: event.issue.number,
    status,
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    baseSha: options.baseShaHint,
    issueRevision,
    runKey,
    branch,
    pullRequestUrl: null,
    updatedAt: options.receivedAt,
  })
  const comment = await upsertStatusComment({
    github: options.github,
    identity: writerIdentity,
    repository: event.repository.full_name,
    issueNumber: event.issue.number,
    comments,
    metadata,
    detail,
  })
  return activationContextSchema.parse({
    schemaVersion: 1,
    shouldRun: false,
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    commentId: comment.id,
    branch,
    writerIdentity,
    removedBootstrapCommentCount: options.removedBootstrapCommentCount,
    request: null,
    config: null,
    admission,
    status,
    detail: sanitizePublicLine(detail),
  })
}

async function updateTerminalActivation(
  options: Parameters<typeof finalizeActivation>[0],
  activation: ActivationContext,
  status: 'NEEDS_HUMAN' | 'FAILED',
  detail: string,
  runKey: string,
): Promise<ActivationContext> {
  const request = activation.request!
  const comments = await options.github.listIssueComments(request.issue.repository, request.issue.number)
  const metadata = statusMetadataSchema.parse({
    version: 2,
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    status,
    claimId: activation.claimId,
    actionsRunId: activation.actionsRunId,
    runUrl: activation.runUrl,
    baseSha: request.baseSha,
    issueRevision: activation.admission!.issueRevision,
    runKey,
    branch: activation.branch,
    pullRequestUrl: null,
    updatedAt: options.finalizedAt,
  })
  const comment = await upsertStatusComment({
    github: options.github,
    identity: activation.writerIdentity,
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    comments,
    metadata,
    detail,
  })
  return activationContextSchema.parse({
    ...activation,
    shouldRun: false,
    commentId: comment.id,
    status,
    detail: sanitizePublicLine(detail),
  })
}

function publicStatusForAdmission(status: string): ActivationStatus {
  switch (status) {
    case 'NEEDS_CLARIFICATION':
    case 'READY_CANDIDATE':
      return 'NEEDS_CLARIFICATION'
    case 'MANUAL_ONLY':
      return 'MANUAL_ONLY'
    case 'FAILED':
      return 'FAILED'
    default:
      return 'NEEDS_HUMAN'
  }
}

export function renderActionsSummary(context: ActivationContext): string {
  const request = context.request
  const rows = [
    `# OMA Maintainer Bot — ${context.status}`,
    '',
    `- Actions run: ${context.runUrl}`,
    `- Issue: ${request === null ? 'from event payload' : `${request.issue.repository}#${request.issue.number}`}`,
    `- Base SHA: ${request?.baseSha ?? 'not resolved'}`,
    `- Issue revision: ${context.admission?.issueRevision ?? 'not resolved'}`,
    `- Branch: ${context.branch ?? 'not created'}`,
    '',
    sanitizePublicLine(context.detail),
    '',
    'No Ready, approval, merge, close, release, publish, tag, or deploy action was performed.',
  ]
  return `${rows.join('\n')}\n`
}
