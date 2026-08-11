import { dirname, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  type CommandResult,
  type ValidationCommand,
} from '@open-multi-agent/maintainer-bot'
import {
  BoundedProcessError,
  BoundedProcessRunner,
  type SandboxProcessRunner,
} from './bounded-process.js'

export const BUBBLEWRAP_PATH = '/usr/bin/bwrap'
export const SANDBOX_REPO_ROOT = '/workspace'

const PROTECTED_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'CI',
  'LANG',
  'LC_ALL',
  'TZ',
  'npm_config_cache',
])

export class ValidationSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationSandboxError'
  }
}

export interface ValidationSandboxInvocation {
  readonly command: typeof BUBBLEWRAP_PATH
  readonly args: readonly string[]
  readonly cwd: '/'
  readonly env: NodeJS.ProcessEnv
}

export async function buildValidationSandboxInvocation(options: {
  readonly repoRoot: string
  readonly command: ValidationCommand
  readonly nodeExecutable?: string
}): Promise<ValidationSandboxInvocation> {
  assertPolicyEnvironment(options.command)
  const repoRoot = await realpath(resolve(options.repoRoot))
  const hostCwd = await realpath(resolve(repoRoot, options.command.cwd))
  const cwdRelation = relative(repoRoot, hostCwd)
  if (cwdRelation === '..' || cwdRelation.startsWith(`..${sep}`) || cwdRelation.startsWith(sep)) {
    throw new ValidationSandboxError('Validation cwd resolves outside the repository.')
  }

  const nodeExecutable = await realpath(options.nodeExecutable ?? process.execPath)
  const nodeBin = dirname(nodeExecutable)
  const nodeRoot = dirname(nodeBin)
  const sandboxCwd = cwdRelation.length === 0
    ? SANDBOX_REPO_ROOT
    : `${SANDBOX_REPO_ROOT}/${cwdRelation.split(sep).join('/')}`
  const sandboxEnvironment: Record<string, string> = {
    PATH: `${nodeBin}:/usr/bin:/bin`,
    HOME: '/home/validation',
    TMPDIR: '/tmp',
    CI: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    npm_config_cache: '/tmp/npm-cache',
    ...options.command.env,
  }
  for (const name of options.command.unsetEnv) delete sandboxEnvironment[name]

  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop', 'ALL',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/home',
    '--dir', '/home/validation',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', nodeRoot, nodeRoot,
    '--ro-bind', repoRoot, SANDBOX_REPO_ROOT,
    '--chdir', sandboxCwd,
    '--clearenv',
    ...Object.entries(sandboxEnvironment).flatMap(([name, value]) => ['--setenv', name, value]),
    '--',
    options.command.command,
    ...options.command.args,
  ]
  return {
    command: BUBBLEWRAP_PATH,
    args,
    cwd: '/',
    // Bubblewrap itself receives no inherited environment. The validation
    // environment is constructed only through --clearenv/--setenv above.
    env: {},
  }
}

export async function runValidationInSandbox(options: {
  readonly repoRoot: string
  readonly command: ValidationCommand
  readonly maxOutputBytes: number
  readonly runner?: SandboxProcessRunner
}): Promise<CommandResult> {
  const invocation = await buildValidationSandboxInvocation(options)
  try {
    return await (options.runner ?? new BoundedProcessRunner()).run(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: options.command.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    })
  } catch (error) {
    if (error instanceof BoundedProcessError) throw error
    throw new ValidationSandboxError('Bubblewrap validation sandbox could not start.')
  }
}

export async function preflightValidationSandbox(options: {
  readonly repoRoot: string
  readonly runner?: SandboxProcessRunner
}): Promise<void> {
  const command: ValidationCommand = {
    id: 'sandbox-preflight',
    command: process.execPath,
    args: ['--version'],
    cwd: '.',
    timeoutMs: 30_000,
    env: {},
    unsetEnv: [],
  }
  const result = await runValidationInSandbox({
    repoRoot: options.repoRoot,
    command,
    maxOutputBytes: 10_000,
    runner: options.runner,
  })
  if (result.exitCode !== 0) throw new ValidationSandboxError('Bubblewrap validation sandbox preflight failed.')
}

function assertPolicyEnvironment(command: ValidationCommand): void {
  for (const name of [...Object.keys(command.env), ...command.unsetEnv]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new ValidationSandboxError('Validation environment name is invalid.')
    }
    if (PROTECTED_ENVIRONMENT_NAMES.has(name)) {
      throw new ValidationSandboxError('Validation policy cannot override sandbox environment invariants.')
    }
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK|GITHUB|^GH_|ACTIONS_|RUNNER_|SSH_|NPM_|NODE_AUTH|ANTHROPIC|DEEPSEEK)/i.test(name)) {
      throw new ValidationSandboxError('Validation policy contains a forbidden credential environment name.')
    }
  }
  for (const value of Object.values(command.env)) {
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      throw new ValidationSandboxError('Validation environment values must be single-line text.')
    }
  }
}
