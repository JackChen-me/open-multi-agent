import { z } from 'zod'
import { approvedEditScopeSchema, validationCommandSchema, validationResultSchema } from './schema.js'

const sha40 = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const repoPath = z.string().min(1).max(500)

export const maintainerRuntimeCodingContractSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-claude-code-backend-v1'),
  baseSha: sha40,
  allowedScopes: z.array(approvedEditScopeSchema).min(1).max(100),
  model: z.literal('deepseek-v4-flash'),
  claudeCodeVersion: z.literal('2.1.220'),
  limits: z.object({
    timeoutMs: z.number().int().positive().max(45 * 60_000),
    maxTurns: z.number().int().positive().max(50),
    maxProcessOutputBytes: z.number().int().positive().max(10_000_000),
  }),
})

export type MaintainerRuntimeCodingContract = z.infer<typeof maintainerRuntimeCodingContractSchema>

export const maintainerRuntimeCodingResultSchema = z.object({
  status: z.literal('CODING_COMPLETED'),
  turns: z.number().int().nonnegative(),
  terminationReason: z.string().min(1).max(200),
  safeEventCount: z.number().int().nonnegative(),
})

export const maintainerRuntimeValidationContractSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-sandbox-validation-v1'),
  baseSha: sha40,
  changedFiles: z.array(z.object({
    path: repoPath,
    contentHash: sha256,
  })).min(1).max(100),
  candidateDiff: z.string().min(1).max(500_000),
  validationCommands: z.array(validationCommandSchema).min(1).max(30),
  limits: z.object({
    maxFileBytes: z.number().int().positive().max(1_000_000),
    maxValidationOutputBytes: z.number().int().positive().max(10_000_000),
  }),
})

export type MaintainerRuntimeValidationContract = z.infer<typeof maintainerRuntimeValidationContractSchema>

export const maintainerRuntimeValidationResultSchema = z.object({
  status: z.literal('VALIDATION_COMPLETED'),
  validationResults: z.array(validationResultSchema).min(1),
})
