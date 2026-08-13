import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  maintainerRuntimeValidationContractSchema,
  redactSensitiveText,
  renderCommand,
  validationResultSchema,
  type ValidationResult,
} from '@open-multi-agent/maintainer-bot'
import { assertApprovedCandidate } from './candidate-gate.js'
import type { SandboxProcessRunner } from './bounded-process.js'
import { runValidationInSandbox } from './validation-sandbox.js'
import {
  assertValidationWorkspaceCandidate,
  cleanupValidationWorkspace,
  createValidationWorkspace,
} from './validation-workspace.js'

export async function runProductionSandboxValidation(options: {
  readonly contract: unknown
  readonly repoRoot: string
  readonly sandboxProcessRunner?: SandboxProcessRunner
  /** Test-only location seam. The production CLI never exposes this option. */
  readonly workspaceParentDir?: string
  readonly sourceEnvironment?: NodeJS.ProcessEnv
}): Promise<ValidationResult[]> {
  assertCredentialFreeValidationEnvironment(options.sourceEnvironment ?? process.env)
  const contract = maintainerRuntimeValidationContractSchema.parse(options.contract)
  const repoRoot = await realpath(resolve(options.repoRoot))
  await assertApprovedCandidate(repoRoot, contract)

  const results: ValidationResult[] = []
  for (const command of contract.validationCommands) {
    const workspace = await createValidationWorkspace({
      sourceRepoRoot: repoRoot,
      baseSha: contract.baseSha,
      changedPaths: contract.changedFiles.map(file => file.path),
      candidateDiff: contract.candidateDiff,
      maxFileBytes: contract.limits.maxFileBytes,
      parentDir: options.workspaceParentDir,
    })
    try {
      await assertApprovedCandidate(workspace.repoRoot, contract, { ignoreUnapprovedUntrackedFiles: true })
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
      await assertApprovedCandidate(workspace.repoRoot, contract, { ignoreUnapprovedUntrackedFiles: true })
      await assertValidationWorkspaceCandidate(workspace, contract.limits.maxFileBytes)
    } finally {
      await cleanupValidationWorkspace(workspace)
    }
  }
  await assertApprovedCandidate(repoRoot, contract)
  return results
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
