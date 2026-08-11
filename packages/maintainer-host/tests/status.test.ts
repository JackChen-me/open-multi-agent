import { describe, expect, it } from 'vitest'
import {
  decideClaim,
  findTrustedStatusComment,
  mergeStatusMetadata,
  parseStatusComment,
  renderStatusComment,
} from '../src/status.js'
import { sanitizePublicLine } from '../src/public-output.js'
import {
  APP_IDENTITY,
  FakeGitHub,
  botComment,
  githubActionsComment,
  REPOSITORY,
} from './helpers.js'

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    version: 2 as const,
    repository: REPOSITORY,
    issueNumber: 488,
    status: 'RUNNING' as const,
    claimId: '100.1',
    actionsRunId: 100,
    runUrl: 'https://github.com/open-multi-agent/open-multi-agent/actions/runs/100',
    baseSha: 'a'.repeat(40),
    issueRevision: 'b'.repeat(64),
    runKey: 'c'.repeat(64),
    branch: 'agent/issue-488-bbbbbbbbbbbb',
    pullRequestUrl: null,
    updatedAt: '2026-08-10T17:43:00Z',
    ...overrides,
  }
}

describe('single trusted BOT status comment', () => {
  it('round-trips machine metadata and ignores user and github-actions marker forgeries', async () => {
    const body = renderStatusComment(metadata(), 'Running deterministic checks.')
    expect(parseStatusComment(body)).toMatchObject({ status: 'RUNNING', runKey: 'c'.repeat(64) })
    const forged = { ...botComment(1, body), user: { id: 99, login: 'attacker', type: 'User' } }
    const actionsForgery = githubActionsComment(2, body)
    const trusted = botComment(3, body)
    const github = new FakeGitHub()
    github.comments = [forged, actionsForgery, trusted]
    expect((await findTrustedStatusComment({
      github,
      comments: github.comments,
      identity: APP_IDENTITY,
      repository: REPOSITORY,
      issueNumber: 488,
    }))?.comment.id).toBe(3)
  })

  it('rejects duplicate trusted comments, provenance drift, and marker injection', async () => {
    const body = renderStatusComment(metadata(), 'Safe detail.')
    const duplicate = new FakeGitHub()
    duplicate.comments = [botComment(1, body), botComment(2, body)]
    await expect(findTrustedStatusComment({
      github: duplicate,
      comments: duplicate.comments,
      identity: APP_IDENTITY,
      repository: REPOSITORY,
      issueNumber: 488,
    })).rejects.toThrow(/More than one trusted/)
    expect(sanitizePublicLine('secret=abc /Users/jack/private <!-- marker -->')).not.toContain('/Users/jack')
    expect(sanitizePublicLine('secret=abc /Users/jack/private <!-- marker -->')).not.toContain('<!--')
    const mismatched = renderStatusComment(metadata({ repository: 'other/repository' }), 'Wrong Issue.')
    const wrongRepository = new FakeGitHub()
    wrongRepository.comments = [botComment(3, mismatched)]
    await expect(findTrustedStatusComment({
      github: wrongRepository,
      comments: wrongRepository.comments,
      identity: APP_IDENTITY,
      repository: REPOSITORY,
      issueNumber: 488,
    })).rejects.toThrow(/different repository or Issue/)

    const wrongEditor = new FakeGitHub()
    wrongEditor.comments = [botComment(4, body)]
    wrongEditor.commentAuthorshipOverrides.set('IC_4', {
      authorLogin: APP_IDENTITY.botLogin,
      editorLogin: 'attacker',
      viewerDidAuthor: true,
      createdViaEmail: false,
    })
    await expect(findTrustedStatusComment({
      github: wrongEditor,
      comments: wrongEditor.comments,
      identity: APP_IDENTITY,
      repository: REPOSITORY,
      issueNumber: 488,
    })).rejects.toThrow(/authorship or editor provenance/)
  })

  it('handles claimed, concurrent, duplicate, stale, and fresh-revision reruns deterministically', () => {
    expect(decideClaim({ existing: null, candidate: metadata(), existingRunActive: false }).kind).toBe('claimed')
    expect(decideClaim({
      existing: metadata({ claimId: '99.1', actionsRunId: 99 }),
      candidate: metadata(),
      existingRunActive: true,
    }).kind).toBe('concurrent')
    expect(decideClaim({
      existing: metadata({ claimId: '99.1', actionsRunId: 99 }),
      candidate: metadata(),
      existingRunActive: false,
    }).kind).toBe('stale-needs-human')
    expect(decideClaim({
      existing: metadata({ status: 'DRAFT_PR_CREATED', claimId: '99.1', actionsRunId: 99 }),
      candidate: metadata(),
      existingRunActive: false,
    }).kind).toBe('duplicate')
    expect(decideClaim({
      existing: metadata({ status: 'NEEDS_HUMAN', runKey: 'd'.repeat(64), claimId: '99.1', actionsRunId: 99 }),
      candidate: metadata(),
      existingRunActive: false,
    }).kind).toBe('claimed')
  })

  it('retains terminal run keys when a later candidate becomes the visible status', () => {
    const first = metadata({ status: 'DRAFT_PR_CREATED', claimId: '99.1', actionsRunId: 99 })
    const later = metadata({
      status: 'RUNNING',
      claimId: '100.1',
      actionsRunId: 100,
      issueRevision: 'd'.repeat(64),
      runKey: 'e'.repeat(64),
    })
    const merged = mergeStatusMetadata(first, later)
    expect(merged.claims).toHaveLength(2)
    expect(decideClaim({
      existing: merged,
      candidate: metadata({ claimId: '101.1', actionsRunId: 101 }),
      existingRunActive: false,
    }).kind).toBe('duplicate')
  })
})
