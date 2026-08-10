/**
 * @open-multi-agent/otel + application-owned provider
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/otel-provider.ts
 *
 * Prerequisites: workspace dev dependencies only; no collector or API key.
 */
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { createOtelTraceSink } from '@open-multi-agent/otel'
import { runDemo } from './demo-runtime.js'

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
const sink = createOtelTraceSink({
  tracerProvider: provider,
  metadata: { environment: 'example' },
})

try {
  const result = await runDemo(sink, 'example-otel-provider')
  await sink.forceFlush({ timeoutMs: 1_000 })
  const spans = exporter.getFinishedSpans()
  console.log({ runId: result.identity?.runId, spans: spans.length, root: spans.at(-1)?.name })
} finally {
  // The adapter does not own the provider by default. Drain OMA first, then
  // close the application-owned provider explicitly.
  await sink.shutdown({ timeoutMs: 1_000 })
  await provider.shutdown()
}
