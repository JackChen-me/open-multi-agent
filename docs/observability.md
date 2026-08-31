# Observability

`open-multi-agent` exposes three telemetry layers: live progress events,
structured trace spans, and an offline single-run DAG/Waterfall Viewer.

For an existing callback integration, follow the staged
[`onTrace` migration guide](./observability-migration.md). Release engineering
and benchmark evidence are recorded in
[`observability-performance.md`](./observability-performance.md) and
[`observability-release-readiness.md`](./observability-release-readiness.md).

## Run identity and outcome

Every top-level execution (`runAgent`, `runTeam`, `runTasks`, `runFromPlan`,
`runConsensus`, and `restore`) returns an identity even when `onTrace` is not
configured:

```typescript
const result = await orchestrator.runTasks(team, tasks, { runId: 'order-42' })

result.identity // { runId, attempt, traceId, rootSpanId, links? } at runtime
result.status   // { code, message? } at runtime
result.errorInfo // redacted, JSON-safe details on failures
```

`runId` identifies a logical run and can be supplied by the caller (1-128
characters). `attempt` starts at 1. Each execution attempt gets a new 32-hex
`traceId` and 16-hex `rootSpanId`. Restore preserves `runId`, increments
`attempt`, generates new trace/root IDs, and links to the previous attempt when
restoring an identity-aware v2 or v3 checkpoint.

Status codes are `ok`, `error`, `cancelled`, `timeout`, `budget_exhausted`,
`rejected`, and `skipped`. Existing `success` fields remain available and are
derived from `status.code === 'ok'`; cancellations and whole-run timeouts are
therefore no longer reported as successful runs. A rejected consensus verdict
is still an `ok` execution outcome—the verdict is a domain result, not a runtime
failure.

For source compatibility in the first 1.x release, the new result fields are
optional in TypeScript declarations, but every runtime result from these APIs
includes `identity` and `status`.

### Per-run metadata

Use `metadata` on any top-level execution to attach bounded evaluation or
correlation facts to that run, such as a prompt version, experiment arm, or
dataset tag:

```typescript
const result = await orchestrator.runTasks(team, tasks, {
  metadata: {
    prompt_version: 'v3',
    experiment: 'routing_ab',
    dataset_tag: 'support_holdout',
  },
})

result.metadata // the validated metadata, even without observability sinks
```

Metadata keys must match `[a-z0-9_.]{1,64}`, each run may contain at most 32
keys, and the `oma.` prefix is reserved for the framework. Values use the
`TraceAttributeValue` contract: a string, finite number, boolean, or a
homogeneous array of one of those scalar types. Strings, including strings in
arrays, are truncated to 1,024 characters. Invalid metadata rejects the call
before execution starts. The framework also reserves the exact `_overridden`
key for restore provenance.

When tracing is active, metadata is written on the root span as
`oma.meta.<key>` and is echoed from the top-level result after validation. A v2
checkpoint persists it; `restore()` inherits the checkpoint metadata unless
the caller supplies a different set. An explicit difference wins and the new
attempt's root span records `oma.meta._overridden=true`. Existing checkpoints
without metadata remain readable.

`TraceStore` materializes the latest attempt's root metadata into
`RunSummary.metadata`, so `getRun()` and `queryRuns()` results expose it.
`TraceQuery` intentionally does not provide metadata filtering.

This per-run channel is distinct from `ObservabilityResource`: use resource
fields for instance-level facts such as service, release, and deployment
environment; use run metadata for dimensions that may change on every call.

## Execution receipts

`buildExecutionReceipt(result, trace?)` derives a compact record of what the
runtime actually executed. It accepts an `AgentRunResult` or `TeamRunResult`
and optional legacy `TraceEvent[]` data, performs no I/O, and never throws when
execution fields are missing:

```typescript
import { buildExecutionReceipt, OpenMultiAgent, type TraceEvent } from '@open-multi-agent/core'

const trace: TraceEvent[] = []
const tracedOrchestrator = new OpenMultiAgent({
  onTrace: (event) => trace.push(event),
})
const result = await tracedOrchestrator.runTeam(team, goal)
const receipt = buildExecutionReceipt(result, trace)
```

The receipt reports `mode`, distinct `rolesExecuted`, start-time-based
`executionOrder`, cross-role `dependencyEdges`, `independentRolesCount`, token
usage, duration, and whether the record is `partial`. For compatibility,
`rolesExecuted` continues to mean concrete assignee names;
`workerInstancesExecuted` makes that meaning explicit and
`taskRolesExecuted` lists distinct caller-declared logical task roles when
present. `independentReviewOccurred` is true only when at least two different
worker instances executed and at least one task dependency connects two
different assignees. Parallel workers with no dependency edge do not count as
an independent review chain. Coordinator planning entries (`coordinator` and
`coordinator:*`) are excluded.

For `runTeam()`, the receipt also carries its stable `id` plus
`routingDecisionId` and, when tracing is enabled, `routingDecisionSpanId`.
These fields link the post-execution topology back to
`TeamRunResult.routingDecision`, which in turn carries the receipt's `receiptId`.
The routing span records the same receipt ID. `ExecutionReceipt` remains the
only structured record of the topology that actually ran; the routing record
describes only the pre-execution choice and its reasons.

Governance decisions must use these execution facts, not labels, claims, or
review markers in model answer text. The builder never inspects answer text.
For a standalone `AgentRunResult`, the optional trace supplies the agent name
and run duration because those facts are not fields on that result type. When
the available result or trace cannot establish a fact, the builder returns an
empty array or `null` for that field and sets `partial: true`.

### Post-execution governance conclusion

Every OMA-produced `TeamRunResult` carries `governanceConclusion`:

- `satisfied` — a `governanceIntent: 'required'` run executed every declared
  role, every adjacent `requiredOrder` pair appears in the observed execution
  order and is connected by a dependency path, and declarations with two or
  more roles produced `independentReviewOccurred: true`;
- `unsatisfied` — at least one of those required execution facts is absent;
- `not-applicable` — governance was omitted, `none`, or `preferred`.

The conclusion is computed by passing the result through
`buildExecutionReceipt()` and then `evaluateGovernance()`. It is therefore a
post-execution topology verdict, not a judgment about answer wording or quality.
Review labels or approval markers in model output cannot satisfy the gate.

`success` is intentionally independent: it continues to mean that the run
finished without runtime errors. A run can be `success: true` and
`governanceConclusion: 'unsatisfied'`; applications that require governance
must gate on the latter field. In particular, multiple required roles without
a dependency-backed review chain do not count as independent review.

## TraceRecord schema v2

The core package exports the `TraceRecord` schema used by the internal
OBS-1B runtime. A span produces `span_start`, zero or more `span_event`
records, and exactly one self-contained `span_end`. Records carry
`schemaVersion: 2`, a unique `recordId`, a per-trace strictly increasing
`sequence`, the run identity, W3C-compatible trace/span IDs, timestamps,
status, safe attributes, and optional links.

The hierarchy uses parent relationships for lifecycle containment and links
for non-tree relationships:

- the run root contains coordinator, task, consensus, checkpoint, and callback operations;
- task attempts are agent children, with LLM and tool calls below the agent;
- DAG prerequisites use `depends_on` links;
- delegated agents are children of the `delegate_to_agent` tool and link back to the task;
- coordinator synthesis uses `consumed` links to task spans;
- checkpoint restore starts a new trace whose root links `continued_from` the prior root.

`span_end` repeats the span kind, name, start time, final attributes, links,
status, and structured error so it remains useful if a start/event record is
lost later in the delivery pipeline. Close is idempotent and the first end
wins.

OBS-2 adds a public sink/exporter lifecycle. The runtime is activated by either
`observability.sinks` or the existing `onTrace` path. Without either option, no
child `TraceRecord` objects or attributes are constructed; top-level
identity/status still exist.

Streaming notifications are span events rather than zero-duration child
spans in v2. TTFT is recorded only by a genuinely streaming provider path;
the current aggregated `chat()` path never substitutes total latency for
TTFT. Legacy `agent_stream` callback events remain unchanged.

## Sinks, exporters, and ownership

`TraceSink` is the synchronous hot-path contract. Its `emit(record): void`
method accepts a record quickly and is never awaited by Agent, Task, or Run
execution. `TraceExporter` is the asynchronous batch-delivery contract used by
`BatchingTraceSink`; network or storage I/O belongs there. A sink or exporter
failure changes observability statistics and diagnostics, never the business
result.

```typescript
import {
  BatchingTraceSink,
  OpenMultiAgent,
  type TraceExporter,
} from '@open-multi-agent/core'

const exporter: TraceExporter = {
  async export(records, signal) {
    // Send the batch using `signal`; return a delivered prefix count.
    return { status: 'success', exported: records.length }
  },
}

const sink = new BatchingTraceSink(exporter)
const orchestrator = new OpenMultiAgent({
  observability: { sinks: [sink] },
})
```

An exporter result has `success`, `retryable`, or permanent `failure` status.
`exported` is the successfully delivered prefix of the supplied batch. A short
`success` is a permanent partial result; a short `retryable` result retries only
the unexported suffix. Rejected or timed-out exporter promises are contained by
the batching sink.

Core also exports `CompositeSink`, `FilteringSink`,
`SensitiveDataProcessor`, and `LegacyCallbackTraceSink`, both from the package
root and the explicit `@open-multi-agent/core/observability` subpath.

## TraceStore query and reference storage

`TraceStore` is the storage-medium-independent persistence and query contract
for v2 `TraceRecord` batches. Core includes `InMemoryTraceStore` as the reference
implementation and `TraceStoreExporter` as the bridge into
`BatchingTraceSink`:

```typescript
import {
  BatchingTraceSink,
  InMemoryTraceStore,
  TraceStoreExporter,
} from '@open-multi-agent/core/observability'

const store = new InMemoryTraceStore()
const sink = new BatchingTraceSink(new TraceStoreExporter(store))

// Configure sink under observability.sinks, run work, then flush its watermark.
await sink.forceFlush({ timeoutMs: 1_000 })
const page = await store.queryRuns({
  status: ['error', 'timeout'],
  agent: ['researcher'],
  limit: 50,
})
```

`InMemoryTraceStore` is not durable and is not a production database. It is
intended for unit tests, local inspection, and short-lived processes. It has no
filesystem or database dependency, and it returns copies rather than mutable
references to its internal records.

### FileTraceStore: persistent single-process reference

`FileTraceStore` is the Node-only reference implementation for local
development, tests, CLIs, and modest single-process services. It ships in the
core package—there is no extra dependency to install—but it must be imported
from the explicit Node-only subpath:

```typescript
import { FileTraceStore } from '@open-multi-agent/core/observability/file'
import {
  BatchingTraceSink,
  TraceStoreExporter,
} from '@open-multi-agent/core/observability'

const store = await FileTraceStore.open('./.oma/traces.ndjson')
const sink = new BatchingTraceSink(new TraceStoreExporter(store))

try {
  const orchestrator = new OpenMultiAgent({ observability: { sinks: [sink] } })
  await orchestrator.runAgent(agent, prompt)
  await sink.forceFlush({ timeoutMs: 5_000 }) // exporter → FileTraceStore
  await store.flush()                         // fsync the trace file
} finally {
  await sink.shutdown({ timeoutMs: 5_000 })
  await store.close()
}
```

Neither `@open-multi-agent/core` nor
`@open-multi-agent/core/observability` exports or imports this implementation.
Only `@open-multi-agent/core/observability/file` loads its Node filesystem
code. Importing any of these modules performs no file I/O; `FileTraceStore.open`
is the explicit creation/recovery boundary.

`FileTraceStore` and `InMemoryTraceStore` run the same TraceStore contract.
The in-memory store has no lifecycle or persistence and its state disappears
with the process. The file store scans its log on open, rebuilds the same
in-memory indexes, serializes every read/mutation on one instance, and exposes
`flush`, `close`, and `compact`. Query cursors remain store-instance-specific:
a cursor from a closed instance is intentionally invalid after reopen; start a
fresh pagination walk.

#### Disk envelope and recovery

The append-only file is UTF-8 NDJSON with this versioned envelope:

```text
file_header(format="oma.file_trace_store", formatVersion=1, traceSchemaMajor=2)
batch_start(batchId, operation, itemCount, payloadSha256)
batch_item(batchId, index, payload)  # one TraceRecord or delete tombstone
...
batch_commit(batchId, itemCount, payloadSha256)
```

The format version belongs to the file envelope; each trace payload still has
its own `schemaVersion: 2`. Recovery does not infer either version from memory.
Unknown additive fields inside supported TraceRecord v2 payloads round-trip
unchanged.

An append/delete batch becomes visible only when its commit marker is a
complete NDJSON line and its id, contiguous item count, and SHA-256 checksum
match the start marker and payloads. On open, the store scans in file order and
replays only committed batches. A final truncated line or trailing uncommitted
batch produces a structured, payload-free diagnostic and is truncated back to
the last committed byte boundary. Thus one API batch is entirely visible or
entirely absent after restart. A malformed complete line, corruption before
the tail, invalid committed payload, unsupported file format, or unsupported
trace schema fails open loudly; it is never skipped.

Delete and retention operations append committed tombstone batches containing
the exact logical run IDs removed. Reopen therefore cannot resurrect deleted
records, and it does not re-evaluate retention against a different clock.

#### Write, flush, close, and failure semantics

- A successful `append` means the complete committed envelope was accepted by
  the operating system's file write and the descriptor was closed. It does
  **not** mean `fsync` completed.
- `flush()` waits behind all operations accepted before it and `fsync`s the
  target file. Repeat calls are safe. It is the explicit boundary for surviving
  an OS crash/power loss to the extent promised by the local filesystem.
- `close()` stops accepting new operations, waits for already accepted work,
  performs the same file `fsync`, and is idempotent. Calls other than repeated
  `close()` reject afterward with a structured `CLOSED` error.
- Graceful CLI/server shutdown should flush the batching sink first, then close
  the store. On an abrupt process exit, fully written but not fsynced batches
  may be lost by an OS/power failure; a process crash alone normally leaves
  writes already accepted by the kernel recoverable.
- Write, permission, disk-full, fsync, and rename failures reject with
  `FileTraceStoreError`. They are never reported as successful. Error and
  diagnostic messages contain no TraceRecord or telemetry payload.

New files request mode `0600`. Platforms without POSIX mode enforcement emit a
diagnostic and rely on their native access controls. The store registers no
signal handlers and never calls `process.exit()`.

#### Crash-safe compaction

`await store.compact()` writes only the current effective records, in stable
query/record order, to `<path>.compact.tmp` in the same directory. It sets mode
`0600`, flushes/fsyncs the temp file, atomically renames it over the target, and
fsyncs the parent directory when the platform/filesystem supports directory
fsync. A rename failure leaves the original target authoritative and usable.
An interrupted temp beside an existing target is diagnosed as stale and is
ignored until the next compaction overwrites it. A temp without its target is
treated as ambiguous possible data and open fails rather than creating an
empty store. Repeated compaction of unchanged state is byte-deterministic.

Compaction does not change query results. Deleted/retention-cleaned records and
their tombstones disappear from the compacted file.

#### Scope and migration boundary

This is a reference store, not a database. It deliberately provides no
cross-process lock, multi-process writer coordination, network-filesystem
consistency, high-concurrency tuning, full-text search, advanced analytics,
tenant authentication, or RBAC. Do not let two instances write one path, and
do not use it as a shared NFS/SMB trace backend. For those requirements,
implement the storage-medium-neutral `TraceStore` contract in a separate
database adapter/package and migrate by replaying the committed TraceRecord
stream. No database driver belongs in the core or this subpath.

From the repository root, run `npm run build -w @open-multi-agent/core`
followed by
`node --expose-gc packages/core/benchmarks/file-trace-store.mjs` for the
repeatable 1k/10k local boundary benchmark (append, fsync, reopen, query,
compaction, heap estimate, file size, and batch-size comparison). The benchmark
is a repository development tool and is intentionally excluded from the npm
tarball.

### Append, schema, and materialization

`append(records)` accepts a batch atomically: validation failure leaves the
whole batch invisible. Schema major `2` is supported; another major is rejected
with `TraceStoreError(code = 'UNSUPPORTED_SCHEMA_VERSION')`. Unknown fields on
schema-v2 records are retained so additive minor evolution can round-trip.

`recordId` is the idempotency key. Re-exporting a previously accepted batch is
a successful no-op for those records. If the same span receives more than one
distinct `span_end`, the first accepted end wins and append returns a
`duplicate_span_end` diagnostic; the later end cannot change the materialized
Agent or Run outcome.

Materialization sorts records within each trace by `sequence`, independent of
arrival order. An end record is self-contained, so an end-only span is complete.
A start with no accepted end remains incomplete. A logical `runId` groups all
attempts and trace identities, including restore continuations. Parentage and
`continued_from`, `depends_on`, `delegated_from`, and `consumed` links are
preserved on materialized spans. The run terminal status is the latest attempt's
actual root end status; it is absent when that record is missing and is never
invented as `ok`.

Run summaries include start/end/duration, attempts and trace/root identity,
terminal status when present, agent/task/model/provider values actually found
in attributes, LLM token and cost facts, incomplete state, and schema version.
Only LLM end records contribute token/cost totals, avoiding double-counting
agent or run rollups.

### Filters, ordering, and opaque cursors

`queryRuns` supports combined `runId`, ISO time range, status, agent, task ID,
model, and provider filters. `startedAfter` is inclusive; `startedBefore` is
exclusive. The default page size is 50 (maximum 500). Stable ordering is
`(startedAt, runId)`, descending by default; `started_asc` reverses both parts
of that key, so equal timestamps always have a deterministic tie-breaker.

The cursor is opaque, store-instance-specific, and bound to the filter/order
that created it. Invalid, tampered, or mismatched cursors reject with
`TraceStoreError(code = 'INVALID_CURSOR')`. The first page captures an append
revision: records appended while later pages are read do not appear in that
pagination walk, preventing duplicates and omissions. A fresh query sees them.
Deletes are immediately consistent and invalidate outstanding cursors; the
append snapshot does not claim a transaction across concurrent delete or
retention operations.

### Delete and retention

`deleteRun(runId)` removes every attempt for one logical run. `delete(query)`
bulk-deletes logical runs using the same frozen filters as queries, without
cursor, order, or limit. Both are idempotent, and successful deletion is
immediately reflected by `getRun` and `queryRuns`.

Retention accepts `maxAgeMs`, `maxRuns`, and an optional terminal-status scope.
Age uses the injected store clock and run start time. `maxRuns` keeps the newest
matching runs by the same stable ordering; age and count deletion sets are
combined. A status-only policy deletes runs with those actual terminal statuses
and does not match incomplete runs with no status. Deletion order is oldest
first with `runId` as the tie-breaker, and repeated application is safe.

TraceStore retention only affects that store. It cannot delete copies already
exported to OTel or another vendor.

### Dashboard, TraceStore, CheckpointStore, and RunStore

| Data plane | Responsibility | Reliability boundary |
|---|---|---|
| Run Viewer | static post-run task DAG plus span Waterfall, timing, token/cost facts, and safe details | derived artifact; no live delivery or authoritative state |
| TraceStore | append/query telemetry, retention, and trace deletion | best-effort; no CAS, lease, suspend, or resume |
| CheckpointStore | safe-boundary execution snapshot consumed by `restore()` | execution recovery state; not a trace query system |
| RunJournal | opt-in append-only record of what happened and what each model call saw | execution state; best-effort writes, never required to recover |
| future RunStore | authoritative durable run state machine | not implemented by Observability v2 |

Losing telemetry must not roll back a durable run. Deleting traces must not
delete checkpoints, shared memory, or remotely exported OTel data.

### Journal versus telemetry

The optional [run journal](run-journal.md) describes the same run these records
describe and is deliberately not part of this stack. Traces are **telemetry**:
sampling, batching, export, and retention deletion may all discard them, and
none of that may change a run. Journal events are **execution state**: they
record what the run did and what each model call saw, and `restore()` can fold
them back into a conversation.

The separation is structural, not conventional — `journal/` does not import from
`observability/` — and it runs to the failure signals as well: a trace delivery
failure and a `journal_append_failed` progress event report on separate records,
and neither implies the other. Journal events carry `traceId` and `spanId` when a
trace runtime is active, which is enough to join the two streams after the fact.
Reach for traces when the question is where the time and tokens went, and for the
journal when it is why the model saw what it saw; the
[run journal guide](run-journal.md) has the event vocabulary and the `verifyRun()`
audit.

## Optional OpenTelemetry package

`@open-multi-agent/otel` is an independent workspace/package that adapts OBS-2
`TraceRecord` batches to OpenTelemetry spans. It is not imported by core, so a
core-only installation has no OpenTelemetry runtime dependency or import path.

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'
import { createOtelTraceSink } from '@open-multi-agent/otel'

// The application has already constructed and configured this OTel provider.
const sink = createOtelTraceSink({
  tracerProvider: provider,
  metadata: { environment: 'production', release: '2026.07.15' },
})
const orchestrator = new OpenMultiAgent({ observability: { sinks: [sink] } })
```

Pass exactly one application-owned `tracer` or `tracerProvider`; supplying
neither is a configuration error. The adapter never reads, initializes, or
replaces the global provider. `forceFlush()` delegates to a supplied provider
when it supports that operation. Provider shutdown is skipped by default, even
when available: set `shutdownOnShutdown: true` only when the adapter owns that
provider's lifecycle. Rejection/timeout maps to the OBS-2 exporter result and
diagnostics, never to an Agent/Task/Run failure.

`egressPolicy` does not wrap the application-owned provider or its exporters.
Use the provider/exporter transport configuration or infrastructure controls
for telemetry egress; see the [egress enforcement matrix](egress-policy.md#enforcement-matrix).

OMA run/agent/task/LLM/tool/consensus/checkpoint records become spans;
retry, verdict, first-chunk, and stream records become `oma.*` events. DAG,
delegation, consumed-synthesis, and restore-continuation relations become OTel
links. The adapter keeps `schemaVersion: 2`, run/attempt, OMA trace/span IDs,
record ID, and sequence as stable `oma.*` attributes. It maps `error`,
`timeout`, and `budget_exhausted` to OTel `Error`; all remaining OMA statuses
remain OTel `Unset` and are preserved in `oma.status`.

Links whose targets were observed by the same adapter use the target span's
actual SDK-generated OTel context. Each link records `oma.link.resolved` plus
the stable OMA target trace/span IDs. A same-process restore resolves through a
bounded cache of the 256 most recent root contexts. After a process restart the
previous SDK context is unavailable, so `continued_from` falls back to a remote
unsampled context built from the OMA IDs and marks itself unresolved; the OMA
target attributes remain available for correlation.

Completed OTel `Span` objects are released immediately. Lightweight contexts
live only until their root span closes, at which point the trace-local registry
is cleared. Root close and adapter shutdown end any remaining open spans as
incomplete before clearing state, so telemetry loss cannot produce an unbounded
live-span registry.

For LLM/tool spans it also emits a bounded compatibility subset of the current
development-status GenAI conventions (provider/model, token/cache/reasoning
counts, tool name, and TTFT). Every span records
`oma.otel.mapping.version` and `oma.otel.gen_ai_semconv.version`; the stable
contract is `oma.*`, not the evolving GenAI field names. It emits no metrics,
so no high-cardinality run/task/tenant/request fields become metric labels.

The adapter exports no prompt, completion, tool arguments/results, raw payload,
credential, chain-of-thought, or reasoning content. Numeric token counts remain
eligible. It forwards only an explicit low-sensitivity `oma.*` allowlist rather
than arbitrary record attributes.

`contentCapture` opens one bounded exception. Under
`contentCapture: { mode: 'upstream-policy' }` the adapter also forwards
`oma.tool.input` and `oma.tool.output`, which core produces only when
`observability.capture` opts in and `SensitiveDataProcessor` has already
redacted and truncated. Both opt-ins are required: the adapter setting alone
exports nothing extra, because without the core policy those attributes are
never recorded. No other content attribute is eligible under any mode, and
reasoning content has no opt-in at all. The default remains
`mode: 'disabled'`.

`service.name` comes from the Resource on the application's own
`TracerProvider`. The adapter never sets it, so a provider built without a
Resource reports OMA spans under the OTel default (`unknown_service:node`).
`metadata.release` and `metadata.environment` map to `service.version` and
`deployment.environment.name` as span attributes; they are not a substitute for
a Resource.

The first release intentionally provides no OTLP convenience subpath. The
application selects its own OTel SDK and OTLP/exporter implementation, avoiding
eager OTLP imports, implicit global-provider configuration, and a second
SDK/exporter compatibility matrix. See
[`packages/otel/README.md`](../packages/otel/README.md) for the full API and
mapping table.

## Flush and shutdown

`forceFlush({ timeoutMs })` captures an acceptance watermark. It promises that
records accepted before that call have been exported or explicitly counted as
failed/dropped; records accepted afterward do not delay that call. It then
delegates to the exporter's optional `forceFlush`. Results are `ok`, `partial`,
`timeout`, or `error` and include cumulative accepted/exported/dropped/failed
counts.

`shutdown({ timeoutMs })` atomically stops acceptance, flushes the cutoff, then
shuts down the exporter. It is idempotent: concurrent and repeated calls share
the first result. An `emit` after the cutoff is dropped and diagnosed. Timeout
is a total lifecycle deadline, not an exception thrown into Agent execution.

The creator of a sink owns its lifecycle. OMA does **not** automatically shut
down injected sinks, install process signal handlers, call `process.exit()`, or
assume that a sink is exclusive to one orchestrator.

```typescript
// Serverless/FaaS: flush this invocation, keep a shared singleton usable.
const result = await orchestrator.runAgent(agent, prompt)
const telemetry = await sink.forceFlush({ timeoutMs: 1_500 })
return { result, telemetry: telemetry.status }

// Short-lived CLI: finish delivery before natural process exit.
try {
  await main()
} finally {
  await sink.forceFlush({ timeoutMs: 5_000 })
  await store?.flush()
  await sink.shutdown({ timeoutMs: 5_000 })
  await store?.close()
}

// Long-lived server: application-owned graceful shutdown.
async function stopServer() {
  await stopAcceptingAndWaitForInflight(server)
  await sink.forceFlush({ timeoutMs: 10_000 })
  await sink.shutdown({ timeoutMs: 10_000 })
  await store?.close()
  await provider?.shutdown()
}
// Register stopServer with your server/process framework if desired.
```

## Queue, retry, drop, and diagnostics

`BatchingTraceSink` defaults are bounded:

| Setting | Default |
|---|---:|
| queued records | 2,048 |
| queued bytes | 16 MiB |
| one record | 256 KiB |
| batch records | 512 |
| scheduled delay | 5 seconds |
| export timeout | 30 seconds |
| retries after the first attempt | 3 |
| retry backoff | 1 second, exponential ×2, equal jitter, capped at 30 seconds |

Only `retryable` results, rejected exporter promises, and export timeouts are
retried. Retry/backoff happens in the transport worker and never blocks
business execution. Queue admission is non-blocking. When capacity is needed,
the sink drops oldest records in this priority order: `stream_chunk`, other
events, `span_start`, then self-contained `span_end`. Oversize records are
rejected before acceptance.

`getStats()` reports accepted, exported, retried, failed, dropped, queued record
count/bytes, and a payload-free last error code. Built-in diagnostics never
include a record, prompt, tool payload, or raw exception. They default to one
`console.warn` per sink+code per 60 seconds; pass `diagnostics: 'silent'`
explicitly to a built-in sink to disable warnings, or use `onDiagnostic`.
Diagnostic handler throws are swallowed without recursively producing another
diagnostic.

## Progress Events

Use `onProgress` when you need lightweight lifecycle events for logs, terminal output, or a live UI.

```typescript
const orchestrator = new OpenMultiAgent({
  onProgress: (event) => {
    console.log(event.type, event.task ?? event.agent ?? '')
  },
})
```

Common event types include `task_start`, `task_complete`, `task_retry`, `task_skipped`, `agent_start`, `agent_complete`, `budget_exceeded`, and `error`. A `task_retry` event's `data.nextDelayMs` is the actual, post-jitter delay before the next attempt, not the nominal backoff schedule.

## Trace Spans

`onTrace` remains source- and runtime-compatible for existing users. Each event
still carries its UUID `spanId`, optional UUID `parentId`, duration, token
counts, and the same best-effort-redacted legacy tool I/O.

```typescript
const orchestrator = new OpenMultiAgent({
  onTrace: async (span) => {
    await traceSink.write(span)
  },
})
```

Forward trace spans to OpenTelemetry, Datadog, Honeycomb, Langfuse, or your own run database only after deciding what data is safe for that sink. See [`integrations/trace-observability`](../packages/core/examples/integrations/trace-observability.ts) for a runnable example.

Every `runTeam()` topology choice emits a `routing_decision` legacy event and
a v2 span with kind `routing` named `decide_execution_route`. The
record includes the decision-time `mode`, `reasons`, optional `confidence`,
the actual `routerVersion`, and structured Router fallback fields when a
Router ran. Hybrid Single candidates also create a
`profile_execution_route` routing span with confidence, latency, token usage,
and fallback code; the decision record and `TeamRunResult` carry the bounded
`semanticRoutingAssessment`. Its `source` distinguishes the priority-chain path
without pretending every choice came from a router:

- `override` — the caller supplied `mode`;
- `declared` — structured governance roles selected the team topology;
- `policy` — framework policy selected the topology, including
  `preferredUnderBudget: 'degrade'` and `planOnly`;
- `router` — automatic routing ran; `routerVersion` identifies that router;
- `legacy-deterministic` — reserved for serialized or compatibility paths that
  bypass an `ExecutionRouter`. Current `runTeam()` auto routing passes through
  `ExecutionRouter`, so new runs do not use this label.

The event/span's `receiptId` points to the eventual `ExecutionReceipt`; the
receipt points back with `routingDecisionId` and `routingDecisionSpanId`.
The assessment is model-inferred evidence and does not duplicate or replace
actual task roles, order, dependency edges, or final tool grants; those remain
post-execution receipt/task facts. Observability sinks pass assessment-derived
text through the existing sensitive-data processor.

The `TraceEvent` union now has eight members, including `routing_decision`.
Internally, `LegacyCallbackTraceSink` maps v2 records back to the exact legacy
event object. Synchronous callback throws and asynchronous rejections remain
isolated and cannot become unhandled rejections. `onTrace` is not marked
deprecated in this release; the 1.x compatibility window remains open while
users can migrate transport code to `observability.sinks` at their own pace.
The copyable stage-by-stage path is in
[`observability-migration.md`](./observability-migration.md), including direct
`LegacyCallbackTraceSink`, batching, TraceStore/OTel, and lifecycle ownership.

Span parentage is best-effort and uses the causal structure known to the runtime. In team runs, worker agent spans point to their task span, and LLM/tool/stream spans point to the agent span. Root spans such as top-level agent runs omit `parentId`.

## Post-Run Run Viewer

`renderRunViewer()` returns a self-contained static HTML page for one run. It
accepts a `TeamRunResult`, a materialized `StoredRun`, or both:

```typescript
import { writeFileSync } from 'node:fs'
import { renderRunViewer } from '@open-multi-agent/core'

const result = await orchestrator.runTeam(team, goal)
writeFileSync('run.html', renderRunViewer({ result }))
```

Result-only mode renders the exact task graph and explicitly labels missing
trace detail. Trace-only mode derives task dependencies from `depends_on`
links and provides every materialized span kind in an attempt-grouped,
expandable, proportional Waterfall. Combined mode uses the result graph as the
authority and links its tasks to richer trace evidence.

```typescript
const run = await traceStore.getRun(result.identity!.runId, { includeRecords: true })
if (run) writeFileSync('run.html', renderRunViewer({ result, run }))
```

`renderTeamRunDashboard(result)` remains source-compatible and delegates to
`renderRunViewer({ result })`; it does not maintain a separate renderer.

The library renderer performs no filesystem or network I/O. The CLI owns file
output:

```bash
# Capture and render the run being executed
oma run --goal "..." --team team.json --dashboard

# Export one previously persisted FileTraceStore run
oma dashboard --trace-store ./.oma/traces.ndjson --run-id <runId> --output run.html
```

The historical command is read-only at the logical store layer and always
closes the store. See [docs/cli.md](./cli.md) for overwrite, stdout, stderr, and
exit-code behavior.

The Viewer renders status, completeness, run identity, duration, attempts,
tokens, costs, agents, models, and providers when recorded. DAG and Waterfall
selection are synchronized by task ID; search and kind/status/agent/task
filters preserve ancestor context. Cyclic or missing hierarchy/dependency data
degrades to visible warnings instead of being silently treated as success.
When routing data is present, a summary above both views shows what mode was
selected, the source and reasons for that choice, and the actual
`ExecutionReceipt` mode/roles/dependency evidence. Result-only and combined
views use `buildExecutionReceipt(result)` for the actual topology rather than
maintaining a dashboard-specific topology model. Trace-only views summarize
the already-materialized Viewer tasks and label that evidence trace-derived
because an `ExecutionReceipt` was not provided.

The generated HTML contains its CSS, JavaScript, and allowlisted data and loads
no remote scripts, stylesheets, fonts, images, telemetry, or runtime API. It
does not embed prompts, completions, arbitrary attributes, tool arguments/tool
results, messages, task descriptions/results, or reasoning content. Safe
display fields are redacted again before serialization. This is a developer
inspection artifact, not a live dashboard, multi-run browser, or authoritative
run-state store.

Generate a representative no-network artifact after building the package:

```bash
npx tsx packages/core/examples/integrations/observability-v2/run-viewer.ts
```

The example writes `oma-dashboards/run-viewer-demo.html` through a real
`FileTraceStore` historical export. Its records are explicitly fictional,
deterministic demo data, not a live provider run.

## What to Persist

For production runs, persist enough data to reconstruct a failure without replaying the entire job:

- `TeamRunResult.tasks` for the executed DAG and task states.
- `TeamRunResult.totalTokenUsage` for cost attribution.
- `result.identity` and `result.status` as the stable run lookup and outcome.
- `TraceRecord` v2 data in a TraceStore for LLM, tool, task, retry/event, link, and attempt evidence.
- The rendered Run Viewer HTML when you need a shareable post-mortem artifact.

> **Redaction scope.** The redaction noted above applies to *telemetry* — trace spans and the dashboard payload. It does **not** cover persisted run state: shared-memory writes and checkpoint saves store agent output verbatim. To scrub secrets there, wrap the durable store with [`RedactingStore`](shared-memory.md#redacting-persisted-secrets).

## Default privacy boundary

The v2 instrumentation does not collect prompts, completions, tool arguments,
or tool results by default. `OpenMultiAgent` wraps configured v2 sinks in a
`SensitiveDataProcessor`; its optional `observability.capture` policy is the
only core-controlled content opt-in. Structured credential fields are removed
even when content capture is enabled. Chain-of-thought/reasoning content,
signed reasoning blocks, and `<thinking>` text are never captured by OMA
instrumentation; numeric reasoning-token counts may be recorded.

Setting `toolInput` or `toolOutput` to `'redacted'` makes tool spans carry
`oma.tool.input` and `oma.tool.output`:

```typescript
const orchestrator = new OpenMultiAgent({
  observability: {
    sinks: [sink],
    capture: { toolInput: 'redacted', toolOutput: 'redacted' },
  },
})
```

The remaining fields are filters, not producers. `prompt` and `completion`
currently gate content that no v2 instrumentation site emits, so setting them
records nothing; they exist so a custom sink's own attributes are filtered
consistently. Legacy `onTrace` is unaffected by this policy and keeps its
own redacted fields.

Legacy `onTrace` keeps its existing redacted tool input/output fields for
compatibility, so its privacy surface is intentionally broader than the v2
default. Trace processing does not redact checkpoints or shared memory.
