/** Shared lifecycle coordination for configured shell-executor instances. */

import type {
  ShellExecOptions,
  ShellExecResult,
  ShellExecutor,
} from './types.js'

export interface ShellExecutorLease {
  /** Release this run's ownership. Safe to call more than once. */
  release(): Promise<void>
}

class ExecutorLifecycle {
  private leases = 0
  private started = false
  private transition: Promise<void> = Promise.resolve()

  constructor(private readonly executor: ShellExecutor) {}

  async acquire(): Promise<ShellExecutorLease> {
    this.leases++

    if (this.leases === 1) {
      // A new run that arrives while the previous dispose is still settling
      // waits for that transition before starting a fresh session.
      this.transition = this.transition.then(async () => {
        await this.executor.start?.()
        this.started = true
      })
    }

    try {
      await this.transition
    } catch (startError) {
      try {
        await this.releaseLease(true)
      } catch (cleanupError) {
        throw new AggregateError(
          [startError, cleanupError],
          'Shell executor start failed and cleanup also failed.',
        )
      }
      throw startError
    }

    let released = false
    return {
      release: async () => {
        if (released) return
        released = true
        await this.releaseLease(false)
      },
    }
  }

  private async releaseLease(startFailed: boolean): Promise<void> {
    this.leases--
    if (this.leases > 0) return

    // `dispose()` is attempted after a failed `start()` too: a remote adapter
    // may have allocated a session before its start promise rejected.
    const shouldDispose = this.started || startFailed
    this.transition = this.transition
      .catch(() => undefined)
      .then(async () => {
        if (shouldDispose) {
          await this.executor.dispose?.()
        }
        this.started = false
      })

    await this.transition
  }
}

const lifecycles = new WeakMap<ShellExecutor, ExecutorLifecycle>()

/**
 * Acquire one run lease for an executor. Overlapping leases share a single
 * start/dispose window; the final release owns disposal.
 */
export function acquireShellExecutor(executor: ShellExecutor): Promise<ShellExecutorLease> {
  let lifecycle = lifecycles.get(executor)
  if (lifecycle === undefined) {
    lifecycle = new ExecutorLifecycle(executor)
    lifecycles.set(executor, lifecycle)
  }
  return lifecycle.acquire()
}

/**
 * Per-run proxy that acquires the shared executor lazily on the first command.
 * This keeps `start()` below grant and onToolCall checks and avoids creating a
 * remote session for runs that are allowed to use bash but never request it.
 */
export class RunScopedShellExecutor implements ShellExecutor {
  private leasePromise: Promise<ShellExecutorLease> | undefined

  constructor(private readonly executor: ShellExecutor) {}

  async exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    if (options.abortSignal?.aborted) {
      return { stdout: '', stderr: '', exitCode: 130 }
    }
    this.leasePromise ??= acquireShellExecutor(this.executor)
    await this.leasePromise
    // A timeout or caller abort may have fired while start() was acquiring a
    // remote session. Never dispatch the command after cancellation.
    if (options.abortSignal?.aborted) {
      return { stdout: '', stderr: '', exitCode: 130 }
    }
    return this.executor.exec(command, options)
  }

  /** Release this run's lease if any command acquired one. */
  async release(): Promise<void> {
    if (this.leasePromise === undefined) return
    let lease: ShellExecutorLease
    try {
      lease = await this.leasePromise
    } catch {
      // acquire() already attempted cleanup and surfaced the start failure to
      // the bash ToolResult. Do not turn that handled tool error into a second
      // run-level failure while closing the run.
      return
    }
    await lease.release()
  }
}
