import { dirname, relative, resolve, sep } from 'node:path'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import {
  NodeCommandRunner,
  type CommandResult,
  type ValidationCommand,
  redactSensitiveText,
} from '@open-multi-agent/maintainer-bot'
import {
  BoundedProcessError,
  BoundedProcessRunner,
  type SandboxProcessRunner,
} from './bounded-process.js'
import {
  assertValidationWorkspaceCandidate,
  cleanupValidationWorkspace,
  createValidationWorkspace,
  VALIDATION_HOSTS,
  VALIDATION_NSSWITCH,
  type ValidationWorkspace,
} from './validation-workspace.js'

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

export type ValidationSandboxPreflightReason =
  | 'BWRAP_EXIT_NONZERO'
  | 'BWRAP_OUTPUT_LIMIT'
  | 'BWRAP_TIMEOUT'
  | 'BWRAP_SPAWN_ERROR'
  | 'BWRAP_INVOCATION_ERROR'

export interface ValidationSandboxPreflightDiagnostic {
  readonly status: 'SANDBOX_UNAVAILABLE'
  readonly reasonCode: ValidationSandboxPreflightReason
  readonly exitCode: number | null
  readonly osErrorCode: string | null
  readonly stdout: string
  readonly stderr: string
}

export class ValidationSandboxPreflightError extends Error {
  constructor(readonly diagnostic: ValidationSandboxPreflightDiagnostic) {
    super('Bubblewrap validation sandbox preflight failed.')
    this.name = 'ValidationSandboxPreflightError'
  }
}

export interface ValidationSandboxInvocation {
  readonly command: typeof BUBBLEWRAP_PATH
  readonly args: readonly string[]
  readonly cwd: '/'
  readonly env: NodeJS.ProcessEnv
}

export async function buildValidationSandboxInvocation(options: {
  readonly workspaceRoot: string
  readonly dependencyRoot: string
  readonly resolverHostsPath: string
  readonly resolverNsswitchPath: string
  readonly command: ValidationCommand
  readonly nodeExecutable?: string
}): Promise<ValidationSandboxInvocation> {
  assertPolicyEnvironment(options.command)
  const workspaceRoot = await realpath(resolve(options.workspaceRoot))
  const dependencyRoot = await realpath(resolve(options.dependencyRoot))
  const resolverHostsPath = await resolveValidationResolverFile(options.resolverHostsPath, VALIDATION_HOSTS)
  const resolverNsswitchPath = await resolveValidationResolverFile(options.resolverNsswitchPath, VALIDATION_NSSWITCH)
  const gitMetadataRoot = await realpath(resolve(workspaceRoot, '.git'))
  const hostCwd = await realpath(resolve(workspaceRoot, options.command.cwd))
  const cwdRelation = relative(workspaceRoot, hostCwd)
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
    '--dir', '/etc',
    '--ro-bind', resolverHostsPath, '/etc/hosts',
    '--ro-bind', resolverNsswitchPath, '/etc/nsswitch.conf',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', nodeRoot, nodeRoot,
    '--bind', workspaceRoot, SANDBOX_REPO_ROOT,
    '--ro-bind', gitMetadataRoot, `${SANDBOX_REPO_ROOT}/.git`,
    '--ro-bind', dependencyRoot, `${SANDBOX_REPO_ROOT}/node_modules`,
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

async function resolveValidationResolverFile(path: string, expected: string): Promise<string> {
  const requestedPath = resolve(path)
  const requestedInfo = await lstat(requestedPath)
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) {
    throw new ValidationSandboxError('Validation resolver configuration must be a regular file.')
  }
  const canonicalPath = await realpath(requestedPath)
  if (await readFile(canonicalPath, 'utf8') !== expected) {
    throw new ValidationSandboxError('Validation resolver configuration differs from the fixed loopback policy.')
  }
  return canonicalPath
}

export async function runValidationInSandbox(options: {
  readonly workspaceRoot: string
  readonly dependencyRoot: string
  readonly resolverHostsPath: string
  readonly resolverNsswitchPath: string
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
  /** Test-only location seam. The production CLI never exposes this option. */
  readonly workspaceParentDir?: string
}): Promise<void> {
  const repoRoot = await realpath(resolve(options.repoRoot))
  await assertNoViteStyleTempFiles(repoRoot)
  const commandRunner = new NodeCommandRunner()
  const baseSha = (await commandRunner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
  const command: ValidationCommand = {
    id: 'sandbox-preflight',
    command: process.execPath,
    args: ['--eval', `
const { mkdirSync, realpathSync, unlinkSync, writeFileSync } = require('node:fs')
const { lookup } = require('node:dns').promises
const temporary = '/workspace/packages/core/vitest.config.ts.timestamp-oma-preflight.mjs'
const disposableOutput = '/workspace/.oma-validation-preflight-cache/output.txt'
;(async () => {
  try {
    writeFileSync(temporary, 'export default {}\\n')
  } finally {
    unlinkSync(temporary)
  }
  mkdirSync('/workspace/.oma-validation-preflight-cache', { recursive: true })
  writeFileSync(disposableOutput, 'ephemeral\\n')
  if (realpathSync('/workspace/node_modules/@open-multi-agent/core') !== '/workspace/packages/core') {
    throw new Error('Workspace dependency symlink escaped the disposable snapshot.')
  }
  const addresses = await lookup('localhost', { all: true })
  if (addresses.length === 0 || addresses.some(({ address }) => address !== '127.0.0.1' && address !== '::1')) {
    throw new Error('Sandbox localhost resolution escaped the loopback boundary.')
  }
})().catch(error => {
  console.error(error instanceof Error ? error.message : 'Sandbox preflight failed.')
  process.exitCode = 1
})
`],
    cwd: '.',
    timeoutMs: 30_000,
    env: {},
    unsetEnv: [],
  }
  let result: CommandResult
  let workspace: ValidationWorkspace | undefined
  try {
    workspace = await createValidationWorkspace({
      sourceRepoRoot: repoRoot,
      baseSha,
      changedPaths: [],
      candidateDiff: '',
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      parentDir: options.workspaceParentDir,
    })
    result = await runValidationInSandbox({
      workspaceRoot: workspace.repoRoot,
      dependencyRoot: workspace.dependencyRoot,
      resolverHostsPath: workspace.resolverHostsPath,
      resolverNsswitchPath: workspace.resolverNsswitchPath,
      command,
      maxOutputBytes: 10_000,
      runner: options.runner,
    })
    if (result.exitCode === 0) {
      await assertValidationWorkspaceCandidate(workspace, Number.MAX_SAFE_INTEGER)
    }
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      throw new ValidationSandboxPreflightError({
        status: 'SANDBOX_UNAVAILABLE',
        reasonCode: error.reason === 'OUTPUT_LIMIT'
          ? 'BWRAP_OUTPUT_LIMIT'
          : error.reason === 'TIMEOUT'
            ? 'BWRAP_TIMEOUT'
            : 'BWRAP_SPAWN_ERROR',
        exitCode: null,
        osErrorCode: error.osErrorCode ?? null,
        stdout: '<empty>',
        stderr: '<empty>',
      })
    }
    throw new ValidationSandboxPreflightError({
      status: 'SANDBOX_UNAVAILABLE',
      reasonCode: 'BWRAP_INVOCATION_ERROR',
      exitCode: null,
      osErrorCode: null,
      stdout: '<empty>',
      stderr: '<empty>',
    })
  } finally {
    if (workspace !== undefined) await cleanupValidationWorkspace(workspace)
    await assertNoViteStyleTempFiles(repoRoot)
  }
  if (result.exitCode !== 0) {
    throw new ValidationSandboxPreflightError({
      status: 'SANDBOX_UNAVAILABLE',
      reasonCode: 'BWRAP_EXIT_NONZERO',
      exitCode: result.exitCode,
      osErrorCode: null,
      stdout: sanitizePreflightEvidence(result.stdout, repoRoot),
      stderr: sanitizePreflightEvidence(result.stderr, repoRoot),
    })
  }
}

async function assertNoViteStyleTempFiles(repoRoot: string): Promise<void> {
  const names = await readdir(resolve(repoRoot, 'packages/core'))
  if (names.some(name => /^vitest\.config\.ts\.timestamp-.*\.mjs$/.test(name))) {
    throw new Error('Host candidate checkout contains a Vite-style temporary config file.')
  }
}

function sanitizePreflightEvidence(value: string, repoRoot: string): string {
  const repoAliases = [repoRoot, repoRoot.replace(/^\/private(?=\/)/, '')]
  let redacted = redactSensitiveText(value)
  for (const alias of repoAliases) redacted = redacted.split(alias).join('<repo>')
  redacted = redacted
    .replace(/\/(?:Users|home|private\/tmp|tmp)\/[^\s:'"`]+/g, '<path>')
    .replace(/(^|[\s(])\/[^\s:'"`)]*/g, '$1<path>')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (redacted.length === 0) return '<empty>'
  if (Buffer.byteLength(redacted) <= 2_000) return redacted
  let bounded = ''
  let bytes = 0
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > 2_000) break
    bounded += character
    bytes += characterBytes
  }
  return `${bounded}<truncated>`
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
