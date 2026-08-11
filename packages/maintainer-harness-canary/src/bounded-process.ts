import { spawn, type ChildProcess } from 'node:child_process'
import type { CommandResult } from '@open-multi-agent/maintainer-bot'

const TERMINATION_GRACE_MS = 250
const CONVERGENCE_GRACE_MS = 2_000

export type BoundedProcessFailureReason = 'OUTPUT_LIMIT' | 'TIMEOUT' | 'SPAWN_ERROR'

export class BoundedProcessError extends Error {
  constructor(
    readonly reason: BoundedProcessFailureReason,
    message: string,
    readonly osErrorCode?: string,
  ) {
    super(message)
    this.name = 'BoundedProcessError'
  }
}

export interface BoundedProcessRunOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  /** Combined stdout plus stderr hard limit, counted as raw bytes. */
  readonly maxOutputBytes: number
}

export interface SandboxProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: BoundedProcessRunOptions,
  ): Promise<CommandResult>
}

export class BoundedProcessRunner implements SandboxProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: BoundedProcessRunOptions,
  ): Promise<CommandResult> {
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
      throw new BoundedProcessError('SPAWN_ERROR', 'Bounded process output limit is invalid.')
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new BoundedProcessError('SPAWN_ERROR', 'Bounded process timeout is invalid.')
    }

    return new Promise<CommandResult>((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout: Buffer[] = []
      let stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationReason: Exclude<BoundedProcessFailureReason, 'SPAWN_ERROR'> | undefined
      let killTimer: NodeJS.Timeout | undefined
      let convergenceTimer: NodeJS.Timeout | undefined

      const clearTimers = () => {
        clearTimeout(timeoutTimer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (convergenceTimer !== undefined) clearTimeout(convergenceTimer)
      }
      const finishError = (error: BoundedProcessError) => {
        if (settled) return
        settled = true
        clearTimers()
        stdout = []
        stderr = []
        reject(error)
      }
      const terminate = (reason: Exclude<BoundedProcessFailureReason, 'SPAWN_ERROR'>) => {
        if (terminationReason !== undefined || settled) return
        terminationReason = reason
        stdout = []
        stderr = []
        child.stdout?.destroy()
        child.stderr?.destroy()
        signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), TERMINATION_GRACE_MS)
        convergenceTimer = setTimeout(() => {
          finishError(new BoundedProcessError(
            reason,
            reason === 'OUTPUT_LIMIT'
              ? 'Validation output exceeded the hard byte limit.'
              : 'Validation exceeded the hard timeout.',
          ))
        }, TERMINATION_GRACE_MS + CONVERGENCE_GRACE_MS)
      }
      const collect = (target: 'stdout' | 'stderr', chunk: unknown) => {
        if (settled || terminationReason !== undefined) return
        const value = Buffer.from(chunk as Uint8Array)
        outputBytes += value.byteLength
        if (outputBytes > options.maxOutputBytes) {
          terminate('OUTPUT_LIMIT')
          return
        }
        if (target === 'stdout') stdout.push(value)
        else stderr.push(value)
      }
      const timeoutTimer = setTimeout(() => terminate('TIMEOUT'), options.timeoutMs)

      child.stdout?.on('data', chunk => collect('stdout', chunk))
      child.stderr?.on('data', chunk => collect('stderr', chunk))
      child.on('error', error => finishError(new BoundedProcessError(
        'SPAWN_ERROR',
        'Validation sandbox process could not start.',
        safeProcessErrorCode(error),
      )))
      child.on('close', code => {
        if (settled) return
        if (terminationReason !== undefined) {
          finishError(new BoundedProcessError(
            terminationReason,
            terminationReason === 'OUTPUT_LIMIT'
              ? 'Validation output exceeded the hard byte limit.'
              : 'Validation exceeded the hard timeout.',
          ))
          return
        }
        settled = true
        clearTimers()
        resolvePromise({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? 1,
        })
      })
    })
  }
}

function safeProcessErrorCode(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN'
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct child if the process group already exited or
      // the platform declined group signalling.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The close/error event or convergence timer remains authoritative.
  }
}
