import { z } from 'zod'
import { bumpVersion, type VersionBump } from './semver.js'

const singleLine = z.string().trim().min(3).max(800).refine(
  value => !/[\r\n]/.test(value),
  'must be a single line',
)

const bumpSchema = z.enum(['none', 'patch', 'minor', 'major'])

export const packageVersionsSchema = z.object({
  core: z.string(),
  otel: z.string(),
  createOmaApp: z.string(),
})

export type PackageVersions = z.infer<typeof packageVersionsSchema>

export const releaseCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  subject: z.string(),
  body: z.string(),
})

export type ReleaseCommit = z.infer<typeof releaseCommitSchema>

export const changedFileSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
})

export type ChangedFile = z.infer<typeof changedFileSchema>

export const releaseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  baseTag: z.string(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  versions: packageVersionsSchema,
  commits: z.array(releaseCommitSchema),
  changedFiles: z.array(changedFileSchema),
  changelogUnreleased: z.string(),
  workspaceChanges: z.object({
    core: z.boolean(),
    otel: z.boolean(),
    createOmaApp: z.boolean(),
    docs: z.boolean(),
    workflows: z.boolean(),
  }),
})

export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>

export const changelogSectionsSchema = z.object({
  breakingChanges: z.array(singleLine).max(12),
  added: z.array(singleLine).max(20),
  changed: z.array(singleLine).max(20),
  fixed: z.array(singleLine).max(20),
  security: z.array(singleLine).max(12),
  compatibility: z.array(singleLine).max(12),
})

export type ChangelogSections = z.infer<typeof changelogSectionsSchema>

export const changeAnalysisSchema = z.object({
  releaseRecommended: z.boolean(),
  recommendedCoreBump: bumpSchema,
  recommendedCreateOmaAppBump: bumpSchema,
  recommendedOtelBump: bumpSchema,
  changelog: changelogSectionsSchema,
  rationale: z.array(singleLine).min(1).max(12),
})

export type ChangeAnalysis = z.infer<typeof changeAnalysisSchema>

export const compatibilityAnalysisSchema = z.object({
  risk: z.enum(['low', 'medium', 'high']),
  breaking: z.boolean(),
  recommendedCoreBump: bumpSchema,
  issues: z.array(singleLine).max(12),
  migrationNotes: z.array(singleLine).max(12),
  rationale: z.array(singleLine).min(1).max(12),
})

export type CompatibilityAnalysis = z.infer<typeof compatibilityAnalysisSchema>

export const releaseProposalSchema = z.object({
  decision: z.enum(['release', 'none']),
  coreBump: bumpSchema,
  createOmaAppBump: bumpSchema,
  otelBump: bumpSchema,
  summary: singleLine,
  changelog: changelogSectionsSchema,
  risks: z.array(singleLine).max(12),
  rationale: z.array(singleLine).min(1).max(12),
}).superRefine((proposal, context) => {
  if (proposal.decision === 'none') {
    for (const [name, bump] of [
      ['coreBump', proposal.coreBump],
      ['createOmaAppBump', proposal.createOmaAppBump],
      ['otelBump', proposal.otelBump],
    ] as const) {
      if (bump !== 'none') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'must be none when decision is none',
        })
      }
    }
  }

  if (proposal.decision === 'release') {
    if (proposal.coreBump === 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coreBump'],
        message: 'a release must increment core',
      })
    }
    if (proposal.createOmaAppBump === 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['createOmaAppBump'],
        message: 'a core release must increment create-oma-app',
      })
    }
    const entryCount = Object.values(proposal.changelog)
      .reduce((total, entries) => total + entries.length, 0)
    if (entryCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changelog'],
        message: 'a release must contain at least one changelog entry',
      })
    }
    if (proposal.changelog.breakingChanges.length > 0 && proposal.coreBump === 'patch') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coreBump'],
        message: 'breaking changes cannot ship as a patch release',
      })
    }
  }
})

export type ReleaseProposal = z.infer<typeof releaseProposalSchema>

export const releaseReviewSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  issues: z.array(singleLine).max(20),
  rationale: z.array(singleLine).min(1).max(12),
})

export type ReleaseReview = z.infer<typeof releaseReviewSchema>

export interface ReleasePlan {
  readonly schemaVersion: 1
  readonly baseTag: string
  readonly baseSha: string
  readonly headSha: string
  readonly releaseDate: string
  readonly currentVersions: PackageVersions
  readonly nextVersions: PackageVersions
  readonly bumps: {
    readonly core: Exclude<VersionBump, 'none'>
    readonly otel: Exclude<VersionBump, 'none'> | null
    readonly createOmaApp: Exclude<VersionBump, 'none'>
  }
  readonly summary: string
  readonly changelog: ChangelogSections
  readonly risks: readonly string[]
  readonly rationale: readonly string[]
  readonly review: ReleaseReview
}

export type ReleaseDecision =
  | { readonly status: 'none'; readonly proposal: ReleaseProposal; readonly review: ReleaseReview }
  | { readonly status: 'rejected'; readonly proposal: ReleaseProposal; readonly review: ReleaseReview }
  | { readonly status: 'release'; readonly plan: ReleasePlan; readonly proposal: ReleaseProposal; readonly review: ReleaseReview }

/**
 * Map core's bump to the create-oma-app bump for a core-only release.
 *
 * create-oma-app is still 0.x, so its minor position carries the "breaking"
 * signal: a core major (breaking) bumps create minor; any non-breaking core
 * bump (minor/patch) bumps create patch. This replaces the old "mirror core's
 * level" policy, which inflated create's minor position on every non-breaking
 * core release.
 */
function createOmaAppBumpForCoreOnly(coreBump: VersionBump): Exclude<VersionBump, 'none'> {
  return coreBump === 'major' ? 'minor' : 'patch'
}

/** Apply repository-owned bump policy before a proposal reaches review. */
export function normalizeReleaseProposal(
  evidence: ReleaseEvidence,
  proposalInput: unknown,
): ReleaseProposal {
  const proposal = releaseProposalSchema.parse(proposalInput)
  if (proposal.decision !== 'release' || evidence.workspaceChanges.createOmaApp) {
    return proposal
  }
  return { ...proposal, createOmaAppBump: createOmaAppBumpForCoreOnly(proposal.coreBump) }
}

export function buildReleaseDecision(
  evidence: ReleaseEvidence,
  proposalInput: unknown,
  reviewInput: unknown,
  releaseDate = new Date().toISOString().slice(0, 10),
): ReleaseDecision {
  const proposal = normalizeReleaseProposal(evidence, proposalInput)
  const review = releaseReviewSchema.parse(reviewInput)

  if (review.verdict === 'reject') return { status: 'rejected', proposal, review }
  if (proposal.decision === 'none') return { status: 'none', proposal, review }

  if (!evidence.workspaceChanges.core) {
    throw new Error('The planner requested a core release, but no packages/core files changed since the last tag.')
  }
  if (evidence.workspaceChanges.otel && proposal.otelBump === 'none') {
    throw new Error('The OTel workspace changed, so the release plan must increment @open-multi-agent/otel.')
  }
  if (!evidence.workspaceChanges.otel && proposal.otelBump !== 'none') {
    throw new Error('The OTel workspace did not change, so the release plan must not increment it.')
  }

  const coreBump = requireBump(proposal.coreBump, 'core')
  const proposedCreateOmaAppBump = requireBump(proposal.createOmaAppBump, 'create-oma-app')
  // A core release always changes create-oma-app's template pins. When the
  // scaffolder workspace had no merged changes of its own, that mechanical pin
  // bump follows core's breaking nature: a core major bumps create minor (its
  // 0.x minor position = breaking), any non-breaking core bump bumps create
  // patch.
  const createOmaAppBump = evidence.workspaceChanges.createOmaApp
    ? proposedCreateOmaAppBump
    : createOmaAppBumpForCoreOnly(coreBump)
  const otelBump = proposal.otelBump === 'none' ? null : proposal.otelBump

  return {
    status: 'release',
    proposal,
    review,
    plan: {
      schemaVersion: 1,
      baseTag: evidence.baseTag,
      baseSha: evidence.baseSha,
      headSha: evidence.headSha,
      releaseDate,
      currentVersions: evidence.versions,
      nextVersions: {
        core: bumpVersion(evidence.versions.core, coreBump),
        otel: otelBump === null
          ? evidence.versions.otel
          : bumpVersion(evidence.versions.otel, otelBump),
        createOmaApp: bumpVersion(evidence.versions.createOmaApp, createOmaAppBump),
      },
      bumps: {
        core: coreBump,
        otel: otelBump,
        createOmaApp: createOmaAppBump,
      },
      summary: proposal.summary,
      changelog: proposal.changelog,
      risks: proposal.risks,
      rationale: proposal.rationale,
      review,
    },
  }
}

function requireBump(
  bump: VersionBump,
  packageName: string,
): Exclude<VersionBump, 'none'> {
  if (bump === 'none') throw new Error(`${packageName} requires a version increment.`)
  return bump
}
