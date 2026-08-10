/**
 * Short-lived CLI graceful shutdown
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/cli-lifecycle.ts
 *
 * Prerequisites: none. No signal handler is registered by OMA or this CLI.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BatchingTraceSink, TraceStoreExporter } from '@open-multi-agent/core/observability'
import { FileTraceStore } from '@open-multi-agent/core/observability/file'
import { runDemo } from './demo-runtime.js'

const directory = await mkdtemp(join(tmpdir(), 'oma-observability-cli-'))
const store = await FileTraceStore.open(join(directory, 'traces.ndjson'))
const sink = new BatchingTraceSink(new TraceStoreExporter(store), { diagnostics: 'silent' })

try {
  const result = await runDemo(sink, 'example-cli-lifecycle')
  console.log({ success: result.success, runId: result.identity?.runId })
} finally {
  // A CLI owns the whole lifecycle: drain OMA, fsync storage, close the sink,
  // then close the store before allowing natural process exit.
  await sink.forceFlush({ timeoutMs: 2_000 })
  await store.flush()
  await sink.shutdown({ timeoutMs: 2_000 })
  await store.close()
  await rm(directory, { recursive: true, force: true })
}
