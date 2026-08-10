/** Compile-only mirrors of the copyable migration-guide snippets. */
import { OpenMultiAgent, type AgentConfig, type TraceEvent } from '@open-multi-agent/core'
import {
  BatchingTraceSink,
  InMemoryTraceStore,
  LegacyCallbackTraceSink,
  TraceStoreExporter,
  type TraceExporter,
} from '@open-multi-agent/core/observability'
import { FileTraceStore } from '@open-multi-agent/core/observability/file'
import { createOtelTraceSink, type OTelTracerProvider } from '@open-multi-agent/otel'

declare const agent: AgentConfig
declare const prompt: string
declare const provider: OTelTracerProvider
declare const legacyCollector: { write(event: TraceEvent): void }
declare function sendBatch(records: readonly unknown[], options: { signal: AbortSignal }): Promise<number>

export const stage0 = new OpenMultiAgent({
  onTrace(event) { legacyCollector.write(event) },
})

export const stage1Sink = new LegacyCallbackTraceSink((event) => legacyCollector.write(event))
export const stage1 = new OpenMultiAgent({ observability: { sinks: [stage1Sink] } })

const exporter: TraceExporter = {
  async export(records, signal) {
    const delivered = await sendBatch(records, { signal })
    return { status: 'success', exported: delivered }
  },
}
export const stage2Sink = new BatchingTraceSink(exporter)
export const stage2 = new OpenMultiAgent({ observability: { sinks: [stage2Sink] } })

export const memoryStore = new InMemoryTraceStore()
export const stage3StoreSink = new BatchingTraceSink(new TraceStoreExporter(memoryStore))
export const stage3OtelSink = createOtelTraceSink({ tracerProvider: provider })

export async function fileLifecycle(path: string): Promise<void> {
  const store = await FileTraceStore.open(path)
  const sink = new BatchingTraceSink(new TraceStoreExporter(store))
  try {
    await new OpenMultiAgent({ observability: { sinks: [sink] } }).runAgent(agent, prompt)
    await sink.forceFlush({ timeoutMs: 1_000 })
    await store.flush()
  } finally {
    await sink.shutdown({ timeoutMs: 1_000 })
    await store.close()
  }
}
