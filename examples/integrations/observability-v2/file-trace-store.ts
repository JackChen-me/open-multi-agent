/**
 * FileTraceStore
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/file-trace-store.ts
 *
 * Prerequisites: none. The application owns sink and store.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BatchingTraceSink,
  TraceStoreExporter,
} from '@open-multi-agent/core/observability'
import { FileTraceStore } from '@open-multi-agent/core/observability/file'
import { runDemo } from './demo-runtime.js'

const directory = await mkdtemp(join(tmpdir(), 'oma-observability-example-'))
const store = await FileTraceStore.open(join(directory, 'traces.ndjson'))
const sink = new BatchingTraceSink(new TraceStoreExporter(store), { diagnostics: 'silent' })

try {
  const result = await runDemo(sink, 'example-file-trace-store')
  await sink.forceFlush({ timeoutMs: 1_000 }) // queue -> exporter -> store
  await store.flush()                         // store -> filesystem fsync
  const stored = await store.getRun(result.identity!.runId)
  console.log({ runId: stored?.runId, status: stored?.status, spans: stored?.spans.length })
} finally {
  await sink.shutdown({ timeoutMs: 1_000 })
  await store.close()
  await rm(directory, { recursive: true, force: true })
}
