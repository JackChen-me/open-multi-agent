# Migrating from `onTrace` to Observability v2

Observability v2 is an additive path. Existing `onTrace` integrations can keep
running while transport, storage, and OpenTelemetry are migrated one layer at a
time. There is no stop-the-world rewrite.

The copyable snippets on this page are mirrored by the compile-only
[`public-snippets.ts`](../packages/core/examples/integrations/observability-v2/public-snippets.ts)
fixture and typechecked in the Node 20/22/24 test matrix.

## Compatibility contract

- `onTrace` is supported throughout the 1.x line and is **not** marked
  deprecated; the compatibility window is open.
- The eight-member `TraceEvent` union, completion/event timing, UUID `spanId`,
  UUID `parentId` tree, and best-effort-redacted legacy tool payloads remain
  unchanged.
- A synchronous callback throw or asynchronous rejection never changes an
  Agent, Task, or Run result and does not become an unhandled rejection.
- New identity, status, start/event/end, links, diagnostics, stores, and OTel
  mapping use `TraceRecord` schema v2. They do not mutate the legacy event
  shapes.

## Migration stages

| Stage | Change | Rollback |
|---|---|---|
| 0 | Keep `onTrace` exactly as it is. | None needed. |
| 1 | Put the callback behind `LegacyCallbackTraceSink`. | Move the same callback back to `onTrace`. |
| 2 | Add `BatchingTraceSink` and a custom `TraceExporter`. | Keep the stage-1 bridge while disabling the new exporter. |
| 3 | Replace the custom exporter with `TraceStoreExporter` or `@open-multi-agent/otel`. | Switch exporters; the OMA run contract is unchanged. |
| 4 | Make the application own `forceFlush` / `shutdown` / store/provider close. | Keep explicit flush and lengthen timeouts; never make business success depend on telemetry. |

### Stage 0: no immediate migration

```ts
import { OpenMultiAgent, type TraceEvent } from '@open-multi-agent/core'

function existingCallback(event: TraceEvent): void {
  legacyCollector.write(event)
}

const oma = new OpenMultiAgent({ onTrace: existingCallback })
```

This remains a valid 1.x configuration.

### Stage 1: wrap the existing callback

```ts
import { OpenMultiAgent } from '@open-multi-agent/core'
import { LegacyCallbackTraceSink } from '@open-multi-agent/core/observability'

const legacySink = new LegacyCallbackTraceSink(existingCallback)
const oma = new OpenMultiAgent({
  observability: { sinks: [legacySink] },
})

try {
  await oma.runAgent(agent, prompt)
  await legacySink.forceFlush({ timeoutMs: 1_000 })
} finally {
  await legacySink.shutdown({ timeoutMs: 1_000 })
}
```

Configure the bridge directly in `observability.sinks`. Do not also pass the
same callback through `onTrace`, or the application has deliberately configured
two deliveries. The bridge retains the legacy privacy surface; v2 sinks beside
it still receive the narrower default-safe records.

### Stage 2: batch a custom exporter

```ts
import {
  BatchingTraceSink,
  type TraceExporter,
} from '@open-multi-agent/core/observability'

const exporter: TraceExporter = {
  async export(records, signal) {
    const delivered = await sendBatch(records, { signal })
    return { status: 'success', exported: delivered }
  },
}

const sink = new BatchingTraceSink(exporter)
const oma = new OpenMultiAgent({ observability: { sinks: [sink] } })
```

`emit()` only admits a record to a bounded local queue. Export results describe
the delivered prefix: a short `success` is a permanent partial delivery; a
short `retryable` retries only the remaining suffix. Rejection, timeout, queue
overflow, and permanent failure are visible in `getStats()`, diagnostics, and
flush results but never alter business results.

Runnable version: [`batching-exporter.ts`](../packages/core/examples/integrations/observability-v2/batching-exporter.ts).

### Stage 3A: choose a TraceStore

```ts
import {
  BatchingTraceSink,
  InMemoryTraceStore,
  TraceStoreExporter,
} from '@open-multi-agent/core/observability'

const store = new InMemoryTraceStore()
const sink = new BatchingTraceSink(new TraceStoreExporter(store))
```

Use `InMemoryTraceStore` for tests and local inspection. Use the Node-only
`FileTraceStore` subpath for durable local files, CLIs, and modest
single-process services. It is not a shared database and must not have two
processes writing the same path.

Runnable versions: [`in-memory-store.ts`](../packages/core/examples/integrations/observability-v2/in-memory-store.ts)
and [`file-trace-store.ts`](../packages/core/examples/integrations/observability-v2/file-trace-store.ts).

### Stage 3B: choose the OpenTelemetry adapter

```bash
npm install @open-multi-agent/core @open-multi-agent/otel @opentelemetry/api
```

The adapter depends on `@open-multi-agent/core@^1.11.0`, the first release
carrying the v2 APIs it maps, and declares `@opentelemetry/api@^1.9.0` as a peer
dependency.

```ts
import { createOtelTraceSink } from '@open-multi-agent/otel'

const sink = createOtelTraceSink({ tracerProvider: applicationProvider })
const oma = new OpenMultiAgent({ observability: { sinks: [sink] } })
```

The application constructs the provider, processors, sampler, resource, and
exporter. The adapter does not use the global provider. Provider shutdown is
off by default; after draining the OMA sink, the application shuts down the
provider it owns.

Runnable in-memory-provider version: [`otel-provider.ts`](../packages/core/examples/integrations/observability-v2/otel-provider.ts).

### Stage 4: own lifecycle explicitly

| Runtime | End-of-work sequence |
|---|---|
| Serverless/FaaS warm singleton | `run → sink.forceFlush(short timeout)`; do not shut down the shared singleton per invocation. |
| Short-lived CLI | `run → sink.forceFlush → store.flush (if file-backed) → sink.shutdown → store.close`. |
| Long-lived server | stop accepting work and await in-flight requests, then `sink.forceFlush → sink.shutdown → store.close → provider.shutdown` for resources the application owns. |

OMA does not install signal handlers, call `process.exit()`, close a supplied
store, or shut down an application-owned provider. See the runnable
[`CLI`](../packages/core/examples/integrations/observability-v2/cli-lifecycle.ts),
[`SIGTERM server`](../packages/core/examples/integrations/observability-v2/server-lifecycle.ts),
and [`FaaS`](../packages/core/examples/integrations/observability-v2/serverless-lifecycle.ts)
examples.

## Privacy difference to account for

Legacy `onTrace` intentionally keeps its historical redacted tool input/output
fields. V2 instrumentation does not collect prompt, completion, tool arguments,
tool results, or reasoning content by default. Numeric usage facts, including
reasoning-token counts, remain eligible. Trace privacy does not redact
CheckpointStore or shared-memory data; use `RedactingStore` separately where
persisted run state needs masking.

## Cutover checklist

1. Run legacy and v2 destinations side by side only when duplicate delivery is
   intentional and separately keyed.
2. Compare run counts by `runId`; do not equate legacy UUID span IDs with v2
   W3C-compatible trace/span IDs.
3. Alert on sink `dropped`, `failed`, and `lastError` rather than turning them
   into Agent failures.
4. Exercise exporter rejection, hang, and partial delivery before cutover.
5. Add lifecycle handling for every process mode before removing the stage-1
   bridge.
6. Keep rollback as a configuration change until the new backend has met its
   retention, privacy, and durability requirements.
