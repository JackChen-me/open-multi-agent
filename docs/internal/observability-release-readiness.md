# Observability v2 release-readiness record

This is the auditable OBS-5 contract, failure-injection, packaging, and release
note record. It does not publish packages, create a tag, or create a GitHub
Release. Performance numbers live in
[`observability-performance.md`](./observability-performance.md); adoption and
cutover steps live in
[`observability-migration.md`](../observability-migration.md).

Baseline: `6339ee50515e149eb1fb5a073f44024d3ab821a3`, including PR #384.

## Public contract source of truth

| Contract | Public surface | Implementation source | Primary evidence |
|---|---|---|---|
| `RunIdentity` | core root types | `types.ts`, `observability/identity.ts` | `observability-v2-identity.test.ts`, checkpoint tests |
| `RunStatus` / `errorInfo` / compatible `success` | core root types/results | `types.ts`, `observability/status.ts` | identity and span suites |
| `TraceRecord` v2 | core root and `/observability` | `observability/records.ts`, `runtime.ts` | `observability-v2-spans.test.ts` |
| `TraceSink` | core root and `/observability` | `observability/sink.ts` | sink lifecycle suite |
| `TraceExporter` | core root and `/observability` | `observability/sink.ts` | sink lifecycle suite |
| `BatchingTraceSink` | core root and `/observability` | `observability/batching.ts` | sink lifecycle suite and benchmark |
| `CompositeSink` | core root and `/observability` | `observability/composite.ts` | composition failure tests |
| `FilteringSink` | core root and `/observability` | `observability/processors.ts` | filter/privacy tests |
| `SensitiveDataProcessor` | core root and `/observability` | `observability/processors.ts` | default privacy tests |
| `LegacyCallbackTraceSink` | core root and `/observability` | `observability/legacy-callback.ts` | seven-shape fidelity and direct migration tests |
| `InMemoryTraceStore` | core root and `/observability` | `observability/in-memory-store.ts` | reusable TraceStore contract suite |
| `TraceStoreExporter` | core root and `/observability` | `observability/store-exporter.ts` | exporter retry/idempotency tests |
| `FileTraceStore` | `/observability/file` only | `observability/file-store.ts` | reusable contract + file/recovery suite |
| `@open-multi-agent/otel` | separate package root | `packages/otel/src` | official in-memory exporter suites |
| `forceFlush` / `shutdown` | `TraceSink`; OTel sink | batching/composite/legacy/OTel implementations | concurrency, timeout, reentry suites |
| diagnostics / stats | sink and file-store types | `sink.ts`, `file-store.ts` | payload-free diagnostic and counter tests |
| checkpoint/restore identity | top-level run results and checkpoint v4 | `memory/checkpoint.ts`, `identity.ts`, orchestrator | v1/v2/v3 read, v4 continuation, runId-conflict tests |

The public contract is the exported type plus the implementation and its tests.
The private design RFC is historical rationale, not a substitute for current
package exports. A contract redesign discovered here must be a separate
follow-up; OBS-5 only permits narrow correctness and compatibility fixes.

## Responsibility boundaries

| Component | Owns | Does not own |
|---|---|---|
| Dashboard | static post-run task DAG artifact | live delivery, durable state, trace query |
| TraceStore | best-effort TraceRecord append/query/delete/retention | authoritative run state, CAS, lease, resume |
| CheckpointStore | safe-boundary execution snapshots used by `restore()` | telemetry retention or trace query |
| Future RunStore | authoritative durable run state machine | implemented by this release |
| OTel adapter | mapping OMA records to spans/events/links | global provider setup, SDK/exporter choice, collector, provider ownership |

## Failure-injection matrix

`Automated` means a committed test runs in the Node 20/22/24 `npm test` CI
matrix. `Runnable` is a no-network example exercised by the package CI job.
`Manual` is an external condition and is not represented as passed.

| Failure | Status | Evidence / expected result |
|---|---|---|
| pre-abort | Automated | identity + span suites: `cancelled`, not success; spans close |
| in-flight abort | Automated | identity + span suites: `cancelled`; no open lifecycle |
| whole-run timeout | Automated | identity + span suites: `timeout`, distinct from caller abort |
| budget exhaustion | Automated | identity + span suites: `budget_exhausted` |
| provider error | Automated | provider 401/429/500 classification and span closure |
| callback sync throw | Automated | legacy suites; callback failure isolated and counted |
| callback async reject | Automated | legacy suites; no unhandled rejection; flush reports failure |
| exporter reject | Automated | batching suite; bounded retry/failure stats |
| exporter hang | Automated | export signal aborted at timeout; business work unaffected |
| partial export | Automated | delivered prefix counted; permanent/retryable suffix semantics |
| bounded retry | Automated | retry count and unexported suffix assertions |
| queue record overflow | Automated | priority drop and cumulative stats |
| queue byte overflow | Automated | byte bound and cumulative stats |
| oversize record | Automated | rejected before acceptance; payload-free diagnostic |
| concurrent `forceFlush` | Automated | independent watermarks complete without lost records |
| shutdown timeout/reentry | Automated | shared idempotent result; later emit dropped and diagnosed |
| diagnostic handler throw | Automated | swallowed without recursion or business failure |
| OTel span start/event/end failure | Automated | record-specific result and diagnostic codes |
| OTel incomplete/out-of-order records | Automated | marked incomplete; duplicate/orphan diagnostics; no throw |
| File write failure | Automated | memory/disk rollback; structured payload-free error |
| File fsync failure | Automated | `flush()` rejects; no durability success claim |
| File rename failure | Automated | original target remains authoritative and usable |
| trailing partial line | Automated | diagnosed and truncated to last committed boundary |
| uncommitted batch | Automated | entire batch invisible after recovery |
| middle-file corruption | Automated | open fails loudly; later valid data is not silently replayed |
| compaction interruption | Automated | stale temp policy and original-target authority |
| SIGTERM graceful shutdown | Runnable | explicit application handler; stop intake, flush, shutdown |
| FaaS flush timeout | Runnable | invocation receives `timeout`; shared singleton is not shut down |
| hard process/OS crash | Manual | start-only spans may remain incomplete; filesystem durability is limited by last fsync |

Across automated cases, telemetry failure does not alter Agent/Task/Run business
results, does not create unhandled rejections, and is visible through a result,
stats, or payload-free diagnostic. Hard process termination is the explicit
exception to guaranteed span closure.

## Privacy and security evidence

The default path is verified end to end, not only documented:

- `observability-v2-privacy.test.ts` runs a deterministic agent and tool through
  `BatchingTraceSink → TraceStoreExporter → InMemoryTraceStore`, then proves the
  prompt, completion, tool arguments, tool result, `<thinking>`, and reasoning
  content are absent while numeric usage remains.
- `otel-exporter.test.ts` proves the OTel allowlist excludes prompt,
  completion, tool payload, raw request/payload, credentials, and reasoning
  content while preserving eligible token counts.
- sink tests prove structured secret fields and reasoning content are removed
  before delivery, and diagnostic handler failures are isolated.
- file tests prove `0600` on POSIX, payload-free corruption errors, and
  structured write/fsync/rename failures.
- legacy trace tests preserve the historical, broader behavior: redacted tool
  input/output remains available to `onTrace` and the legacy bridge.

Trace privacy does not redact checkpoint or shared-memory payloads. That data
plane requires a separately configured `RedactingStore` where appropriate.

## Package and version compatibility decision

The already-published `@open-multi-agent/core@1.10.0` predates the public
Observability v2 sink/store APIs. It cannot satisfy the OTel adapter and must
not be included in the adapter's compatible range.

Decision:

- first core release containing the complete Observability v2 public API:
  `@open-multi-agent/core@1.11.0`;
- first adapter release: `@open-multi-agent/otel@0.1.0`;
- adapter core dependency: `^1.11.0`;
- starter templates are prepared to pin core `1.11.0`;
- no new versioning system is introduced.

This is an additive feature set, so a core minor is appropriate. The OTel
adapter remains on its independent `0.x` line. The package boundary is based on
module ownership, optional installation, provider lifecycle, and compatibility—not
on a permanent count of core dependencies. Any new dependency must justify
security, install size, maintenance, and compatibility cost; unused optional or
platform-specific SDKs should remain outside eager root imports when useful.

## Tarball and consumer smoke contract

`scripts/observability-tarball-smoke.mjs` builds real `npm pack` tarballs and
installs them into clean temporary consumers:

1. **core only** — imports core, `/observability`, and
   `/observability/file`; runs in-memory and file stores without installing
   OTel;
2. **core + OTel** — installs the core and OTel tarballs plus official OTel API
   and SDK dependencies; reconstructs parent hierarchy, link resolution, and
   error status with `InMemorySpanExporter`; flushes and shuts down explicitly;
3. **minimum declared core** — proves core `1.11.0` contains every symbol used
   by OTel and that the manifest range is exactly `^1.11.0`.

The same script always tests the current core tarball in scenario 2. Once the
repository advances beyond `1.11.x`, CI can pass a separately obtained
`OMA_OBSERVABILITY_MIN_CORE_TARBALL` for scenario 3 while scenario 2 continues
to smoke the higher current version.

Tarball checks allow only `dist/`, `README.md`, `LICENSE`, and `package.json`,
verify every export target exists, and keep tests, source, examples, and
benchmarks out. Core source/package tests also prevent OTel references from
entering core and keep the FileTraceStore implementation behind
`/observability/file`. The core root is already Node-oriented and reaches
`node:fs` through pre-existing `FileStore` and built-in file-tool exports; OBS-5
does not claim it is browser-safe or attempt an unrelated root-export redesign.

## Draft release notes

### Observability v2

- Stable `runId` / attempt identity and normalized runtime status now appear on
  every top-level runtime result. New result fields stay optional in 1.x TypeScript
  declarations for source compatibility but are present at runtime.
- Caller abort, whole-run timeout, provider failure, budget exhaustion, and
  approval rejection now have distinct outcomes; legacy `success` remains and
  derives from `status.code === 'ok'`.
- Identity-aware checkpoint schemas preserve logical identity across restore,
  increment the attempt, start a new trace, and link to the prior root. Schema
  v1, v2, and v3 remain readable; current v4 writes also carry in-flight runner
  and durable-approval continuation state.
- TraceRecord schema v2 adds start/event/end records, W3C-compatible IDs,
  structured errors, and DAG/delegation/synthesis/restore links.
- `TraceSink`, `TraceExporter`, and `BatchingTraceSink` add bounded queueing,
  partial delivery, retry, diagnostics, `forceFlush`, and idempotent shutdown.
- `InMemoryTraceStore`, `TraceStoreExporter`, and the Node-only
  `FileTraceStore` reference implementation add local query and persistence.
- `@open-multi-agent/otel` is an independently installed adapter for an
  application-owned OpenTelemetry provider.
- `onTrace` remains supported, is not deprecated in this release, and preserves
  all seven existing event shapes and UUID parent relationships.
- V2 content capture is off by default: prompts, completions, tool payloads,
  credentials, and reasoning content are not collected. Legacy `onTrace`
  retains its historical redacted tool payload behavior.
- `FileTraceStore` is a single-process reference store, not a shared database.
  Durability past OS/power failure begins at explicit `flush()`/`close()` fsync.

Release order:

1. publish core `1.11.0`;
2. run a registry-installed core smoke;
3. publish OTel `0.1.0` with core range `^1.11.0`;
4. run the joint registry-installed smoke.

This task prepares and locally validates that sequence. npm publish, tags, and
GitHub Releases remain Manual.

## Final verdict

结论：CONDITIONAL GO

Blocker

- None in the locally testable OBS-5 scope.

Major

- The literal requirement “core root import does not load `node:fs`” is not true
  of the pre-OBS-v2 package: the existing root statically exports `FileStore`
  and built-in file tools. OBS-5 verified the scoped compatibility invariant
  that root and `/observability` do not reach the new FileTraceStore module,
  `/observability` itself does not reach `node:fs`, and
  `/observability/file` does. Accept this existing Node-oriented root boundary
  for 1.11.0 or create a separate root-export/browser-compatibility redesign;
  do not mix that redesign into OBS-5.

Minor

- Clean-consumer installs repeat npm's existing `node-domexception` deprecation
  warning through the current dependency graph; it does not affect the smoke.

Manual

- Current OBS-5 branch GitHub Actions: not run because this task explicitly
  forbids push/PR. Local commands matching the Node 18/20/22 test matrix pass.
- npm permissions and registry publication.
- Post-publish registry install smoke, in the documented core-first order.
- Tag and GitHub Release creation.
- optional real OTLP collector canary.

已验证

- Baseline ancestor check passed at PR #384 merge commit `6339ee5`.
- Public contracts, package exports, private RFC rationale, and PR #371/#373/
  #374/#375/#376/#384 implementation/validation records were audited.
- Legacy bridge direct migration works without also configuring `onTrace`; all
  seven historical shapes and UUID parent behavior remain covered.
- Public migration snippets typecheck; seven no-key examples execute.
- Failure-injection and privacy suites pass, including payload-free diagnostics,
  FileTraceStore `0600`, and actual sink/store/OTel content exclusion.
- Dedicated performance gates pass: no-sink `-0.530%`, additional retained
  `-1.18 B/run`, legacy `0.125 µs`, batch enqueue `1.250 µs`, OTel
  `15.208 µs` p95.
- Core 1.11.0 / OTel 0.1.0 / `^1.11.0` compatibility is locked by manifests,
  tests, starter pins, lockfile, and minimum-version consumer fixture.
- Node 18.20.8, 20.19.4, and 22.22.3 local full matrices each pass: core 1,350,
  create-oma-app 26, OTel 15 tests.
- Root lint, build, dedicated benchmark matrix, tolerant benchmark gate,
  `git diff --check`, both dry-run packs, and real tarball consumer scenarios
  pass.

未验证/风险

- No current-branch remote CI result until a PR is allowed.
- Registry permissions, actual publication, provenance, tag, and GitHub Release
  remain external/manual.
- A real OTLP collector/backend canary is optional; official
  `InMemorySpanExporter` covers adapter semantics locally.
- FileTraceStore remains single-process/reference only; no multi-process or
  network-filesystem guarantee is implied.

下一步

- Accept the documented pre-existing root `node:fs` scope exception.
- Open a PR when authorized and require the normal remote CI matrix to pass.
- Merge OBS-5, publish core 1.11.0, run registry core smoke, then publish OTel
  0.1.0 and run the joint registry smoke.
- Do not publish, tag, or create a GitHub Release from this task.

OBS-5 is locally merge-ready once the root `node:fs` scope exception is
accepted. It is not yet externally release-complete because remote CI and the
manual registry sequence have intentionally not run.
