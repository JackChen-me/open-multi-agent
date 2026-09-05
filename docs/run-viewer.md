# Run Viewer

The Run Viewer answers one question after a run has already finished: what
actually ran, in what order, and where did the time and tokens go? It renders a
single run as a self-contained static HTML page with a task DAG and a span
waterfall, from data you already have: a `TeamRunResult`, a run read back out of
a [TraceStore](observability.md#tracestore-query-and-reference-storage), or both.

It is a developer inspection artifact. It is not a live dashboard, a multi-run
browser, or an authoritative store of run state.

## Render a run

`renderRunViewer(input, options?)` returns the page as a string. It performs no
filesystem or network I/O, so the caller decides where the HTML goes.

```typescript
import { writeFileSync } from 'node:fs'
import { renderRunViewer } from '@open-multi-agent/core'

const result = await orchestrator.runTeam(team, goal)
writeFileSync('run.html', renderRunViewer({ result }))
```

`input` is `{ result?, run? }` and at least one of the two is required. `options`
accepts `title` (default `'OMA Run Viewer'`) and `defaultView` (`'dag'` or
`'waterfall'`; the default is `'dag'` when the run has a task graph and
`'waterfall'` when it does not).

### Three input modes

| Input | Mode | What the page can show |
|---|---|---|
| `{ result }` | `result` | The exact task graph from the result, with missing trace detail labeled |
| `{ run }` | `trace` | Every materialized span, with task dependencies derived from `depends_on` links |
| `{ result, run }` | `combined` | The result graph as the authority, linked to the richer trace evidence |

The `run` input is a `StoredRun`, which is what a `TraceStore` returns. Read it
back with `includeRecords: true` so the waterfall has spans to lay out:

```typescript
import { renderRunViewer } from '@open-multi-agent/core'

const run = await traceStore.getRun(result.identity!.runId, { includeRecords: true })
if (run) writeFileSync('run.html', renderRunViewer({ result, run }))
```

`renderTeamRunDashboard(result)` is the older single-argument entry point. It
remains source-compatible and simply calls `renderRunViewer({ result })`; there
is no second renderer behind it.

### Input errors

`buildRunViewerModel(input, options?)` is the same model builder the renderer
calls, exported separately for callers who want the structured
`RunViewerModel` rather than HTML: the summary, tasks, spans, DAG layout,
warnings, and filter vocabularies. Both it and `renderRunViewer` throw
`RunViewerInputError` with a `code` field before rendering anything:

| `code` | Cause |
|---|---|
| `MISSING_SOURCE` | Neither `result` nor `run` was supplied |
| `UNSUPPORTED_SCHEMA_VERSION` | The `StoredRun` does not carry trace schema major 2 |
| `RUN_ID_MISMATCH` | `result.identity.runId` and `run.runId` name different runs |

Problems in the data itself are not errors. Absent result detail, absent trace
detail, a run with no task graph, and a dependency graph that contains a cycle
each become a `RunViewerWarning` that the page displays, so degraded input is
visible rather than silently rendered as success. A cyclic graph falls back to a
stable list layout instead of a DAG.

## What the page shows

The header reports status, completeness, run identity, duration, attempts,
tokens, costs, agents, models, and providers, for whichever of those the input
recorded. DAG and waterfall selection are synchronized by task ID, and search
plus kind/status/agent/task filters preserve ancestor context.

When routing data is present, a summary above both views shows the selected
mode, the source and reasons for that choice, and the actual `ExecutionReceipt`
evidence. Result and combined modes build that receipt with
[`buildExecutionReceipt(result)`](observability.md#execution-receipts) rather
than keeping a viewer-specific topology model. A trace-only view has no result
to derive a receipt from, so it summarizes the materialized viewer tasks and
labels that evidence trace-derived.

## CLI

Two `oma` paths write the same page without any application code. Both are
specified in [the CLI reference](cli.md#oma-dashboard), including output
paths, overwrite behavior, stdout/stderr split, and exit codes.

```bash
# Capture and render the run being executed
oma run --goal "..." --team team.json --dashboard

# Export one previously persisted FileTraceStore run
oma dashboard --trace-store ./.oma/traces.ndjson --run-id <runId> --output run.html
```

`oma run --dashboard` attaches a capture sink to the run, materializes the
records it collected, and renders result plus trace. When identity or capture is
unavailable it falls back to result-only data and reports a warning on stderr
rather than failing the run. `oma dashboard` reads one run out of an existing
`FileTraceStore`, renders it trace-only, and always closes the store; it never
appends, deletes, compacts, or applies retention.

## Privacy boundary

The generated HTML contains its own CSS, JavaScript, and data, and loads no
remote scripts, stylesheets, fonts, images, telemetry, or runtime API.

The embedded payload is built from an explicit allowlist, not from raw span
attributes. It carries no prompts, completions, tool arguments, tool results,
messages, task descriptions or results, reasoning content, or arbitrary
attributes. The whole model, waterfall layout included, then passes through the
same sensitive-value redaction utility the trace processors use before it is
serialized into the page.

That boundary covers telemetry only. Checkpoints and shared memory are not
redacted by it; see
[the default privacy boundary](observability.md#default-privacy-boundary).

## Runnable example

```bash
npx tsx packages/core/examples/integrations/observability-v2/run-viewer.ts
```

[`run-viewer.ts`](../packages/core/examples/integrations/observability-v2/run-viewer.ts)
writes `oma-dashboards/run-viewer-demo.html` through a real `FileTraceStore`
export. Its records are explicitly fictional deterministic demo data: the
example performs no model call, tool execution, network request, or
OpenTelemetry registration.
