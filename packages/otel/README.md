# `@open-multi-agent/otel`

Optional OpenTelemetry adapter for `@open-multi-agent/core` TraceRecord v2.
It converts OBS-2 `TraceExporter` batches into spans on a tracer you explicitly
provide. The package never reads, registers, or replaces the global
`TracerProvider`.

```bash
npm install @open-multi-agent/core@^1.11.0 @open-multi-agent/otel@^0.1.0
# Install and configure the OpenTelemetry SDK/exporter chosen by your application.
```

Core `1.11.0` is the first release containing the public TraceRecord v2,
sink/exporter, and TraceStore APIs required by this package. Core `1.10.0` is
not compatible.

## Use an application-owned provider

```ts
import { OpenMultiAgent } from '@open-multi-agent/core'
import { createOtelTraceSink } from '@open-multi-agent/otel'

// `provider` is configured by the application with its SDK and exporter.
const sink = createOtelTraceSink({
  tracerProvider: provider,
  metadata: {
    environment: 'production',
    release: '2026.07.15',
    tenantId: 'opaque-tenant-id',
  },
})

const oma = new OpenMultiAgent({ observability: { sinks: [sink] } })
```

Pass exactly one of `tracer` or `tracerProvider`. Passing neither is a clear
configuration error: this package does not fall back to `trace.getTracer()` or
any global provider.

Core `egressPolicy` does not wrap this application-owned provider or any
exporter attached to it. Configure telemetry egress in the provider/exporter or
at the infrastructure boundary; see the core
[egress enforcement matrix](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/egress-policy.md#enforcement-matrix).

## Lifecycle and ownership

The caller owns the tracer/provider in every mode.

- `sink.forceFlush()` first flushes the OMA batching queue, then delegates to
  `provider.forceFlush()` when a provider was supplied and implements it.
- With a direct `tracer`, there is no provider lifecycle to delegate to, so the
  adapter phase is a successful no-op.
- `sink.shutdown()` does **not** shut down a caller-owned provider by default.
  Set `shutdownOnShutdown: true` only when this adapter is the component that
  owns the provider lifecycle.
- Completed OTel `Span` objects are released immediately. Lightweight contexts
  remain only until their OMA root closes; the 256 most recent root contexts
  are retained so a same-process checkpoint restore can resolve its continuation
  link. Shutdown ends any still-open span as incomplete and clears all adapter
  state.
- Provider rejection or timeout becomes the OBS-2 exporter result and sink
  diagnostics/stats; it never changes an Agent, Task, or Run result.

Use a `BatchingTraceSink` directly via `createOtelTraceExporter()` when the
application owns batching configuration itself.

For a complete no-network example with the official `InMemorySpanExporter`, see
[`otel-provider.ts`](https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/core/examples/integrations/observability-v2/otel-provider.ts).

### Process lifecycle

- **Serverless/FaaS:** call `sink.forceFlush()` with a short invocation budget;
  do not shut down a warm shared sink/provider per invocation.
- **CLI:** run, force-flush the sink, shut down the sink, then shut down the
  application-owned provider before natural process exit.
- **Long-lived server:** stop intake and await in-flight work before the sink
  cutoff; then force-flush/shut down the sink and finally shut down the provider.

This package and core register no process signal handlers. The application owns
that integration. Keep `shutdownOnShutdown` at its default `false` when the
provider is shared with other instrumentation; set it to `true` only when this
adapter is the provider owner.

## Mapping

The adapter creates one OTel span for each OMA `span_start`/`span_end` pair.
An end record that arrives without a start creates a marked incomplete span so
the self-contained OBS-2 end snapshot remains observable. Duplicates and
orphan events are ignored with payload-free diagnostics.

| OMA operation | OTel representation |
|---|---|
| root run | `oma.run` span (`INTERNAL`) |
| coordinator decomposition/synthesis | OMA plan/agent/callback span, original name retained |
| task, agent attempt, consensus, checkpoint | `INTERNAL` span, original name retained |
| LLM | `CLIENT` span with compatible `gen_ai.*` attributes |
| tool / delegation | `INTERNAL` span; delegated task relation is an OTel link |
| retry / consensus verdict / stream chunks | `oma.*` events |
| DAG / restore / synthesis consumption | OTel links with `oma.link.relation` and explicit resolution metadata |

When the referenced span was observed by the same adapter, the OTel link uses
that span's actual SDK-generated `SpanContext`, so backends can resolve it to the
exported span. This covers DAG dependencies, delegation, synthesis consumption,
and same-process checkpoint restore. Every link also records
`oma.link.resolved`, `oma.link.target.trace_id`, and
`oma.link.target.span_id`; the target IDs are the stable OMA identifiers.

After a process restart, the adapter has no access to the previous provider's
SDK-generated context because checkpoints intentionally contain only OMA IDs.
Such a `continued_from` link remains a valid remote OTel link using the OMA IDs,
`TraceFlags.NONE`, and `oma.link.resolved = false`. Use its target attributes
for correlation; a backend cannot be expected to navigate it to the previously
exported OTel span.

Stable correlation attributes include `oma.schema.version = 2`,
`oma.run.id`, `oma.run.attempt`, `oma.trace.id`, `oma.span.id`,
`oma.record.id`, `oma.record.sequence`, and `oma.otel.mapping.version`.
`oma.otel.gen_ai_semconv.version` records the current compatible GenAI mapping:
`1.43.0-development`. `oma.*` remains the stable OMA contract; the GenAI
attributes are a compatibility surface and can evolve with OpenTelemetry.

`ok`, `cancelled`, `rejected`, and `skipped` map to OTel `Unset`; `error`,
`timeout`, and `budget_exhausted` map to `Error`. The source OMA status is
always retained as `oma.status`.

The adapter maps model/provider, input/output/cache/reasoning token counts,
tool name/error facts, cost metadata, retry fields, and TTFT. It emits no
metrics, so no OMA high-cardinality values become metric labels.

## Privacy

Prompt, completion, tool arguments/results, raw payloads, credentials, and
reasoning/chain-of-thought content are filtered by default. The adapter uses an
explicit low-sensitivity `oma.*` allowlist rather than forwarding arbitrary
record attributes. This includes `<thinking>` and provider reasoning content.
Token counts remain eligible for export.

`contentCapture` accepts `mode: 'disabled'` (the default) and
`mode: 'upstream-policy'`. Under `upstream-policy` the adapter additionally
forwards `oma.tool.input` and `oma.tool.output`, and nothing else:

```typescript
const sink = createOtelTraceSink({
  tracerProvider: provider,
  contentCapture: { mode: 'upstream-policy' },
})
```

That mode defers to the capture policy upstream of the adapter rather than
introducing one here. Core records those two attributes only when
`observability.capture` sets `toolInput`/`toolOutput`, and only after
`SensitiveDataProcessor` has stripped structured credentials, redacted the
text, and truncated it to `maxContentChars`. Enabling the adapter mode without
the core policy exports nothing extra, because the attributes do not exist.
Reasoning and chain-of-thought content have no opt-in under any mode.

`service.name` belongs to the Resource on the application's `TracerProvider`.
This adapter never sets it; a provider built without a Resource reports OMA
spans under the OTel default (`unknown_service:node`). `metadata.release` and
`metadata.environment` are span attributes (`service.version`,
`deployment.environment.name`) and do not replace a Resource.

## OTLP convenience decision

This initial release deliberately has no `/otlp-http` convenience subpath.
The application chooses and configures its own OpenTelemetry SDK and OTLP (or
other) exporter, keeping this package's runtime surface to the OTel API and
avoiding eager OTLP imports, global-provider configuration, and a second
SDK/exporter version matrix. An explicit convenience subpath can be added later
without changing the root import.
