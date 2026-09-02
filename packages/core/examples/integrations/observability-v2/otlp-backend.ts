/**
 * @open-multi-agent/otel over a real OTLP/HTTP exporter
 *
 * Every other example in this directory uses an in-process exporter, which
 * proves the adapter's semantics but never serializes a span or opens a
 * socket. This one runs the path a Langfuse / Datadog / Honeycomb / Grafana
 * user actually takes: OTel SDK -> OTLP/HTTP exporter -> HTTP -> a backend.
 *
 * The backend here is a loopback listener started by this file, so the example
 * still needs no API key, no external collector, and no internet access. It
 * prints what actually crossed the wire. Point `OTLP_URL` and `OTLP_HEADERS`
 * at a real vendor to send the same payload there instead.
 *
 * Run after building the workspaces:
 *   npx tsx packages/core/examples/integrations/observability-v2/otlp-backend.ts
 *
 * Prerequisites: workspace dev dependencies only.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { createOtelTraceSink } from '@open-multi-agent/otel'
import { runToolDemo } from './demo-runtime.js'

interface ReceivedSpan {
  readonly name: string
  readonly attributes: Record<string, unknown>
}

const received: ReceivedSpan[] = []

// Stands in for the vendor's ingestion endpoint. A real backend also
// authenticates, rate limits, and returns partial-success details.
const backend = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    console.log(
      `[backend] ${request.method} ${request.url} ${body.length}B`
      + ` auth=${request.headers.authorization ? 'present' : 'absent'}`,
    )
    received.push(...decodeSpans(body))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"partialSuccess":{}}')
  })
})

function decodeSpans(body: Buffer): ReceivedSpan[] {
  try {
    const payload = JSON.parse(body.toString('utf8')) as {
      resourceSpans?: { scopeSpans?: { spans?: {
        name: string
        attributes?: { key: string, value: Record<string, unknown> }[]
      }[] }[] }[]
    }
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) =>
        (scope.spans ?? []).map((span) => ({
          name: span.name,
          attributes: Object.fromEntries(
            (span.attributes ?? []).map((attribute) =>
              [attribute.key, Object.values(attribute.value)[0]]),
          ),
        }))))
  } catch {
    // A protobuf exporter would land here; this example only decodes JSON.
    return []
  }
}

await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
const port = (backend.address() as AddressInfo).port
const url = process.env.OTLP_URL ?? `http://127.0.0.1:${port}/v1/traces`

const exporter = new OTLPTraceExporter({
  url,
  // Most hosted backends authenticate with a header. Read real credentials
  // from the environment; never commit them.
  headers: process.env.OTLP_HEADERS
    ? JSON.parse(process.env.OTLP_HEADERS) as Record<string, string>
    : { authorization: 'Basic <replace-with-your-backend-credential>' },
})

// service.name lives on the Resource, not on span attributes. Without one the
// backend files every OMA span under `unknown_service:node`. The adapter never
// sets it, because the provider belongs to the application.
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'oma-otlp-example' }),
  spanProcessors: [new BatchSpanProcessor(exporter)],
})

const sink = createOtelTraceSink({
  tracerProvider: provider,
  metadata: { environment: 'example', release: 'otlp-backend-demo' },
  // Second half of the double opt-in below. On its own this exports nothing
  // extra, because core never records the attributes without its own policy.
  contentCapture: { mode: 'upstream-policy' },
})

try {
  // First half of the double opt-in. Without this, tool spans carry the tool
  // name and error flag only.
  const result = await runToolDemo(sink, 'example-otlp-backend', {
    toolInput: 'redacted',
    toolOutput: 'redacted',
  })
  await sink.forceFlush({ timeoutMs: 5_000 })

  console.log(`\nrun ${result.identity?.runId ?? 'unknown'} exported ${received.length} spans:`)
  for (const span of received) {
    const tool = span.attributes['oma.tool.name']
    const detail = tool
      ? ` tool=${String(tool)}`
        + ` input=${JSON.stringify(span.attributes['oma.tool.input'] ?? null)}`
        + ` output=${JSON.stringify(span.attributes['oma.tool.output'] ?? null)}`
      : ` model=${String(span.attributes['gen_ai.request.model'] ?? '-')}`
    console.log(`  ${span.name.padEnd(14)}${detail}`)
  }
  console.log(
    '\nWithout the capture policy the same run exports the tool name and error'
    + ' flag with no input or output. Prompts, completions, and reasoning stay'
    + ' excluded under every mode.',
  )
} finally {
  // Drain OMA first, then the application-owned provider, then the listener.
  await sink.shutdown({ timeoutMs: 5_000 })
  await provider.shutdown()
  await new Promise<void>((resolve) => backend.close(() => resolve()))
}
