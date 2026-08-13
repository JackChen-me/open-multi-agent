import { hashJson, type CommandRunner } from '@open-multi-agent/maintainer-bot'
import { verifyGitHubAppWriter, sameGitHubAppWriterIdentity } from './app-auth.js'
import type { GitHubClient } from './github.js'
import { sanitizePublicLine } from './public-output.js'
import {
  bootstrapFailureStageSchema,
  bootstrapStatusMetadataSchema,
  githubLabelEventSchema,
  startFailureStageSchema,
  startContextSchema,
  statusMetadataSchema,
  type BootstrapFailureStage,
  type GitHubAppWriterContract,
  type ProductionPolicy,
  type StartContext,
  type StartFailureStage,
  type StatusMetadata,
} from './schema.js'
import {
  BOOTSTRAP_BOT_LOGIN,
  BOOTSTRAP_BOT_USER_ID,
  BOOTSTRAP_STATUS_MARKER,
  assertBootstrapStatusCommentAuthorship,
  assertTrustedStatusCommentAuthorship,
  findTrustedStatusComment,
  publicActivationStatus,
  renderStartedStatusComment,
  renderStatusComment,
  upsertStatusComment,
} from './status.js'

export interface StartWorkflowOptions {
  readonly event: unknown
  readonly github: GitHubClient
  readonly runner: CommandRunner
  readonly repoRoot: string
  readonly policy: ProductionPolicy
  readonly claimId: string
  readonly actionsRunId: number
  readonly runUrl: string
  readonly workflowSha: string
  readonly writerContract: GitHubAppWriterContract
  readonly startedAt: string
}

export class StartWorkflowError extends Error {
  readonly stage: StartFailureStage
  readonly publicDetail: string

  constructor(stage: StartFailureStage, publicDetail: string, cause?: unknown) {
    super(publicDetail, cause === undefined ? undefined : { cause })
    this.name = 'StartWorkflowError'
    this.stage = startFailureStageSchema.parse(stage)
    this.publicDetail = sanitizePublicLine(publicDetail)
  }
}

export async function startWorkflow(options: StartWorkflowOptions): Promise<StartContext> {
  let event: ReturnType<typeof githubLabelEventSchema.parse>
  try {
    event = githubLabelEventSchema.parse(options.event)
  } catch (error) {
    throw new StartWorkflowError('event-policy', 'The workflow event does not match the trusted issues.labeled contract.', error)
  }
  const repository = event.repository.full_name
  if (
    !options.policy.enabled
    || repository !== options.policy.repository
    || event.label.name !== options.policy.agentReadyLabel
  ) {
    throw new StartWorkflowError('event-policy', 'The label event is outside the enabled Maintainer Bot production policy.')
  }
  let writerIdentity
  try {
    writerIdentity = await verifyGitHubAppWriter({
      github: options.github,
      repository,
      contract: options.writerContract,
    })
  } catch (error) {
    throw new StartWorkflowError(
      'app-identity',
      'The minted GitHub App token did not pass the trusted identity, installation, permission, and repository-scope contract.',
      error,
    )
  }
  let repositoryMetadata
  try {
    repositoryMetadata = await options.github.getRepository(repository)
  } catch (error) {
    throw new StartWorkflowError('repository-metadata', 'The trusted repository metadata could not be resolved.', error)
  }
  if (
    repositoryMetadata.fullName !== repository
    || repositoryMetadata.defaultBranch !== event.repository.default_branch
  ) {
    throw new StartWorkflowError('repository-metadata', 'Repository identity or default branch changed after workflow dispatch.')
  }
  let currentIssue
  try {
    currentIssue = await options.github.getIssue(repository, event.issue.number)
  } catch (error) {
    throw new StartWorkflowError('issue-snapshot', 'The current Issue snapshot could not be resolved.', error)
  }
  if (!issueSnapshotMatches(event.issue, currentIssue)) {
    throw new StartWorkflowError(
      'issue-snapshot',
      'The Issue changed between the labeled event and the first trusted GitHub snapshot.',
    )
  }
  let baseSha
  try {
    baseSha = await options.github.getBranchSha(repository, repositoryMetadata.defaultBranch)
  } catch (error) {
    throw new StartWorkflowError('base-identity', 'The current default-branch base could not be resolved.', error)
  }
  if (baseSha === null) {
    throw new StartWorkflowError('base-identity', 'The default branch could not be resolved to a fixed commit.')
  }
  if (!/^[0-9a-f]{40}$/.test(options.workflowSha) || options.workflowSha !== baseSha) {
    throw new StartWorkflowError(
      'base-identity',
      'The default branch moved after workflow dispatch; a fresh agent-ready authorization is required.',
    )
  }
  let localHeadResult
  let localStatusResult
  try {
    [localHeadResult, localStatusResult] = await Promise.all([
      options.runner.run('git', ['rev-parse', 'HEAD'], { cwd: options.repoRoot }),
      options.runner.run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: options.repoRoot }),
    ])
  } catch (error) {
    throw new StartWorkflowError('local-checkout', 'The trusted workflow checkout could not be verified.', error)
  }
  if (localHeadResult.stdout.trim() !== baseSha || localStatusResult.stdout.trim().length > 0) {
    throw new StartWorkflowError(
      'local-checkout',
      'The trusted workflow checkout is not clean at GITHUB_WORKFLOW_SHA and the current default-branch SHA.',
    )
  }

  let comments
  let trusted
  try {
    comments = await options.github.listIssueComments(repository, event.issue.number)
    trusted = await findTrustedStatusComment({
      github: options.github,
      comments,
      identity: writerIdentity,
      repository,
      issueNumber: event.issue.number,
    })
  } catch (error) {
    throw new StartWorkflowError(
      'status-preflight',
      'The authoritative Maintainer Bot status state or App authorship provenance could not be verified.',
      error,
    )
  }
  const bootstrap = comments.filter(comment =>
    comment.user.id === BOOTSTRAP_BOT_USER_ID
    && comment.user.login === BOOTSTRAP_BOT_LOGIN
    && comment.user.type === 'Bot'
    && comment.body?.includes(BOOTSTRAP_STATUS_MARKER))
  if (bootstrap.length > 1) {
    throw new StartWorkflowError('status-preflight', 'Multiple trusted bootstrap failure comments exist.')
  }
  if (bootstrap[0] !== undefined) {
    try {
      await assertBootstrapStatusCommentAuthorship(options.github, bootstrap[0])
      await options.github.deleteIssueComment(repository, bootstrap[0].id)
    } catch (error) {
      throw new StartWorkflowError(
        'status-preflight',
        'The prior non-authoritative bootstrap notice could not be verified and removed safely.',
        error,
      )
    }
  }

  const pending = statusMetadataSchema.parse({
    version: 2,
    repository,
    issueNumber: event.issue.number,
    status: 'STARTED',
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    baseSha,
    issueRevision: null,
    runKey: null,
    branch: null,
    pullRequestUrl: null,
    updatedAt: options.startedAt,
  })
  const markerMetadata = trusted?.metadata ?? pending
  const detail = trusted === null
    ? 'The dedicated GitHub App identity, event snapshot, and default-branch base passed preflight. Runtime installation and sandbox checks are starting; no durable run claim exists yet.'
    : 'The new label event passed App and snapshot preflight. The previous durable machine claim remains authoritative until runtime preflight and deterministic admission finish.'
  const body = renderStartedStatusComment(markerMetadata, detail, {
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    baseSha,
  })
  let comment
  try {
    comment = trusted === null
      ? await options.github.createIssueComment(repository, event.issue.number, body)
      : await options.github.updateIssueComment(repository, trusted.comment.id, body)
    await assertTrustedStatusCommentAuthorship(options.github, comment, writerIdentity)
  } catch (error) {
    throw new StartWorkflowError(
      'status-write',
      'The App-authenticated STARTED status could not be written and verified safely.',
      error,
    )
  }
  const partial = {
    schemaVersion: 1,
    repository,
    issueNumber: event.issue.number,
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    commentId: comment.id,
    baseSha,
    eventSnapshotMatched: true,
    removedBootstrapCommentCount: bootstrap.length,
    executionBackend: options.policy.executionBackend,
    writerIdentity,
    startedAt: options.startedAt,
  } as const
  return startContextSchema.parse({ ...partial, artifactHash: hashJson(partial) })
}

export function verifyStartContextHash(start: StartContext, expectedHash: string): StartContext {
  const parsed = startContextSchema.parse(start)
  const { artifactHash, ...partial } = parsed
  const actual = hashJson(partial)
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || artifactHash !== actual || expectedHash !== actual) {
    throw new Error('The STARTED artifact hash does not match its trusted step output.')
  }
  return parsed
}

export async function recoverStartFailure(options: {
  readonly event: unknown
  readonly github: GitHubClient
  readonly policy: ProductionPolicy
  readonly claimId: string
  readonly actionsRunId: number
  readonly runUrl: string
  readonly writerContract: GitHubAppWriterContract
  readonly failureStage: StartFailureStage
  readonly failureDetail: string
  readonly recoveredAt: string
}): Promise<{
  readonly status: 'FAILED'
  readonly authoritativeStatus: ReturnType<typeof publicActivationStatus>
  readonly stage: StartFailureStage
  readonly detail: string
}> {
  const event = githubLabelEventSchema.parse(options.event)
  const stage = startFailureStageSchema.parse(options.failureStage)
  const repository = event.repository.full_name
  if (
    !options.policy.enabled
    || repository !== options.policy.repository
    || event.label.name !== options.policy.agentReadyLabel
  ) {
    throw new Error('Start recovery event is outside the enabled Maintainer Bot production policy.')
  }
  assertWorkflowRunIdentity({
    repository,
    claimId: options.claimId,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
  })
  const identity = await verifyGitHubAppWriter({
    github: options.github,
    repository,
    contract: options.writerContract,
  })
  let repositoryMetadata: Awaited<ReturnType<GitHubClient['getRepository']>>
  try {
    repositoryMetadata = await options.github.getRepository(repository)
  } catch {
    throw new Error('Start recovery could not resolve trusted repository metadata.')
  }
  if (
    repositoryMetadata.fullName !== repository
    || repositoryMetadata.defaultBranch !== event.repository.default_branch
  ) {
    throw new Error('Start recovery repository identity does not match the trusted event.')
  }
  let currentIssue: Awaited<ReturnType<GitHubClient['getIssue']>>
  let baseSha: string | null
  let comments: Awaited<ReturnType<GitHubClient['listIssueComments']>>
  try {
    [currentIssue, baseSha, comments] = await Promise.all([
      options.github.getIssue(repository, event.issue.number),
      options.github.getBranchSha(repository, repositoryMetadata.defaultBranch),
      options.github.listIssueComments(repository, event.issue.number),
    ])
  } catch {
    throw new Error('Start recovery could not resolve the current Issue, base, and status state.')
  }
  if (currentIssue.number !== event.issue.number || baseSha === null) {
    throw new Error('Start recovery could not bind the event Issue and current default-branch base.')
  }
  const trusted = await findTrustedStatusComment({
    github: options.github,
    comments,
    identity,
    repository,
    issueNumber: event.issue.number,
  })
  const failureDetail = sanitizePublicLine(options.failureDetail)
  let metadata: StatusMetadata
  let detail: string
  if (trusted === null) {
    metadata = statusMetadataSchema.parse({
      version: 2,
      repository,
      issueNumber: event.issue.number,
      status: 'FAILED',
      claimId: options.claimId,
      actionsRunId: options.actionsRunId,
      runUrl: options.runUrl,
      baseSha,
      issueRevision: null,
      runKey: null,
      branch: null,
      pullRequestUrl: null,
      updatedAt: options.recoveredAt,
    })
    detail = `Typed start failed at ${stage}. ${failureDetail} No durable runKey, model run, branch, push, or Draft PR was authorized.`
  } else if (trusted.metadata.claimId !== options.claimId) {
    metadata = trusted.metadata
    detail = `Typed start failed at ${stage}. ${failureDetail} The earlier authoritative ${publicActivationStatus(metadata.status)} state and durable claim ledger were preserved unchanged.`
  } else if (trusted.metadata.status !== 'STARTED' && trusted.metadata.status !== 'RUNNING') {
    metadata = trusted.metadata
    detail = `Typed start failed at ${stage}. ${failureDetail} The already-terminal authoritative ${publicActivationStatus(metadata.status)} state and durable claim ledger were preserved unchanged.`
  } else {
    metadata = statusMetadataSchema.parse({
      ...trusted.metadata,
      status: trusted.metadata.runKey === null ? 'FAILED' : 'NEEDS_HUMAN',
      updatedAt: options.recoveredAt,
    })
    detail = trusted.metadata.runKey === null
      ? `Typed start failed at ${stage}. ${failureDetail} The non-durable STARTED state was closed without authorizing a model run or Draft PR.`
      : `Typed start failed at ${stage} after a durable RUNNING claim. ${failureDetail} Automatic resume is forbidden; the runKey and bounded claim ledger were preserved.`
  }
  await upsertStatusComment({
    github: options.github,
    identity,
    repository,
    issueNumber: event.issue.number,
    comments,
    metadata,
    detail,
  })
  return {
    status: 'FAILED',
    authoritativeStatus: publicActivationStatus(metadata.status),
    stage,
    detail: sanitizePublicLine(detail),
  }
}

export async function publishBootstrapFailure(options: {
  readonly event: unknown
  readonly github: GitHubClient
  readonly actionsRunId: number
  readonly runUrl: string
  readonly stage: BootstrapFailureStage
  readonly publishedAt: string
}): Promise<{ readonly status: 'FAILED'; readonly baseSha: string; readonly detail: string }> {
  const event = githubLabelEventSchema.parse(options.event)
  const stage = bootstrapFailureStageSchema.parse(options.stage)
  const repository = event.repository.full_name
  const viewer = await options.github.getAuthenticatedViewerLogin()
  if (viewer !== BOOTSTRAP_BOT_LOGIN) {
    throw new Error('Bootstrap failure notice does not have the expected repository token identity.')
  }
  const repositoryMetadata = await options.github.getRepository(repository)
  const baseSha = await options.github.getBranchSha(repository, repositoryMetadata.defaultBranch)
  if (baseSha === null) throw new Error('Bootstrap failure notice could not resolve the default branch.')
  const comments = await options.github.listIssueComments(repository, event.issue.number)
  const found = comments.filter(comment =>
    comment.user.id === BOOTSTRAP_BOT_USER_ID
    && comment.user.login === BOOTSTRAP_BOT_LOGIN
    && comment.user.type === 'Bot'
    && comment.body?.includes(BOOTSTRAP_STATUS_MARKER))
  if (found.length > 1) throw new Error('Multiple trusted bootstrap failure comments exist.')
  if (found[0] !== undefined) await assertBootstrapStatusCommentAuthorship(options.github, found[0])
  const reason = stage === 'app-token-mint'
    ? 'APP_TOKEN_UNAVAILABLE'
    : 'APP_IDENTITY_OR_RECOVERY_UNVERIFIED'
  const detail = stage === 'app-token-mint'
    ? 'The dedicated Maintainer Bot GitHub App is disabled, missing required configuration, or its installation token could not be minted. No App-authenticated start, model, or writer process ran.'
    : 'A token was minted, but the trusted App identity/scope could not be verified or App-authenticated start recovery could not safely publish a terminal update. No model or writer process ran.'
  const metadata = bootstrapStatusMetadataSchema.parse({
    version: 1,
    repository,
    issueNumber: event.issue.number,
    status: 'FAILED',
    stage,
    reason,
    detail,
    actionsRunId: options.actionsRunId,
    runUrl: options.runUrl,
    baseSha,
    updatedAt: options.publishedAt,
  })
  const body = `${[
    `<!-- ${BOOTSTRAP_STATUS_MARKER} ${JSON.stringify(metadata)} -->`,
    '## OMA Maintainer Bot — FAILED',
    '',
    `- Actions run: [${options.actionsRunId}](${options.runUrl})`,
    `- Base SHA: \`${baseSha}\``,
    '- Issue revision: `not resolved`',
    `- Failure stage: \`${stage}\``,
    `- Reason: \`${reason}\``,
    '',
    detail,
    '',
    '_This bootstrap status is non-authoritative: it has no durable run claim and cannot authorize a model run or Draft PR. Any earlier App-authenticated claim remains authoritative._',
  ].join('\n')}\n`
  const written = found[0] === undefined
    ? await options.github.createIssueComment(repository, event.issue.number, body)
    : await options.github.updateIssueComment(repository, found[0].id, body)
  await assertBootstrapStatusCommentAuthorship(options.github, written)
  return { status: 'FAILED', baseSha, detail }
}

export async function recoverWorkflowFailure(options: {
  readonly event: unknown
  readonly start: StartContext
  readonly github: GitHubClient
  readonly writerContract: GitHubAppWriterContract
  readonly recoveredAt: string
}): Promise<{ readonly status: ReturnType<typeof publicActivationStatus>; readonly detail: string }> {
  const event = githubLabelEventSchema.parse(options.event)
  const start = startContextSchema.parse(options.start)
  if (start.repository !== event.repository.full_name || start.issueNumber !== event.issue.number) {
    throw new Error('Recovery start artifact does not belong to this Issue.')
  }
  const identity = await verifyGitHubAppWriter({
    github: options.github,
    repository: start.repository,
    contract: options.writerContract,
  })
  if (!sameGitHubAppWriterIdentity(identity, start.writerIdentity)) {
    throw new Error('Recovery App identity differs from the verified start identity.')
  }
  const comments = await options.github.listIssueComments(start.repository, start.issueNumber)
  const trusted = await findTrustedStatusComment({
    github: options.github,
    comments,
    identity,
    repository: start.repository,
    issueNumber: start.issueNumber,
  })
  if (trusted === null || trusted.comment.id !== start.commentId) {
    throw new Error('Recovery could not find the single trusted App status comment from start.')
  }
  const previous = trusted.metadata
  const sameClaim = previous.claimId === start.claimId
  const activeClaim = sameClaim && (previous.status === 'STARTED' || previous.status === 'RUNNING')
  const terminalClaim = sameClaim && !activeClaim
  let metadata: StatusMetadata
  let detail: string
  if (terminalClaim) {
    metadata = previous
    detail = `The control layer had already published terminal state ${publicActivationStatus(previous.status)}; recovery preserved that authoritative terminal result and durable claim ledger.`
  } else if (activeClaim) {
    metadata = statusMetadataSchema.parse({
      ...previous,
      status: previous.status === 'RUNNING' ? 'NEEDS_HUMAN' : 'FAILED',
      updatedAt: options.recoveredAt,
    })
    detail = previous.status === 'RUNNING'
      ? 'The control layer stopped after a durable RUNNING claim. Automatic model resume is forbidden; inspect this run and reauthorize a fresh revision or base.'
      : 'The control layer stopped before establishing a durable runKey. No model resume or Draft PR was authorized.'
  } else {
    metadata = statusMetadataSchema.parse({
      version: 2,
      repository: start.repository,
      issueNumber: start.issueNumber,
      status: 'FAILED',
      claimId: start.claimId,
      actionsRunId: start.actionsRunId,
      runUrl: start.runUrl,
      baseSha: start.baseSha,
      issueRevision: null,
      runKey: null,
      branch: null,
      pullRequestUrl: null,
      updatedAt: options.recoveredAt,
    })
    detail = 'The control layer failed before it established a durable claim for this run. The prior claim remains in the bounded ledger; no model resume or Draft PR was authorized.'
  }
  await upsertStatusComment({
    github: options.github,
    identity,
    repository: start.repository,
    issueNumber: start.issueNumber,
    comments,
    metadata,
    detail,
  })
  return { status: publicActivationStatus(metadata.status), detail: sanitizePublicLine(detail) }
}

function issueSnapshotMatches(
  eventIssue: ReturnType<typeof githubLabelEventSchema.parse>['issue'],
  current: Awaited<ReturnType<GitHubClient['getIssue']>>,
): boolean {
  const labels = (values: Array<string | { name: string }>) =>
    [...new Set(values.map(value => typeof value === 'string' ? value : value.name))].sort()
  return current.number === eventIssue.number
    && current.title === eventIssue.title
    && (current.body ?? '') === (eventIssue.body ?? '')
    && current.state === eventIssue.state
    && current.updated_at === eventIssue.updated_at
    && current.comments === eventIssue.comments
    && current.user.login === eventIssue.user.login
    && JSON.stringify(labels(current.labels)) === JSON.stringify(labels(eventIssue.labels))
}

function assertWorkflowRunIdentity(input: {
  readonly repository: string
  readonly claimId: string
  readonly actionsRunId: number
  readonly runUrl: string
}): void {
  const escapedRunId = String(input.actionsRunId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`^${escapedRunId}\\.[1-9]\\d*$`).test(input.claimId)) {
    throw new Error('Start recovery claim ID is not bound to the current Actions run and attempt.')
  }
  let url: URL
  try {
    url = new URL(input.runUrl)
  } catch {
    throw new Error('Start recovery run URL is invalid.')
  }
  if (
    url.protocol !== 'https:'
    || url.search.length > 0
    || url.hash.length > 0
    || url.pathname !== `/${input.repository}/actions/runs/${input.actionsRunId}`
  ) {
    throw new Error('Start recovery run URL is not bound to the current repository and Actions run.')
  }
}
