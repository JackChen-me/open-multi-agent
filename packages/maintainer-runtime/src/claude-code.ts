import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface HarnessAllowedScope {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface SafeHarnessEvent {
  readonly sequence: number
  readonly type: string
  readonly subtype: string | null
}

export interface HarnessTurnCountDiagnostic {
  readonly resultEventSeen: boolean
  readonly fieldPresent: boolean
  readonly jsonType: 'number' | 'string' | 'boolean' | 'object' | 'array' | 'null' | 'not_applicable'
  readonly numericClass: 'within_limit' | 'max_plus_one' | 'above_max_plus_one' | 'not_applicable'
  readonly configuredMaxTurns: number
}

export interface HarnessSummary {
  readonly events: string
  readonly safeEvents: SafeHarnessEvent[]
  readonly turns: number
  readonly terminationReason: string
}

export type HarnessRuntimeFailureStage = 'harness_execution' | 'harness_output'

export type HarnessRuntimeFailureReason =
  | 'CLI_UNAVAILABLE'
  | 'CLI_NONZERO'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'MALFORMED_OUTPUT'
  | 'TURN_COUNT_MISSING'
  | 'TURN_COUNT_TYPE_INVALID'
  | 'TURN_COUNT_NON_INTEGER'
  | 'TURN_COUNT_NEGATIVE'
  | 'TURN_COUNT_LIMIT_EXCEEDED'
  | 'TURN_LIMIT_REACHED'

export class HarnessRuntimeError extends Error {
  constructor(
    readonly stage: HarnessRuntimeFailureStage,
    readonly reasonCode: HarnessRuntimeFailureReason,
    message: string,
    readonly turnCountDiagnostic?: HarnessTurnCountDiagnostic,
  ) {
    super(message)
    this.name = 'HarnessRuntimeError'
  }
}

class HarnessOutputError extends Error {
  constructor(
    readonly reasonCode: Exclude<HarnessRuntimeFailureReason, 'CLI_UNAVAILABLE' | 'CLI_NONZERO' | 'TIMEOUT' | 'OUTPUT_LIMIT'>,
    message: string,
    readonly turnCountDiagnostic?: HarnessTurnCountDiagnostic,
  ) {
    super(message)
    this.name = 'HarnessOutputError'
  }
}

const SAFE_EVENT_TYPES = new Set([
  'system',
  'assistant',
  'user',
  'result',
  'tool_progress',
  'tool_use_summary',
  'rate_limit_event',
])

const SAFE_EVENT_SUBTYPES = new Set([
  'init',
  'success',
  'error',
  'error_max_turns',
  'compact_boundary',
  'hook_response',
])

export function buildHarnessSettings(options: {
  readonly repoRoot: string
  readonly artifactDir: string
  readonly controlDir: string
  readonly allowedScopes: readonly HarnessAllowedScope[]
}) {
  const readRule = `Read(${permissionAbsolute(options.repoRoot)}/**)`
  const editRules = buildEditRules(options.repoRoot, options.allowedScopes)
  const deniedPaths = [
    '/proc',
    options.artifactDir,
    options.controlDir,
  ]
  return {
    permissions: {
      defaultMode: 'dontAsk',
      allow: [readRule, ...editRules],
      deny: [
        'Bash', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__*',
        ...deniedPaths.flatMap(path => [
          `Read(${permissionAbsolute(path)}/**)`,
          `Edit(${permissionAbsolute(path)}/**)`,
        ]),
      ],
      disableBypassPermissionsMode: 'disable',
      disableAutoMode: 'disable',
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      filesystem: {
        denyRead: deniedPaths,
        denyWrite: [options.artifactDir, options.controlDir],
      },
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowUnixSockets: [],
      },
      credentials: {
        envVars: [
          { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' },
          { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
          { name: 'DEEPSEEK_API_KEY', mode: 'deny' },
          { name: 'GITHUB_TOKEN', mode: 'deny' },
          { name: 'GH_TOKEN', mode: 'deny' },
          { name: 'NPM_TOKEN', mode: 'deny' },
          { name: 'NODE_AUTH_TOKEN', mode: 'deny' },
          { name: 'SSH_AUTH_SOCK', mode: 'deny' },
          { name: 'ACTIONS_RUNTIME_TOKEN', mode: 'deny' },
        ],
      },
    },
  }
}

export function buildHarnessArgs(options: {
  readonly prefix?: readonly string[]
  readonly settingsPath: string
  readonly repoRoot: string
  readonly allowedScopes: readonly HarnessAllowedScope[]
  readonly policy: {
    readonly model: string
    readonly limits: { readonly maxTurns: number }
  }
}): string[] {
  const readRule = `Read(${permissionAbsolute(options.repoRoot)}/**)`
  const editRules = buildEditRules(options.repoRoot, options.allowedScopes)
  return [
    ...(options.prefix ?? []),
    '--bare',
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(options.policy.limits.maxTurns),
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--settings', options.settingsPath,
    '--strict-mcp-config',
    '--no-chrome',
    '--model', options.policy.model,
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Edit,Glob,Grep',
    '--allowedTools', readRule, ...editRules,
    '--disallowedTools', 'Bash', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'mcp__*',
  ]
}

export async function spawnHarness(options: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly maxTurns: number
}): Promise<HarnessSummary> {
  return new Promise((resolvePromise, reject) => {
    const supportsProcessGroups = process.platform !== 'win32'
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: supportsProcessGroups,
    })
    let stdout = Buffer.alloc(0)
    let stderrBytes = 0
    let settled = false
    let spawned = false
    let executionError = false
    let terminationReason: 'TIMEOUT' | 'OUTPUT_LIMIT' | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    const finishReject = (failure: HarnessRuntimeError) => {
      if (settled) return
      settled = true
      reject(failure)
    }
    const signalHarness = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
      try {
        if (supportsProcessGroups) process.kill(-pid, signal)
        else child.kill(signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          // A direct signal is a last-resort cleanup for an unexpected process-group failure.
          try {
            child.kill(signal)
          } catch {
            // The terminal result remains fail-closed and is decided only after child close.
          }
        }
      }
    }
    const terminateHarness = (reason: 'TIMEOUT' | 'OUTPUT_LIMIT'): void => {
      if (terminationReason !== undefined) return
      terminationReason = reason
      clearTimeout(timer)
      signalHarness('SIGTERM')
      forceKillTimer = setTimeout(() => signalHarness('SIGKILL'), 1_000)
      forceKillTimer.unref()
    }
    const timer = setTimeout(() => {
      terminateHarness('TIMEOUT')
    }, options.timeoutMs)
    child.once('spawn', () => {
      spawned = true
    })
    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)])
      if (stdout.byteLength > options.maxOutputBytes) terminateHarness('OUTPUT_LIMIT')
    })
    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > options.maxOutputBytes) terminateHarness('OUTPUT_LIMIT')
    })
    child.on('error', () => {
      clearTimeout(timer)
      if (!spawned) {
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
        finishReject(new HarnessRuntimeError('harness_execution', 'CLI_UNAVAILABLE', 'Claude Code CLI could not start.'))
        return
      }
      executionError = true
      if (terminationReason === undefined) {
        signalHarness('SIGTERM')
        forceKillTimer ??= setTimeout(() => signalHarness('SIGKILL'), 1_000)
        forceKillTimer.unref()
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (terminationReason !== undefined) signalHarness('SIGKILL')
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      if (settled) return
      if (terminationReason === 'OUTPUT_LIMIT') {
        finishReject(new HarnessRuntimeError('harness_output', 'OUTPUT_LIMIT', 'Claude Code output exceeded the canary limit.'))
        return
      }
      if (terminationReason === 'TIMEOUT') {
        finishReject(new HarnessRuntimeError('harness_execution', 'TIMEOUT', 'Claude Code exceeded the wall-clock limit.'))
        return
      }
      if (executionError) {
        finishReject(new HarnessRuntimeError('harness_execution', 'CLI_NONZERO', 'Claude Code process failed during execution.'))
        return
      }
      if (code !== 0) {
        finishReject(new HarnessRuntimeError(
          'harness_execution',
          'CLI_NONZERO',
          'Claude Code exited non-zero.',
        ))
        return
      }
      try {
        const parsed = parseHarnessStream(stdout.toString('utf8'), options.maxTurns)
        settled = true
        resolvePromise(parsed)
      } catch (error) {
        if (error instanceof HarnessOutputError) {
          finishReject(new HarnessRuntimeError('harness_output', error.reasonCode, error.message, error.turnCountDiagnostic))
          return
        }
        finishReject(new HarnessRuntimeError(
          'harness_output',
          'MALFORMED_OUTPUT',
          error instanceof Error ? error.message : 'Claude Code returned malformed output.',
        ))
      }
    })
    child.stdin.end(options.stdin)
  })
}

export function parseHarnessStream(value: string, maxTurns: number): HarnessSummary {
  const lines = value.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length === 0) throw new Error('Claude Code returned empty output.')
  const safeEvents: SafeHarnessEvent[] = []
  let result: Record<string, unknown> | undefined
  for (let index = 0; index < lines.length; index += 1) {
    let event: unknown
    try {
      event = JSON.parse(lines[index]!)
    } catch {
      throw new Error('Claude Code returned malformed stream-json output.')
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('Claude Code stream event is not an object.')
    }
    const record = event as Record<string, unknown>
    const typeCandidate = typeof record['type'] === 'string' ? record['type'] : ''
    const subtypeCandidate = typeof record['subtype'] === 'string' ? record['subtype'] : ''
    const type = SAFE_EVENT_TYPES.has(typeCandidate) ? typeCandidate : 'unknown'
    const subtype = SAFE_EVENT_SUBTYPES.has(subtypeCandidate) ? subtypeCandidate : null
    safeEvents.push({ sequence: index + 1, type, subtype })
    if (type === 'result') {
      if (result !== undefined) throw new Error('Claude Code returned multiple result events.')
      result = record
    }
  }
  if (result === undefined) throw new Error('Claude Code returned no terminal result event.')
  const turnCountDiagnostic = classifyTurnCount(result, maxTurns)
  if (result['subtype'] === 'error_max_turns') {
    throw new HarnessOutputError(
      'TURN_LIMIT_REACHED',
      'Claude Code reached the configured maximum turn limit.',
      turnCountDiagnostic,
    )
  }
  if (result['subtype'] !== 'success' || result['is_error'] === true) {
    throw new Error('Claude Code terminal result was not successful.')
  }
  if (!turnCountDiagnostic.fieldPresent) {
    throw new HarnessOutputError(
      'TURN_COUNT_MISSING',
      'Claude Code terminal result omitted num_turns.',
      turnCountDiagnostic,
    )
  }
  if (turnCountDiagnostic.jsonType !== 'number') {
    throw new HarnessOutputError(
      'TURN_COUNT_TYPE_INVALID',
      'Claude Code terminal result num_turns was not a JSON number.',
      turnCountDiagnostic,
    )
  }
  const turns = result['num_turns'] as number
  if (!Number.isSafeInteger(turns)) {
    throw new HarnessOutputError(
      'TURN_COUNT_NON_INTEGER',
      'Claude Code terminal result num_turns was not a finite safe integer.',
      turnCountDiagnostic,
    )
  }
  if (turns < 0) {
    throw new HarnessOutputError(
      'TURN_COUNT_NEGATIVE',
      'Claude Code terminal result num_turns was negative.',
      turnCountDiagnostic,
    )
  }
  if (turns > maxTurns) {
    throw new HarnessOutputError(
      'TURN_COUNT_LIMIT_EXCEEDED',
      'Claude Code terminal result num_turns exceeded the configured limit.',
      turnCountDiagnostic,
    )
  }
  const events = safeEvents.map(event => `${JSON.stringify(event)}\n`).join('')
  return { events, safeEvents, turns, terminationReason: 'success' }
}

export async function assertNoSymlinksOrOversize(
  paths: readonly string[],
  repoRoot: string,
  maxBytes: number,
): Promise<void> {
  for (const path of paths) {
    const info = await lstat(resolve(repoRoot, path))
    if (info.isSymbolicLink()) throw new Error('Symlink changes are forbidden.')
    if (!info.isFile()) throw new Error('Changed path is not a regular file.')
    if (info.size > maxBytes) throw new Error('Changed file exceeds the canary size limit.')
  }
}

function classifyTurnCount(
  result: Record<string, unknown>,
  maxTurns: number,
): HarnessTurnCountDiagnostic {
  const fieldPresent = Object.prototype.hasOwnProperty.call(result, 'num_turns')
  const value = result['num_turns']
  const valueType = typeof value
  const jsonType: HarnessTurnCountDiagnostic['jsonType'] = !fieldPresent
    ? 'not_applicable'
    : value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : valueType === 'number' || valueType === 'string' || valueType === 'boolean'
          ? valueType
          : valueType === 'object'
            ? 'object'
            : 'not_applicable'
  const numericClass = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value <= maxTurns
      ? 'within_limit'
      : value === maxTurns + 1
        ? 'max_plus_one'
        : 'above_max_plus_one'
    : 'not_applicable'
  return {
    resultEventSeen: true,
    fieldPresent,
    jsonType,
    numericClass,
    configuredMaxTurns: maxTurns,
  }
}

function permissionAbsolute(path: string): string {
  const absolute = resolve(path).replaceAll('\\', '/')
  return absolute.startsWith('/') ? `/${absolute}` : `//${absolute}`
}

function buildEditRules(repoRoot: string, scopes: readonly HarnessAllowedScope[]): string[] {
  return scopes.map(scope => {
    const absolute = permissionAbsolute(resolve(repoRoot, scope.path))
    return scope.kind === 'directory' ? `Edit(${absolute}/**)` : `Edit(${absolute})`
  })
}
