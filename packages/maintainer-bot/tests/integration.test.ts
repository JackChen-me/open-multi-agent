import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderCommand } from '../src/command.js'
import {
  ghAwAdapterDefinitionSchema,
  REQUIRED_SAFE_OUTPUT_REVALIDATIONS,
  revalidateDraftPrArtifact,
  revalidateDraftPrSafeOutput,
} from '../src/integration.js'
import { buildDraftPrProposal } from '../src/proposal.js'
import { hashJson, sha256 } from '../src/hash.js'
import { reviewBundleSchema } from '../src/review-bundle.js'
import {
  contextManifestSchema,
  draftPrProposalSchema,
  reviewOutputSchema,
  type DraftPrProposal,
} from '../src/schema.js'
import { authorizedRequest, ScriptedCommandRunner, testConfig } from './helpers.js'
import { computeRunKey } from '../src/state.js'

const TARGET = 'packages/demo/src/greeting.ts'
const CURRENT = 'export const greeting = "!"\n'

describe('gh-aw custom-engine adapter boundary', () => {
  it('requires an immutable gh-aw commit pin and the complete worktree-bound gate contract', () => {
    const definition = {
      schemaVersion: 1,
      contract: 'oma-maintainer-bot-control-plane-v1',
      integration: 'github-agentic-workflows-custom-engine',
      pinPolicy: {
        ghAwReference: 'REQUIRED_IMMUTABLE_COMMIT_SHA',
        omaMaintainerBotPolicyVersion: 'policy-v1',
        omaMaintainerBotPromptVersion: 'prompt-v1',
      },
      trigger: { event: 'issues.labeled', requiredLabel: 'agent-ready', requiredAuthorizerPermission: 'write' },
      customEngine: {
        command: 'node', args: ['packages/maintainer-bot/dist/cli.js', 'run'],
        modelEnvironmentAllowlist: ['DEEPSEEK_API_KEY'], modelEnvironmentForbidden: ['GITHUB_TOKEN'],
      },
      safeOutput: {
        acceptedKind: 'draft_pr', requireEligibleForHostWrite: true,
        hostMustRevalidate: [...REQUIRED_SAFE_OUTPUT_REVALIDATIONS],
        prohibitedActions: ['ready_for_review', 'approve', 'merge'],
      },
    }
    expect(() => ghAwAdapterDefinitionSchema.parse(definition)).toThrow()
    const pinned = {
      ...definition,
      pinPolicy: { ...definition.pinPolicy, ghAwReference: 'a'.repeat(40) },
    }
    expect(ghAwAdapterDefinitionSchema.parse(pinned).pinPolicy.ghAwReference).toBe('a'.repeat(40))
    expect(() => ghAwAdapterDefinitionSchema.parse({
      ...pinned,
      safeOutput: { ...pinned.safeOutput, hostMustRevalidate: ['proposalHash'] },
    })).toThrow(/worktreeHead/)
  })

  it('requires artifact and actual worktree evidence before host write', async () => {
    const fixture = await safeOutputFixture()
    expect(revalidateDraftPrArtifact(fixture)).toEqual(fixture.proposal)
    await expect(revalidateDraftPrSafeOutput(fixture)).resolves.toEqual(fixture.proposal)
  })

  it('fails closed when reviewed file content drifts before the host gate', async () => {
    const fixture = await safeOutputFixture()
    await writeFile(join(fixture.repoRoot, TARGET), 'export const greeting = "drift"\n')
    await expect(revalidateDraftPrSafeOutput(fixture)).rejects.toThrow(/content drifted after review/)
  })

  it('fails closed when only the reviewed file mode drifts before the host gate', async () => {
    const fixture = await safeOutputFixture()
    await chmod(join(fixture.repoRoot, TARGET), 0o755)
    await expect(revalidateDraftPrSafeOutput(fixture)).rejects.toThrow(/candidate diff drifted/)
  })

  it('rejects proposal artifacts that do not bind the validated candidate diff', async () => {
    const fixture = await safeOutputFixture()
    const { validatedCandidateDiffHash: _omitted, proposalHash: _oldHash, ...legacyPartial } = fixture.proposal
    expect(() => draftPrProposalSchema.parse({
      ...legacyPartial,
      proposalHash: hashJson(legacyPartial),
    })).toThrow()
  })

  it('fails closed on an extra untracked path or changed HEAD', async () => {
    const extra = await safeOutputFixture({ status: ` M ${TARGET}\n?? packages/demo/src/extra.ts\n` })
    await expect(revalidateDraftPrSafeOutput(extra)).rejects.toThrow(/maintainer-approved issue scope/)

    const moved = await safeOutputFixture({ head: 'b'.repeat(40) })
    await expect(revalidateDraftPrSafeOutput(moved)).rejects.toThrow(/differs from proposal base SHA/)
  })

  it('fails closed on deletion or rename status records', async () => {
    const deleted = await safeOutputFixture({ status: ` D ${TARGET}\n` })
    await expect(revalidateDraftPrSafeOutput(deleted)).rejects.toThrow(/Deletions are outside/)
    const renamed = await safeOutputFixture({ status: `R  ${TARGET} -> packages/demo/src/renamed.ts\n` })
    await expect(revalidateDraftPrSafeOutput(renamed)).rejects.toThrow(/Renames are outside/)
  })

  it('fails closed on rejected review or acceptance-result mismatch', async () => {
    const rejectedFixture = await safeOutputFixture()
    const rejected = withProposalChange(rejectedFixture.proposal, {
      review: reviewOutputSchema.parse({
        verdict: 'reject', repairable: false, issues: ['Acceptance is not proven.'],
        acceptanceResults: rejectedFixture.request.issue.acceptanceCriteria.map(criterion => ({
          criterion, status: 'unknown', evidence: 'The evidence is incomplete.',
        })),
        rationale: ['Human review is required.'],
      }),
    })
    await expect(revalidateDraftPrSafeOutput({
      ...rejectedFixture,
      proposal: rejected,
      record: { ...rejectedFixture.record, proposalHash: rejected.proposalHash },
    })).rejects.toThrow(/reviewer did not approve/)

    const mismatchFixture = await safeOutputFixture()
    const mismatch = withProposalChange(mismatchFixture.proposal, {
      review: reviewOutputSchema.parse({
        verdict: 'approve', repairable: false, issues: [],
        acceptanceResults: [{
          criterion: 'A different criterion.', status: 'pass', evidence: 'Irrelevant evidence.',
        }],
        rationale: ['The wrong criterion was reviewed.'],
      }),
    })
    await expect(revalidateDraftPrSafeOutput({
      ...mismatchFixture,
      proposal: mismatch,
      record: { ...mismatchFixture.record, proposalHash: mismatch.proposalHash },
    })).rejects.toThrow(/reviewer results differ/)
  })

  it('fails closed when manifest configuration or run identity no longer matches', async () => {
    const policyFixture = await safeOutputFixture()
    await expect(revalidateDraftPrSafeOutput({
      ...policyFixture,
      config: { ...policyFixture.config, policyVersion: 'policy-v2' },
    })).rejects.toThrow(/policy, or prompt version differs/)

    const validationFixture = await safeOutputFixture()
    const changedValidation = {
      ...validationFixture.config.validationCommands[0]!,
      args: ['run', 'different-check'],
    }
    await expect(revalidateDraftPrSafeOutput({
      ...validationFixture,
      config: {
        ...validationFixture.config,
        validationCommands: [changedValidation, ...validationFixture.config.validationCommands.slice(1)],
      },
    })).rejects.toThrow(/manifest validation set differs/)

    const recordFixture = await safeOutputFixture()
    await expect(revalidateDraftPrSafeOutput({
      ...recordFixture,
      record: { ...recordFixture.record, baseSha: 'b'.repeat(40) },
    })).rejects.toThrow(/matching authoritative proposal-ready run record/)
  })
})

async function safeOutputFixture(overrides: { head?: string; status?: string } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'oma-safe-output-'))
  await mkdir(join(repoRoot, 'packages/demo/src'), { recursive: true })
  await writeFile(join(repoRoot, TARGET), CURRENT)
  const request = authorizedRequest()
  const config = testConfig()
  const partialManifest = {
    schemaVersion: 1 as const, policyVersion: config.policyVersion, promptVersion: config.promptVersion,
    generatedAt: '2026-08-10T00:00:00Z', repository: request.issue.repository,
    issueNumber: request.issue.number, issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha, targetWorkspaces: request.issue.targetWorkspaces,
    targetPaths: request.issue.targetPaths, allowedPaths: config.allowedPaths,
    approvedEditScopes: [{ path: TARGET, kind: 'file' as const }],
    protectedPaths: config.protectedPaths, validationCommands: config.validationCommands, sources: [],
    retrieval: { method: 'deterministic-file-tree-import-history-v1' as const, selectedFiles: [], omittedCandidateCount: 0, importRelations: [] },
    sufficiency: { sufficient: true, errors: [], warnings: [] },
  }
  const manifest = contextManifestSchema.parse({ ...partialManifest, manifestHash: hashJson(partialManifest) })
  const validationResults = config.validationCommands.map(command => ({
    id: command.id,
    command: renderCommand(command.command, command.args),
    success: true,
    exitCode: 0,
    durationMs: 1,
    stdout: 'pass',
    stderr: '',
    truncated: false,
  }))
  const review = reviewOutputSchema.parse({
    verdict: 'approve', repairable: false, issues: [],
    acceptanceResults: request.issue.acceptanceCriteria.map(criterion => ({
      criterion, status: 'pass', evidence: 'The final deterministic evidence proves this criterion.',
    })),
    rationale: ['Every gate passed.'],
  })
  const diff = `diff --git a/${TARGET} b/${TARGET}\n-old\n+${CURRENT}`
  const reviewBundle = reviewBundleSchema.parse({
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
    changedPaths: [TARGET],
    currentFiles: [{ path: TARGET, contentHash: sha256(CURRENT), content: CURRENT, byteLength: Buffer.byteLength(CURRENT) }],
    diff,
    diffHash: sha256(diff),
    validationResults,
    relevantContext: [],
    contextManifestHash: manifest.manifestHash,
  })
  const proposal = buildDraftPrProposal({
    request, config, manifest,
    appliedEdits: [{ path: TARGET, reason: 'Fix.', beforeHash: sha256('old'), afterHash: sha256(CURRENT), bytes: Buffer.byteLength(CURRENT), created: false }],
    validationResults, reviewBundle, review, implementationSummary: 'Fix the greeting.', risks: [],
  })
  const record = {
    schemaVersion: 1 as const,
    runKey: computeRunKey({
      repository: request.issue.repository,
      issueNumber: request.issue.number,
      issueRevision: request.authorization!.issueRevision,
      baseSha: request.baseSha,
    }),
    runId: 'run-safe-output',
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
    status: 'DRAFT_PR_PROPOSAL_READY' as const,
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:01:00Z',
    leaseExpiresAt: '2026-08-10T00:15:00Z',
    contextManifestHash: manifest.manifestHash,
    proposalHash: proposal.proposalHash,
  }
  const runner = new ScriptedCommandRunner((_command, args) => {
    if (args[0] === 'rev-parse') return { stdout: `${overrides.head ?? request.baseSha}\n`, stderr: '', exitCode: 0 }
    if (args[0] === 'status') return { stdout: overrides.status ?? ` M ${TARGET}\n`, stderr: '', exitCode: 0 }
    if (args[0] === 'diff') {
      return stat(join(repoRoot, TARGET)).then(info => ({
        stdout: (info.mode & 0o111) === 0 ? diff : diff.replace(
          `diff --git a/${TARGET} b/${TARGET}\n`,
          `diff --git a/${TARGET} b/${TARGET}\nold mode 100644\nnew mode 100755\n`,
        ),
        stderr: '',
        exitCode: 0,
      }))
    }
    throw new Error(`unexpected safe-output command: ${args.join(' ')}`)
  })
  return { repoRoot, runner, request, config, manifest, proposal, record }
}

function withProposalChange(
  proposal: DraftPrProposal,
  change: Partial<DraftPrProposal>,
): DraftPrProposal {
  const { proposalHash: _ignored, ...withoutHash } = { ...proposal, ...change }
  return draftPrProposalSchema.parse({ ...withoutHash, proposalHash: hashJson(withoutHash) })
}
