import type { CommandRunner } from './command.js'
import { renderCommand, sanitizedChildEnvironment } from './command.js'
import { pathWithin, resolveInside } from './paths.js'
import {
  validationResultSchema,
  type MaintainerConfig,
  type ValidationCommand,
  type ValidationResult,
} from './schema.js'

export interface RunValidationOptions {
  readonly repoRoot: string
  readonly config: MaintainerConfig
  readonly runner: CommandRunner
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
}

export async function runRegisteredValidations(
  options: RunValidationOptions,
): Promise<ValidationResult[]> {
  assertUniqueValidationIds(options.config.validationCommands)
  const now = options.now ?? (() => Date.now())
  const results: ValidationResult[] = []
  for (const validation of options.config.validationCommands) {
    assertValidationCwd(validation, options.config)
    const environment = validationEnvironment(options.env, validation)
    const startedAt = now()
    const result = await options.runner.run(validation.command, validation.args, {
      cwd: validation.cwd === '.' ? options.repoRoot : resolveInside(options.repoRoot, validation.cwd),
      env: environment,
      allowFailure: true,
      timeoutMs: validation.timeoutMs,
      maxOutputChars: 100_000,
    })
    const durationMs = Math.max(0, now() - startedAt)
    const stdout = boundValidationOutput(result.stdout)
    const stderr = boundValidationOutput(result.stderr)
    results.push(validationResultSchema.parse({
      id: validation.id,
      command: renderCommand(validation.command, validation.args),
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      environment: {
        set: Object.entries(validation.env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => ({ name, value })),
        unset: [...validation.unsetEnv].sort(),
      },
    }))
  }
  return results
}

function validationEnvironment(
  source: NodeJS.ProcessEnv | undefined,
  validation: ValidationCommand,
): NodeJS.ProcessEnv {
  const environment = sanitizedChildEnvironment(source)
  for (const name of validation.unsetEnv) delete environment[name]
  for (const [name, value] of Object.entries(validation.env)) environment[name] = value
  return environment
}

export function allValidationsPassed(results: readonly ValidationResult[]): boolean {
  return results.length > 0 && results.every(result => result.success && !result.truncated)
}

function assertUniqueValidationIds(commands: readonly ValidationCommand[]): void {
  const ids = new Set<string>()
  for (const command of commands) {
    if (ids.has(command.id)) throw new Error(`Duplicate validation command id: ${command.id}`)
    ids.add(command.id)
  }
}

function assertValidationCwd(command: ValidationCommand, config: MaintainerConfig): void {
  if (command.cwd === '.') return
  if (!config.allowedPaths.some(path => pathWithin(command.cwd, path) || pathWithin(path, command.cwd))) {
    throw new Error(`Validation cwd is unrelated to the configured allowed paths: ${command.cwd}`)
  }
}

function boundValidationOutput(value: string): { text: string; truncated: boolean } {
  const limit = 50_000
  if (value.length <= limit) return { text: value, truncated: false }
  const half = Math.floor((limit - 40) / 2)
  return {
    text: `${value.slice(0, half)}\n[validation output truncated]\n${value.slice(-half)}`,
    truncated: true,
  }
}
