import { hashJson } from './hash.js'
import {
  admissionDecisionSchema,
  controlPlaneRequestSchema,
  type AdmissionDecision,
  type AdmissionReasonCode,
  type ControlPlaneRequest,
  type MaintainerIssue,
  type MaintainerState,
} from './schema.js'

const WRITE_PERMISSIONS = new Set(['write', 'maintain', 'admin'])

const MANUAL_FLAG_REASONS: Readonly<Record<string, AdmissionReasonCode>> = {
  architecture: 'MANUAL_ARCHITECTURE',
  'public-api-major': 'MANUAL_PUBLIC_API',
  'breaking-change': 'MANUAL_BREAKING_CHANGE',
  'cross-workspace-refactor': 'MANUAL_CROSS_WORKSPACE_REFACTOR',
  security: 'MANUAL_SECURITY',
  permissions: 'MANUAL_PERMISSIONS',
  privacy: 'MANUAL_PRIVACY',
  license: 'MANUAL_LICENSE',
  ci: 'MANUAL_CI_RELEASE_PUBLISH',
  release: 'MANUAL_CI_RELEASE_PUBLISH',
  publish: 'MANUAL_CI_RELEASE_PUBLISH',
  'dependency-compatibility-unknown': 'MANUAL_DEPENDENCY_COMPATIBILITY',
  'nondeterministic-validation': 'MANUAL_NONDETERMINISTIC_VALIDATION',
}

const REASON_MESSAGES: Readonly<Record<AdmissionReasonCode, string>> = {
  ISSUE_NOT_OPEN: 'The issue is not open.',
  MISSING_PROBLEM: 'The problem statement is missing.',
  MISSING_REPRODUCTION: 'A bug requires deterministic reproduction steps or a constructible failing-test procedure.',
  MISSING_CURRENT_BEHAVIOR: 'Current behavior is missing.',
  MISSING_EXPECTED_BEHAVIOR: 'Expected behavior is missing.',
  MISSING_ACCEPTANCE_CRITERIA: 'Verifiable acceptance criteria are missing.',
  VAGUE_ACCEPTANCE_CRITERIA: 'At least one acceptance criterion is too vague to verify deterministically.',
  MISSING_TARGET_SCOPE: 'Target workspace and repository paths must be explicit.',
  MISSING_OUT_OF_SCOPE: 'Out-of-scope behavior must be explicit.',
  OPEN_PRODUCT_OR_ARCHITECTURE_DECISION: 'The issue contains an unresolved product or architecture decision.',
  ACTIVE_PULL_REQUEST: 'An active pull request already covers this issue revision.',
  ACTIVE_RUN: 'An active maintainer-bot run already covers this issue revision.',
  EXTERNAL_BLOCKER: 'The issue has an unresolved external blocker.',
  MANUAL_ARCHITECTURE: 'Architecture design requires manual maintainer ownership.',
  MANUAL_PUBLIC_API: 'A major public API change requires manual maintainer ownership.',
  MANUAL_BREAKING_CHANGE: 'A breaking change requires manual maintainer ownership.',
  MANUAL_CROSS_WORKSPACE_REFACTOR: 'A cross-workspace refactor requires manual maintainer ownership.',
  MANUAL_SECURITY: 'Security-sensitive work is manual-only.',
  MANUAL_PERMISSIONS: 'Permission-sensitive work is manual-only.',
  MANUAL_PRIVACY: 'Privacy-sensitive work is manual-only.',
  MANUAL_LICENSE: 'License-sensitive work is manual-only.',
  MANUAL_CI_RELEASE_PUBLISH: 'CI, release, and publication work is manual-only.',
  MANUAL_DEPENDENCY_COMPATIBILITY: 'Dependency work without fixed compatibility targets is manual-only.',
  MANUAL_TRACKER_DISCUSSION_QUESTION: 'Trackers, discussions, and questions are not development tasks.',
  MANUAL_NONDETERMINISTIC_VALIDATION: 'The issue cannot be validated deterministically.',
  AUTHORIZATION_MISSING: 'A write-authorized maintainer has not granted agent-ready authorization.',
  AUTHORIZER_LACKS_WRITE: 'The recorded authorizer did not have write permission.',
  AUTHORIZATION_STALE: 'The issue revision changed after authorization.',
  AUTHORIZATION_BASE_MISMATCH: 'The authorized base commit differs from the requested base commit.',
  AGENT_READY_LABEL_MISSING: 'The agent-ready label is not present.',
  BASE_SHA_MISSING: 'A fixed base commit SHA is required.',
}

export function computeIssueRevision(issueInput: MaintainerIssue): string {
  const issue = structuredIssueRevisionPayload(issueInput)
  return hashJson(issue)
}

export function evaluateAdmission(requestInput: ControlPlaneRequest): AdmissionDecision {
  const request = controlPlaneRequestSchema.parse(requestInput)
  const issueRevision = computeIssueRevision(request.issue)
  const manualReasons = collectManualReasons(request.issue)
  const readinessReasons = collectReadinessReasons(request.issue)
  const blockerReasons = collectBlockerReasons(request.issue)

  if (manualReasons.length > 0) {
    return decision('MANUAL_ONLY', false, request, issueRevision, manualReasons)
  }
  if (blockerReasons.length > 0) {
    return decision('BLOCKED', false, request, issueRevision, blockerReasons)
  }
  if (readinessReasons.length > 0) {
    return decision('NEEDS_CLARIFICATION', false, request, issueRevision, readinessReasons)
  }

  const authorizationReasons = collectAuthorizationReasons(request, issueRevision)
  if (authorizationReasons.length > 0) {
    const staleOrInvalid = authorizationReasons.some(reason =>
      reason === 'AUTHORIZATION_STALE'
      || reason === 'AUTHORIZATION_BASE_MISMATCH'
      || reason === 'AUTHORIZER_LACKS_WRITE',
    )
    return decision(
      staleOrInvalid ? 'BLOCKED' : 'READY_CANDIDATE',
      false,
      request,
      issueRevision,
      authorizationReasons,
    )
  }

  return decision('AGENT_READY', true, request, issueRevision, [])
}

export function canTransition(from: MaintainerState, to: MaintainerState): boolean {
  const transitions: Readonly<Record<MaintainerState, readonly MaintainerState[]>> = {
    READY_CANDIDATE: ['AGENT_READY', 'NEEDS_CLARIFICATION', 'MANUAL_ONLY', 'BLOCKED'],
    NEEDS_CLARIFICATION: ['READY_CANDIDATE', 'MANUAL_ONLY', 'BLOCKED'],
    MANUAL_ONLY: [],
    BLOCKED: ['READY_CANDIDATE', 'NEEDS_CLARIFICATION', 'MANUAL_ONLY'],
    AGENT_READY: ['RUNNING', 'BLOCKED'],
    RUNNING: ['DRAFT_PR_PROPOSAL_READY', 'NEEDS_HUMAN', 'FAILED'],
    DRAFT_PR_PROPOSAL_READY: ['DRAFT_PR_CREATED', 'NEEDS_HUMAN'],
    DRAFT_PR_CREATED: [],
    NEEDS_HUMAN: [],
    FAILED: [],
  }
  return transitions[from].includes(to)
}

export function assertTransition(from: MaintainerState, to: MaintainerState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal maintainer-bot state transition: ${from} -> ${to}`)
  }
}

function structuredIssueRevisionPayload(issue: MaintainerIssue): unknown {
  return {
    repository: issue.repository,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    updatedAt: issue.updatedAt,
    comments: issue.comments,
    kind: issue.kind,
    problem: issue.problem,
    reproductionSteps: issue.reproductionSteps,
    currentBehavior: issue.currentBehavior,
    expectedBehavior: issue.expectedBehavior,
    acceptanceCriteria: issue.acceptanceCriteria,
    targetWorkspaces: issue.targetWorkspaces,
    targetPaths: issue.targetPaths,
    outOfScope: issue.outOfScope,
    openDecisions: issue.openDecisions,
    riskFlags: issue.riskFlags,
    linkedPullRequests: issue.linkedPullRequests,
    blockers: issue.blockers,
  }
}

function collectManualReasons(issue: MaintainerIssue): AdmissionReasonCode[] {
  const reasons = new Set<AdmissionReasonCode>()
  if (['tracker', 'discussion', 'question'].includes(issue.kind)) {
    reasons.add('MANUAL_TRACKER_DISCUSSION_QUESTION')
  }
  if (issue.kind === 'security') reasons.add('MANUAL_SECURITY')
  if (issue.kind === 'refactor' && issue.targetWorkspaces.length > 1) {
    reasons.add('MANUAL_CROSS_WORKSPACE_REFACTOR')
  }
  if (issue.kind === 'dependency' && issue.openDecisions.length > 0) {
    reasons.add('MANUAL_DEPENDENCY_COMPATIBILITY')
  }
  for (const flag of issue.riskFlags) {
    const reason = MANUAL_FLAG_REASONS[flag]
    if (reason !== undefined) reasons.add(reason)
  }
  return [...reasons]
}

function collectReadinessReasons(issue: MaintainerIssue): AdmissionReasonCode[] {
  const reasons: AdmissionReasonCode[] = []
  if (issue.state !== 'open') reasons.push('ISSUE_NOT_OPEN')
  if (issue.problem.trim().length < 10) reasons.push('MISSING_PROBLEM')
  if (issue.kind === 'bug' && issue.reproductionSteps.length === 0) {
    reasons.push('MISSING_REPRODUCTION')
  }
  if (issue.currentBehavior.trim().length < 5) reasons.push('MISSING_CURRENT_BEHAVIOR')
  if (issue.expectedBehavior.trim().length < 5) reasons.push('MISSING_EXPECTED_BEHAVIOR')
  if (issue.acceptanceCriteria.length === 0) reasons.push('MISSING_ACCEPTANCE_CRITERIA')
  if (issue.acceptanceCriteria.some(isVagueCriterion)) reasons.push('VAGUE_ACCEPTANCE_CRITERIA')
  if (issue.targetWorkspaces.length === 0 || issue.targetPaths.length === 0) {
    reasons.push('MISSING_TARGET_SCOPE')
  }
  if (issue.outOfScope.length === 0) reasons.push('MISSING_OUT_OF_SCOPE')
  if (issue.openDecisions.length > 0) reasons.push('OPEN_PRODUCT_OR_ARCHITECTURE_DECISION')
  return reasons
}

function collectBlockerReasons(issue: MaintainerIssue): AdmissionReasonCode[] {
  const reasons: AdmissionReasonCode[] = []
  if (issue.linkedPullRequests.some(pull => pull.state === 'open')) reasons.push('ACTIVE_PULL_REQUEST')
  if (issue.activeRunId !== undefined) reasons.push('ACTIVE_RUN')
  if (issue.blockers.length > 0) reasons.push('EXTERNAL_BLOCKER')
  return reasons
}

function collectAuthorizationReasons(
  request: ControlPlaneRequest,
  issueRevision: string,
): AdmissionReasonCode[] {
  const authorization = request.authorization
  if (authorization === null) return ['AUTHORIZATION_MISSING']

  const reasons: AdmissionReasonCode[] = []
  if (!WRITE_PERMISSIONS.has(authorization.grantedByPermission)) {
    reasons.push('AUTHORIZER_LACKS_WRITE')
  }
  if (!request.issue.labels.includes(authorization.label)) {
    reasons.push('AGENT_READY_LABEL_MISSING')
  }
  if (authorization.issueRevision !== issueRevision) reasons.push('AUTHORIZATION_STALE')
  if (authorization.baseSha !== request.baseSha) reasons.push('AUTHORIZATION_BASE_MISMATCH')
  return reasons
}

function decision(
  status: MaintainerState,
  mayDevelop: boolean,
  request: ControlPlaneRequest,
  issueRevision: string,
  reasonCodes: AdmissionReasonCode[],
): AdmissionDecision {
  return admissionDecisionSchema.parse({
    schemaVersion: 1,
    status,
    mayDevelop,
    issueRevision,
    baseSha: request.baseSha,
    reasonCodes,
    reasons: reasonCodes.map(code => REASON_MESSAGES[code]),
  })
}

function isVagueCriterion(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.!。！]/g, '')
  return normalized.length < 12 || [
    'works',
    'it works',
    'fix it',
    'fixed',
    'tests pass',
    'make it better',
  ].includes(normalized)
}
