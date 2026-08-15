/**
 * Dependency-light contract for executing commands requested by the `bash`
 * built-in. Implementations may execute locally or dispatch to an external
 * environment; the contract itself has no runtime imports.
 */

/** Options supplied for one shell command. */
export interface ShellExecOptions {
  /** Working directory interpreted inside the executor's environment. */
  readonly cwd?: string
  /** Deadline the executor must enforce for the command it controls. */
  readonly timeoutMs: number
  /** Cancellation signal; aborting it must terminate the controlled command. */
  readonly abortSignal?: AbortSignal
}

/** Captured result of one shell command. */
export interface ShellExecResult {
  readonly stdout: string
  readonly stderr: string
  /** `124` on timeout, `130` on abort, and `127` when startup fails. */
  readonly exitCode: number
}

/**
 * Execution seam behind the granted `bash` built-in.
 *
 * One instance represents a reusable session. OMA calls `start()` before a
 * run may use it, may call `exec()` concurrently, and calls `dispose()` after
 * the last overlapping run using that instance finishes. Implementations that
 * cannot execute concurrently must serialize calls internally.
 */
export interface ShellExecutor {
  /** Acquire reusable resources such as a remote session. */
  start?(): Promise<void>
  /** Execute one bash command to completion. */
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult>
  /**
   * Release all resources owned by this instance, terminating any outstanding
   * command that a tool-level timeout or abort backstop left unsettled.
   */
  dispose?(): Promise<void>
}
