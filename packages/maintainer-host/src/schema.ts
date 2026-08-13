import { z } from 'zod'
import {
  admissionDecisionSchema,
  controlPlaneRequestSchema,
  maintainerConfigSchema,
  normalizeRepoPath,
  validationCommandSchema,
} from '@open-multi-agent/maintainer-bot'

const sha40 = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const repoPath = z.string().min(1).max(500).superRefine((value, context) => {
  if (value !== value.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'repository paths must not contain surrounding whitespace' })
    return
  }
  if (/[*?[\]{}]/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'repository policy paths must be literal, not globs' })
  }
  if (value.endsWith('/')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'repository policy paths must not have a trailing slash' })
  }
  try {
    if (normalizeRepoPath(value) !== value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'repository policy paths must use canonical normalized form' })
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'repository policy path is unsafe',
    })
  }
})
const boundedLine = z.string().trim().min(1).max(1_000).refine(
  value => !/[\r\n]/.test(value),
  'must be a single line',
)

export const githubLabelEventSchema = z.object({
  action: z.literal('labeled'),
  label: z.object({ name: z.string() }),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    updated_at: z.string(),
    comments: z.number().int().nonnegative(),
    user: z.object({ login: z.string().min(1) }),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    default_branch: z.string().min(1),
  }),
  sender: z.object({ login: z.string().min(1) }),
})

export type GitHubLabelEvent = z.infer<typeof githubLabelEventSchema>

export const githubIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  updated_at: z.string(),
  comments: z.number().int().nonnegative(),
  user: z.object({ login: z.string().min(1) }),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
})

export type GitHubIssue = z.infer<typeof githubIssueSchema>

export const githubActorSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  type: z.string().min(1),
})

export type GitHubActor = z.infer<typeof githubActorSchema>

export const githubCommentSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string().min(1),
  body: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  author_association: z.string().optional(),
  user: githubActorSchema,
})

export type GitHubComment = z.infer<typeof githubCommentSchema>

export const githubTimelineEventSchema = z.object({
  event: z.string(),
  source: z.object({
    issue: z.object({
      number: z.number().int().positive(),
      state: z.enum(['open', 'closed']),
      pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
    }).optional(),
  }).optional(),
}).passthrough()

export type GitHubTimelineEvent = z.infer<typeof githubTimelineEventSchema>

export const githubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  user: githubActorSchema,
  head: z.object({ ref: z.string(), sha: sha40 }),
  base: z.object({ ref: z.string(), sha: sha40 }),
  merged_at: z.string().nullable(),
})

export type GitHubPullRequest = z.infer<typeof githubPullRequestSchema>

export const githubActionsRunSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
  conclusion: z.string().nullable(),
  html_url: z.string().url(),
})

export type GitHubActionsRun = z.infer<typeof githubActionsRunSchema>

const githubAppSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/)
const githubClientIdSchema = z.string().regex(/^[A-Za-z0-9._-]{8,100}$/)

export const githubAppWriterContractSchema = z.object({
  enabled: z.boolean(),
  expectedAppId: z.number().int().positive(),
  expectedClientId: githubClientIdSchema,
  expectedSlug: githubAppSlugSchema,
  expectedInstallationId: z.number().int().positive(),
  expectedBotUserId: z.number().int().positive(),
  actualSlug: githubAppSlugSchema,
  actualInstallationId: z.number().int().positive(),
})

export type GitHubAppWriterContract = z.infer<typeof githubAppWriterContractSchema>

export const githubAppWriterIdentitySchema = z.object({
  appId: z.number().int().positive(),
  clientId: githubClientIdSchema,
  slug: githubAppSlugSchema,
  installationId: z.number().int().positive(),
  botUserId: z.number().int().positive(),
  botLogin: z.string().min(1).max(120),
}).superRefine((identity, context) => {
  if (identity.botLogin !== `${identity.slug}[bot]`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['botLogin'],
      message: 'GitHub App bot login must match the verified App slug',
    })
  }
})

export type GitHubAppWriterIdentity = z.infer<typeof githubAppWriterIdentitySchema>

const pathRuleSchema = z.object({
  path: repoPath,
  kind: z.enum(['file', 'directory']).default('directory'),
  validationIds: z.array(z.string()).min(1),
})

export const productionPolicySchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-activation-v1'),
  enabled: z.boolean(),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  agentReadyLabel: z.literal('agent-ready'),
  policyVersion: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  executionBackend: maintainerConfigSchema.shape.executionBackend,
  model: z.string().min(1).max(200),
  claudeCode: maintainerConfigSchema.shape.claudeCode,
  allowedPaths: z.array(repoPath).min(1),
  protectedPaths: z.array(repoPath).min(1),
  manualOnlyPaths: z.array(repoPath),
  alwaysValidationIds: z.array(z.string()).min(1),
  workspaces: z.array(z.object({
    name: z.string().min(1),
    root: repoPath,
    validationIds: z.array(z.string()).min(1),
    pathRules: z.array(pathRuleSchema).default([]),
  })).min(1),
  validationRegistry: z.array(validationCommandSchema).min(1),
  context: maintainerConfigSchema.shape.context,
  edits: maintainerConfigSchema.shape.edits,
  limits: maintainerConfigSchema.shape.limits,
  modelPricing: maintainerConfigSchema.shape.modelPricing,
  pullRequest: z.object({
    branchPrefix: z.literal('agent/issue-'),
    maxChangedFiles: z.number().int().positive().max(100),
  }),
}).superRefine((policy, context) => {
  const unique = (values: readonly string[], path: Array<string | number>, label: string) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: `${label} must be unique` })
    }
  }
  unique(policy.allowedPaths, ['allowedPaths'], 'allowed paths')
  unique(policy.protectedPaths, ['protectedPaths'], 'protected paths')
  unique(policy.manualOnlyPaths, ['manualOnlyPaths'], 'manual-only paths')
  unique(policy.alwaysValidationIds, ['alwaysValidationIds'], 'always-validation ids')
  unique(policy.workspaces.map(workspace => workspace.name), ['workspaces'], 'workspace names')
  unique(policy.workspaces.map(workspace => workspace.root), ['workspaces'], 'workspace roots')
  policy.workspaces.forEach((workspace, index) => {
    unique(workspace.validationIds, ['workspaces', index, 'validationIds'], 'workspace validation ids')
    unique(workspace.pathRules.map(rule => rule.path), ['workspaces', index, 'pathRules'], 'workspace path rules')
  })
  const registryIds = new Set(policy.validationRegistry.map(command => command.id))
  if (registryIds.size !== policy.validationRegistry.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['validationRegistry'], message: 'validation ids must be unique' })
  }
  const references = [
    ...policy.alwaysValidationIds,
    ...policy.workspaces.flatMap(workspace => [
      ...workspace.validationIds,
      ...workspace.pathRules.flatMap(rule => rule.validationIds),
    ]),
  ]
  for (const id of references) {
    if (!registryIds.has(id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validationRegistry'],
        message: `unknown validation id referenced by policy: ${id}`,
      })
    }
  }
})

export type ProductionPolicy = z.infer<typeof productionPolicySchema>

export const activationStatusSchema = z.enum([
  'STARTED',
  'RUNNING',
  'NEEDS_CLARIFICATION',
  'MANUAL_ONLY',
  'NEEDS_HUMAN',
  'FAILED',
  'DRAFT_PR_CREATED',
])

export type ActivationStatus = z.infer<typeof activationStatusSchema>

export const statusClaimSchema = z.object({
  status: activationStatusSchema,
  claimId: z.string().min(1).max(300),
  actionsRunId: z.number().int().positive(),
  runUrl: z.string().url(),
  baseSha: sha40,
  issueRevision: sha256.nullable(),
  runKey: sha256.nullable(),
  branch: z.string().max(240).nullable(),
  pullRequestUrl: z.string().url().nullable(),
  updatedAt: z.string(),
})

export type StatusClaim = z.infer<typeof statusClaimSchema>

export const statusMetadataSchema = z.object({
  version: z.literal(2),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  issueNumber: z.number().int().positive(),
  status: activationStatusSchema,
  claimId: z.string().min(1).max(300),
  actionsRunId: z.number().int().positive(),
  runUrl: z.string().url(),
  baseSha: sha40,
  issueRevision: sha256.nullable(),
  runKey: sha256.nullable(),
  branch: z.string().max(240).nullable(),
  pullRequestUrl: z.string().url().nullable(),
  updatedAt: z.string(),
  claims: z.array(statusClaimSchema).max(64).default([]),
}).superRefine((metadata, context) => {
  const keys = metadata.claims.map(claim => claim.runKey ?? `pending:${claim.claimId}`)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claims'],
      message: 'durable claim ledger entries must have unique runKey or pending claim identifiers',
    })
  }
})

export type StatusMetadata = z.infer<typeof statusMetadataSchema>

export const activationContextSchema = z.object({
  schemaVersion: z.literal(1),
  shouldRun: z.boolean(),
  claimId: z.string(),
  actionsRunId: z.number().int().positive(),
  runUrl: z.string().url(),
  commentId: z.number().int().positive(),
  branch: z.string().max(240).nullable(),
  writerIdentity: githubAppWriterIdentitySchema,
  removedBootstrapCommentCount: z.number().int().nonnegative().max(1),
  request: controlPlaneRequestSchema.nullable(),
  config: maintainerConfigSchema.nullable(),
  admission: admissionDecisionSchema.nullable(),
  status: activationStatusSchema,
  detail: boundedLine,
})

export type ActivationContext = z.infer<typeof activationContextSchema>

export const engineResultSchema = z.object({
  schemaVersion: z.literal(1),
  attempted: z.boolean(),
  exitCode: z.number().int(),
  status: z.string().min(1),
  detail: boundedLine,
})

export type EngineResult = z.infer<typeof engineResultSchema>
