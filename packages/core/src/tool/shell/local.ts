/** Local host implementation of the shell-executor contract. */

import { spawn } from 'node:child_process'
import { isSensitiveName } from '../../utils/redaction.js'
import { killProcessTree } from '../../utils/process-tree.js'
import type {
  ShellExecOptions,
  ShellExecResult,
  ShellExecutor,
} from './types.js'

const SAFE_ENV_ALLOWLIST = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
])

/**
 * Execute `bash -c` on the host using the built-in's historical environment,
 * timeout, abort, and process-tree cleanup behavior.
 *
 * This class is not a sandbox or security boundary. It executes with the
 * permissions of the current Node.js process.
 */
export class LocalShellExecutor implements ShellExecutor {
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    if (options.abortSignal?.aborted) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 130 })
    }
    return new Promise<ShellExecResult>((resolve) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      const child = spawn('bash', ['-c', command], {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        env: buildSafeShellEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

      let timedOut = false
      let aborted = false
      let settled = false

      const done = (exitCode: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.abortSignal?.removeEventListener('abort', onAbort)

        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')

        resolve({ stdout, stderr, exitCode })
      }

      // Kill the whole process group so backgrounded children do not outlive
      // the command on either timeout or caller cancellation.
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
      }, options.timeoutMs)

      const onAbort = (): void => {
        aborted = true
        killProcessTree(child)
      }

      if (options.abortSignal !== undefined) {
        options.abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      // `close` (process exited AND stdio drained) is the normal completion
      // path. After a forced kill we settle on `exit` instead: on Windows,
      // MSYS bash descendants may otherwise keep the stdio pipes open.
      const resolveExitCode = (code: number | null): number => {
        if (timedOut) return 124
        if (aborted) return 130
        return code ?? 1
      }

      child.on('close', (code: number | null) => {
        done(resolveExitCode(code))
      })

      child.on('exit', (code: number | null) => {
        if (timedOut || aborted) {
          done(resolveExitCode(code))
        }
      })

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          options.abortSignal?.removeEventListener('abort', onAbort)
          resolve({
            stdout: '',
            stderr: err.message,
            exitCode: 127,
          })
        }
      })
    })
  }
}

function buildSafeShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!SAFE_ENV_ALLOWLIST.has(name)) continue
    if (isSensitiveName(name)) continue
    safeEnv[name] = value
  }
  return safeEnv
}
