/**
 * @fileoverview AbortSignal composition helpers shared across the agent layer.
 */

/**
 * Combine two {@link AbortSignal}s so that aborting either one aborts the
 * returned signal. Works on supported Node 20+ releases without
 * `AbortSignal.any`.
 */
export function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (a.aborted || b.aborted) {
    controller.abort()
    return controller.signal
  }
  const abort = () => controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}

/**
 * Promise-based delay that resolves early if `signal` aborts, so a long backoff
 * sleep does not outlive a cancelled run. Cleans up its timer and listener on
 * whichever path resolves first to avoid leaks across many retrying tasks.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
