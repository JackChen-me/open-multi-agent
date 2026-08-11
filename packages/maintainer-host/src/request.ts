import {
  computeIssueRevision,
  controlPlaneRequestSchema,
  maintainerIssueSchema,
  type ControlPlaneRequest,
  type MaintainerIssue,
} from '@open-multi-agent/maintainer-bot'
import type { GitHubClient } from './github.js'
import { parseIssueMarkdown } from './markdown.js'
import { deriveRiskFlags, resolveTargetWorkspaces } from './policy.js'
import {
  githubLabelEventSchema,
  type GitHubAppWriterIdentity,
  type GitHubLabelEvent,
  type ProductionPolicy,
} from './schema.js'
import { findTrustedStatusComment } from './status.js'
import { isMatchingBotDraftPullRequest } from './writer.js'

export class ControlPlaneBuildError extends Error {
  readonly code: string
  readonly publicStatus: 'NEEDS_CLARIFICATION' | 'MANUAL_ONLY' | 'NEEDS_HUMAN' | 'FAILED'
  readonly reasons: readonly string[]

  constructor(
    code: string,
    publicStatus: ControlPlaneBuildError['publicStatus'],
    reasons: readonly string[],
  ) {
    super(reasons.join(' '))
    this.name = 'ControlPlaneBuildError'
    this.code = code
    this.publicStatus = publicStatus
    this.reasons = reasons
  }
}

export interface BuildControlPlaneRequestOptions {
  readonly event: unknown
  readonly github: GitHubClient
  readonly policy: ProductionPolicy
  readonly eventId: string
  readonly receivedAt: string
  readonly writerIdentity: GitHubAppWriterIdentity
  readonly removedBootstrapCommentCount?: number
}

export async function buildControlPlaneRequest(
  options: BuildControlPlaneRequestOptions,
): Promise<ControlPlaneRequest> {
  const event = githubLabelEventSchema.parse(options.event)
  const removedBootstrapCommentCount = options.removedBootstrapCommentCount ?? 0
  if (!Number.isSafeInteger(removedBootstrapCommentCount) || removedBootstrapCommentCount < 0 || removedBootstrapCommentCount > 1) {
    throw new ControlPlaneBuildError(
      'INVALID_BOOTSTRAP_COMMENT_COUNT',
      'FAILED',
      ['The trusted bootstrap status cleanup count is invalid.'],
    )
  }
  assertCandidateEvent(event, options.policy)
  const repository = event.repository.full_name
  const repositoryMetadata = await options.github.getRepository(repository)
  if (repositoryMetadata.fullName !== repository || repositoryMetadata.defaultBranch !== event.repository.default_branch) {
    throw new ControlPlaneBuildError(
      'REPOSITORY_METADATA_MISMATCH',
      'NEEDS_HUMAN',
      ['Repository identity or default branch changed after the label event.'],
    )
  }
  const [currentIssue, comments, timeline, permission, baseSha] = await Promise.all([
    options.github.getIssue(repository, event.issue.number),
    options.github.listIssueComments(repository, event.issue.number),
    options.github.listIssueTimeline(repository, event.issue.number),
    options.github.getCollaboratorPermission(repository, event.sender.login),
    options.github.getBranchSha(repository, repositoryMetadata.defaultBranch),
  ])
  if (baseSha === null) {
    throw new ControlPlaneBuildError('DEFAULT_BRANCH_MISSING', 'NEEDS_HUMAN', ['The default branch could not be resolved to a fixed commit.'])
  }
  assertIssueStillMatchesEvent(event, currentIssue)

  const eventTimestamp = Date.parse(event.issue.updated_at)
  if (!Number.isFinite(eventTimestamp)) {
    throw new ControlPlaneBuildError('INVALID_EVENT_TIMESTAMP', 'FAILED', ['The label event contains an invalid issue timestamp.'])
  }
  let trustedStatus: Awaited<ReturnType<typeof findTrustedStatusComment>>
  try {
    trustedStatus = await findTrustedStatusComment({
      github: options.github,
      comments,
      identity: options.writerIdentity,
      repository,
      issueNumber: event.issue.number,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const mismatch = detail.includes('different repository or Issue')
    const duplicate = detail.includes('More than one trusted')
    throw new ControlPlaneBuildError(
      mismatch
        ? 'TRUSTED_STATUS_IDENTITY_MISMATCH'
        : duplicate
          ? 'MULTIPLE_TRUSTED_STATUS_COMMENTS'
          : 'TRUSTED_STATUS_METADATA_INVALID',
      'NEEDS_HUMAN',
      [mismatch
        ? 'The trusted Maintainer Bot status comment belongs to a different repository or Issue.'
        : duplicate
          ? 'More than one trusted Maintainer Bot status comment exists for this Issue.'
          : 'The trusted Maintainer Bot status comment has invalid metadata or App authorship provenance.'],
    )
  }
  const trustedStatusComments = trustedStatus === null ? [] : [trustedStatus]
  const trustedBotPullRequestNumbers = new Set<number>()
  const priorStatus = trustedStatusComments[0]?.metadata
  if (
    priorStatus !== undefined
    && priorStatus.runKey !== null
    && priorStatus.issueRevision !== null
    && priorStatus.branch !== null
  ) {
    const pulls = await options.github.listPullRequestsForHead(repository, priorStatus.branch)
    if (
      pulls.length === 1
      && isMatchingBotDraftPullRequest(
        pulls[0]!,
        priorStatus.runKey,
        repositoryMetadata.defaultBranch,
        priorStatus.baseSha,
        priorStatus.branch,
        options.writerIdentity,
      )
    ) {
      trustedBotPullRequestNumbers.add(pulls[0]!.number)
    }
  }
  const trustedIds = new Set(trustedStatusComments.map(item => item.comment.id))
  const materialComments = comments.filter(comment => !trustedIds.has(comment.id))
  const preAuthorizationTrustedCount = trustedStatusComments.filter(item =>
    item.metadata.claimId !== options.eventId
    && Date.parse(item.comment.created_at) <= eventTimestamp).length
  const expectedMaterialCommentCount = event.issue.comments
    - preAuthorizationTrustedCount
    - removedBootstrapCommentCount
  const postAuthorizationComment = materialComments.find(comment => Date.parse(comment.updated_at) > eventTimestamp)
  if (postAuthorizationComment !== undefined) {
    throw new ControlPlaneBuildError(
      'MATERIAL_COMMENT_AFTER_LABEL',
      'NEEDS_HUMAN',
      ['A material issue comment was added or edited after agent-ready authorization. Revalidate the Issue and label a fresh revision.'],
    )
  }
  if (expectedMaterialCommentCount < 0 || materialComments.length !== expectedMaterialCommentCount) {
    throw new ControlPlaneBuildError(
      'MATERIAL_COMMENT_SET_CHANGED',
      'NEEDS_HUMAN',
      ['The material Issue comment set changed after agent-ready authorization. Revalidate the Issue and label a fresh revision.'],
    )
  }
  const currentUpdatedAt = Date.parse(currentIssue.updated_at)
  const latestTrustedStatusUpdate = Math.max(
    eventTimestamp,
    ...trustedStatusComments.map(item => Date.parse(item.comment.updated_at)).filter(Number.isFinite),
  )
  if (
    !Number.isFinite(currentUpdatedAt)
    || currentUpdatedAt < eventTimestamp
    || currentUpdatedAt > latestTrustedStatusUpdate
  ) {
    throw new ControlPlaneBuildError(
      'ISSUE_UPDATED_AFTER_TRUSTED_SNAPSHOT',
      'NEEDS_HUMAN',
      ['The Issue changed after the latest trusted BOT snapshot. Revalidate the material revision before applying agent-ready again.'],
    )
  }

  const body = currentIssue.body ?? ''
  const markdown = parseIssueMarkdown(body)
  if (!markdown.ok) {
    throw new ControlPlaneBuildError(
      'ISSUE_MARKDOWN_INVALID',
      'NEEDS_CLARIFICATION',
      markdown.errors.map(error => `${error.code}: ${error.message}`),
    )
  }
  const labels = labelNames(currentIssue.labels)
  let targetWorkspaces: string[]
  try {
    targetWorkspaces = resolveTargetWorkspaces(options.policy, markdown.value.targetPaths)
  } catch (error) {
    throw new ControlPlaneBuildError(
      'TARGET_POLICY_REJECTED',
      'NEEDS_CLARIFICATION',
      [error instanceof Error ? error.message : String(error)],
    )
  }
  const issue = maintainerIssueSchema.parse({
    repository,
    number: currentIssue.number,
    title: currentIssue.title,
    body,
    state: currentIssue.state,
    author: currentIssue.user.login,
    updatedAt: event.issue.updated_at,
    labels,
    comments: materialComments.map(comment => ({
      id: String(comment.id),
      author: comment.user.login,
      body: comment.body ?? '',
      updatedAt: comment.updated_at,
    })),
    kind: deriveIssueKind(labels, markdown.value.targetPaths),
    problem: markdown.value.problem,
    reproductionSteps: markdown.value.reproductionSteps,
    currentBehavior: markdown.value.currentBehavior,
    expectedBehavior: markdown.value.expectedBehavior,
    acceptanceCriteria: markdown.value.acceptanceCriteria,
    targetWorkspaces,
    targetPaths: markdown.value.targetPaths,
    outOfScope: markdown.value.outOfScope,
    openDecisions: markdown.value.openDecisions,
    riskFlags: deriveRiskFlags({
      policy: options.policy,
      targetPaths: markdown.value.targetPaths,
      targetWorkspaces,
      title: currentIssue.title,
      body: [
        markdown.value.problem,
        markdown.value.currentBehavior,
        markdown.value.expectedBehavior,
      ].join('\n'),
      labels,
    }),
    linkedPullRequests: linkedPullRequests(timeline, trustedBotPullRequestNumbers),
    blockers: markdown.value.blockers,
  })
  const issueRevision = computeIssueRevision(issue)
  return controlPlaneRequestSchema.parse({
    schemaVersion: 1,
    eventId: options.eventId,
    receivedAt: options.receivedAt,
    baseSha,
    issue,
    authorization: {
      kind: 'label',
      label: 'agent-ready',
      grantedBy: event.sender.login,
      grantedByPermission: normalizePermission(permission),
      issueRevision,
      baseSha,
      grantedAt: event.issue.updated_at,
    },
  })
}

function assertCandidateEvent(event: GitHubLabelEvent, policy: ProductionPolicy): void {
  if (!policy.enabled) {
    throw new ControlPlaneBuildError('BOT_DISABLED', 'NEEDS_HUMAN', ['OMA Maintainer Bot is disabled by trusted repository policy.'])
  }
  if (event.repository.full_name !== policy.repository) {
    throw new ControlPlaneBuildError('WRONG_REPOSITORY', 'FAILED', ['The label event targets a repository outside trusted policy.'])
  }
  if (event.label.name !== policy.agentReadyLabel) {
    throw new ControlPlaneBuildError('NOT_AGENT_READY', 'FAILED', ['Only the exact agent-ready label can authorize a candidate run.'])
  }
}

function assertIssueStillMatchesEvent(event: GitHubLabelEvent, current: {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  user: { login: string }
  labels: Array<string | { name: string }>
}): void {
  const eventLabels = labelNames(event.issue.labels)
  const currentLabels = labelNames(current.labels)
  const matches = current.number === event.issue.number
    && current.title === event.issue.title
    && (current.body ?? '') === (event.issue.body ?? '')
    && current.state === event.issue.state
    && current.user.login === event.issue.user.login
    && JSON.stringify(eventLabels) === JSON.stringify(currentLabels)
  if (!matches) {
    throw new ControlPlaneBuildError(
      'ISSUE_CHANGED_AFTER_LABEL',
      'NEEDS_HUMAN',
      ['Issue title, body, state, labels, or author changed after agent-ready authorization. Revalidate and label a fresh revision.'],
    )
  }
}

function labelNames(labels: Array<string | { name: string }>): string[] {
  return [...new Set(labels.map(label => typeof label === 'string' ? label : label.name))].sort()
}

function deriveIssueKind(labels: readonly string[], paths: readonly string[]): MaintainerIssue['kind'] {
  const lower = new Set(labels.map(label => label.toLowerCase()))
  if ([...lower].some(label => label.includes('security'))) return 'security'
  if (lower.has('bug')) return 'bug'
  if (lower.has('enhancement') || lower.has('feature')) return 'feature'
  if ([...lower].some(label => label.includes('question'))) return 'question'
  if ([...lower].some(label => label.includes('discussion'))) return 'discussion'
  if ([...lower].some(label => label.includes('tracker'))) return 'tracker'
  if ([...lower].some(label => label.includes('dependency'))) return 'dependency'
  if ([...lower].some(label => label.includes('refactor'))) return 'refactor'
  if (paths.every(path => path.startsWith('docs/') || path.endsWith('README.md'))) return 'docs'
  if (paths.every(path => path.includes('/tests/') || /\.test\.[^.]+$/.test(path))) return 'test'
  return 'other'
}

function linkedPullRequests(timeline: readonly {
  event: string
  source?: { issue?: { number: number; state: 'open' | 'closed'; pull_request?: { merged_at?: string | null } } }
}[], excludedPullRequestNumbers: ReadonlySet<number>): Array<{ number: number; state: 'open' | 'closed' | 'merged' }> {
  const pulls = new Map<number, { number: number; state: 'open' | 'closed' | 'merged' }>()
  for (const item of timeline) {
    const issue = item.source?.issue
    if (item.event !== 'cross-referenced' || issue?.pull_request === undefined) continue
    if (excludedPullRequestNumbers.has(issue.number)) continue
    pulls.set(issue.number, {
      number: issue.number,
      state: issue.pull_request.merged_at ? 'merged' : issue.state,
    })
  }
  return [...pulls.values()].sort((a, b) => a.number - b.number)
}

function normalizePermission(
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none',
): 'admin' | 'maintain' | 'write' | 'triage' | 'read' {
  return permission === 'none' ? 'read' : permission
}
