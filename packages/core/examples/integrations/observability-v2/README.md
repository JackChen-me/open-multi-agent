# Observability v2 examples

These examples exercise the real public package/subpath APIs with a
deterministic local adapter. They need no model API key, global OpenTelemetry
provider, or external collector. Only `otlp-backend.ts` opens a socket, and it
binds a loopback listener of its own rather than reaching the internet. Build
the workspaces first, then run any file with `npx tsx`.

| Example | Ownership and lifecycle |
|---|---|
| [`batching-exporter.ts`](./batching-exporter.ts) | application-owned custom exporter and batching sink |
| [`in-memory-store.ts`](./in-memory-store.ts) | non-durable in-memory store; application shuts down the sink |
| [`file-trace-store.ts`](./file-trace-store.ts) | drain sink, fsync store, shut down sink, close store |
| [`otel-provider.ts`](./otel-provider.ts) | official in-memory exporter; OMA sink drains before application provider shutdown |
| [`otlp-backend.ts`](./otlp-backend.ts) | real OTLP/HTTP exporter posting to a loopback listener the example starts itself |
| [`cli-lifecycle.ts`](./cli-lifecycle.ts) | short-lived natural exit with explicit flush/shutdown/close |
| [`server-lifecycle.ts`](./server-lifecycle.ts) | application registers SIGTERM, stops intake, drains telemetry |
| [`serverless-lifecycle.ts`](./serverless-lifecycle.ts) | short per-invocation flush; warm singleton is not shut down |
| [`run-viewer.ts`](./run-viewer.ts) | persists fictional deterministic records to `FileTraceStore`, then exports one historical run to `oma-dashboards/run-viewer-demo.html` |

[`public-snippets.ts`](./public-snippets.ts) is compile-only. It mirrors the
copyable migration guide API combinations and is included in the automated
TypeScript check.

The separate [`trace-observability.ts`](../trace-observability.ts) intentionally
remains the legacy `onTrace` example.

Generate the offline Run Viewer demo from the repository root:

```bash
npx tsx packages/core/examples/integrations/observability-v2/run-viewer.ts
```

The command needs no API key or network access. Its trace represents fictional,
deterministic demo data rather than a live provider run. The explicit output
path is non-overwriting; move the existing HTML before generating it again.
