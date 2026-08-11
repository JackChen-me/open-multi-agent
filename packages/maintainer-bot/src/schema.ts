import { z } from 'zod'

const sha40 = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const repoPath = z.string().trim().min(1).max(500)
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200)
const boundedLine = z.string().trim().min(1).max(1_000).refine(
  value => !/[\r\n]/.test(value),
  'must be a single line',
)

export const maintainerStateSchema = z.enum([
  'READY_CANDIDATE',
  'NEEDS_CLARIFICATION',
  'MANUAL_ONLY',
  'BLOCKED',
  'AGENT_READY',
  'RUNNING',
  'DRAFT_PR_PROPOSAL_READY',
  'DRAFT_PR_CREATED',
  'NEEDS_HUMAN',
  'FAILED',
])

export type MaintainerState = z.infer<typeof maintainerStateSchema>

export const admissionReasonCodeSchema = z.enum([
  'ISSUE_NOT_OPEN',
  'MISSING_PROBLEM',
  'MISSING_REPRODUCTION',
  'MISSING_CURRENT_BEHAVIOR',
  'MISSING_EXPECTED_BEHAVIOR',
  'MISSING_ACCEPTANCE_CRITERIA',
  'VAGUE_ACCEPTANCE_CRITERIA',
  'MISSING_TARGET_SCOPE',
  'MISSING_OUT_OF_SCOPE',
  'OPEN_PRODUCT_OR_ARCHITECTURE_DECISION',
  'ACTIVE_PULL_REQUEST',
  'ACTIVE_RUN',
  'EXTERNAL_BLOCKER',
  'MANUAL_ARCHITECTURE',
  'MANUAL_PUBLIC_API',
  'MANUAL_BREAKING_CHANGE',
  'MANUAL_CROSS_WORKSPACE_REFACTOR',
  'MANUAL_SECURITY',
  'MANUAL_PERMISSIONS',
  'MANUAL_PRIVACY',
  'MANUAL_LICENSE',
  'MANUAL_CI_RELEASE_PUBLISH',
  'MANUAL_DEPENDENCY_COMPATIBILITY',
  'MANUAL_TRACKER_DISCUSSION_QUESTION',
  'MANUAL_NONDETERMINISTIC_VALIDATION',
  'AUTHORIZATION_MISSING',
  'AUTHORIZER_LACKS_WRITE',
  'AUTHORIZATION_STALE',
  'AUTHORIZATION_BASE_MISMATCH',
  'AGENT_READY_LABEL_MISSING',
  'BASE_SHA_MISSING',
])

export type AdmissionReasonCode = z.infer<typeof admissionReasonCodeSchema>

export const issueRiskFlagSchema = z.enum([
  'architecture',
  'public-api-major',
  'breaking-change',
  'cross-workspace-refactor',
  'security',
  'permissions',
  'privacy',
  'license',
  'ci',
  'release',
  'publish',
  'dependency-compatibility-unknown',
  'nondeterministic-validation',
])

export type IssueRiskFlag = z.infer<typeof issueRiskFlagSchema>

export const issueCommentSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  body: z.string().max(100_000),
  updatedAt: z.string().min(1),
})

export const linkedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed', 'merged']),
})

export const maintainerIssueSchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  number: z.number().int().positive(),
  title: z.string().trim().min(1).max(1_000),
  body: z.string().max(200_000),
  state: z.enum(['open', 'closed']),
  author: z.string().min(1),
  updatedAt: z.string().min(1),
  labels: z.array(z.string().min(1)).max(100),
  comments: z.array(issueCommentSchema).max(500).default([]),
  kind: z.enum([
    'bug',
    'feature',
    'docs',
    'test',
    'refactor',
    'dependency',
    'question',
    'discussion',
    'tracker',
    'security',
    'other',
  ]),
  problem: z.string().max(50_000),
  reproductionSteps: z.array(z.string().trim().min(1).max(5_000)).max(50),
  currentBehavior: z.string().max(50_000),
  expectedBehavior: z.string().max(50_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(5_000)).max(50),
  targetWorkspaces: z.array(z.string().trim().min(1).max(200)).max(20),
  targetPaths: z.array(repoPath).max(100),
  outOfScope: z.array(z.string().trim().min(1).max(5_000)).max(50),
  openDecisions: z.array(z.string().trim().min(1).max(5_000)).max(50),
  riskFlags: z.array(issueRiskFlagSchema).max(20).default([]),
  linkedPullRequests: z.array(linkedPullRequestSchema).max(50).default([]),
  activeRunId: z.string().min(1).optional(),
  blockers: z.array(z.string().trim().min(1).max(5_000)).max(50).default([]),
})

export type MaintainerIssue = z.infer<typeof maintainerIssueSchema>

export const maintainerAuthorizationSchema = z.object({
  kind: z.enum(['label', 'structured']),
  label: z.literal('agent-ready'),
  grantedBy: z.string().min(1),
  grantedByPermission: z.enum(['read', 'triage', 'write', 'maintain', 'admin']),
  issueRevision: sha256,
  baseSha: sha40,
  grantedAt: z.string().min(1),
})

export type MaintainerAuthorization = z.infer<typeof maintainerAuthorizationSchema>

export const controlPlaneRequestSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(500),
  receivedAt: z.string().min(1),
  baseSha: sha40,
  issue: maintainerIssueSchema,
  authorization: maintainerAuthorizationSchema.nullable(),
})

export type ControlPlaneRequest = z.infer<typeof controlPlaneRequestSchema>

export const admissionDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  status: maintainerStateSchema,
  mayDevelop: z.boolean(),
  issueRevision: sha256,
  baseSha: sha40,
  reasonCodes: z.array(admissionReasonCodeSchema),
  reasons: z.array(boundedLine),
})

export type AdmissionDecision = z.infer<typeof admissionDecisionSchema>

export const validationCommandSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(2_000)).max(100),
  cwd: repoPath.default('.'),
  timeoutMs: z.number().int().positive().max(30 * 60_000).default(10 * 60_000),
  env: z.record(environmentName, z.string().max(2_000)).default({}),
  unsetEnv: z.array(environmentName).max(100).default([]),
}).superRefine((command, context) => {
  for (const name of Object.keys(command.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH_SOCK)/i.test(name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['env', name],
        message: 'validation environment overrides cannot define credential-like variables',
      })
    }
    if (command.unsetEnv.includes(name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['env', name],
        message: 'a validation environment variable cannot be both set and unset',
      })
    }
  }
  if (new Set(command.unsetEnv).size !== command.unsetEnv.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unsetEnv'],
      message: 'validation unsetEnv entries must be unique',
    })
  }
})

export type ValidationCommand = z.infer<typeof validationCommandSchema>

export const maintainerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  model: z.string().min(1).max(200).default('deepseek-v4-flash'),
  agentReadyLabel: z.literal('agent-ready').default('agent-ready'),
  allowedPaths: z.array(repoPath).min(1).max(100),
  protectedPaths: z.array(repoPath).max(100).default([
    '.git',
    '.github/workflows',
    '.github/RELEASING.md',
    'package-lock.json',
  ]),
  context: z.object({
    maxFiles: z.number().int().positive().max(500).default(120),
    maxBytes: z.number().int().positive().max(1_000_000).default(800_000),
    maxBytesPerFile: z.number().int().positive().max(500_000).default(80_000),
    maxHistoryEntries: z.number().int().nonnegative().max(100).default(20),
  }).default({}),
  edits: z.object({
    maxFiles: z.number().int().positive().max(100).default(20),
    maxBytesPerFile: z.number().int().positive().max(1_000_000).default(160_000),
    maxTotalBytes: z.number().int().positive().max(5_000_000).default(500_000),
  }).default({}),
  validationCommands: z.array(validationCommandSchema).min(1).max(30),
  limits: z.object({
    maxTokenBudget: z.number().int().positive().max(2_000_000).default(160_000),
    maxCostUsd: z.number().positive().max(1_000).default(2),
    runTimeoutMs: z.number().int().positive().max(2_147_483_647).default(15 * 60_000),
    maxRepairLoops: z.number().int().min(0).max(2).default(2),
  }).default({}),
  modelPricing: z.object({
    inputPerMillionUsd: z.number().nonnegative().max(1_000),
    outputPerMillionUsd: z.number().nonnegative().max(1_000),
  }),
})

export type MaintainerConfig = z.infer<typeof maintainerConfigSchema>

export const contextSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    'system-policy',
    'issue',
    'repository-policy',
    'repository-file',
    'workspace-map',
    'git-history',
    'linked-evidence',
  ]),
  locator: z.string().min(1),
  trust: z.enum(['system-policy', 'repository-policy', 'untrusted-evidence']),
  priority: z.number().int().min(0).max(100),
  content: z.string(),
  contentHash: sha256,
  byteLength: z.number().int().nonnegative(),
  originalByteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

export type ContextSource = z.infer<typeof contextSourceSchema>

export const approvedEditScopeSchema = z.object({
  path: repoPath,
  kind: z.enum(['file', 'directory']),
})

export type ApprovedEditScope = z.infer<typeof approvedEditScopeSchema>

export const contextManifestSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.string(),
  promptVersion: z.string(),
  generatedAt: z.string(),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  issueRevision: sha256,
  baseSha: sha40,
  targetWorkspaces: z.array(z.string()),
  targetPaths: z.array(repoPath),
  allowedPaths: z.array(repoPath),
  approvedEditScopes: z.array(approvedEditScopeSchema),
  protectedPaths: z.array(repoPath),
  validationCommands: z.array(validationCommandSchema),
  sources: z.array(contextSourceSchema),
  retrieval: z.object({
    method: z.literal('deterministic-file-tree-import-history-v1'),
    selectedFiles: z.array(repoPath),
    omittedCandidateCount: z.number().int().nonnegative(),
    importRelations: z.array(z.object({ from: repoPath, to: repoPath })),
  }),
  sufficiency: z.object({
    sufficient: z.boolean(),
    errors: z.array(boundedLine),
    warnings: z.array(boundedLine),
  }),
  manifestHash: sha256,
})

export type ContextManifest = z.infer<typeof contextManifestSchema>

export const modelTriageSchema = z.object({
  verdict: z.enum(['proceed', 'needs_human']).describe(
    'Use proceed only when no unresolved uncertainty or manual-only risk remains.',
  ),
  confirmedIssueRevision: sha256.describe(
    'Copy the exact immutable issue revision from the context manifest.',
  ),
  confirmedAcceptanceCriteria: z.array(boundedLine).min(1).max(50).describe(
    'Copy every authorized acceptance criterion exactly, without rewriting or adding criteria.',
  ),
  uncertainties: z.array(boundedLine).max(30).describe(
    'Only unresolved evidence gaps that require a human decision. Return [] when evidence resolves them.',
  ),
  manualRiskSignals: z.array(boundedLine).max(30).describe(
    'Only actual blocking manual-only risks. Return []; never add reassuring no-risk statements.',
  ),
}).superRefine((triage, context) => {
  const blockers = [...triage.uncertainties, ...triage.manualRiskSignals]
  if (triage.verdict === 'proceed' && blockers.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'proceed requires empty uncertainties and manualRiskSignals',
    })
  }
  if (triage.verdict === 'needs_human' && blockers.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'needs_human requires at least one concrete blocking reason',
    })
  }
  for (const [field, values] of [
    ['uncertainties', triage.uncertainties],
    ['manualRiskSignals', triage.manualRiskSignals],
  ] as const) {
    values.forEach((value, index) => {
      if (/\b(?:no|none|not)\b.{0,40}\b(?:risk|uncertaint|issue|concern|identified|significant)\b/i.test(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index],
          message: 'blocking arrays must not contain reassuring or already-resolved statements',
        })
      }
    })
  }
})

export type ModelTriage = z.infer<typeof modelTriageSchema>

export const implementationPlanSchema = z.object({
  summary: boundedLine,
  acceptanceCriteria: z.array(boundedLine).min(1).max(50),
  files: z.array(z.object({
    path: repoPath,
    reason: boundedLine,
  })).max(50),
  validationCommandIds: z.array(z.string()).max(30),
  risks: z.array(boundedLine).max(30),
  unresolvedQuestions: z.array(boundedLine).max(30),
})

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>

export const editOperationSchema = z.object({
  path: repoPath,
  expectedHash: sha256.nullable(),
  content: z.string().max(1_000_000),
  reason: boundedLine,
})

export type EditOperation = z.infer<typeof editOperationSchema>

export const implementationOutputSchema = z.object({
  summary: boundedLine,
  edits: z.array(editOperationSchema).max(100),
  risks: z.array(boundedLine).max(30),
  assumptions: z.array(boundedLine).max(30),
})

export type ImplementationOutput = z.infer<typeof implementationOutputSchema>

export const validationResultSchema = z.object({
  id: z.string(),
  command: z.string(),
  success: z.boolean(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  environment: z.object({
    set: z.array(z.object({ name: environmentName, value: z.string().max(2_000) })),
    unset: z.array(environmentName),
  }).default({ set: [], unset: [] }),
})

export type ValidationResult = z.infer<typeof validationResultSchema>

export const reviewOutputSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  repairable: z.boolean(),
  issues: z.array(boundedLine).max(50),
  acceptanceResults: z.array(z.object({
    criterion: boundedLine,
    status: z.enum(['pass', 'fail', 'unknown']),
    evidence: boundedLine,
  })).min(1).max(50),
  rationale: z.array(boundedLine).min(1).max(30),
}).superRefine((review, context) => {
  if (review.verdict === 'approve') {
    if (review.issues.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issues'],
        message: 'approved review cannot contain issues',
      })
    }
    if (review.acceptanceResults.some(result => result.status !== 'pass')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceResults'],
        message: 'approved review requires every acceptance criterion to pass',
      })
    }
  }
})

export type ReviewOutput = z.infer<typeof reviewOutputSchema>

export const draftPrProposalSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('draft_pr'),
  eligibleForHostWrite: z.literal(true),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  issueRevision: sha256,
  baseSha: sha40,
  contextManifestHash: sha256,
  title: boundedLine,
  summary: boundedLine,
  acceptanceCriteria: z.array(boundedLine).min(1),
  changedFiles: z.array(z.object({
    path: repoPath,
    reason: boundedLine,
    beforeHash: sha256.nullable(),
    afterHash: sha256,
  })).min(1),
  validationResults: z.array(validationResultSchema).min(1),
  skippedChecks: z.array(boundedLine),
  model: z.string(),
  promptVersion: z.string(),
  policyVersion: z.string(),
  risks: z.array(boundedLine),
  review: reviewOutputSchema,
  generatedAt: z.string(),
  proposalHash: sha256,
})

export type DraftPrProposal = z.infer<typeof draftPrProposalSchema>
