/**
 * @fileoverview Error-aware retry with jittered exponential backoff for agent
 * task execution. Exported for testability and re-exported from the orchestrator
 * barrel so the public `executeWithRetry` / `computeRetryDelay` paths stay stable.
 */

import type { AgentRunResult, Task, TokenUsage } from '../types.js'
import { isRetryableError } from '../errors.js'
import { abortableDelay } from '../utils/abort.js'
import { DurableApprovalError } from '../approval/durable.js'

/** Maximum delay cap to prevent runaway exponential backoff (30 seconds). */
export const MAX_RETRY_DELAY_MS = 30_000

/**
 * Compute the retry delay for a given attempt, capped at {@link MAX_RETRY_DELAY_MS}.
 */
export function computeRetryDelay(
  baseDelay: number,
  backoff: number,
  attempt: number,
): number {
  return Math.min(baseDelay * backoff ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

/**
 * Execute an agent task with optional retry and exponential backoff.
 *
 * Exported for testability — called internally by {@link executeQueue}.
 *
 * Retry is off by default (`maxRetries: 0`). When enabled it is error-aware:
 * provably-terminal failures (auth/validation errors, aborted calls, 4xx client
 * errors other than 408/409/429) skip retries instead of wasting attempts;
 * backoff is jittered to avoid lockstep re-collision against a rate-limited
 * provider; and `abortSignal` is honored between attempts so a cancelled run
 * neither sleeps a full backoff nor fires one more attempt.
 *
 * @param run      - The function that executes the task (typically `pool.run`).
 * @param task     - The task to execute (retry config read from its fields).
 * @param onRetry  - Called before each retry sleep with the (post-jitter) delay.
 * @param delayFn  - Injectable delay function (defaults to `abortableDelay`).
 * @param opts     - Optional `abortSignal` (checked between attempts) and `rng`
 *                   (injectable `Math.random` for deterministic jitter in tests).
 * @returns The final {@link AgentRunResult} from the last attempt.
 */
export async function executeWithRetry(
  run: (attempt: number) => Promise<AgentRunResult>,
  task: Task,
  onRetry?: (data: { attempt: number; maxAttempts: number; error: string; nextDelayMs: number }) => void,
  delayFn: (ms: number, signal?: AbortSignal) => Promise<void> = abortableDelay,
  opts?: { abortSignal?: AbortSignal; rng?: () => number },
): Promise<AgentRunResult> {
  const abortSignal = opts?.abortSignal
  const rng = opts?.rng ?? Math.random
  const rawRetries = Number.isFinite(task.maxRetries) ? task.maxRetries! : 0
  const maxAttempts = Math.max(0, rawRetries) + 1
  const baseDelay = Math.max(0, Number.isFinite(task.retryDelayMs) ? task.retryDelayMs! : 1000)
  const backoff = Math.max(1, Number.isFinite(task.retryBackoff) ? task.retryBackoff! : 2)

  let lastError: string = ''
  // Accumulate token usage across all attempts so billing/observability
  // reflects the true cost of retries.
  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  const failure = (output: string): AgentRunResult => ({
    success: false,
    output,
    messages: [],
    tokenUsage: totalUsage,
    toolCalls: [],
  })

  // Compute the jittered backoff, report it, and sleep. Equal jitter over
  // [nominal/2, nominal] decorrelates tasks retrying in lockstep while keeping a
  // floor so a rate-limited provider isn't hammered instantly. Applied to the
  // already-capped nominal, so the sleep never exceeds MAX_RETRY_DELAY_MS.
  const backoffSleep = async (attempt: number): Promise<void> => {
    const nominal = computeRetryDelay(baseDelay, backoff, attempt)
    const jittered = Math.round(nominal / 2 + rng() * (nominal / 2))
    onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: jittered })
    await delayFn(jittered, abortSignal)
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Honor abort before every attempt — this turns an abort that landed during
    // a prior backoff sleep into an early return instead of one more attempt.
    if (abortSignal?.aborted) {
      return failure(lastError || 'Run aborted')
    }

    try {
      const result = await run(attempt)
      totalUsage = {
        input_tokens: totalUsage.input_tokens + result.tokenUsage.input_tokens,
        output_tokens: totalUsage.output_tokens + result.tokenUsage.output_tokens,
      }

      if (result.success) {
        return { ...result, tokenUsage: totalUsage }
      }
      // Suspension is a durable continuation boundary, not a retryable task
      // failure. Re-running here would ask for the same approval again and
      // could race the primary decision record.
      if (result.status?.code === 'suspended') {
        return { ...result, tokenUsage: totalUsage }
      }
      if (result.error instanceof DurableApprovalError) throw result.error
      lastError = result.output

      // Prefer the stable classification already attached to the outcome.
      // This also covers framework failures (validation, cancellation, budget)
      // whose raw Error may have been removed by a hook or serialization seam.
      const terminal = result.errorInfo?.retryable === false
        || (result.error !== undefined && !isRetryableError(result.error))
      if (!terminal && attempt < maxAttempts && !abortSignal?.aborted) {
        await backoffSleep(attempt)
        continue
      }

      return { ...result, tokenUsage: totalUsage }
    } catch (err) {
      if (err instanceof DurableApprovalError) throw err
      lastError = err instanceof Error ? err.message : String(err)

      // Streaming path: the structured error is in scope here. Skip retries on
      // terminal errors (auth/validation/abort) so they don't waste attempts.
      const terminal = !isRetryableError(err)
      if (!terminal && attempt < maxAttempts && !abortSignal?.aborted) {
        await backoffSleep(attempt)
        continue
      }

      // Terminal, aborted, or retries exhausted — return a failure result.
      return failure(lastError)
    }
  }

  // Should not be reached, but TypeScript needs a return.
  return failure(lastError)
}
