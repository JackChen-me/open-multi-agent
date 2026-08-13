import { describe, expect, it } from 'vitest'
import {
  maintainerRuntimeCodingContractSchema,
  maintainerRuntimeCodingResultSchema,
  maintainerRuntimeValidationContractSchema,
  maintainerRuntimeValidationResultSchema,
} from '../src/runtime-contract.js'

describe('Maintainer Runtime contracts', () => {
  it('owns one schema for the coding request and terminal envelope', () => {
    const request = maintainerRuntimeCodingContractSchema.parse({
      schemaVersion: 1,
      contract: 'oma-maintainer-claude-code-backend-v1',
      baseSha: 'a'.repeat(40),
      allowedScopes: [{ path: 'packages/otel/README.md', kind: 'file' }],
      model: 'deepseek-v4-flash',
      claudeCodeVersion: '2.1.220',
      limits: { timeoutMs: 60_000, maxTurns: 20, maxProcessOutputBytes: 100_000 },
    })
    expect(request.allowedScopes).toEqual([{ path: 'packages/otel/README.md', kind: 'file' }])
    expect(maintainerRuntimeCodingResultSchema.parse({
      status: 'CODING_COMPLETED',
      turns: 3,
      terminationReason: 'success',
      safeEventCount: 4,
    }).turns).toBe(3)
  })

  it('owns one schema for the frozen candidate and validation envelope', () => {
    const request = maintainerRuntimeValidationContractSchema.parse({
      schemaVersion: 1,
      contract: 'oma-maintainer-sandbox-validation-v1',
      baseSha: 'b'.repeat(40),
      changedFiles: [{ path: 'packages/otel/README.md', contentHash: 'c'.repeat(64) }],
      candidateDiff: 'diff --git a/packages/otel/README.md b/packages/otel/README.md\n',
      validationCommands: [{ id: 'git-diff-check', command: 'git', args: ['diff', '--check'] }],
      limits: { maxFileBytes: 100_000, maxValidationOutputBytes: 100_000 },
    })
    expect(request.validationCommands[0]?.id).toBe('git-diff-check')
    expect(maintainerRuntimeValidationResultSchema.parse({
      status: 'VALIDATION_COMPLETED',
      validationResults: [{
        id: 'git-diff-check',
        command: 'git diff --check',
        success: true,
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
        truncated: false,
        environment: { set: [], unset: [] },
      }],
    }).validationResults).toHaveLength(1)
  })
})
