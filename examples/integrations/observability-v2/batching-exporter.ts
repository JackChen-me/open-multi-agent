/**
 * BatchingTraceSink + custom TraceExporter
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/batching-exporter.ts
 *
 * Prerequisites: none. The application owns both exporter and sink.
 */
import {
  BatchingTraceSink,
  type TraceExporter,
} from '@open-multi-agent/core/observability'
import { runDemo } from './demo-runtime.js'

let exported = 0
const exporter: TraceExporter = {
  async export(records) {
    exported += records.length
    return { status: 'success', exported: records.length }
  },
}
const sink = new BatchingTraceSink(exporter, { diagnostics: 'silent' })

try {
  const result = await runDemo(sink, 'example-batching-exporter')
  const delivery = await sink.forceFlush({ timeoutMs: 1_000 })
  console.log({ runId: result.identity?.runId, exported, delivery: delivery.status })
} finally {
  await sink.shutdown({ timeoutMs: 1_000 })
}
