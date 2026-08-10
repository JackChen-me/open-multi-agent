/**
 * InMemoryTraceStore
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/in-memory-store.ts
 *
 * Prerequisites: none. The application owns the sink and non-durable store.
 */
import {
  BatchingTraceSink,
  InMemoryTraceStore,
  TraceStoreExporter,
} from '@open-multi-agent/core/observability'
import { runDemo } from './demo-runtime.js'

const store = new InMemoryTraceStore()
const sink = new BatchingTraceSink(new TraceStoreExporter(store), { diagnostics: 'silent' })

try {
  const result = await runDemo(sink, 'example-in-memory-store')
  await sink.forceFlush({ timeoutMs: 1_000 })
  const stored = await store.getRun(result.identity!.runId)
  console.log({ runId: stored?.runId, status: stored?.status, spans: stored?.spans.length })
} finally {
  await sink.shutdown({ timeoutMs: 1_000 })
}
