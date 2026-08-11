import {
  statusMetadataSchema,
  type GitHubComment,
  type GitHubAppWriterIdentity,
  type StatusClaim,
  type StatusMetadata,
} from './schema.js'
import type { GitHubClient } from './github.js'
import { sanitizePublicLine } from './public-output.js'

export const STATUS_MARKER = 'oma-maintainer-bot-status:v2'
export const BOOTSTRAP_STATUS_MARKER = 'oma-maintainer-bot-bootstrap-status:v1'

export type ClaimDecision =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'duplicate'; readonly detail: string }
  | { readonly kind: 'concurrent'; readonly detail: string }
  | { readonly kind: 'stale-needs-human'; readonly detail: string }

export function renderStatusComment(metadataInput: StatusMetadata, detail: string): string {
  const metadata = statusMetadataSchema.parse(metadataInput)
  const safeDetail = sanitizePublicLine(detail)
  const rows = [
    `<!-- ${STATUS_MARKER} ${JSON.stringify(metadata)} -->`,
    `## OMA Maintainer Bot — ${metadata.status}`,
    '',
    `- Actions run: [${metadata.actionsRunId}](${metadata.runUrl})`,
    `- Base SHA: \`${metadata.baseSha}\``,
    `- Issue revision: ${metadata.issueRevision === null ? '`pending`' : `\`${metadata.issueRevision}\``}`,
  ]
  if (metadata.branch !== null) rows.push(`- Branch: \`${metadata.branch}\``)
  if (metadata.pullRequestUrl !== null) rows.push(`- Draft PR: ${metadata.pullRequestUrl}`)
  rows.push('', safeDetail, '', '_This bot creates Draft PRs only. It never approves, merges, closes, releases, publishes, tags, or deploys._')
  return `${rows.join('\n')}\n`
}

export function parseStatusComment(body: string): StatusMetadata | null {
  const escaped = STATUS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...body.matchAll(new RegExp(`<!--\\s*${escaped}\\s+(\\{[^\\n]*\\})\\s*-->`, 'g'))]
  if (matches.length === 0) return null
  if (matches.length !== 1) throw new Error('Maintainer Bot status comment contains multiple machine markers.')
  try {
    return statusMetadataSchema.parse(JSON.parse(matches[0]![1]!))
  } catch {
    throw new Error('Maintainer Bot status comment contains invalid machine metadata.')
  }
}

export function isTrustedStatusComment(
  comment: GitHubComment,
  identity: GitHubAppWriterIdentity,
): boolean {
  return isExpectedAppBotUser(comment.user, identity)
}

export function isExpectedAppBotUser(
  user: { readonly id: number; readonly login: string; readonly type: string },
  identity: GitHubAppWriterIdentity,
): boolean {
  return user.id === identity.botUserId
    && user.login === identity.botLogin
    && user.type === 'Bot'
}

export async function findTrustedStatusComment(input: {
  readonly github: GitHubClient
  readonly comments: readonly GitHubComment[]
  readonly identity: GitHubAppWriterIdentity
  readonly repository: string
  readonly issueNumber: number
}): Promise<{ comment: GitHubComment; metadata: StatusMetadata } | null> {
  const found: Array<{ comment: GitHubComment; metadata: StatusMetadata }> = []
  for (const comment of input.comments) {
    if (!isTrustedStatusComment(comment, input.identity) || comment.body === null || !comment.body.includes(STATUS_MARKER)) continue
    await assertTrustedStatusCommentAuthorship(input.github, comment, input.identity)
    const metadata = parseStatusComment(comment.body)
    if (metadata === null) continue
    if (metadata.repository !== input.repository || metadata.issueNumber !== input.issueNumber) {
      throw new Error('Trusted Maintainer Bot status comment belongs to a different repository or Issue.')
    }
    found.push({ comment, metadata })
  }
  if (found.length > 1) throw new Error('More than one trusted Maintainer Bot status comment exists for this issue.')
  return found[0] ?? null
}

export function decideClaim(input: {
  readonly existing: StatusMetadata | null
  readonly candidate: StatusMetadata
  readonly existingRunActive: boolean
}): ClaimDecision {
  const existing = input.existing === null ? null : statusMetadataSchema.parse(input.existing)
  const candidate = statusMetadataSchema.parse(input.candidate)
  if (existing === null) return { kind: 'claimed' }
  if (existing.claimId === candidate.claimId && existing.actionsRunId === candidate.actionsRunId) {
    return { kind: 'claimed' }
  }
  const matching = candidate.runKey === null ? undefined : durableClaims(existing)
    .find(claim => claim.runKey === candidate.runKey)
  if (matching !== undefined) {
    if (matching.status === 'RUNNING' || matching.status === 'STARTED') {
      const matchingCurrent = existing.runKey === matching.runKey && existing.claimId === matching.claimId
      return input.existingRunActive
        && matchingCurrent
        ? { kind: 'concurrent', detail: 'The same issue revision and base SHA already has an active Actions run.' }
        : { kind: 'stale-needs-human', detail: 'A prior RUNNING claim is no longer active. Automatic model resume is forbidden; a maintainer must reauthorize a fresh revision or base.' }
    }
    return {
      kind: 'duplicate',
      detail: `The same issue revision and base SHA already reached terminal state ${matching.status}; no second run or Draft PR was created.`,
    }
  }
  if ((existing.status === 'RUNNING' || existing.status === 'STARTED') && input.existingRunActive) {
    return { kind: 'concurrent', detail: 'Another Maintainer Bot claim for this issue is still active.' }
  }
  return { kind: 'claimed' }
}

export async function upsertStatusComment(input: {
  readonly github: GitHubClient
  readonly identity: GitHubAppWriterIdentity
  readonly repository: string
  readonly issueNumber: number
  readonly comments: readonly GitHubComment[]
  readonly metadata: StatusMetadata
  readonly detail: string
}): Promise<GitHubComment> {
  const existing = await findTrustedStatusComment({
    github: input.github,
    comments: input.comments,
    identity: input.identity,
    repository: input.repository,
    issueNumber: input.issueNumber,
  })
  const metadata = mergeStatusMetadata(existing?.metadata ?? null, input.metadata)
  const body = renderStatusComment(metadata, input.detail)
  const result = existing === null
    ? input.github.createIssueComment(input.repository, input.issueNumber, body)
    : input.github.updateIssueComment(input.repository, existing.comment.id, body)
  const comment = await result
  await assertTrustedStatusCommentAuthorship(input.github, comment, input.identity)
  return comment
}

async function assertTrustedStatusCommentAuthorship(
  github: GitHubClient,
  comment: GitHubComment,
  identity: GitHubAppWriterIdentity,
): Promise<void> {
  if (!isExpectedAppBotUser(comment.user, identity)) {
    throw new Error('GitHub did not attribute the status comment to the expected Maintainer Bot App user.')
  }
  const authorship = await github.getIssueCommentAuthorship(comment.node_id)
  if (
    authorship.authorLogin !== identity.botLogin
    || authorship.viewerDidAuthor !== true
    || authorship.createdViaEmail
    || authorship.editorLogin !== null && authorship.editorLogin !== identity.botLogin
  ) {
    throw new Error('Maintainer Bot status comment authorship or editor provenance is not the expected GitHub App.')
  }
}

export function mergeStatusMetadata(
  existingInput: StatusMetadata | null,
  nextInput: StatusMetadata,
): StatusMetadata {
  const next = statusMetadataSchema.parse(nextInput)
  const existing = existingInput === null ? null : statusMetadataSchema.parse(existingInput)
  const claims = new Map<string, StatusClaim>()
  const add = (claim: StatusClaim) => {
    const key = claim.runKey ?? `pending:${claim.claimId}`
    claims.set(key, claim)
  }
  if (existing !== null) {
    existing.claims.forEach(add)
    add(toStatusClaim(existing))
  }
  next.claims.forEach(add)
  if (next.runKey !== null) claims.delete(`pending:${next.claimId}`)
  add(toStatusClaim(next))
  if (claims.size > 64) {
    throw new Error('Maintainer Bot durable claim ledger reached its safe capacity; operator intervention is required.')
  }
  return statusMetadataSchema.parse({ ...next, claims: [...claims.values()] })
}

function durableClaims(metadata: StatusMetadata): StatusClaim[] {
  const claims = new Map<string, StatusClaim>()
  for (const claim of metadata.claims) claims.set(claim.runKey ?? `pending:${claim.claimId}`, claim)
  const current = toStatusClaim(metadata)
  claims.set(current.runKey ?? `pending:${current.claimId}`, current)
  return [...claims.values()]
}

function toStatusClaim(metadata: StatusMetadata): StatusClaim {
  return {
    status: metadata.status,
    claimId: metadata.claimId,
    actionsRunId: metadata.actionsRunId,
    runUrl: metadata.runUrl,
    baseSha: metadata.baseSha,
    issueRevision: metadata.issueRevision,
    runKey: metadata.runKey,
    branch: metadata.branch,
    pullRequestUrl: metadata.pullRequestUrl,
    updatedAt: metadata.updatedAt,
  }
}

export function isActionsRunActive(status: string | undefined): boolean {
  return status !== undefined && status !== 'completed'
}
