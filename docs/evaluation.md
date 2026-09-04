# Evaluation

The `@open-multi-agent/core/eval` subpath measures agent and multi-agent quality
offline or through best-effort online sampling. Evaluation observes completed
results; it never changes the business result.

Use runtime verification and evaluation for different jobs:

| | `runConsensus()` / per-task `verify` | Evaluation |
|---|---|---|
| When | During one business run | Offline in batches or asynchronously after a live run |
| Changes the business result | Yes: may accept, revise, or reject | No |
| Measures | One result | Cases, versions, regressions, and trends |
| Failure meaning | Affects the runtime verdict | Produces `scorer_error`; never becomes score zero |
| Output | `ConsensusResult` | `EvalRecord`, `EvalRunReport`, and `GateVerdict` |

The two mechanisms compose: verification protects a single run, while an
EvalSet can detect changes in verification pass rate over time.

## Scorers

```ts
import { defineScorer, type ScorerContext } from '@open-multi-agent/core/eval'

const exact = defineScorer({
  name: 'exact-match',
  version: '1',
  score({ output, evalCase }) {
    const hit = output === evalCase.expected
    return { score: hit ? 1 : 0, pass: hit }
  },
})

const context: ScorerContext = {
  evalCase: { id: 'capital-france', input: 'Capital of France?', expected: 'Paris' },
  output: 'Paris',
  metadata: { promptVersion: 'v2' },
  signal: new AbortController().signal,
}

const result = await exact.score(context)
console.log(result.score) // 1
```

Scores must be finite numbers from `0` through `1`. `pass` is optional so a later gate can apply its own threshold. `defineScorer()` freezes the scorer definition and validates both synchronous and asynchronous results. A scorer may omit `version`, but OMA warns once per scorer name because a gate then cannot distinguish scoring-logic drift from target drift. Bump the version whenever a rule, prompt, judge model, or judge configuration changes.

## Scorer failures are not zero scores

A scorer that throws, rejects, or exceeds its timeout has not measured quality. `runEvalSet()` records that outcome as an `EvalRecord` with `status: 'scorer_error'`, normalizes the error, continues to later scorers, and excludes the failure from score averages, percentiles, and pass rates. Do not replace scorer failures with `{ score: 0 }`.

If the target itself throws, the sample produces one `target_error` record under the reserved scorer name `_target`; its scorers do not run. The eval subpath also defines the `EvalRecord` shape and schema major version.

### Reference scorers

Reference scorers are deliberately small examples, not universal quality
standards. Import them from `@open-multi-agent/core/eval`:

| Factory | Score meaning | Required data and missing-data behavior |
|---|---|---|
| `toolCallSuccessScorer()` | Successful tool spans / all tool spans | Uses trace status when available. A result-only `ToolCallRecord` has no error flag, so completed result calls are treated as successful. No calls returns `1` with `details.tool_calls = 0` and an explicit not-applicable reason. |
| `structuredOutputComplianceScorer(schema?)` | `1` when `AgentRunResult.structured` exists and, when supplied, passes the Zod schema | Intended only for targets whose agent config has `outputSchema`. Missing structured output is a measured failure (`0`), not missing infrastructure. |
| `costBudgetScorer({ maxTokens?, maxCostAmount? })` | Hard step: `1` within every observable ceiling, otherwise `0` | Tokens come from the OMA result; cost comes from `StoredRun.costs`. Unavailable dimensions are named in `reason` and `details.data_complete`; no observable dimension returns `1` with `applicable: false`. Multiple currencies throw and become `scorer_error` instead of being added incorrectly. |
| `dependencyUtilizationScorer()` | Completed dependency-bearing task spans / all dependency-bearing task spans | Requires a trace. This is a conservative dependency-chain completion proxy; it proves linked prerequisites and the dependent task completed, not that the model semantically used prerequisite text. |
| `duplicateWorkScorer({ threshold? })` | `1 - duplicatePairs / comparedPairs` | Requires both a trace and `TeamRunResult`. Trace identifies task IDs; actual outputs come from `agentResults`. Similarity is Jaccard over normalized character trigrams. Fewer than two outputs returns explicit not-applicable `1`. |
| `noProgressScorer({ maxStallTurns? })` | `1` within the allowed consecutive stalls; above it, `maxStallTurns / observedMaximum` | Requires a trace. A stall is a failed task-agent attempt with LLM work, no tool call, and no completed task. This measures agent attempts, not semantic reasoning turns. |
| `createAnswerRelevancyScorer({ judges, ... })` | Mean judge score for direct relevance to input and expected output | Thin `createJudgeScorer()` wrapper with a fixed `{ score, reason }` schema. Treat it as a prompt template to version and validate against your own data. |

The three structure-aware scorers expose behavior specific to a multi-agent DAG,
but remain privacy-aware: traces do not persist task output bodies. Dependency
utilization and no-progress therefore use honest structural proxies, while
duplicate-work reads outputs from the in-memory `TeamRunResult` and uses the
trace only to select task executions. Use these three with offline
`runEvalSet(..., { traceStore })`; online sampling does not load a trace for a scorer.

```ts
import {
  createAnswerRelevancyScorer,
  toolCallSuccessScorer,
} from '@open-multi-agent/core/eval'

const scorers = [
  toolCallSuccessScorer(),
  createAnswerRelevancyScorer({
    version: 'relevancy-prompt-v1',
    judges: [{ name: 'judge', model: 'claude-sonnet-4-6', provider: 'anthropic' }],
  }),
]
```

## Quick start: offline evaluation in five minutes

```ts
import {
  defineEvalSet,
  defineScorer,
  runEvalSet,
  type EvalTarget,
} from '@open-multi-agent/core/eval'

const set = defineEvalSet({
  name: 'greetings',
  version: '1.0.0',
  cases: [
    { id: 'a', input: 'hi', expected: 'HI', tags: ['upper'] },
    { id: 'b', input: 'yo', expected: 'YO', tags: ['upper'] },
  ],
  defaults: { concurrency: 2 },
})

const target: EvalTarget = async (input) => ({
  output: String(input).toUpperCase(),
})

const exact = defineScorer({
  name: 'exact',
  version: '1',
  score({ output, evalCase }) {
    const pass = output === evalCase.expected
    return { score: pass ? 1 : 0, pass }
  },
})

const report = await runEvalSet(set, target, {
  scorers: [exact],
  repeats: 2,
  metadata: { prompt_version: 'v2' },
})

console.log(report.records.length)          // 4
console.log(report.aggregates[0]?.avg)      // 1
console.log(report.aggregates[0]?.passRate) // 1
```

`defineEvalSet()` validates non-empty names, versions, and cases; requires case IDs to be unique; and returns a deeply frozen copy. Treat `version` as the content version and bump it whenever cases change. `filterTags` selects cases matching any requested tag. `repeats` and `concurrency` override the set defaults.

Each case/repeat target runs once, then that sample's scorers run serially. Different samples run in parallel up to `concurrency` (default `2`). Aborting stops new samples from being scheduled, waits for already-started samples, and returns a partial report with `aborted: true`.

Report percentiles use the nearest-rank method. For two sorted scores, p50 is the lower score and p95 is the higher score. `passRate` only includes scored records that explicitly contain `pass`; scorer errors are excluded from every score denominator. `byTag` repeats the same aggregation for each case tag. Target token usage is counted once per sample, even when multiple scorers run, and costs are summed only within the same currency.

## Sample production runs online

Online evaluation is opt-in on `OpenMultiAgent`. A settled top-level run only
performs a synchronous sampling decision and bounded queue admission; scorers
and store writes run later and never change the business result.

```ts
import { OpenMultiAgent } from '@open-multi-agent/core'
import {
  InMemoryEvalStore,
  defineScorer,
} from '@open-multi-agent/core/eval'

const onlineStore = new InMemoryEvalStore()
const lengthScorer = defineScorer({
  name: 'length',
  version: '1',
  score({ output }) {
    const length = String(output).length
    return { score: Math.min(1, length / 200), pass: length >= 40 }
  },
})

const orchestrator = new OpenMultiAgent({
  evaluation: {
    scorers: [lengthScorer],
    sample: 0.05,
    maxConcurrent: 1,
    maxQueueLength: 100,
    budget: { maxEvaluationsPerMinute: 30 },
    store: onlineStore,
  },
})

const run = await orchestrator.runAgent(agent, prompt)
// The business result does not wait for lengthScorer or onlineStore.
console.log(run.success)

await orchestrator.evaluation.forceFlush({ timeoutMs: 1_000 })
const page = await onlineStore.query({ runId: [run.identity!.runId] })
console.log(page.items[0]?.source) // online
```

`runAgent`, `runTeam`, `runTasks`, `runFromPlan`, `runConsensus`, and `restore`
all use the same evaluator owned by the `OpenMultiAgent` instance. Its
`evalRunId` therefore remains stable for that instance lifetime. Each sampled
run produces one `EvalRecord` per scorer with `source: 'online'`, no EvalSet or
case ID, and a `runRef` containing the exact logical run and attempt.
For structured `runAgent()` input, the evaluator receives a defensive copy of
the caller's `LLMMessage[]`; string calls retain their existing string input.
Payload omission, bounding, redaction, and persistence still follow
`storePayloads` below.

Numeric sampling uses `Math.random() < sample`. A rule can select by normalized
status and validated run metadata without implementing tail sampling:

```ts
const failuresOnly = new OpenMultiAgent({
  evaluation: {
    scorers: [lengthScorer],
    sample: (context) =>
      context.status.code !== 'ok'
      && context.metadata['deployment'] === 'canary',
    store: onlineStore,
  },
})
```

A throwing sampling rule is treated as `false` and diagnosed. A scorer throw,
rejection, or timeout produces a `scorer_error` record. A rejected store append
drops that sample's record batch. Queue overflow, exhausted budgets, callbacks,
and all evaluation failures are isolated from the original run result.

Online defaults are deliberately conservative: evaluation is off when the
configuration is omitted or `sample` is `0`; `maxConcurrent` is `1`,
`maxQueueLength` is `100`, payload persistence is `none`, diagnostics warn at
most once per code per 60 seconds, and there is no implicit rate or cost cap.
`diagnostics: 'silent'` must be explicit. `getStats()` returns cumulative
`sampled`, `enqueued`, `completed`, `dropped`, `failed`, and `storeFailed`
counts.

`maxEvaluationsPerMinute` counts scorer evaluations, so one sampled run with
three scorers consumes three units. `maxCostPerHour` uses the caller's existing
`OrchestratorConfig.estimateCost` function and the model usage surfaced by
framework-backed scorers such as `createJudgeScorer`. The cap uses the same
caller-defined unit returned by `estimateCost`, can overshoot by currently
running scorer work, and resumes as the rolling hour advances. Rule scorers
without model usage cost zero. Custom model-backed scorers cannot be costed
unless they use a framework scorer that reports its internal usage. Configuring
`maxCostPerHour` without `estimateCost` leaves the cap inactive and emits one
payload-free warning; it never silently blocks runs.

`storePayloads: 'none'` gives scorers a content-free run-input description and
does not persist input or output. `'redacted'` gives scorers and the record a
bounded, redacted input string and persists a bounded, redacted output;
`'full'` does the same without redaction and must be an explicit privacy
decision. Scorers always receive the candidate output in memory so they can
score it. In particular, a judge scorer sends that output to its configured
model provider; do not enable an external judge for data that may not leave its
trust boundary.

### Lifecycle ownership

The application owns evaluator lifecycle. OMA installs no signal handlers and
does not call `process.exit()`. All evaluator timers are unreferenced, so they
do not keep a CLI or serverless process alive. This also means a process crash
or natural exit can lose queued work: the first implementation is in-process,
best-effort, and intentionally not durable. A durable or cross-process scoring
queue is a separate future integration, not an `EvalStore` guarantee.

```ts
// Serverless/FaaS: flush this invocation; keep a shared singleton usable.
const result = await orchestrator.runAgent(agent, prompt)
const evaluation = await orchestrator.evaluation.forceFlush({ timeoutMs: 1_500 })
return { result, evaluation: evaluation.status }

// Short-lived CLI: settle accepted samples before natural process exit.
try {
  await main()
} finally {
  await orchestrator.evaluation.forceFlush({ timeoutMs: 5_000 })
  await orchestrator.evaluation.shutdown({ timeoutMs: 5_000 })
}

// Long-lived server: stop traffic, then drain and close on graceful shutdown.
async function stopServer() {
  await stopAcceptingAndWaitForInflight(server)
  await orchestrator.evaluation.forceFlush({ timeoutMs: 10_000 })
  await orchestrator.evaluation.shutdown({ timeoutMs: 10_000 })
  await provider?.shutdown()
}
// Register stopServer with your server/process framework if desired.
```

`forceFlush()` waits for the samples accepted before its watermark and returns
`ok`, `partial`, `timeout`, or `error` plus cumulative counts. `shutdown()`
atomically rejects new samples, flushes its cutoff, and is idempotent: repeated
or concurrent calls share the first result. `OpenMultiAgent.shutdown()` remains
the existing team-registry reset; evaluator shutdown is explicit through
`orchestrator.evaluation`.

On the online-evaluation maintainer benchmark (Node 22, 50,000 same-process direct
admissions), sampling plus bounded enqueue measured approximately `0.42 µs`
p95 (`0.30 µs` mean) on the implementation host. Absolute microseconds vary by
host; CI additionally retains the existing observability same-host regression
gate for the unconfigured path.

## EvalStore

Use `InMemoryEvalStore` for short-lived local runs, tests, or an adapter
prototype. Pass it to `runEvalSet()` to persist one atomic batch per completed
case/repeat sample:

```ts
import {
  InMemoryEvalStore,
  runEvalSet,
} from '@open-multi-agent/core/eval'

const store = new InMemoryEvalStore()
const storedReport = await runEvalSet(set, target, {
  scorers: [exact],
  store,
})

const first = await store.query({
  evalRunId: storedReport.evalRunId,
  scorer: ['exact'],
  order: 'time_asc',
  limit: 100,
})
```

`EvalStore.append()` is atomic per batch and idempotent by `recordId`. Queries
can filter by evaluation run, referenced OMA run, EvalSet name, scorer, source,
status, and inclusive `after` / exclusive `before` timestamps. Results use the
stable `(timestampUnixMs, recordId)` order. The default page limit is 100 and
the maximum is 1,000.

Cursors are opaque snapshots. Appends after the first page do not create gaps
or duplicates in that pagination sequence. A cursor is valid only for the same
store instance and normalized query; changing filters, deleting records, or
reopening a file store invalidates it. Do not parse or persist cursors as data.

The optional `InMemoryEvalStore({ maxRecords })` capacity is a hard limit. A
batch that would exceed it is rejected atomically. Use retention explicitly
when eviction is intended:

```ts
await store.applyRetention({
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxRecords: 10_000,
  sources: ['offline'],
})

await store.delete({
  evalSetName: 'greetings',
  before: new Date('2026-01-01T00:00:00.000Z').toISOString(),
})
```

Deletion and retention are idempotent. In their shared `DeleteResult`,
`runIds` contains affected `evalRunId` values, `runsDeleted` counts distinct
affected evaluation runs, and `recordsDeleted` counts records. A `sources`
retention scope applies both age and count limits only to those sources; when it
is the only field, all records in the selected sources are deleted.

For durable local storage, import the Node-only implementation separately:

```ts
import { FileEvalStore } from '@open-multi-agent/core/eval/file'

const fileStore = await FileEvalStore.open('./eval-results/history.ndjson', {
  onDiagnostic(diagnostic) {
    console.warn(diagnostic.code, diagnostic.message)
  },
})

await fileStore.append(storedReport.records)
await fileStore.flush()
await fileStore.compact()
await fileStore.close()
```

`FileEvalStore` is a single-process reference implementation, not a production
database or a cross-process coordination layer. It keeps an append-only,
schema-versioned NDJSON mutation log and rebuilds its in-memory index on open.
A committed batch is visible in full or not at all; a process or machine crash
can lose at most the last, not-yet-durable batch. `flush()` is the explicit
fsync boundary. Recovery truncates only an incomplete final line or batch and
emits a diagnostic; complete corruption fails loudly.

Compaction writes `<file>.compact.tmp`, fsyncs it, atomically renames it over the
target, and then fsyncs the parent directory where supported. A stale temp file
never overrides an existing target. Use a database-backed `EvalStore` adapter
when multiple processes, large data volumes, or server-side aggregation are
required.

Stores preserve unknown fields within the supported schema major so future
minor additions survive a round trip. A higher `schemaVersion` major is
rejected rather than downgraded. There is intentionally no aggregation method
on `EvalStore`: calculate trends from queried records in memory. Needing
aggregation pushdown is a signal to introduce a database adapter, not to add
file-specific concepts to the interface.

Persistence is fail-open for the evaluation run. If a sample batch cannot be
stored, `runEvalSet()` still returns its complete records and aggregates and
adds one payload-free entry to `report.warnings` for that sample.

## Evaluate OMA runs

Use the convenience targets when the system under evaluation is an OMA agent, team, or fixed plan:

```ts
import { Team, type AgentConfig, type PlanArtifact } from '@open-multi-agent/core'
import {
  targetFromAgent,
  targetFromPlan,
  targetFromTeam,
} from '@open-multi-agent/core/eval'

declare const agent: AgentConfig
declare const team: Team
declare const plan: PlanArtifact

const agentTarget = targetFromAgent(agent, {
  metadata: { prompt_version: 'v2' },
})
const teamTarget = targetFromTeam(team)
const planTarget = targetFromPlan(team, plan)

void agentTarget
void teamTarget
void planTarget
```

Agent and team targets convert non-string input with `String(input)` and use it as the prompt or goal. Plan targets replay the supplied `PlanArtifact`; the plan fixes the tasks and goal. These wrappers return the OMA result alongside the primary output, inject `eval_case` and one-based `eval_repeat` run metadata, and add available model/provider fingerprints. The runner uses the result identity for `runRef` and the result usage for report totals. When `traceStore` is provided, it also loads the matching `StoredRun` into `ScorerContext.trace`.

Record metadata merges in this order, with later values winning: case metadata, `runEvalSet()` metadata, then metadata echoed by a convenience target (including its configuration fingerprint).

## Load EvalSets and write reports

File I/O is isolated in the Node-only `@open-multi-agent/core/eval/file`
subpath. The root package and `@open-multi-agent/core/eval` do not import this
entry point.

```ts
import {
  loadEvalReport,
  loadEvalSet,
  loadGatePolicy,
  writeEvalReport,
} from '@open-multi-agent/core/eval/file'

const setFromJson = await loadEvalSet('./evals/greetings.json')
const fileReport = await runEvalSet(setFromJson, target, { scorers: [exact] })

await writeEvalReport(fileReport, { format: 'json', path: './report.json' })
await writeEvalReport(fileReport, { format: 'markdown', path: './report.md' })
await writeEvalReport(fileReport, { format: 'junit', path: './report.junit.xml' })

const policy = await loadGatePolicy('./evals/gate.json')
const baseline = await loadEvalReport('./evals/baseline.json')
```

`loadEvalSet()` parses JSON, applies the same validation and deep freezing as
`defineEvalSet()`, and includes the resolved file path plus the first schema
issue in validation errors. `writeEvalReport()` creates parent directories as
needed and supports:

- `json`: the authoritative, pretty-printed `EvalRunReport` representation.
- `markdown`: metadata, scorer and tag aggregates, failed samples, and totals
  for human review. Long failure reasons are truncated.
- `junit`: one testcase per record. `pass: false` becomes `<failure>`;
  `scorer_error` and `target_error` become `<error>`; records without `pass`
  and without an error are successful testcases. XML names and messages are
  fully escaped.

`loadGatePolicy()` and `loadEvalReport()` validate their schema-versioned JSON
contracts and report the resolved file path plus the first invalid field. Loaded
objects are defensively copied and deeply frozen.

## Run evaluations from the CLI

After building or installing the package, a no-network target can be evaluated
from a shell or CI job:

```bash
oma eval run --set ./evals/greetings.json --target ./evals/target.mjs \
  --report json --report junit --out ./eval-results \
  --gate ./evals/gate.json --baseline ./evals/baseline.json \
  --meta prompt_version=v2
```

The target module must default-export an `EvalTarget` function or
`{ target, scorers? }`. An optional `--scorers` module default-exports a
`Scorer[]`; scorer names must be unique across both sources. The CLI dynamically
imports and executes these user modules with the current process permissions,
so they must be trusted.

Reports are written below `<out>/<evalRunId>/`; `--out` defaults to
`./eval-results`. `--report` is repeatable and defaults to JSON. `--meta
key=value` is also repeatable and all values are strings. See
[the CLI reference](cli.md#oma-eval-run) for the complete argument and exit-code
contract.

Without `--gate`, low scores and `pass: false` records do not change the exit
code. With `--gate`, the stdout summary includes the verdict and its path, and
the exact `{ pass, failures, warnings }` object is written to
`<out>/<evalRunId>/verdict.json`. A failed gate or every selected target failing
exits 1. Usage/file/module errors exit 2. `--baseline` requires `--gate`.

## Gate quality in CI

`evaluateGate()` is pure logic exported from `@open-multi-agent/core/eval`:

```ts
import { evaluateGate } from '@open-multi-agent/core/eval'

const verdict = evaluateGate(report, {
  schemaVersion: 1,
  thresholds: [
    // A rule scorer plus passRate=1 is a deterministic quality gate.
    { scorer: 'exact', metric: 'passRate', min: 1 },
    { scorer: 'relevancy', metric: 'avg', min: 0.8 },
    { scorer: 'relevancy', metric: 'p50', min: 0.85, tag: 'critical' },
  ],
  maxScorerErrorRate: 0.1,
  maxTargetErrorRate: 0,
  baseline: {
    maxRegression: 0.05,
    perScorer: { exact: 0 },
  },
}, baseline)

if (!verdict.pass) process.exitCode = 1
```

The equivalent JSON policy is:

```json
{
  "schemaVersion": 1,
  "thresholds": [
    { "scorer": "exact", "metric": "passRate", "min": 1 },
    { "scorer": "relevancy", "metric": "avg", "min": 0.8 },
    { "scorer": "relevancy", "metric": "p50", "min": 0.85, "tag": "critical" }
  ],
  "maxScorerErrorRate": 0.1,
  "maxTargetErrorRate": 0,
  "baseline": {
    "maxRegression": 0.05,
    "perScorer": { "exact": 0 }
  }
}
```

Thresholds support `avg`, `p50`, `p95`, `min`, and `passRate`, with optional
tag scoping and inclusive `min`/`max` boundaries. A missing scorer, tag, or
`passRate` source is a configuration failure rather than a silent pass. The
health defaults fail when scorer errors exceed 10% of scored plus scorer-error
records, or when any selected target fails.

Every verdict contains only `pass`, `failures`, and `warnings`. A failure has a
stable `kind`, optional scorer/metric/tag coordinates, the observed `actual`,
the configured `limit`, and a human-readable `message`. For failures about
availability rather than a measured score, `missing_scorer` uses `actual: 0`
and `limit: 1`, while `baseline_mismatch` uses `actual: 1` and `limit: 0`.

A baseline is an ordinary JSON `EvalRunReport`, not a second file format. The
recommended workflow is:

1. Run the accepted target with `--report json` and copy its `report.json` to a
   reviewed location such as `evals/baseline.json`.
2. Commit that report together with its versioned EvalSet and gate policy.
3. In CI, compare the candidate report with `--baseline`.
4. Update the baseline only after intentionally reviewing and accepting the
   behavior change; the CLI never updates it automatically.

Set name or version mismatches fail by default. Set
`baseline.allowSetMismatch` to `true` only when a warning plus skipped
regression checks is intended. When a scorer version differs, OMA warns and
skips that scorer's regression checks because a changed judge prompt or model
does not produce a comparable score. Threshold and health checks still run.
If baseline rules are configured but no baseline report is supplied, OMA warns
and skips regression checks.

Use `oma eval gate` when report generation and quality enforcement are separate
CI stages. It prints the exact verdict JSON to stdout:

```bash
oma eval gate --report ./candidate/report.json --gate ./evals/gate.json \
  --baseline ./evals/baseline.json
```

A GitHub Actions job can preserve both machine-readable reports while letting
the gate control the step status:

```yaml
- name: Run deterministic evaluation gate
  run: |
    oma eval run --set ./evals/set.json --target ./evals/target.mjs \
      --gate ./evals/gate.json --baseline ./evals/baseline.json \
      --report json --report junit --out ./eval-results || exit 1

- name: Upload evaluation JUnit report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: evaluation-junit
    path: eval-results/**/report.junit.xml
```

## Routing stability regression EvalSet

The frozen `run-team-routing-stability@1.0.0` EvalSet in
`packages/core/tests/fixtures/eval/routing-stability-set.json` measures whether
equivalent `runTeam()` goals keep the same executed topology when prompt length
or language changes. Each family contains short and detailed English variants
plus Chinese, Japanese, and Korean translations. Governance families carry the
same `governanceIntent: 'required'`,
`requiredRoles`, and `requiredOrder` declaration on every variant; benign
families carry no declaration.

The test injects one deterministic `LLMAdapter` into every worker and the
coordinator. Every model call returns the same fixed text, including a valid
two-role coordinator plan. It also injects a valid low-risk `TaskProfiler`
fixture for benign Single candidates and fails the test unless Hybrid profiling
finishes with `outcome: 'applied'`; the gate therefore cannot pass by silently
falling back from invalid profile output. The suite makes no network request
and needs no API key. Within one family, the goal text is therefore the only
routing input that changes. The measured topology comes from
`buildExecutionReceipt(result)` and the `result.tasks` short-circuit marker, and
contains only:

- `single-short-circuit` versus task graph;
- the worker roles that actually executed; and
- cross-role dependency edges.

Model output, generated task IDs, timing, token usage, and scheduler start order
are excluded. For `n` variants, flip rate is the number of unordered variant
pairs with different canonical topologies divided by `n * (n - 1) / 2`.
Length invariance compares the fixture's short/detailed English pair; language
invariance compares its explicitly paired English/Chinese variants.

`packages/core/tests/fixtures/eval/routing-stability-gate.json` applies three
absolute thresholds to the `governance` tag: routing-stability minimum `1`
(zero flips), length-invariance minimum `1`, and language-invariance minimum
`1`. It also gates benign routing-stability at `0.95` (at most 5% pair flips);
benign length/language submetrics remain monitored. Scorer and target error
limits are both zero. The existing CI `npm test` matrix blocks a change that
makes a declared route depend on goal language or length or pushes benign
topology flips over the limit. A negative-control test injects a fake declared
router that collapses Chinese variants to one role and asserts that both the
routing-stability and language-invariance thresholds fail.

The current snapshot below is emitted in the test's `[routing-stability]`
EvalSet report:

| Family | Pair flips | Flip rate | Length invariant | Language invariant |
|---|---:|---:|---:|---:|
| Declared wire transfer | 0 / 10 | 0% | 100% | 100% |
| Declared key rotation | 0 / 10 | 0% | 100% | 100% |
| **Declared governance total** | **0 / 20** | **0%** | **100%** | **100%** |
| Undeclared DNS | 0 / 10 | 0% | 100% | 100% |
| Undeclared database comparison | 0 / 10 | 0% | 100% | 100% |
| **Undeclared benign total** | **0 / 20** | **0%** | **100%** | **100%** |

The target for undeclared benign routing is at most 5% pair flips and at most
5% length mismatches (at least 95% length invariance). Update the frozen corpus
version and the documented snapshot only after reviewing an intentional
measurement change.

## Semantic routing policy EvalSet

`packages/core/tests/fixtures/eval/semantic-routing-set.json` freezes the V1
Hybrid policy contract independently from provider behavior. It covers short
independent-evidence and independent-review goals, permission isolation,
consequential side effects, conflicting objectives, ordinary short and long
single-task negatives, equivalent Chinese/Japanese/Korean goals, and a
prompt-injection sample.

Each fixture contains a reviewed `TaskProfile`, framework-computed facts, and
the expected deterministic recommendation. CI validates the strict profile
schema and requires every fixture to match exactly. This proves Policy behavior
without treating one provider's current classification as the semantic
contract. Real-provider E2E is limited to checking that the one-call Profiler
integration can produce a valid profile; it is not the sole routing oracle.

Shadow evaluation belongs in CI and canary release work, not the public runtime
default. Before promoting a major release, measure the reviewed end-to-end
corpus against these gates:

- zero false-Single results on critical cases;
- at least 95% reviewed routing accuracy;
- at most 1% invalid/failed Profiler outputs;
- median Profiler token overhead no greater than 5% of representative total
  usage; and
- P95 end-to-end latency regression no greater than 10%.

### Running the real-provider Shadow gate

`packages/core/tests/e2e/semantic-routing-shadow.test.ts` runs the reviewed
synthetic corpus through the actual `LLMTaskProfiler`, then applies the same
deterministic policy that Hybrid routing uses. It is skipped unless
`SEMANTIC_ROUTING_SHADOW=1` is set, executes no workers or tools, and does not
send user data. The profiler uses the shipping `LLMTaskProfiler` default of 800
output tokens per fixture, so the canary validates the production contract. The
optional `SEMANTIC_ROUTING_SHADOW_BASE_URL` and
`SEMANTIC_ROUTING_SHADOW_REGION` values map to the selected adapter; Bedrock
uses its normal AWS credential chain instead of the API-key variable.

For DeepSeek V4, the built-in profiler explicitly uses non-thinking mode: this
is a bounded JSON classification call, and DeepSeek otherwise enables thinking
by default. The production route and this gate use the same setting.

Set credentials only in your local shell or CI secret store; never paste a key
into a command, repository file, or test log. For example, map an existing
local provider secret without printing it:

```bash
export SEMANTIC_ROUTING_SHADOW=1
export SEMANTIC_ROUTING_SHADOW_PROVIDER=openai
export SEMANTIC_ROUTING_SHADOW_MODEL=gpt-4o-mini
export SEMANTIC_ROUTING_SHADOW_API_KEY="$OPENAI_API_KEY"
npm run test:semantic-routing-shadow -w @open-multi-agent/core
```

The report contains only provider/model identifiers, aggregate accuracy,
failure and mismatch case IDs, P95 profiler latency, and aggregate token use.
It deliberately omits goals, inferred reasons, raw model output, and all
configuration secrets. The executable gate enforces zero invalid profiles,
zero critical false-Single outcomes, and at least 95% reviewed routing
accuracy. Record the output as release evidence. Measure the remaining
end-to-end token and latency regression gates in the production-shadow canary
before declaring a provider/model supported for Hybrid routing.

Historical success rates, online adaptive learning, and Team-to-Single
optimization require separately versioned evaluation, monitoring, and rollback
and are not part of V1.

## Memory evaluation metrics

`MemoryExtractionSample` and `MemoryRetrievalSample` are experimental input
shapes for future memory scorers; this release adds no memory runtime and no
automatic memory writer. The following metrics can be implemented with existing
rule or judge scorers:

| Stage | Metric | Definition |
|---|---|---|
| Extraction | Yield | Valid extracted records relative to conversation, token, latency, or monetary cost. Report raw counts beside any ratio. |
| Extraction | Duplicate and conflict rate | Share of records that repeat, contradict, or add no durable information. Rule checks can catch exact duplicates; semantic conflict needs a versioned judge. |
| Extraction | Staleness annotation rate | Share of time-sensitive records carrying enough provenance or expiry information to identify staleness risk. |
| Extraction | Scope leakage | Private content written into team scope. This is a safety gate: any non-zero leakage fails. |
| Extraction | Cost and reasons | Extraction latency and tokens, plus the distribution of skipped and merged reasons. |
| Retrieval | Relevance | Judge score between the query and retrieved records. Version the rubric and judge configuration. |
| Retrieval | Omission | Available positive records that should have been returned but were not. |
| Retrieval | Pollution | Run the same case with and without retrieved memory; a lower primary score after injection is harmful pollution. |
| Retrieval | Added cost | Extra tokens and latency caused by retrieval and prompt injection. |

Automatic extraction or consolidation should not be enabled by default until it
passes both a versioned offline EvalSet gate and online sampling. Scope leakage
is always a hard safety gate, independent of average quality.

## Privacy

EvalSet cases may contain private user data. `storePayloads` therefore defaults to `'none'`, so records contain scores, reasons, metadata, and run references but no input/output snapshots. `'redacted'` serializes each payload field, caps it at 8 KiB, and applies OMA's existing secret redaction. `'full'` keeps the serialized text without redaction but still applies the 8 KiB cap; opt into it only for data you are prepared to retain. A model-based judge necessarily sends the evaluated output to the configured judge model regardless of record payload storage.

## Reproducibility and the absence of a seed

OMA's current provider contract has no cross-provider seed parameter or LLM response recording. Adding a seed to `EvalSet` would therefore promise determinism the framework cannot provide. Use `repeats` to sample nondeterministic behavior and compare the aggregate statistics. `targetFromPlan()` fixes the orchestration plan, but model responses can still vary.

## Use OMA agents as judges

```ts
import { z } from 'zod'
import { createJudgeScorer } from '@open-multi-agent/core/eval'

const relevancy = createJudgeScorer({
  name: 'relevancy',
  version: 'prompt-v1',
  judges: [
    { name: 'judge-a', model: 'claude-sonnet-4-6', provider: 'anthropic' },
    { name: 'judge-b', model: 'gpt-5', provider: 'openai' },
  ],
  quorum: 2,
  timeoutMs: 30_000,
  verdictSchema: z.object({
    score: z.number().min(0).max(1),
    pass: z.boolean(),
    reason: z.string(),
  }),
})

const result = await relevancy.score(context)
console.log(result.score, result.pass)
```

Judge scores are averaged. When the verdict schema returns a boolean `pass`, the scorer returns `pass: true` after the configured quorum is reached. The default verdict schema contains only `score` and `reason`, so the default result leaves `pass` undefined.

`result.details.judges`, `result.details.models`, and `result.details.scores` are parallel arrays: values at the same index describe one judge. This flat representation remains compatible with trace attribute values while preserving model-drift evidence. Bump the scorer `version` whenever judge models, configuration, or prompts change.

### Judging non-text output

`judgePrompt` runs once per judge and may return a plain string (wrapped into the
standard text prompt, as above) or a complete `readonly LLMMessage[]` — see
[structured input](structured-input.md) for the message/content-block shape. The
per-judge form lets a mixed roster (a cheap text-only judge alongside an
expensive vision-capable one) each receive input suited to what they can
actually score. `AgentConfig.capabilities` is the caller-declared signal for
this — OMA does not infer it, so an unset judge falls back to whatever content
its own `judgePrompt` branch decides to send:

```ts
import { z } from 'zod'
import { buildStructuredOutputInstruction } from '@open-multi-agent/core'
import type { ImageBlock, LLMMessage } from '@open-multi-agent/core'

const verdictSchema = z.object({
  score: z.number().min(0).max(1),
  pass: z.boolean(),
  reason: z.string(),
})

/**
 * The newest image the run produced. A tool-produced artifact arrives as an
 * image part nested inside a `tool_result` block rather than as a top-level
 * image block, and only its base64 variant can be replayed into judge input.
 */
function latestImage(messages: readonly LLMMessage[]): ImageBlock | undefined {
  for (const block of messages.flatMap((message) => message.content).reverse()) {
    if (block.type === 'image') return block
    if (block.type === 'tool_result' && typeof block.content !== 'string') {
      for (const part of [...block.content].reverse()) {
        if (part.type === 'image' && part.source.type === 'base64') {
          return { type: 'image', source: part.source }
        }
      }
    }
  }
  return undefined
}

const artifactQuality = createJudgeScorer({
  name: 'artifact-quality',
  judges: [
    { name: 'vision-judge', model: 'claude-sonnet-4-6', capabilities: ['vision'] },
    { name: 'text-judge', model: 'gpt-5' },
  ],
  quorum: 2,
  verdictSchema,
  judgePrompt(context, judge) {
    const supportsVision = judge.capabilities?.includes('vision') ?? false
    const image = context.result && 'messages' in context.result
      ? latestImage(context.result.messages)
      : undefined
    const outputInstruction = buildStructuredOutputInstruction(verdictSchema)

    if (supportsVision && image) {
      return [{
        role: 'user',
        content: [
          { type: 'text', text: 'Rate how well this chart matches the request.' },
          image,
          { type: 'text', text: outputInstruction },
        ],
      }]
    }

    return [{
      role: 'user',
      content: [
        { type: 'text', text: `Rate this candidate output: ${String(context.output)}` },
        { type: 'text', text: outputInstruction },
      ],
    }]
  },
})
```

When `judgePrompt` returns messages, the caller owns the complete input. OMA
passes those messages through unchanged: it does not add the standard case
template or a verdict-schema instruction. Append
`buildStructuredOutputInstruction(verdictSchema)` to every branch that returns
messages so the judge is instructed to emit JSON that `createJudgeScorer` can
parse.

Locating the artifact is the caller's job too: `ScorerContext` exposes the run
transcript, not a produced artifact. Only content the caller passed into the run
appears as a top-level image block. A scorer that searches those alone silently
judges the run's own input image, or drops to its text branch with no image at
all when the run took no image input. Search nested `tool_result` content as
well, as `latestImage` above does.

A judge that fails on content it cannot handle fails the whole `score()` call —
`createJudgeScorer` has no per-judge failure isolation. Give every non-vision
judge a working fallback branch rather than relying on the framework to skip it.

## FAQ

### Should a scorer error count as zero?

No. It means quality was not measured. OMA records `scorer_error`, excludes it
from score denominators, and lets gate health limits decide whether the
evaluation infrastructure is reliable enough.

### Why did a baseline scorer comparison produce a warning?

Candidate and baseline scorer versions differ, or one side omitted the scorer.
OMA still applies absolute thresholds and health checks, but skips an invalid
apples-to-oranges regression comparison. Review the scorer change and create a
new accepted baseline intentionally.

### Can evaluation delay or fail the business response?

Offline evaluation is a separate call. Online evaluation performs only a
synchronous sampling and bounded-queue decision after the run settles; scoring
and persistence are best-effort and isolated. Call `forceFlush()` when the host
must wait for accepted samples before exit.

### Does `targetFromPlan()` make an LLM run deterministic?

It fixes the task graph and avoids another coordinator decomposition. Model
responses can still vary because OMA has no cross-provider seed contract. Use
`repeats` and compare distributions.

### Where can I see complete examples?

Run `examples/patterns/eval-offline-regression.ts` for a no-key two-target gate
or `examples/patterns/eval-online-sampling.ts` for `FileEvalStore` lifecycle.
