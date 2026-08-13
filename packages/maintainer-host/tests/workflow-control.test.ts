import { describe, expect, it } from 'vitest'
import { parseStatusComment, renderStatusComment } from '../src/status.js'
import {
  StartWorkflowError,
  publishBootstrapFailure,
  recoverStartFailure,
  recoverWorkflowFailure,
  startWorkflow,
  verifyStartContextHash,
} from '../src/workflow-control.js'
import {
  APP_BOT_USER_ID,
  APP_CONTRACT,
  BASE_SHA,
  FakeGitHub,
  ISSUE_NUMBER,
  REPOSITORY,
  cleanRunner,
  githubActionsComment,
  labelEvent,
  productionPolicy,
} from './helpers.js'

const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/900`

describe('typed workflow control', () => {
  it('publishes a non-durable STARTED artifact only after App, snapshot, and triple-SHA checks', async () => {
    const github = new FakeGitHub()
    const start = await startWorkflow({
      event: labelEvent(), github, runner: cleanRunner(), repoRoot: '/trusted-checkout',
      policy: await productionPolicy(), claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL,
      workflowSha: BASE_SHA, writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })
    expect(start).toMatchObject({
      claimId: '900.1', baseSha: BASE_SHA, executionBackend: 'claude-code',
      eventSnapshotMatched: true, removedBootstrapCommentCount: 0,
    })
    expect(verifyStartContextHash(start, start.artifactHash)).toEqual(start)
    const metadata = parseStatusComment(github.comments[0]!.body!)
    expect(metadata).toMatchObject({ status: 'STARTED', runKey: null, issueRevision: null, claims: [] })
    expect(github.comments[0]!.body).toContain('no durable run claim exists yet')
  })

  it('rejects a tampered STARTED artifact before prepare can trust any bound field', async () => {
    const github = new FakeGitHub()
    const start = await startWorkflow({
      event: labelEvent(), github, runner: cleanRunner(), repoRoot: '/trusted-checkout',
      policy: await productionPolicy(), claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL,
      workflowSha: BASE_SHA, writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })
    expect(() => verifyStartContextHash({ ...start, baseSha: 'b'.repeat(40) }, start.artifactHash))
      .toThrow(/artifact hash/)
  })

  it('requires updated_at equality and performs no status write for a stale event snapshot', async () => {
    const github = new FakeGitHub()
    github.issue.updated_at = '2026-08-10T17:44:00Z'
    await expect(startWorkflow({
      event: labelEvent(), github, runner: cleanRunner(), repoRoot: '/trusted-checkout',
      policy: await productionPolicy(), claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL,
      workflowSha: BASE_SHA, writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })).rejects.toMatchObject({
      name: 'StartWorkflowError',
      stage: 'issue-snapshot',
      publicDetail: expect.stringMatching(/Issue changed/),
    })
    expect(github.comments).toEqual([])
  })

  it('closes an App STARTED status when artifact persistence fails after the write', async () => {
    const github = new FakeGitHub()
    await startWorkflow({
      event: labelEvent(), github, runner: cleanRunner(), repoRoot: '/trusted-checkout',
      policy: await productionPolicy(), claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL,
      workflowSha: BASE_SHA, writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })
    const result = await recoverStartFailure({
      event: labelEvent(), github, policy: await productionPolicy(), claimId: '900.1',
      actionsRunId: 900, runUrl: RUN_URL, writerContract: APP_CONTRACT,
      failureStage: 'artifact-write',
      failureDetail: 'STARTED was published, but the hash-bound artifact could not be persisted.',
      recoveredAt: '2026-08-10T17:44:00Z',
    })
    expect(result).toMatchObject({ status: 'FAILED', authoritativeStatus: 'FAILED', stage: 'artifact-write' })
    expect(parseStatusComment(github.comments[0]!.body!)).toMatchObject({ status: 'FAILED', runKey: null })
    expect(github.comments[0]!.body).toContain('OMA Maintainer Bot — FAILED')
    expect(github.comments[0]!.body).toContain('artifact-write')
  })

  it('publishes an App-authenticated FAILED for a stale pre-write snapshot without blaming App configuration', async () => {
    const github = new FakeGitHub()
    github.issue.updated_at = '2026-08-10T17:44:00Z'
    let failure: StartWorkflowError | undefined
    try {
      await startWorkflow({
        event: labelEvent(), github, runner: cleanRunner(), repoRoot: '/trusted-checkout',
        policy: await productionPolicy(), claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL,
        workflowSha: BASE_SHA, writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
      })
    } catch (error) {
      if (error instanceof StartWorkflowError) failure = error
    }
    expect(failure?.stage).toBe('issue-snapshot')
    await recoverStartFailure({
      event: labelEvent(), github, policy: await productionPolicy(), claimId: '900.1',
      actionsRunId: 900, runUrl: RUN_URL, writerContract: APP_CONTRACT,
      failureStage: failure!.stage, failureDetail: failure!.publicDetail,
      recoveredAt: '2026-08-10T17:45:00Z',
    })
    expect(github.comments[0]!.body).toContain('issue-snapshot')
    expect(github.comments[0]!.body).toContain('Issue changed')
    expect(github.comments[0]!.body).not.toContain('App is disabled')
    expect(github.comments[0]!.body).not.toContain('missing required configuration')
  })

  it('deletes at most one GraphQL-verified bootstrap notice and records the cleanup count', async () => {
    const github = new FakeGitHub()
    github.comments = [githubActionsComment(44, '<!-- oma-maintainer-bot-bootstrap-status:v1 {} -->\n')]
    github.issue.comments = 1
    const event = labelEvent({ issue: { ...labelEvent().issue, comments: 1 } })
    const start = await startWorkflow({
      event, github, runner: cleanRunner(), repoRoot: '/trusted-checkout', policy: await productionPolicy(),
      claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL, workflowSha: BASE_SHA,
      writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })
    expect(start.removedBootstrapCommentCount).toBe(1)
    expect(github.deletedComments).toBe(1)
  })

  it('keeps previous durable metadata authoritative while STARTED runtime preflight is visible', async () => {
    const github = new FakeGitHub()
    const prior = {
      version: 2 as const, repository: REPOSITORY, issueNumber: ISSUE_NUMBER, status: 'FAILED' as const,
      claimId: '800.1', actionsRunId: 800, runUrl: `${RUN_URL}0`, baseSha: BASE_SHA,
      issueRevision: '1'.repeat(64), runKey: '2'.repeat(64), branch: 'agent/issue-488-old',
      pullRequestUrl: null, updatedAt: '2026-08-10T17:40:00Z', claims: [],
    }
    await github.createIssueComment(REPOSITORY, ISSUE_NUMBER, renderStatusComment(prior, 'Prior terminal state.'))
    github.issue.comments = 1
    const event = labelEvent({ issue: { ...labelEvent().issue, comments: 1 } })
    await startWorkflow({
      event, github, runner: cleanRunner(), repoRoot: '/trusted-checkout', policy: await productionPolicy(),
      claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL, workflowSha: BASE_SHA,
      writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })
    expect(parseStatusComment(github.comments[0]!.body!)).toEqual({ ...prior, headSha: null })
    expect(github.comments[0]!.body).toContain('OMA Maintainer Bot — STARTED')
    expect(github.comments[0]!.body).toContain('Previous durable status: `FAILED`')
  })

  it('preserves an earlier terminal claim when a later typed start fails', async () => {
    const github = new FakeGitHub()
    const prior = {
      version: 2 as const, repository: REPOSITORY, issueNumber: ISSUE_NUMBER, status: 'DRAFT_PR_CREATED' as const,
      claimId: '800.1', actionsRunId: 800, runUrl: `https://github.com/${REPOSITORY}/actions/runs/800`,
      baseSha: BASE_SHA, issueRevision: '1'.repeat(64), runKey: '2'.repeat(64),
      branch: 'agent/issue-488-old', pullRequestUrl: `https://github.com/${REPOSITORY}/pull/700`,
      updatedAt: '2026-08-10T17:40:00Z', claims: [],
    }
    await github.createIssueComment(REPOSITORY, ISSUE_NUMBER, renderStatusComment(prior, 'Prior terminal state.'))
    await recoverStartFailure({
      event: labelEvent(), github, policy: await productionPolicy(), claimId: '900.1',
      actionsRunId: 900, runUrl: RUN_URL, writerContract: APP_CONTRACT,
      failureStage: 'base-identity', failureDetail: 'The default branch moved after workflow dispatch.',
      recoveredAt: '2026-08-10T17:45:00Z',
    })
    expect(parseStatusComment(github.comments[0]!.body!)).toMatchObject({
      ...prior,
      claims: [expect.objectContaining({ claimId: prior.claimId, runKey: prior.runKey, status: prior.status })],
    })
    expect(github.comments[0]!.body).toContain('OMA Maintainer Bot — DRAFT_PR_CREATED')
    expect(github.comments[0]!.body).toContain('preserved unchanged')
  })

  it('rejects start recovery under the wrong App identity without changing status', async () => {
    const github = new FakeGitHub()
    await expect(recoverStartFailure({
      event: labelEvent(), github, policy: await productionPolicy(), claimId: '900.1',
      actionsRunId: 900, runUrl: RUN_URL,
      writerContract: { ...APP_CONTRACT, expectedBotUserId: APP_BOT_USER_ID + 1 },
      failureStage: 'app-identity', failureDetail: 'The App identity did not verify.',
      recoveredAt: '2026-08-10T17:45:00Z',
    })).rejects.toThrow(/bot user does not match/)
    expect(github.comments).toEqual([])
  })

  it('maps an interrupted durable RUNNING claim to public FAILED while retaining its runKey', async () => {
    const github = new FakeGitHub()
    const start = await startWorkflow({
      event: labelEvent(), github, runner: cleanRunner(), repoRoot: '/trusted-checkout',
      policy: await productionPolicy(), claimId: '900.1', actionsRunId: 900, runUrl: RUN_URL,
      workflowSha: BASE_SHA, writerContract: APP_CONTRACT, startedAt: '2026-08-10T17:43:00Z',
    })
    const running = {
      version: 2 as const, repository: REPOSITORY, issueNumber: ISSUE_NUMBER, status: 'RUNNING' as const,
      claimId: start.claimId, actionsRunId: start.actionsRunId, runUrl: start.runUrl, baseSha: start.baseSha,
      issueRevision: '1'.repeat(64), runKey: '2'.repeat(64), branch: 'agent/issue-488-current',
      pullRequestUrl: null, updatedAt: '2026-08-10T17:50:00Z', claims: [],
    }
    await github.updateIssueComment(REPOSITORY, start.commentId, renderStatusComment(running, 'Running.'))
    const result = await recoverWorkflowFailure({
      event: labelEvent(), start, github, writerContract: APP_CONTRACT, recoveredAt: '2026-08-10T18:00:00Z',
    })
    expect(result.status).toBe('FAILED')
    const recovered = parseStatusComment(github.comments[0]!.body!)
    expect(recovered).toMatchObject({ status: 'NEEDS_HUMAN', runKey: running.runKey })
    expect(github.comments[0]!.body).toContain('OMA Maintainer Bot — FAILED')
    expect(github.comments[0]!.body).not.toContain('OMA Maintainer Bot — NEEDS_HUMAN')
  })

  it('publishes repository-token bootstrap failure as explicitly non-authoritative FAILED', async () => {
    const github = new FakeGitHub()
    github.viewerLogin = 'github-actions[bot]'
    github.commentUser = { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' }
    const result = await publishBootstrapFailure({
      event: labelEvent(), github, actionsRunId: 900, runUrl: RUN_URL, stage: 'app-token-mint',
      publishedAt: '2026-08-10T18:00:00Z',
    })
    expect(result.status).toBe('FAILED')
    expect(github.comments[0]!.body).toContain('OMA Maintainer Bot — FAILED')
    expect(github.comments[0]!.body).toContain('non-authoritative')
    expect(github.comments[0]!.body).toContain('has no durable run claim and cannot authorize')
    expect(github.comments[0]!.body).toContain('Failure stage: `app-token-mint`')
    expect(github.comments[0]!.body).toContain('Reason: `APP_TOKEN_UNAVAILABLE`')
    expect(github.comments[0]!.user.id).toBe(41_898_282)
    expect(github.comments[0]!.user.id).not.toBe(APP_BOT_USER_ID)
  })
})
