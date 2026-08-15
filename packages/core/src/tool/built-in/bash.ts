/**
 * Built-in bash tool.
 *
 * Executes a shell command and returns its stdout + stderr.  Supports an
 * optional timeout and a custom working directory.
 */

import { z } from 'zod'
import { defineTool } from '../framework.js'
import { redactSensitiveText } from '../../utils/redaction.js'
import { LocalShellExecutor } from '../shell/local.js'
import type {
  ShellExecResult,
  ShellExecutor,
} from '../shell/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const EXECUTOR_BACKSTOP_GRACE_MS = 100
const DEFAULT_SHELL_EXECUTOR = new LocalShellExecutor()

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const bashTool = defineTool({
  name: 'bash',
  consequential: true,
  description:
    'Execute a bash command and return its stdout and stderr. ' +
    'Use this for file system operations, running scripts, installing packages, ' +
    'and any task that requires shell access. ' +
    'The command runs in a non-interactive shell (bash -c). ' +
    'Long-running commands should use the timeout parameter.',

  inputSchema: z.object({
    command: z.string().describe('The bash command to execute.'),
    timeout: z
      .number()
      .optional()
      .describe(
        `Timeout in milliseconds before the command is forcibly killed. ` +
          `Defaults to ${DEFAULT_TIMEOUT_MS} ms.`,
      ),
    cwd: z
      .string()
      .optional()
      .describe('Working directory in which to run the command.'),
  }),

  execute: async (input, context) => {
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS

    let execution: ShellExecResult
    try {
      execution = await executeWithBackstop(
        context.shellExecutor ?? DEFAULT_SHELL_EXECUTOR,
        input.command,
        { cwd: input.cwd, timeoutMs },
        context.abortSignal,
      )
    } catch (error) {
      execution = {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 127,
      }
    }

    const { stdout, stderr, exitCode } = execution
    const combined = redactSensitiveText(buildOutput(stdout, stderr, exitCode))
    const isError = exitCode !== 0

    return {
      data: combined,
      isError,
    }
  },
})

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BashRunOptions {
  cwd: string | undefined
  timeoutMs: number
}

/**
 * Bound an executor even when an adapter fails to honour its own timeout or
 * abort contract. The executor receives the cancellation immediately; the
 * short grace period lets a cooperative implementation return captured output
 * before the wrapper falls back to an empty conventional result.
 */
async function executeWithBackstop(
  executor: ShellExecutor,
  command: string,
  options: BashRunOptions,
  signal: AbortSignal | undefined,
): Promise<ShellExecResult> {
  // The local implementation already owns a process-tree-aware deadline and
  // abort path. Calling it directly preserves the historical timing and
  // captured-output behavior exactly; the wrapper backstop is for pluggable
  // executors whose cooperation OMA cannot assume.
  if (executor instanceof LocalShellExecutor) {
    return executor.exec(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      abortSignal: signal,
    })
  }

  if (signal?.aborted) {
    return { stdout: '', stderr: '', exitCode: 130 }
  }

  type TerminationReason = 'timeout' | 'abort'
  type Outcome =
    | { readonly kind: 'result'; readonly result: ShellExecResult }
    | { readonly kind: 'backstop'; readonly reason: TerminationReason }

  const commandAbort = new AbortController()
  let termination: TerminationReason | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let resolveBackstop!: (outcome: Outcome) => void
  const backstop = new Promise<Outcome>((resolve) => {
    resolveBackstop = resolve
  })

  const terminate = (reason: TerminationReason): void => {
    if (termination !== undefined) return
    termination = reason
    commandAbort.abort()
    graceTimer = setTimeout(() => {
      resolveBackstop({ kind: 'backstop', reason })
    }, EXECUTOR_BACKSTOP_GRACE_MS)
  }

  const onAbort = (): void => terminate('abort')
  signal?.addEventListener('abort', onAbort, { once: true })
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  try {
    // Invoke first so LocalShellExecutor's own deadline is registered before
    // the wrapper backstop. That preserves its captured-output behavior while
    // still bounding a non-cooperative custom executor.
    const execution = executor.exec(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      abortSignal: commandAbort.signal,
    })
      .then((result): Outcome => ({ kind: 'result', result }))
      .catch((error: unknown): Outcome => {
        // Cancellation-triggered adapter rejections still use the cross-adapter
        // 124/130 result contract. Unrelated executor failures propagate to the
        // ToolExecutor, which converts thrown tool errors into ToolResult values.
        if (termination !== undefined) {
          return {
            kind: 'result',
            result: {
              stdout: '',
              stderr: '',
              exitCode: termination === 'timeout' ? 124 : 130,
            },
          }
        }
        throw error
      })

    if (signal?.aborted) terminate('abort')
    timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs)

    const outcome = await Promise.race([execution, backstop])
    if (outcome.kind === 'backstop') {
      return {
        stdout: '',
        stderr: '',
        exitCode: outcome.reason === 'timeout' ? 124 : 130,
      }
    }
    if (termination !== undefined) {
      return {
        ...outcome.result,
        exitCode: termination === 'timeout' ? 124 : 130,
      }
    }
    return outcome.result
  } catch (error) {
    // An executor is allowed by JavaScript to throw before returning its
    // promise. Cancellation remains authoritative in that race too.
    if (termination !== undefined) {
      return {
        stdout: '',
        stderr: '',
        exitCode: termination === 'timeout' ? 124 : 130,
      }
    }
    throw error
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Format captured output into a single readable string.
 * When only stdout is present its content is returned as-is.
 * When stderr is also present both sections are labelled.
 */
function buildOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = []

  if (stdout.length > 0) {
    parts.push(stdout)
  }

  if (stderr.length > 0) {
    parts.push(
      stdout.length > 0
        ? `--- stderr ---\n${stderr}`
        : stderr,
    )
  }

  if (parts.length === 0) {
    return exitCode === 0
      ? '(command completed with no output)'
      : `(command exited with code ${exitCode}, no output)`
  }

  if (exitCode !== 0 && parts.length > 0) {
    parts.push(`\n(exit code: ${exitCode})`)
  }

  return parts.join('\n')
}
