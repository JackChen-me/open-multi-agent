import { describe, expect, it } from 'vitest'
import { hashJson, sha256 } from '../src/hash.js'
import { buildDraftPrProposal } from '../src/proposal.js'
import { reviewBundleSchema } from '../src/review-bundle.js'
import { contextManifestSchema, reviewOutputSchema } from '../src/schema.js'
import { authorizedRequest, testConfig } from './helpers.js'

function manifest() {
  const request = authorizedRequest()
  const partial = {
    schemaVersion: 1 as const,
    policyVersion: 'policy-v1',
    promptVersion: 'prompt-v1',
    generatedAt: '2026-08-10T00:00:00.000Z',
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
    targetWorkspaces: request.issue.targetWorkspaces,
    targetPaths: request.issue.targetPaths,
    allowedPaths: ['packages/demo'],
    approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' as const }],
    protectedPaths: ['.git'],
    validationCommands: testConfig().validationCommands,
    sources: [],
    retrieval: {
      method: 'deterministic-file-tree-import-history-v1' as const,
      selectedFiles: request.issue.targetPaths,
      omittedCandidateCount: 0,
      importRelations: [],
    },
    sufficiency: { sufficient: true, errors: [], warnings: [] },
  }
  return contextManifestSchema.parse({ ...partial, manifestHash: hashJson(partial) })
}

const validation = [{
  id: 'fixture-test',
  command: '"npm" "test"',
  success: true,
  exitCode: 0,
  durationMs: 10,
  stdout: 'pass',
  stderr: '',
  truncated: false,
}]

const approvedReview = reviewOutputSchema.parse({
  verdict: 'approve',
  repairable: false,
  issues: [],
  acceptanceResults: authorizedRequest().issue.acceptanceCriteria.map(criterion => ({
    criterion,
    status: 'pass',
    evidence: 'The final diff and focused validation prove this criterion.',
  })),
  rationale: ['The bounded diff satisfies every authorized acceptance criterion.'],
})

function reviewBundle(content = 'new') {
  const request = authorizedRequest()
  const context = manifest()
  const diff = `diff --git a/packages/demo/src/greeting.ts b/packages/demo/src/greeting.ts\n-old\n+${content}\n`
  return reviewBundleSchema.parse({
    schemaVersion: 1,
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
    requirements: {
      problem: request.issue.problem,
      currentBehavior: request.issue.currentBehavior,
      expectedBehavior: request.issue.expectedBehavior,
      acceptanceCriteria: request.issue.acceptanceCriteria,
      outOfScope: request.issue.outOfScope,
    },
    changedPaths: ['packages/demo/src/greeting.ts'],
    currentFiles: [{
      path: 'packages/demo/src/greeting.ts',
      contentHash: sha256(content),
      content,
      byteLength: Buffer.byteLength(content),
    }],
    diff,
    diffHash: sha256(diff),
    validationResults: validation,
    relevantContext: [],
    contextManifestHash: context.manifestHash,
  })
}

describe('safe Draft PR proposal gate', () => {
  it('builds a hash-bound Draft-only proposal after every gate passes', () => {
    const proposal = buildDraftPrProposal({
      request: authorizedRequest(),
      config: testConfig(),
      manifest: manifest(),
      appliedEdits: [{
        path: 'packages/demo/src/greeting.ts',
        reason: 'Fix punctuation.',
        beforeHash: sha256('old'),
        afterHash: sha256('new'),
        bytes: 3,
        created: false,
      }],
      validationResults: validation,
      reviewBundle: reviewBundle(),
      review: approvedReview,
      implementationSummary: 'Fix deterministic greeting punctuation.',
      risks: ['The fixture is intentionally narrow.'],
      now: () => new Date('2026-08-10T02:00:00.000Z'),
    })
    expect(proposal).toMatchObject({
      kind: 'draft_pr',
      eligibleForHostWrite: true,
      validatedCandidateDiffHash: reviewBundle().diffHash,
      issueNumber: 101,
      baseSha: 'a'.repeat(40),
      policyVersion: 'policy-v1',
      promptVersion: 'prompt-v1',
      claudeCodeTokenUsage: 'not_applicable',
    })
    const { proposalHash, ...withoutHash } = proposal
    expect(proposalHash).toBe(hashJson(withoutHash))
  })

  it('refuses failed, truncated, or reviewer-rejected evidence', () => {
    const base = {
      request: authorizedRequest(),
      config: testConfig(),
      manifest: manifest(),
      appliedEdits: [{
        path: 'packages/demo/src/greeting.ts', reason: 'Fix.', beforeHash: null,
        afterHash: sha256('new'), bytes: 3, created: true,
      }],
      reviewBundle: reviewBundle(),
      implementationSummary: 'Fix greeting.',
      risks: [],
    }
    expect(() => buildDraftPrProposal({
      ...base,
      validationResults: [{ ...validation[0]!, success: false, exitCode: 1 }],
      review: approvedReview,
    })).toThrow(/Validation failure/)
    expect(() => buildDraftPrProposal({
      ...base,
      validationResults: [{ ...validation[0]!, truncated: true }],
      review: approvedReview,
    })).toThrow(/Validation failure/)
    expect(() => buildDraftPrProposal({
      ...base,
      validationResults: validation,
      review: reviewOutputSchema.parse({
        verdict: 'reject', repairable: false, issues: ['Acceptance is not proven.'],
        acceptanceResults: [{ criterion: 'Criterion remains unproven.', status: 'unknown', evidence: 'No evidence was supplied.' }],
        rationale: ['The final evidence is incomplete.'],
      }),
    })).toThrow(/Reviewer rejection/)
  })

  it('refuses a proposal when validation or review-time file content drifted from the applied edit hash', () => {
    expect(() => buildDraftPrProposal({
      request: authorizedRequest(),
      config: testConfig(),
      manifest: manifest(),
      appliedEdits: [{
        path: 'packages/demo/src/greeting.ts', reason: 'Fix.', beforeHash: sha256('old'),
        afterHash: sha256('new'), bytes: 3, created: false,
      }],
      validationResults: validation,
      reviewBundle: reviewBundle('validation-mutated-content'),
      review: approvedReview,
      implementationSummary: 'Fix greeting.',
      risks: [],
    })).toThrow(/afterHash differs from the fresh review snapshot/)
  })
})
