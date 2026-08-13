import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  NodeCommandRunner,
  parseChangedPaths,
  redactSensitiveText,
  renderCommand,
  resolveInside,
  sha256,
  validationCommandSchema,
  validationResultSchema,
  type ValidationResult,
} from '@open-multi-agent/maintainer-bot'
import { z } from 'zod'
import type { SandboxProcessRunner } from './bounded-process.js'
import { runValidationInSandbox } from './validation-sandbox.js'
import {
  assertValidationWorkspaceIntegrity,
  cleanupValidationWorkspace,
  createValidationWorkspace,
  type ValidationWorkspace,
} from './validation-workspace.js'

export const productionValidationContractSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal('oma-maintainer-sandbox-validation-v1'),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  changedFiles: z.array(z.object({
    path: z.string().min(1).max(500),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1).max(100),
  candidateDiff: z.string().min(1).max(500_000),
  validationCommands: z.array(validationCommandSchema).min(1).max(30),
  limits: z.object({
    maxFileBytes: z.number().int().positive().max(1_000_000),
    maxValidationOutputBytes: z.number().int().positive().max(10_000_000),
  }),
})

export type ProductionValidationContract = z.infer<typeof productionValidationContractSchema>

export async function runProductionSandboxValidation(options: {
  readonly contract: unknown
  readonly repoRoot: string
  readonly sandboxProcessRunner?: SandboxProcessRunner
  /** Test-only location seam. The production CLI never exposes this option. */
  readonly workspaceParentDir?: string
  readonly sourceEnvironment?: NodeJS.ProcessEnv
}): Promise<ValidationResult[]> {
  assertCredentialFreeValidationEnvironment(options.sourceEnvironment ?? process.env)
  const contract = productionValidationContractSchema.parse(options.contract)
  const repoRoot = await realpath(resolve(options.repoRoot))
  await assertSourceCandidate(repoRoot, contract)

  let workspace: ValidationWorkspace | undefined
  try {
    workspace = await createValidationWorkspace({
      sourceRepoRoot: repoRoot,
      baseSha: contract.baseSha,
      changedPaths: contract.changedFiles.map(file => file.path),
      candidateDiff: contract.candidateDiff,
      maxFileBytes: contract.limits.maxFileBytes,
      parentDir: options.workspaceParentDir,
    })
    const results: ValidationResult[] = []
    for (const command of contract.validationCommands) {
      const startedAt = Date.now()
      const result = await runValidationInSandbox({
        workspaceRoot: workspace.repoRoot,
        dependencyRoot: workspace.dependencyRoot,
        resolverHostsPath: workspace.resolverHostsPath,
        resolverNsswitchPath: workspace.resolverNsswitchPath,
        command,
        maxOutputBytes: contract.limits.maxValidationOutputBytes,
        runner: options.sandboxProcessRunner,
      })
      results.push(validationResultSchema.parse({
        id: command.id,
        command: renderCommand(command.command, command.args),
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        stdout: boundAndRedact(result.stdout, contract.limits.maxValidationOutputBytes),
        stderr: boundAndRedact(result.stderr, contract.limits.maxValidationOutputBytes),
        truncated: false,
        environment: {
          set: Object.entries(command.env)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => ({ name, value })),
          unset: [...command.unsetEnv].sort(),
        },
      }))
    }
    await assertValidationWorkspaceIntegrity(workspace, contract.limits.maxFileBytes)
    await assertSourceCandidate(repoRoot, contract)
    return results
  } finally {
    if (workspace !== undefined) await cleanupValidationWorkspace(workspace)
  }
}

async function assertSourceCandidate(
  repoRoot: string,
  contract: ProductionValidationContract,
): Promise<void> {
  const runner = new NodeCommandRunner()
  const [head, status] = await Promise.all([
    runner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    runner.run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot }),
  ])
  if (head.stdout.trim() !== contract.baseSha) {
    throw new Error('Production validation source checkout differs from the pinned base SHA.')
  }
  const actualPaths = parseChangedPaths(status.stdout)
  const expectedPaths = contract.changedFiles.map(file => file.path).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Production validation source path set differs from the approved candidate.')
  }
  for (const file of contract.changedFiles) {
    const absolute = resolveInside(repoRoot, file.path)
    const info = await lstat(absolute)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Production validation candidate contains a non-regular file.')
    }
    if (sha256(await readFile(absolute)) !== file.contentHash) {
      throw new Error('Production validation source content differs from the approved candidate.')
    }
  }
}

function assertCredentialFreeValidationEnvironment(environment: NodeJS.ProcessEnv): void {
  const forbidden = Object.keys(environment).filter(name =>
    /(?:GITHUB|GH_|ACTIONS_|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH_SOCK|NPM_CONFIG_USERCONFIG)/i.test(name))
  if (forbidden.length > 0) {
    throw new Error('Production validation process environment contains forbidden credentials.')
  }
}

function boundAndRedact(value: string, maxBytes: number): string {
  const redacted = redactSensitiveText(value)
  if (Buffer.byteLength(redacted) <= maxBytes) return redacted
  throw new Error('Production validation output exceeded its hard byte limit.')
}
