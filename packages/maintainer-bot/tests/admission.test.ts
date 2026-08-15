import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  computeIssueRevision,
  evaluateAdmission,
} from '../src/admission.js'
import { controlPlaneRequestSchema } from '../src/schema.js'
import { authorizedRequest, BASE_SHA, readyIssue } from './helpers.js'

describe('issue admission gate', () => {
  it('never develops a ready issue without maintainer authorization', () => {
    const request = authorizedRequest({}, { authorization: null })
    const decision = evaluateAdmission(request)
    expect(decision.status).toBe('READY_CANDIDATE')
    expect(decision.mayDevelop).toBe(false)
    expect(decision.reasonCodes).toEqual(['AUTHORIZATION_MISSING'])
  })

  it('admits an exact revision authorized by a write maintainer', () => {
    const decision = evaluateAdmission(authorizedRequest())
    expect(decision.status).toBe('AGENT_READY')
    expect(decision.mayDevelop).toBe(true)
    expect(decision.reasonCodes).toEqual([])
  })

  it('admits a bounded docs issue without traditional reproduction steps', () => {
    const decision = evaluateAdmission(authorizedRequest({
      kind: 'docs',
      reproductionSteps: [],
      problem: 'The provider guide omits the exact environment-variable precedence used by the documented adapter.',
      currentBehavior: 'The guide lists variables but does not state their precedence.',
      expectedBehavior: 'The guide states the existing deterministic precedence without changing runtime behavior.',
      acceptanceCriteria: ['The provider guide lists the three precedence levels in their exact runtime order.'],
      targetPaths: ['docs/providers.md'],
      targetWorkspaces: ['repository-docs'],
      outOfScope: ['Do not change adapter code, public APIs, or provider behavior.'],
    }))
    expect(decision.status).toBe('AGENT_READY')
    expect(decision.reasonCodes).not.toContain('MISSING_REPRODUCTION')
  })

  it('does not admit a bug without reproduction or a failing-test procedure', () => {
    const decision = evaluateAdmission(authorizedRequest({
      kind: 'bug',
      reproductionSteps: [],
    }))
    expect(decision.status).toBe('NEEDS_CLARIFICATION')
    expect(decision.reasonCodes).toContain('MISSING_REPRODUCTION')
  })

  it('invalidates authorization after any material issue edit', () => {
    const original = authorizedRequest()
    const editedIssue = readyIssue({
      expectedBehavior: 'The function returns "Hello, Ada!!".',
      updatedAt: '2026-08-10T00:01:00.000Z',
    })
    const request = controlPlaneRequestSchema.parse({ ...original, issue: editedIssue })
    const decision = evaluateAdmission(request)
    expect(decision.status).toBe('BLOCKED')
    expect(decision.mayDevelop).toBe(false)
    expect(decision.reasonCodes).toContain('AUTHORIZATION_STALE')
    expect(computeIssueRevision(editedIssue)).not.toBe(original.authorization?.issueRevision)
  })

  it.each([
    ['architecture', 'MANUAL_ARCHITECTURE'],
    ['public-api-major', 'MANUAL_PUBLIC_API'],
    ['breaking-change', 'MANUAL_BREAKING_CHANGE'],
    ['security', 'MANUAL_SECURITY'],
    ['permissions', 'MANUAL_PERMISSIONS'],
    ['privacy', 'MANUAL_PRIVACY'],
    ['license', 'MANUAL_LICENSE'],
    ['ci', 'MANUAL_CI_RELEASE_PUBLISH'],
    ['release', 'MANUAL_CI_RELEASE_PUBLISH'],
    ['publish', 'MANUAL_CI_RELEASE_PUBLISH'],
    ['dependency-compatibility-unknown', 'MANUAL_DEPENDENCY_COMPATIBILITY'],
    ['nondeterministic-validation', 'MANUAL_NONDETERMINISTIC_VALIDATION'],
  ] as const)('routes %s risk to MANUAL_ONLY', (flag, reason) => {
    const decision = evaluateAdmission(authorizedRequest({ riskFlags: [flag] }))
    expect(decision.status).toBe('MANUAL_ONLY')
    expect(decision.reasonCodes).toContain(reason)
  })

  it.each(['question', 'discussion', 'tracker'] as const)(
    'never develops %s issues',
    kind => expect(evaluateAdmission(authorizedRequest({ kind })).status).toBe('MANUAL_ONLY'),
  )

  it('requires a complete deterministic Definition of Ready', () => {
    const decision = evaluateAdmission(authorizedRequest({
      problem: '',
      reproductionSteps: [],
      currentBehavior: '',
      expectedBehavior: '',
      acceptanceCriteria: ['works'],
      targetPaths: [],
      targetWorkspaces: [],
      outOfScope: [],
      openDecisions: ['Choose a new architecture.'],
    }))
    expect(decision.status).toBe('NEEDS_CLARIFICATION')
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      'MISSING_PROBLEM',
      'MISSING_REPRODUCTION',
      'MISSING_CURRENT_BEHAVIOR',
      'MISSING_EXPECTED_BEHAVIOR',
      'VAGUE_ACCEPTANCE_CRITERIA',
      'MISSING_TARGET_SCOPE',
      'MISSING_OUT_OF_SCOPE',
      'OPEN_PRODUCT_OR_ARCHITECTURE_DECISION',
    ]))
  })

  it('blocks active PRs, active runs, and external blockers', () => {
    const decision = evaluateAdmission(authorizedRequest({
      linkedPullRequests: [{ number: 55, state: 'open' }],
      activeRunId: 'run-existing',
      blockers: ['Waiting for upstream reproduction.'],
    }))
    expect(decision.status).toBe('BLOCKED')
    expect(decision.reasonCodes).toEqual([
      'ACTIVE_PULL_REQUEST',
      'ACTIVE_RUN',
      'EXTERNAL_BLOCKER',
    ])
  })

  it('rejects a label granted by a non-write user', () => {
    const request = authorizedRequest()
    const decision = evaluateAdmission(controlPlaneRequestSchema.parse({
      ...request,
      authorization: { ...request.authorization, grantedByPermission: 'triage' },
    }))
    expect(decision.status).toBe('BLOCKED')
    expect(decision.reasonCodes).toContain('AUTHORIZER_LACKS_WRITE')
  })

  it('rejects a base SHA different from the authorized base', () => {
    const request = authorizedRequest()
    const decision = evaluateAdmission(controlPlaneRequestSchema.parse({
      ...request,
      baseSha: 'b'.repeat(40),
      authorization: { ...request.authorization, baseSha: BASE_SHA },
    }))
    expect(decision.status).toBe('BLOCKED')
    expect(decision.reasonCodes).toContain('AUTHORIZATION_BASE_MISMATCH')
  })
})

describe('maintainer state transitions', () => {
  it('permits only explicit lifecycle edges', () => {
    expect(canTransition('AGENT_READY', 'RUNNING')).toBe(true)
    expect(canTransition('RUNNING', 'DRAFT_PR_PROPOSAL_READY')).toBe(true)
    expect(canTransition('DRAFT_PR_PROPOSAL_READY', 'DRAFT_PR_CREATED')).toBe(true)
    expect(canTransition('RUNNING', 'DRAFT_PR_CREATED')).toBe(false)
    expect(() => assertTransition('DRAFT_PR_CREATED', 'RUNNING')).toThrow(/Illegal/)
  })
})
