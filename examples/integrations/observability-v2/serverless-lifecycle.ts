/**
 * Serverless/FaaS short flush
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/serverless-lifecycle.ts
 *
 * Prerequisites: none. A warm singleton is flushed, not shut down per request.
 */
import { BatchingTraceSink, type TraceExporter } from '@open-multi-agent/core/observability'
import { runDemo } from './demo-runtime.js'

const hangingExporter: TraceExporter = {
  async export() { return new Promise(() => {}) },
}
const sharedSink = new BatchingTraceSink(hangingExporter, {
  diagnostics: 'silent',
  exportTimeoutMs: 100,
  maxRetries: 0,
})

export async function handler() {
  const result = await runDemo(sharedSink, 'example-serverless-lifecycle')
  const telemetry = await sharedSink.forceFlush({ timeoutMs: 5 })
  // Do not call shutdown here: a warm runtime may reuse the singleton.
  return { success: result.success, telemetry: telemetry.status }
}

// A real FaaS host keeps the invocation alive while its returned promise is
// pending. The standalone demo uses one temporary referenced handle to model
// that host; BatchingTraceSink's own timers intentionally remain unref'ed.
const invocationHost = setInterval(() => {}, 1_000)
try {
  console.log(await handler())
} finally {
  clearInterval(invocationHost)
}
