import { z } from 'zod'
import { validationCommandSchema } from '@open-multi-agent/maintainer-bot'

const sha40 = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const repoPath = z.string().trim().min(1).max(500)

export const canaryPolicySchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-harness-canary-v1'),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  claudeCodeVersion: z.literal('2.1.220'),
  model: z.literal('deepseek-v4-flash'),
  allowedPaths: z.array(repoPath).min(1).max(50),
  protectedPaths: z.array(repoPath).min(1).max(100),
  validationRules: z.array(z.object({
    path: repoPath,
    validationCommands: z.array(validationCommandSchema).min(1).max(10),
  })).min(1).max(50),
  limits: z.object({
    wallClockMs: z.number().int().positive().max(45 * 60_000),
    maxTurns: z.number().int().positive().max(50),
    maxChangedFiles: z.number().int().positive().max(20),
    maxDiffBytes: z.number().int().positive().max(500_000),
    maxFileBytes: z.number().int().positive().max(500_000),
    maxProcessOutputBytes: z.number().int().positive().max(10_000_000),
    maxValidationOutputBytes: z.number().int().positive().max(200_000),
  }),
})

export type CanaryPolicy = z.infer<typeof canaryPolicySchema>

export const materialEvidenceSchema = z.object({
  id: z.number().int().positive(),
  author: z.string().min(1).max(200),
  body: z.string().max(200_000),
  updatedAt: z.string().min(1).max(100),
})

export const rawIssueSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  baseSha: sha40,
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(1_000),
    body: z.string().max(200_000),
    state: z.enum(['open', 'closed']),
    author: z.string().min(1),
    updatedAt: z.string().min(1),
    labels: z.array(z.string().min(1)).max(100),
  }),
  materialEvidence: z.array(materialEvidenceSchema).max(200).default([]),
})

export type RawIssueSnapshot = z.infer<typeof rawIssueSnapshotSchema>

export const canaryRequestSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-harness-request-v1'),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  baseSha: sha40,
  canarySnapshotRevision: sha256,
  materialEvidence: z.array(materialEvidenceSchema).max(200),
  issue: rawIssueSnapshotSchema.shape.issue.extend({
    problem: z.string().min(1).max(50_000),
    currentBehavior: z.string().min(1).max(50_000),
    expectedBehavior: z.string().min(1).max(50_000),
    reproductionSteps: z.array(z.string().min(1).max(5_000)).max(50),
    acceptanceCriteria: z.array(z.string().min(1).max(5_000)).min(1).max(50),
    targetPaths: z.array(repoPath).min(1).max(20),
    outOfScope: z.array(z.string().min(1).max(5_000)).min(1).max(50),
  }),
  allowedPaths: z.array(repoPath).min(1).max(20),
  validationCommands: z.array(validationCommandSchema).min(1).max(20),
})

export type CanaryRequest = z.infer<typeof canaryRequestSchema>

export const validationEvidenceSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  success: z.boolean(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
})

export const safeEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.string().min(1).max(100),
  subtype: z.string().max(100).nullable(),
})

const artifactBase = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-harness-artifact-v1'),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).nullable(),
  issueNumber: z.number().int().positive().nullable(),
  canarySnapshotRevision: sha256.nullable(),
  baseSha: sha40.nullable(),
  allowedPaths: z.array(repoPath),
  authority: z.literal('canary_evidence_only'),
  productionAuthorization: z.literal(false),
  eventsHash: sha256,
  safeEvents: z.array(safeEventSchema),
  validationResults: z.array(validationEvidenceSchema),
  durationMs: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative().nullable(),
  terminationReason: z.string().min(1).max(200).nullable(),
  claudeCodeVersion: z.literal('2.1.220').nullable(),
  model: z.literal('deepseek-v4-flash').nullable(),
  artifactHash: sha256,
})

export const succeededCanaryArtifactSchema = artifactBase.extend({
  status: z.literal('SUCCEEDED'),
  changedPaths: z.array(repoPath).min(1),
  diffBytes: z.number().int().positive(),
  diffHash: sha256,
})

export const failedCanaryArtifactSchema = artifactBase.extend({
  status: z.literal('FAILED'),
  stage: z.enum([
    'request_validation',
    'checkout_preflight',
    'harness_configuration',
    'harness_execution',
    'harness_output',
    'scope_validation',
    'deterministic_validation',
    'artifact_validation',
    'internal',
  ]),
  reasonCode: z.enum([
    'REQUEST_INVALID',
    'BASE_MISMATCH',
    'DIRTY_CHECKOUT',
    'CLI_UNAVAILABLE',
    'CLI_NONZERO',
    'TIMEOUT',
    'OUTPUT_LIMIT',
    'MALFORMED_OUTPUT',
    'SCOPE_VIOLATION',
    'VALIDATION_FAILED',
    'VALIDATION_SANDBOX_UNAVAILABLE',
    'VALIDATION_OUTPUT_LIMIT',
    'VALIDATION_TIMEOUT',
    'ARTIFACT_CONTAMINATION',
    'SECRET_LEAK',
    'PROVIDER_ENV_EXPOSURE',
    'INTERNAL_ERROR',
  ]),
  message: z.string().min(1).max(500),
})

export const canaryArtifactSchema = z.discriminatedUnion('status', [
  succeededCanaryArtifactSchema,
  failedCanaryArtifactSchema,
])

export type CanaryArtifact = z.infer<typeof canaryArtifactSchema>
export type FailedCanaryArtifact = z.infer<typeof failedCanaryArtifactSchema>
export type SafeEvent = z.infer<typeof safeEventSchema>
