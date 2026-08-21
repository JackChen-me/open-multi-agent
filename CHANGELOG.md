# Changelog

## Unreleased

## 1.16.1 - 2026-08-21

### Added

- Export eight previously internal public types from the package root
  (ThinkingConfig, ToolResultMetadata, ProcessAgentBackendConfig,
  ProcessBackendInputMode, CostEstimateContext, MessageBusSnapshot,
  MessageSnapshot, MessageReadStateSnapshot)
- Document DeepSeek V4-Pro-0813 / V4-Flash-0731 GA snapshots and default
  thinking at high effort

### Changed

- Accepted verify revisions now refresh structured output together with the
  revised answer instead of leaving stale parsed output
- Slim core package READMEs, move contributor credits to CONTRIBUTORS.md, and
  add LLM egress policy / shell executor coverage to the Chinese READMEs

### Compatibility

- All public API changes are additive: eight new type-only exports from the
  package root
- No public export was removed or narrowed, so existing consumers can upgrade
  without code changes

## 1.16.0 - 2026-08-16

### Added

- Add opt-in `EgressPolicy` (`offline` or `allowlist`) that restricts
  framework-owned LLM network requests and intersects run-, agent-, and
  orchestrator-level scopes.
- Add pluggable `ShellExecutor` / `LocalShellExecutor` so callers control where
  the built-in `bash` tool runs, exposed via the new
  `@open-multi-agent/core/shell` subpath export.
- Add `StructuredOutputValidationError`, which marks persistent schema failures
  after the built-in corrective attempt as terminal for task-level retry.
- Add `EgressPolicyError` with stable codes (`INVALID_EGRESS_POLICY`,
  `EGRESS_POLICY_DENIED`, `EGRESS_POLICY_TARGET_UNRESOLVED`,
  `EGRESS_POLICY_UNSUPPORTED`) for disallowed or unenforceable LLM egress.

### Changed

- The built-in `bash` tool now executes through a configurable shell executor
  with a fail-closed backstop and 127 exit code on execution failure.
- LLM adapters now resolve provider default base URLs and enforce egress policy
  before opening framework-owned requests; policy use is opt-in and preserves
  legacy unrestricted behavior.
- Task retry now respects a result's stable `errorInfo.retryable: false`
  classification.

### Fixed

- Structured-output agents no longer report a late valid response as success
  after their whole-run timeout fired.
- Task retry no longer reruns validation, cancellation, and budget failures when
  the raw in-process error is unavailable.

### Security

- Add framework-owned LLM egress restriction (`EgressPolicy`) that can confine
  provider transports to loopback or an explicit origin allowlist.

### Compatibility

- All core additions are backward compatible: new exports, optional config
  fields, and new error classes; no public export was removed or narrowed and
  the Node engines floor is unchanged.
- Egress policy is opt-in: omitting egressPolicy on run/agent/orchestrator
  config preserves legacy unrestricted LLM egress behavior.
- Shell executor is opt-in: AgentConfig.shellExecutor /
  OrchestratorConfig.defaultShellExecutor default to LocalShellExecutor for the
  built-in bash tool; callers that invoked bashTool.execute() directly now own
  the executor lifecycle and may observe results with exitCode 127 instead of a
  thrown tool error when execution fails.
- StructuredOutputValidationError and EgressPolicyError are now classified as
  non-retryable by isRetryableError and mapped to terminal failure states;
  task-level retry behavior for such failures changes.
- New public surface added in this release: ./shell subpath export
  (LocalShellExecutor, ShellExecOptions, ShellExecResult, ShellExecutor),
  StructuredOutputValidationError, EgressPolicyError, EgressPolicy, and
  egressPolicy/shellExecutor config fields.

## 1.15.0 - 2026-08-09

### Added

- Durable approval gates can suspend plan, round, task-dispatch, and tool-call
  decisions, persist content-bound pending requests and first-wins reviewer
  decisions in a checkpoint `MemoryStore`, and resume only the approved plan,
  task, or validated tool invocation. Missing state, stale hashes, schema drift,
  and tampering fail closed, while derived execution receipts carry the review
  evidence without making telemetry the authoritative record. New checkpoint
  writes use schema version 4 to preserve approval continuation state.
- Checkpoint recovery preserves in-flight built-in runner messages, turn and
  token accounting, pending tool calls, and independently committed tool
  results. Restore replays committed results without re-executing their tools,
  reruns only missing calls, and exposes the stable model-issued `toolCallId`
  to tools and per-call gates for external idempotency.
- `Agent.run()`, `Agent.stream()`, and `OpenMultiAgent.runAgent()` accept
  complete structured message histories. Persistent `Agent.prompt()`
  conversations can accept one structured user turn, including image input,
  with runtime validation, defensive copies, and full-message access in
  `beforeRun`.
- Rich tool results separate application-owned `ToolResult.data` from validated,
  model-visible text, image, and file `modelOutput`. Built-in adapters and MCP
  map supported content explicitly, while runner context, checkpoints,
  recovery, progress, evaluation, and privacy-safe trace summaries preserve the
  richer result.
- `AgentConfig.history` restores persisted conversation messages into a new
  `Agent` so subsequent `prompt()` calls can continue an earlier conversation.

### Compatibility

- Existing string inputs, string/error tool results, and compression markers
  keep their previous behavior. Structured input and rich tool output are
  additive; adapter- and model-specific media limits still apply.
- Checkpoint readers remain compatible with version 1, version 2, and version 3
  snapshots. OMA cannot atomically commit an arbitrary external side effect
  together with its checkpoint write, so consequential integrations still need
  external idempotency for that crash window.
- `runTeam()` and `runTasks()` remain text-only. Process and ACP backends remain
  task-grained and reject structured input rather than silently dropping it.
- Existing approval callbacks can continue returning allow or deny. Suspension
  is additive; task gates with live verification wiring, standalone
  `runAgent()`, the simple-goal shortcut, process backends, and ACP backends do
  not expose every resumable private tool-loop path.
- `@open-multi-agent/otel@0.1.1` is not republished. Its
  `@open-multi-agent/core@^1.11.0` dependency remains compatible with core
  `1.15.0`.

## 1.14.0 - 2026-08-01

### Breaking changes

This release shipped as a minor version, so a caller on a `^1.x` range receives
it without an explicit upgrade step. npm reports an `engines` mismatch as an
`EBADENGINE` warning rather than an install failure, so a Node 18 project
installs 1.14.0 successfully and then fails at run time.

- **Node.js 20 or newer is now required.** The `engines` floor moved from 18 to
  20 across `@open-multi-agent/core`, `@open-multi-agent/otel`, and
  `create-oma-app`. Node 18 reached end of life on 2025-04-30.
- **The bundled `openai` dependency moved from v4 to v6.** A project that also
  depends on `openai` directly resolves a nested second copy until it moves to
  v6 as well.
- **Plans that were previously accepted can now fail at validation time.**
  Invalid task dependency graphs, unsatisfiable task requirements, and invalid
  coordinator plans are rejected before execution instead of running partially.
  Each of these surfaces a defect that was previously silent, so correct graphs
  and rosters are unaffected. The individual entries are under Changed and
  Fixed below.

### Added

- Adaptive plan recovery lets a run revise the not-yet-executed part of its task
  graph. Opt in with `recovery.mode: 'repairable'`, then supply a `Replanner` or
  an `onTaskOutcome` callback that proposes an append-only `PlanPatch`. Patches
  are validated for agent eligibility, limits, task states, references, and the
  resulting DAG, gated through the optional `onPlanPatch` approval, and applied
  atomically at a task-outcome barrier before downstream dispatch or failure
  cascade. Revision history is exposed in results, progress events, and
  observability spans.
- Hybrid semantic execution routing supplements the deterministic router with a
  single structured semantic assessment. Opt in with
  `executionRouting: { strategy: 'hybrid' }`. The release adds a
  provider-neutral `TaskProfiler` interface, a built-in `LLMTaskProfiler`, a
  strict task-profile schema, typed routing failures with timeout and fallback
  metadata, and semantic-routing observability.
- DeepSeek V4 Flash reasoning controls. `AgentConfig.thinking.enabled` now maps
  to DeepSeek's native `thinking.type`, and `thinking.effort` accepts the
  DeepSeek-only value `'max'` without forwarding it to OpenAI, Azure OpenAI, or
  GitHub Copilot.
- `validateTaskRequirements` is exported for callers that want to check task
  requirements against a roster before dispatch.
- New typed errors are exported for the failure modes above:
  `InvalidTaskRequirementsError`, `UnsupportedToolCallError`,
  `RoutingDeclarationRequiredError`, `RoutingProfilerFailedError`, and
  `RoutingTimeoutError`.

### Changed

- On the OpenAI v6 SDK, user aborts are now classified as cancellation rather
  than as a retryable failure, and unsupported custom tool calls are rejected
  explicitly instead of being passed through.
- Task requirements are enforced as global hard constraints. A task whose
  requirements no agent satisfies is now rejected rather than assigned to an
  ineligible agent.

### Fixed

- Invalid task dependency graphs are rejected up front instead of executing a
  partially valid plan.
- The coordinator fails closed on an invalid plan rather than continuing with a
  plan it could not validate.

### Compatibility

- Automatic `runTeam()` routing remains deterministic. Hybrid semantic routing
  is opt-in through `executionRouting.strategy` and does not change existing
  runs.
- Adaptive plan recovery is opt-in. Task graphs stay fixed unless
  `recovery.mode` selects `'repairable'`.
- Adaptive recovery adds a version 2 task-queue snapshot carrying plan-revision
  history. `TaskQueue.fromSnapshot()` still accepts version 1 snapshots, so
  checkpoints written by earlier releases remain restorable.
- Every public export from 1.13.0 is still exported. New result and
  configuration fields remain optional, so existing callers and serialized
  results continue to type-check.

## 1.13.0 - 2026-07-24

### Added

- Execution routing can now be selected explicitly with `mode`, customized
  through `ExecutionRouter`, or left to the built-in `DeterministicRouter`.
  Every `runTeam()` topology choice exposes a structured routing decision and
  trace linkage.
- Structured governance declarations support required or preferred roles,
  ordered review paths, budget-aware degradation, post-execution conclusions,
  and privacy-preserving execution receipts.
- Consequential tools can be declared through `ToolDefinition.consequential`.
  Undeclared runs expose a machine-readable disclosure flag and can opt into
  confirmation through the existing `onToolCall` gate.
- Model routes can declare ordered fallback routes for retryable worker
  provider failures.
- Agents and tasks can declare structured capabilities and hard requirements.
  The scheduler adds `capability-match` and weighted `composite` strategies,
  structured warnings, and optional strict assignee validation.
- `TeamRunResult.taskResults` preserves unmerged results by task ID. Explicit
  tasks can choose raw, structured, or combined dependency payloads and attach
  bounded role/provenance metadata.
- `OrchestratorConfig.onTaskDispatch(task)` provides a native per-task pipeline
  approval gate. It is mutually exclusive with `onApproval`.
- The offline Run Viewer surfaces execution-routing decisions, and Evaluation
  includes a language-neutral routing-stability gate.

### Changed

- Task DAG execution is event-driven by default. A downstream task now starts
  when its dependencies are satisfied instead of waiting for unrelated tasks
  from the same ready set.
- Progress events from independent DAG branches may interleave instead of
  arriving in round-sized groups. Consumers should correlate events by task ID
  and use task status plus `dependsOn` rather than adjacency to derive state.
- Unassigned tasks are scheduled one ready task at a time against the current
  DAG snapshot. Dependency-aware ready-set ordering and existing strategy
  eligibility/fallback contracts are preserved.
- Abort, budget exhaustion, and task-dispatch approval rejection now stop new
  dispatches, drain in-flight work, and then skip remaining tasks.
- Automatic execution routing recognizes structured Chinese, Japanese, and
  Korean goals and uses script-aware information length instead of relying on
  English-only word patterns and raw character count.

### Fixed

- CJK keyword extraction and zero-score fallback no longer select an
  ineligible agent or lose a valid keyword-based match.
- Governed `planOnly` runs validate and return the declared role DAG without
  executing agents.
- Explicit execution modes, governance floors, and per-run token/cost ceilings
  now resolve through a documented precedence order and disclose overrides or
  budget degradation instead of silently changing topology.

### Compatibility

- Configuring the existing `onApproval` callback automatically retains legacy
  round scheduling and callback semantics. A separate
  `legacyBatchScheduling` flag is not provided because `onApproval` already
  selects that compatibility path.
- Custom UIs that depend on round-grouped progress timing can temporarily
  configure `onApproval: async () => true`; event-driven consumers should
  migrate to task-ID correlation.
- Raw dependency output remains the default. Structured dependency handoff,
  governance declarations, consequential confirmation, and custom execution
  routing are opt-in.
- New result fields remain optional in public TypeScript interfaces so older
  serialized results and caller-authored fixtures continue to type-check.
- `@open-multi-agent/otel@0.1.0` is not republished; its
  `@open-multi-agent/core@^1.11.0` dependency remains compatible with core
  `1.13.0`.

## 1.12.1 - 2026-07-20

### Evaluation V1 (#403–#409)

- New `@open-multi-agent/core/eval` and `/eval/file` entry points.
- Define reusable `Scorer` implementations and versioned `EvalSet` fixtures.
- Run deterministic offline evaluations with reports, stores, gates, CLI commands, and reference scorers.
- Sample and score production runs online without changing the business result.

### Offline Run Viewer (#394, #411)

- Open saved results and traces locally without a running service.
- Inspect task-level model, provider, token, and cost information through the viewer and CLI.

### Per-run metadata (#396)

- Top-level run APIs accept bounded metadata that is propagated into results, traces, and checkpoint restores.

### Zero-key onboarding (#414)

- `create-oma-app@0.5.0` can install and run a deterministic Demo without API keys or model requests.
- Demo output clearly discloses simulated model responses and produces Markdown, JSON, and HTML reports.
- New `--no-install` and `--no-run` flags support controlled scaffolding workflows.

### Examples catalog (#412)

- Added a machine-readable examples catalog, schema, and coverage validation.

### Fixes (#390, #417)

- The process backend cleans up descendant processes after the parent exits.
- `v1.12.1` fixes installed `oma` binaries so the CLI launches correctly through npm-created symlinks. This was found during the `v1.12.0` post-publish verification.

### Compatibility

- Existing run modes remain compatible.
- Evaluation is disabled by default, and online evaluation does not change the business result.
- Scorer failures are recorded as `scorer_error` and excluded from score aggregates instead of being counted as zero.
- `@open-multi-agent/otel@0.1.0` is not republished and remains compatible with core `1.12.1`.
- #397, #400, #401, and #402 are behavior-preserving internal extractions, not new public APIs.

### Install

```bash
npm install @open-multi-agent/core@1.12.1
npm create oma-app@latest my-oma
```

## 1.11.0 - 2026-07-17

### Features

- **Observability v2: trace spans and run identity** (#371, #373 by @JackChen-me). Every run now carries a stable `runId`, `attempt`, `traceId`, and `rootSpanId`, and emits the new TraceRecord v2 schema: a proper span tree covering run, coordinator, task, agent, LLM, tool, retry, delegation, consensus, and checkpoint, with DAG, synthesis, and restore relationships expressed as links. The existing seven-field `onTrace` callback keeps working unchanged. See [docs/observability.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md).

- **Observability v2: sink and exporter lifecycle** (#374 by @JackChen-me). The new `@open-multi-agent/core/observability` subpath ships the public `TraceSink` / `TraceExporter` contract plus `BatchingTraceSink` (bounded queue, batched export, backoff retries, priority-aware drop), `CompositeSink`, `FilteringSink`, `SensitiveDataProcessor`, and `LegacyCallbackTraceSink`. Tracing stays metadata-only by default: prompts, completions, tool payloads, credentials, and reasoning content are never captured.

- **Observability v2: trace stores** (#375, #384 by @JackChen-me). A storage-independent `TraceStore` contract (append, get, query, delete, retention) with two references: the zero-dependency `InMemoryTraceStore`, and `FileTraceStore` behind `@open-multi-agent/core/observability/file`, an append-only NDJSON store with crash-safe compaction and explicit flush, close, and diagnostics. FileTraceStore targets local development, tests, CLIs, and modest single-process services.

- **New package: @open-multi-agent/otel 0.1.0** (#376, #385 by @JackChen-me). A separately installable adapter that maps TraceRecord v2 spans onto OpenTelemetry. Its only peer dependency is `@opentelemetry/api ^1.9.0` (npm 7+ installs it automatically), it never initializes or replaces the global `TracerProvider`, and it versions independently of core. It requires core 1.11.0; core 1.10.0 does not contain the v2 APIs. Core itself remains installable and runnable without any OpenTelemetry packages. See [docs/observability-migration.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-migration.md).

- **Per-call tool gate** (#377 by @scarab-systems). Optional `onToolCall` on `AgentConfig` / `OrchestratorConfig` runs after Zod validation and before execution, returning allow or deny per call. A deny becomes a normal error `ToolResult` (never a throw), and a throwing or invalid gate fails closed. Documented with a runnable risk-gated bash example in #383. See [docs/tool-configuration.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md).

- **Generic process backend** (#378 by @scarab-systems). The new `@open-multi-agent/core/process` subpath runs a local command as an agent: protocol-neutral, with stdin or argument prompt delivery, cancellation, and redacted stderr on failure. It complements the existing protocol-aware ACP backend. See [docs/external-agents.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md).

- **Bash command risk classifier** (#382 by @JackChen-me). `classifyBashCommand` behind the `@open-multi-agent/core/classifiers` subpath returns a `safe` / `review` / `high` level with a reason, splitting compound commands and taking the highest risk. It is a dependency-free heuristic meant to pair with the tool gate, explicitly not a security boundary.

- **create-oma-app 0.4.0: production starters** (#370 by @JackChen-me). `npm create oma-app@latest` now offers production-ready `pr-review` and `security` starters alongside `demo`, with cloud or Ollama provider selection. Starters generate Markdown, JSON, and OMA DAG dashboard reports, analyze GitHub strictly read-only, and redact secrets before model analysis.

- **Adaptive customer support recipe** (#386 by @JackChen-me). A new cookbook example where `runTeam` engages only the specialists relevant to each ticket instead of the full roster.

### Fixes

- **Cancelled and timed-out runs no longer report success** (#371 by @JackChen-me). Cancellation and whole-run timeout paths could previously surface as successful results; they now report their real outcome through the normalized `status`.

### Compatibility notes

- `onTrace` remains fully supported and is not deprecated. `LegacyCallbackTraceSink` can now be configured directly as a sink, preserving the seven legacy event shapes without also wiring `onTrace`.
- Results now always include `identity` and `status`. The new fields stay optional in TypeScript for this release, and `success` is still present, derived from `status.code === 'ok'`.
- Dependency ownership is now expressed per package: OpenTelemetry packages belong exclusively to `@open-multi-agent/otel`, and core must stay importable without them.

### Install

```
npm install @open-multi-agent/core@1.11.0
npm install @open-multi-agent/otel@0.1.0   # optional OpenTelemetry adapter, requires core 1.11.0
```

New project: `npm create oma-app@latest` (scaffold updated to create-oma-app@0.4.0, which pins core 1.11.0).

Thanks to @scarab-systems and @JackChen-me.

## 1.10.0 - 2026-07-11

### Features

- **External coding agents over ACP** (#360 by @JackChen-me). OMA can now orchestrate an external coding agent over the Agent Client Protocol as a first-class team member, alongside LLM agents in the same task DAG. Declare an agent with `backend: { kind: 'acp', ... }` and it runs a local coding CLI (for example Claude Code via the official `@agentclientprotocol/claude-agent-acp` adapter) instead of an LLM, sharing the same shared memory, cascade-on-failure, and token budget as any other agent. See [docs/external-agents.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md).

- **Orchestrator cost budget** (#358 by @LambIessz). New `maxCostBudget` and `estimateCost` on orchestrator config let you set a user-defined spend cap. The estimator receives the effective model, provider, phase, and task id so you can price per model, and the cap is enforced across `runAgent`, `runTasks`, `runTeam`, consensus, and synthesis, mirroring the existing token-budget boundaries.

- **Per-agent scoped tool credentials** (#362 by @JackChen-me). New `AgentConfig.credentials` is a per-agent secret bag threaded into `ToolUseContext.credentials`. Tool code reads `context.credentials?.SEARCH_API_KEY` instead of closing a single shared secret over every tool, so each agent holds only the credentials it was assigned. A compromised or misbehaving subagent no longer inherits the coordinator's full access.

- **Secret redaction on the persistence path** (#359 by @JackChen-me). Redaction previously stopped at the observability layer, so a secret an agent emitted into its answer was scrubbed in traces but written in the clear to shared memory and any on-disk checkpoint. The new `RedactingStore`, a `MemoryStore` decorator, redacts values at the single choke point every shared-memory and checkpoint write passes through, and is structure-aware for JSON so checkpoint snapshots stay valid with only secrets masked. Closes #339.

- **MessageBus persisted in checkpoints** (#363 by @LambIessz). Checkpoint and restore now carry MessageBus state (messages and per-agent read position), so a resumed run keeps its inter-agent message history. Live callback subscribers stay process-local and are not serialized. Closes #343.

- **Trace span parent linkage** (#354 by @tlysanhuo). Every trace event now carries a `spanId` and optional `parentId`, with stable agent span ids so LLM and tool spans point to their owning agent span, worker agents link under their task span, and `plan_ready` links under the coordinator decomposition. A team run is now reconstructable as a proper span tree. Closes #340.

### Fixes

- **Windows: kill the full process tree on bash timeout** (#357 by @Bobuyoucrypto). A timed-out `bash` command on Windows now kills its full process tree with `taskkill /T /F` and returns promptly, instead of leaving background children alive and hanging until they exit on their own. Exit codes 124 (timeout) and 130 (abort) are reported authoritatively, and the suite now passes on Windows.

### Install

```
npm install @open-multi-agent/core@1.10.0
```

New project: `npm create oma-app@latest` (scaffold updated to create-oma-app@0.3.1, which pins core 1.10.0).

Thanks to @LambIessz, @tlysanhuo, @Bobuyoucrypto, and @JackChen-me.

## 1.9.0 - 2026-07-03

### Features

- **Durable memory: `FileStore`** (#347 by @JackChen-me). A zero-dependency, filesystem-backed `MemoryStore`, so checkpoint/resume survives a process restart out of the box. Writes are atomic (temp file, fsync, rename) and reads come from an in-memory mirror; a corrupt state file fails loud instead of silently. Until now the only bundled store was `InMemoryStore`, so durability meant writing your own.
- **Error-aware task retry** (#346 by @JackChen-me). Retry (opt-in via `maxRetries > 0`) now classifies failures: `isRetryableError()` skips provably-terminal errors (most 4xx, token-budget, aborted calls) instead of burning attempts, while 429, 5xx, network blips, and per-call timeouts still retry. Adds equal jitter and honors abort signals, on both streaming and non-streaming paths.
- **Per-call LLM timeout** (#344 by @JackChen-me). New opt-in `AgentConfig.callTimeoutMs` (and on `CoordinatorConfig`) bounds a single `adapter.chat()` call, so one stalled request no longer hangs the whole run. Uniform across every adapter and surfaced as `LLMCallTimeoutError`, distinct from a deliberate abort or a real API error. Unset preserves current behavior exactly.
- **Run-level metrics on `TeamRunResult`** (#345 by @lesbass). `TeamRunResult` now carries a `metrics` rollup (total tokens, retries, error/failure/completed counts, and task-latency aggregates) computed from per-task data, and the dashboard renders a matching summary bar.
- **Vercel AI SDK 7 support** (#348 by @JackChen-me). The optional `ai` peer range now spans `^5 || ^6 || ^7`, so you can use the AI SDK bridge on the latest release without peer-dependency warnings. No adapter code changes. The AI SDK 7 bridge needs Node >= 22 (core stays >= 18).

### Docs

- Plan preview and replay guide, surfaced from both READMEs (#349 by @JackChen-me).

### Install

```
npm install @open-multi-agent/core@1.9.0
```

New project: `npm create oma-app@latest`

Thanks to @lesbass and @JackChen-me.

## 1.8.1 - 2026-06-27

Patch release with two install/runtime fixes.

### Fixes

- **`defaultModel` now reaches every agent, not just the coordinator.** Previously `OrchestratorConfig.defaultModel` only applied to the coordinator pass. Workers, `runAgent`, delegated, and consensus agents never inherited it, so it was effectively dead for executing agents. They now inherit `defaultModel` the same way they already inherited `defaultProvider`, `defaultBaseURL`, and `defaultApiKey`. `AgentConfig.model` becomes optional in an orchestrated run; a standalone `new Agent()` still requires an explicit model and throws a clear error if it is missing. (#323)
- **Vercel AI SDK v6 is now supported.** The optional `ai` peer range widened from `^5.0.0` to `^5.0.0 || ^6.0.0`, so installs that pair the framework with AI SDK v6 (for example via `@ai-sdk/react@3`, which pulls `ai@6`) no longer fail with ERESOLVE. The adapter works against both majors. (#324)

### Docs

README and examples cleanups: clearer out-of-the-box vs peer-install provider guidance, a one-click Vercel deploy starter link, corrected example run paths after the reorg, and Ecosystem additions. (#320–#322, #325–#331)

---

Also republishes `create-oma-app@0.2.1` (template pin bumped to core `1.8.1`).

## 1.8.0 - 2026-06-19

### Features
- **Checkpoint and resume** (#294 by @mvanhorn, #314 by @JackChen-me). A long run can now survive a crash or restart. Persist progress to any `MemoryStore` with `checkpoint: true` on `runTeam` / `runTasks` / `runFromPlan`, then resume with `orchestrator.restore(...)`. On resume, `runTeam` re-runs coordinator synthesis so you still get a final answer, and checkpointing into the team's own shared-memory store no longer re-serializes the whole store per task.
- **Consensus verification reaches runTeam** (#301 by @nuthalapativarun). The per-task judge loop from 1.7.0 now applies to coordinator-generated tasks. Pass the judges with `RunTeamOptions.verifyJudges`, and the coordinator opts a task in with `verify: true` or a partial config.
- **Native reasoning round-trip on Bedrock** (#302 by @nuthalapativarun). Extended-thinking blocks round-trip through Bedrock's signature protocol with full fidelity, moving `echoesReasoning` from `never` to `own-issued`.

### Fixes
- Dashboard: the run details panel is back to a right-hand sidebar on desktop instead of stacking under the canvas (#308 by @JackChen-me).

### Onboarding and examples
- `npm create oma-app` scaffolds a runnable multi-agent demo in one command (#305, #306 by @JackChen-me).
- The full-app examples run end to end on a single DeepSeek key (#311 by @JackChen-me).
- New consensus pattern example (#297 by @nuthalapativarun).

### Install
npm install @open-multi-agent/core@1.8.0

New project: npm create oma-app@latest

Thanks to @mvanhorn, @nuthalapativarun, and @JackChen-me.

## 1.7.0 - 2026-06-15

### ⚠️ Breaking: built-in tools are now opt-in / default-deny (#289 by @JackChen-me)

A no-tools agent used to receive every built-in implicitly, including an
unsandboxed `bash`. Tool output flows back to the model, so under prompt
injection that was a remotely triggerable exec + exfiltration path. Built-in
tools (`bash`, `file_*`, `grep`, `glob`, `delegate_to_agent`) now need a
positive grant: with neither `tools` nor `toolPreset` set, an agent resolves to
zero.

Migrating:
- One-line restore of the old allow-all: `defaultToolPreset: 'full'` on `OrchestratorConfig`.
- Or grant per agent via `tools` / `toolPreset`.
- Custom tools (`customTools` / `addTool`) are unaffected: registration is the grant, and `disallowedTools` is still honored.

### Features
- **Consensus / adversarial verification** (#280 by @CodingBangboo). `runConsensus()` runs proposers against judges, plus an optional per-task `verify` hook that puts a task's own result through the same judge loop.
- **Deterministic model routing** (#286 by @cat0825). Opt-in `modelRouting` sends different orchestration calls (coordinator, synthesis, workers, delegated) to different models by match rules, without mutating your team config. Also fixes routing being bypassed on pooled agents.
- **MiniMax-M3 is the new default** (#292 by @octo-patch). Up to a 1M-token context (512K guaranteed) with image input. M2.7 and `MiniMax-M2.7-highspeed` stay available if you pin them explicitly.

### Docs
- Model routing guide: `docs/model-routing.md`, linked from both READMEs (#293 by @JackChen-me).
- TencentDB-Agent-Memory integration cookbook under `examples/` (#295 by @JackChen-me).
- LiteLLM added to the OpenAI-compatible providers table (#283 by @RheagalFire).

### Install
npm install @open-multi-agent/core@1.7.0

Thanks to @CodingBangboo, @cat0825, @octo-patch, and @RheagalFire. Extra thanks to @CodingBangboo, who landed the consensus primitive (#280) and has been a steady reviewer this cycle.

## 1.6.0 - 2026-06-06

### Features
- Replay persisted team plans, so a previously decomposed plan can be re-run without a new coordinator pass (#285 by @cat0825)
- Add a Tencent Hunyuan provider adapter (#281 by @KaitlynFeng)
- Add a robust regex fallback for malformed single-string JSON tool calls from local models (#269 by @apollo-mg)

### Fixes
- Validate message content at every adapter entry, surfacing a clear InvalidMessageError instead of a deep `content.some is not a function` crash (#288 by @JackChen-me, implementing the fail-fast approach @apollo-mg diagnosed in #268)
- Preserve memoryScope and retry config when a plan is replayed (#287 by @JackChen-me)
- Support structured shared-memory handoff between agents (#284 by @cat0825)

### Internal
- Extract a shared repairToolArgs helper across the OpenAI-compatible adapters (#282 by @JackChen-me)
- Add unit tests for the error types (#290 by @Oxygen56)

### Docs
- Move the Ecosystem section above Examples in the README (#277 by @JackChen-me)

### Install
npm install @open-multi-agent/core@1.6.0

Thanks to @KaitlynFeng, @apollo-mg, @cat0825, and @Oxygen56.

## 1.5.0 - 2026-05-30

### Features

- **Per-agent filesystem sandbox** (#264 by @JackChen-me). `file_read/file_write/file_edit/grep/glob`
  now resolve every path, symlinks included, inside each agent's `cwd`, defaulting to
  `<cwd>/.agent-workspace`. `bash` stays unsandboxed. Behavior change below.
- **Cross-provider reasoning text fallback** (#260 by @MyPrototypeWhat). `preserveReasoningAsText`
  carries reasoning across providers that can't echo native reasoning blocks, as inline
  `<thinking>` text instead of dropping it. Phase 2 of #223.
- **MiMo provider** (#265 by @kidoom).
- **Doubao (Volcengine) provider shortcut** (#261 by @kidoom, #236 by @janelawrence). Target
  Doubao models without custom `baseURL` wiring.
- **DeepSeek V4 default model names** (#250 by @JackChen-me). Behavior change below.

### Fixes

- **Secrets redacted from traces, bash output, and dashboard payloads** (#263 by @JackChen-me).
  API keys and tokens no longer leak into observability surfaces.
- **MCP: dedupe normalized tool names, clean up client/transport on connect failure**
  (#256 by @JackChen-me).
- **Orchestrator honors `abortSignal` before synthesis and rejects ambiguous task deps**
  (#255 by @JackChen-me).
- **Loop detector replays history and warns on text-only loops** (#254 by @JackChen-me).
- **DeepSeek echoes `reasoning_content` on V4 tool-calling** (#251 by @JackChen-me).

### Behavior changes

- **Filesystem tools sandbox to `<cwd>/.agent-workspace` by default** (#264). Agents that read or
  wrote outside `process.cwd()`, or used relative paths, now get a sandbox error. Set
  `OrchestratorConfig.defaultCwd` (or `AgentConfig.cwd`) to your root, `process.cwd()` for the old
  wide default, or `null` to disable. `bash` is not sandboxed.
- **DeepSeek CLI default is now `deepseek-v4-flash`** (#250). Affects the `oma` CLI run without
  `--model`; library users are unaffected (no hardcoded default in the adapter). `deepseek-chat`
  and `deepseek-reasoner` keep routing until DeepSeek retires them on 2026-07-24.

### Package metadata

- **`docs/` no longer ships in the npm tarball.** README links now point to the GitHub copy, so
  they always track the latest version. If you read docs from
  `node_modules/@open-multi-agent/core/docs/` (uncommon), switch to the GitHub URLs.

### Examples and docs

- Provider examples: Moonshot (#259), Qwen (#257), and an index of existing ones (#258), all by
  @goodneamtakenbydogs.
- Bilig WorkPaper MCP integration example (#247 by @gregkonush).
- README restructured with built-in capabilities surfaced and zh synced (#273 by @JackChen-me),
  CLAUDE.md slimmed to a code map (#274 by @JackChen-me), integrations governance README replacing
  the stale DECISIONS.md (#248 by @JackChen-me).
- Tests and CI: DeepSeek tool-calling via `chat()` and `stream()` (#252 by @btroops), OpenAI
  adapter fallback assertions (#253), CI on `npm ci` (#262), and a CI check asserting the npm
  tarball ships only `dist/` plus metadata.

### Install

```
npm install @open-multi-agent/core@1.5.0
```

Thanks to @kidoom, @janelawrence, @MyPrototypeWhat, @goodneamtakenbydogs, @btroops, and @gregkonush.

## 1.4.2 - 2026-05-24

Drop-in safe patch: three opt-in additions and three new examples. All new APIs default to off.

### New (opt-in)

- **`RunTeamOptions.revealCoordinator`** (#245 by @JackChen-me). When `true`, prepends a team-context block (goal, full roster, this worker's assignee identity) to every worker prompt under `runTeam`. Default `false` keeps existing prompts byte-identical. `runTasks` and the short-circuit single-agent path ignore it. Closes #244.
- **`enableReasoningTextReplay`** (#234 by @matthewYang08). Opt-in replay of framework `reasoning` blocks as inline `<thinking>` text on OpenAI-family requests, capped by `maxReasoningReplayChars` (default 1200). Also closes a latent 400 against OpenAI when a reasoning-only assistant message emitted `{content: null}` with no `tool_calls`. Refs #223.
- **`ReasoningBlock.provenance` + `LLMAdapter.capabilities`** (#243 by @MyPrototypeWhat). Phase 1 of #223: additive IR fields, per-adapter `echoesReasoning: 'never' | 'own-issued'` declarations, and a shared `reasoningBlockToInlineText` helper. No behavior change yet; Phase 2 wires `capabilities` into the outbound fallback.

### Examples

- Doubao (ByteDance) provider example via Volcengine Ark (#232 by @nuthalapativarun).
- Zhipu GLM provider example (#231 by @nuthalapativarun).
- Narrative puzzle hint arbitration cookbook: 5-agent multi-source conflict resolution with external safety veto (#235 by @suans4746-del). Closes #212.

### Documentation

- `compressToolResults` and `maxToolOutputChars` documented in the context management guide (#233 by @nuthalapativarun).

### Install

`npm install @open-multi-agent/core@1.4.2`

Thanks to @MyPrototypeWhat, @nuthalapativarun, @matthewYang08, and @suans4746-del.

**Full Changelog:** https://github.com/open-multi-agent/open-multi-agent/compare/v1.4.1...v1.4.2

## 1.4.1 - 2026-05-18

Patch release: two bug fixes for OpenAI-family adapters and the runner, plus Vercel AI SDK as an optional adapter. The previous npm package (`@jackchen_me/open-multi-agent`) is now formally deprecated.

### Bug fixes
- **OpenAI-family adapters: guard `choices[0]` with optional chaining** (#220). Prevents crashes when providers return empty `choices` arrays. Thanks @dvirarad.
- **Runner: defer `maxTokenBudget` break until after `tool_result` is appended** (#221). Fixes orphaned `tool_use` blocks when the token budget is hit mid-turn. Thanks @CodingBangboo.

### New (optional)
- **Vercel AI SDK adapter** via the dedicated `@open-multi-agent/core/ai-sdk` subpath (#229). Bridges `LLMAdapter` to AI SDK's `generateText` / `streamText`. Optional peer dep `ai`; main import is unaffected if you don't use it. Thanks @ibrahimkzmv.

### Documentation
- MiniMax provider community offer and setup guide (#219).
- Label hero GIF as post-run replay (#222).

### Deprecation
- The previous npm package, `@jackchen_me/open-multi-agent`, is now formally deprecated. Existing installs continue to work; new installs should use `npm install @open-multi-agent/core`. The npm CLI shows a deprecation message automatically.

**Full Changelog:** https://github.com/open-multi-agent/open-multi-agent/compare/v1.4.0...v1.4.1

## 1.4.0 - 2026-05-09

### Highlights

#### Official org package

Open Multi-Agent now has an official organization package:

```bash
npm install @open-multi-agent/core
```

New projects should use `@open-multi-agent/core`.

#### Plan-only orchestration

Adds PlanOnly mode so teams can inspect the coordinator's task DAG before running agent work. (#203 by @CodingBangboo)

#### LLM adapter improvements

- Preserve reasoning blocks across Anthropic and Gemini turns. (#205 by @MyPrototypeWhat)
- Forward `reasoning_effort` and backfill sampling-parameter parity across OpenAI-compatible, Copilot, and Azure paths. (#209 by @MyPrototypeWhat)
- Add a Mistral provider example and README entry. (#206 by @mvanhorn)

#### Shared memory TTL

SharedMemory entries can now expire by turn count. (#213 by @MyPrototypeWhat)

### Fixes

- Keep text-tool extraction depth non-negative when a stray closing brace appears. (#217 by @voidborne-d)
- Fix truncation behavior and tighten coordinator dependency guidance. (#215 by @CodingBangboo)

### Examples and Docs

- Add paper replication triage cookbook example. (#202 by @DaiMao-UT)
- Add rare disease information triage example. (#211 by @oooooowoooooo)
- Refresh README, hero animation, badges, docs, and repository links for the new GitHub organization. (#214 and #218 by @JackChen-me)

### Compatibility

No intentional runtime API breaks were introduced. The package identity changed to `@open-multi-agent/core`.

The previous package path, `@jackchen_me/open-multi-agent`, remains supported during the migration window and is also published at `1.4.0`.

### Install

```bash
npm install @open-multi-agent/core@1.4.0
```

Legacy path during the migration window:

```bash
npm install @jackchen_me/open-multi-agent@1.4.0
```

## 1.3.1 - 2026-05-02

### Features

#### Streaming reasoning events
`StreamEvent` now supports a `reasoning` type that carries the model's thinking tokens in real time. `ReasoningBlock` is also added to the `ContentBlock` union for non-streaming paths. Supported on Anthropic and OpenAI providers. (#174 by @SiMinus)

#### `onAgentStream` and `onPlanReady` hooks
Two new orchestrator hooks (runTeam only): `onAgentStream` delivers real-time per-token streaming events during agent runs, and `onPlanReady` fires after the coordinator decomposes the goal into a task DAG -- return `false` to abort before any agent work starts. (#182, #181 by @tizerluo; #184, #183 by @JackChen-me)

#### Agent Observation Pipeline: new trace events
`plan_ready` and `agent_stream` trace events join the trace pipeline, enabling downstream observers to react to plan generation and streaming agent output. (#188 by @ibrahimkzmv)

#### AWS Bedrock adapter
New LLM adapter for Amazon Bedrock, supporting the full adapter contract (chat + stream). (#194 by @CodingBangboo)

#### ToolCallTrace includes input/output
`ToolCallTrace` now carries the tool's input and output payloads, making it useful for debugging and audit without inspecting the raw conversation. (#124 by @MyPrototypeWhat)

### Fixes

- Strip image blocks before summarize compression to avoid ballooning token cost. (#196 by @MyPrototypeWhat)
- Preserve `tool_use`/`tool_result` pairing during sliding-window truncation, fixing orphaned tool blocks. (#193 by @MyPrototypeWhat)
- `onAgentStream` path now forwards the full `RunOptions` into the streaming runner so `onTrace`, delegation, and run metadata work during streaming. (#184 by @JackChen-me)
- `onPlanReady` abort path now reports the real coordinator token cost instead of zero, and catches thrown callbacks. (#183 by @JackChen-me)

### Examples

- Express customer support pipeline: multi-agent triage, routing, and resolution. (#191 by @CodingBangboo)
- Personalized interview simulator: dynamic question generation with structured output. (#189 by @mmjwxbc)
- Incident postmortem DAG: reconstruct timeline from logs and deploys. (#187 by @binghuaren96)

### Docs

- README capability tagline, per-area contributor attribution, and a JSDoc fix. (#190, #186, #180 by @JackChen-me)

### Install

```bash
npm install @jackchen_me/open-multi-agent@1.3.1
```

Thanks to @SiMinus, @tizerluo, @ibrahimkzmv, @CodingBangboo, @MyPrototypeWhat, @mmjwxbc, and @binghuaren96 for the external contributions.

## 1.3.0 - 2026-04-26

### New capabilities

#### Agent delegation
Agents in an orchestrated run can now hand a sub-prompt to another agent on the team and receive its final output as a tool result. Opt-in via `registerBuiltInTools(registry, { includeDelegateTool: true })`. Five guards: self-delegation, unknown agent, cycle detection, configurable depth cap (`maxDelegationDepth`, default 3), and pool deadlock. Delegated runs' token usage rolls into the parent's `maxTokenBudget` so sub-agents cannot silently bypass it. (#123 by @JackChen-me)

#### `runTeam` DAG dashboard CLI
`oma runTeam ... --dashboard` writes a static HTML view of the resolved task graph after a run, including dependencies and per-task status. (#122 by @ibrahimkzmv, follow-up docs in #141 by @JackChen-me)

#### `outputSchema` enforcement and `defineTool` passthrough
The previously advisory `outputSchema` on `AgentConfig` is now enforced: results are parsed and validated, with one retry on validation failure. `defineTool` schemas pass through to the LLM provider. (#149 by @Xin-Mai)

#### Pluggable shared memory
`TeamConfig.sharedMemoryStore` accepts any `MemoryStore` implementation (Redis, SQLite, your own). `sharedMemory: true` keeps the existing in-process default. (#157 by @JackChen-me)

#### Advanced LLM sampling
`top_p`, `top_k`, `repetition_penalty`, `min_p`, and `extraBody` are now first-class on agent and coordinator configs. Payload spread order is fixed so `extraBody` overrides sampling parameters but never transport. (#163 by @apollo-mg)

#### `parallelToolCalls` exposed for OpenAI
Was previously hardcoded; now configurable per agent. (#173 by @JackChen-me)

#### Two new providers
- **Azure OpenAI** adapter, closing the long-standing #24. (#143 by @Klarline)
- **Qiniu** provider for users on Chinese infrastructure. (#154 by @JackChiang233, follow-up README/CLI docs in #165 by @JackChen-me)

### Fixes

- **Context compaction persistence and turn dropping.** `compact` strategy was losing turns and not persisting compressed history. (#161 by @apollo-mg)
- **OpenAI mixed-content message ordering.** Tool messages must precede user messages in mixed content; previously emitted in the wrong order. (#178 by @voidborne-d)
- **Provider type widening on configs.** `AgentConfig`, `CoordinatorConfig`, and `OrchestratorConfig` were not using the full `SupportedProvider` union. (#158 by @JackChen-me)

### Behavior changes

`#163` removed two implicit defaults that some users may have relied on:

- `parallel_tool_calls: false` is no longer forced. If you need the old behavior, set `parallelToolCalls: false` explicitly (now exposed via #173).
- The default `frequency_penalty` override has been removed.

These are behavior changes, not API breaks, but worth checking if you depended on the old defaults.

The same PR also moved the local `<think>` tag parsing out of the agent layer into `tool/text-tool-extractor.ts`. This is internal cleanup with no user-visible impact.

### Examples and cookbook

Nine new examples and a category reorganization (#125 by @JackChen-me):

- Meeting summarizer pattern. (#139 by @mvanhorn, moved into `cookbook/` in #140 by @JackChen-me)
- Translation / back-translation cookbook. (#145 by @zouhh22333-beep)
- Competitive monitoring. (#146 by @pei-pei45)
- Multi-perspective code review, upgraded to structured output and free providers. (#150 by @Kinoo0)
- Contract review DAG with step-level retry. (#155 by @fault-segment)
- Research aggregation with schema. (#159 by @Optimisttt)
- Engram integration: memory store, toolkit, two demos. (#160 by @Agentscreator, Ecosystem section refresh in #151 by @JackChen-me)
- @agentsonar/oma integration: sidecar from the [agentsonar](https://github.com/agentsonar) team detecting cross-run delegation cycles, repetition, and rate bursts. (e7aecf3 by @JackChen-me)
- Cost-tiered pipeline comparing flagship vs mixed model tiers. (#164 by @HuXiangyu123)
- OpenRouter provider example. (#167 by @kenrogers)
- `local-quantized.ts` showing tuned sampling on vLLM and llama-server. (ff987cf by @JackChen-me)

### Docs and infrastructure

- README refresh: positioning, branding, hero block, integrations, examples section. (#126, #176, #177, #179 by @JackChen-me)
- `CLAUDE.md` architecture map synced with the current `src/` layout. (#171 by @JackChen-me)
- CLI dashboard documented and added to the flag table. (#141 by @JackChen-me)
- Real badges and Codecov integration. (#127, #128, #129, #130 by @JackChen-me)
- npm registry pinned to `npmjs.org` via repo-level `.npmrc` (#170 by @JackChen-me).
- Extended LLM adapter coverage for issue #54. (#144 by @jadegold55)

### Install

```bash
npm install @jackchen_me/open-multi-agent@1.3.0
```

Thanks to @ibrahimkzmv, @mvanhorn, @Klarline, @jadegold55, @zouhh22333-beep, @Kinoo0, @apollo-mg, @Optimisttt, @Agentscreator, @pei-pei45, @fault-segment, @Xin-Mai, @HuXiangyu123, @JackChiang233, @kenrogers, and @voidborne-d for the external contributions that make this release.

**Full changelog:** https://github.com/JackChen-me/open-multi-agent/compare/v1.2.0...v1.3.0

## 1.2.0 - 2026-04-18

First minor release since 1.1.0. MCP integration, three new LLM providers, context management strategies, a CLI, tool output cost controls, and fixes for abort and error propagation.

### Features

- **MCP integration.** New `connectMCPTools()` wires any MCP server (stdio) directly into agent tool use. `@modelcontextprotocol/sdk` is an optional peer dependency. Runnable example at `examples/16-mcp-github.ts`. (#89, by @ibrahimkzmv)

- **Three new LLM providers.** First-class `provider: 'deepseek'` (`deepseek-chat`, `deepseek-reasoner`), `provider: 'minimax'` (global and China endpoints via `MINIMAX_BASE_URL`), and verified Groq via OpenAI-compatible `baseURL` in `examples/19-groq.ts`. (#113 and #114 by @hkalex; #121 by @mvanhorn)

- **Context management strategies.** New `AgentConfig.contextStrategy` keeps long runs under token ceilings with four strategies: `sliding-window`, `summarize`, `compact` (rule-based, no extra LLM call), and `custom`. (#88 by @ibrahimkzmv; #111, #119 by @JackChen-me)

- **Tool output cost controls.** New `AgentConfig.maxToolOutputChars` and per-tool `ToolDefinition.maxOutputChars` truncate large outputs (head + tail with a marker). New `AgentConfig.compressToolResults` compresses older tool results once the agent has moved on; errors are never compressed. (#110, #115, #116, #117, #118 by @JackChen-me)

- **CLI (`oma`).** New binary for shell and CI with `oma run`, `oma task`, `oma provider`, JSON-first output, and stable exit codes. Docs at `docs/cli.md`. (#107 by @ibrahimkzmv)

- **`AgentConfig.customTools`.** Inject tool definitions at config time from the orchestrator. Bypasses preset/allowlist filtering but still respects `disallowedTools`. (#109, #112 by @JackChen-me)

- **`glob` built-in tool.** Find files by glob pattern, sorted by modification time. (#102 by @ibrahimkzmv)

### Fixes

- **`AbortSignal` propagation.** Abort now reaches tool execution, the Gemini adapter, and the abort queue path. (#104 fixes #99, #100, #101, by @JackChen-me)

- **Error event propagation.** `AgentRunner.run()` now surfaces error events to callers. (#103 fixes #98, by @JackChen-me)

### Examples

- `examples/16-mcp-github.ts`: full MCP wiring
- `examples/17-minimax.ts`, `examples/18-deepseek.ts`, `examples/19-groq.ts`: provider quickstarts
- `examples/with-vercel-ai-sdk/`: Next.js + OMA `runTeam()` + AI SDK `useChat`

### Docs

- READMEs (EN/ZH) expanded: CLI, MCP, context strategies, tool output control, `customTools`. ZH caught up with EN on items that shipped in 1.1.

### Install

```bash
npm install @jackchen_me/open-multi-agent@1.2.0
```

Thanks to @hkalex, @ibrahimkzmv, and @mvanhorn for the external contributions that make this release.

**Full changelog:** https://github.com/JackChen-me/open-multi-agent/compare/v1.1.0...v1.2.0

## 1.1.0 - 2026-04-11

First minor release since `1.0.1`. Six new features, two fixes, two new examples, and one behavior change you should read before upgrading.

### ⚠️ Behavior change (read this before upgrading)

**Agents now run with default-deny, dependency-scoped context (#87).**
An agent only sees results from tasks it explicitly `dependsOn`, instead of every prior task in the run. This prevents context leakage between unrelated agents and keeps token usage predictable in larger teams.

If your existing teams relied on agents implicitly seeing all prior task output, add explicit `dependsOn` edges in your task graph. No API change is required for `runTeam()` users whose coordinator already produces a sensible DAG.

This change was prompted by a combination of competitive analysis (XCLI scopes sub-agent context to a minimum file set + tool allowlist by default) and a [public post on X by guk2472](https://x.com/guk2472/status/2040833298063045075) flagging inter-agent context pollution as the real production killer in multi-agent systems. Thanks for the signal.

### Features

- **AbortSignal support** for `runTeam()` and `runTasks()` (#69). Cancel a run mid-flight from the caller.
- **Skip coordinator for simple goals** in `runTeam()` (#70). Single-agent goals no longer pay the coordinator round-trip.
- **Token budget management** at agent and orchestrator level (#71). Stops runs that exceed a configured budget instead of silently burning tokens.
- **Tool allowlist / denylist / preset** (#83). Restrict which tools an agent can call without rebuilding the registry.
- **Customizable coordinator** (#85). Override the coordinator's model, system prompt, tools, `toolPreset`, and `disallowedTools` via `CoordinatorConfig`.
- **Dependency-scoped agent context** (#87). See behavior change above.

### Fixes

- **Per-agent mutex** prevents concurrent runs on the same `Agent` instance from corrupting state (#77).
- **Duplicate progress events** in the short-circuit path for `runTeam()` are gone, and `completedTaskCount` is no longer double-incremented (#82).

### Examples

- Multi-source research aggregation (#79)
- Multi-perspective code review (#80)

### Docs

- README top fold rewritten and Examples section trimmed (#95)
- Coverage badge updated to 88% (#57)
- `DECISIONS.md` restructured to signal openness on MCP and A2A

### Install

```bash
npm install @jackchen_me/open-multi-agent@1.1.0
```

## 1.0.1 - 2026-04-05

The `1.0.1`, `0.2.0`, and `0.1.0` entries are summarized from npm package
metadata and Git history because no GitHub Release notes were published for
them.

### Changed

- Limited the npm package to compiled output and package documentation instead
  of publishing repository source, tests, examples, and project metadata.
- Added contract tests for the Anthropic, OpenAI, Gemini, and GitHub Copilot
  adapters, plus opt-in provider E2E tests, raising reported coverage from 71%
  to 88% (#56).

### Compatibility

- The compiled `dist/` output and public runtime API are unchanged from
  `1.0.0`.

## 1.0.0 - 2026-04-05

### What's new since 0.2.0

#### Features
- **Structured output** — optional `outputSchema` (Zod) on any agent, with auto-retry on validation failure (#36, #38)
- **Task retry with exponential backoff** — `maxRetries`, `retryDelayMs`, `retryBackoff` per task (#37)
- **Observability** — `onTrace` callback emits structured spans for LLM calls, tool calls, tasks, and agent runs (#40)
- **Lifecycle hooks** — `beforeRun` / `afterRun` on AgentConfig for prompt rewriting and result post-processing (#45)
- **Human-in-the-loop** — `onApproval` callback between task execution rounds to gate the next batch (#46)
- **Loop detection** — detects stuck agents repeating the same tool calls or text, with configurable `warn` / `terminate` / custom handler (#49)
- **Grok (xAI) adapter** — first-class support with dedicated GrokAdapter (#44)
- **Fallback tool-call extraction** — local models that emit tool calls as plain text are now handled automatically (#47)

#### Testing & quality
- 340 tests, 71% line coverage across `src/` (#53)
- Coverage badge added to README (#55)

#### Full changelog
https://github.com/JackChen-me/open-multi-agent/compare/v0.2.0...v1.0.0

## 0.2.0 - 2026-04-03

### Added

- Added GitHub Copilot as a first-class LLM provider (#9).
- Added `baseURL` and `apiKey` overrides for OpenAI-compatible APIs and local
  servers such as Ollama, vLLM, and LM Studio.
- Agents can declare an `outputSchema`. Final JSON output is validated with
  Zod, exposed through `result.structured`, and retried once with validation
  feedback when necessary (#36, #38).
- Added task-level retry with capped exponential backoff and accumulated token
  usage across attempts (#37).

### Fixed

- Blocked tasks are unblocked after their dependencies complete instead of
  remaining stuck indefinitely.
- `randomUUID` is imported from `node:crypto` so the package works on its
  declared Node.js 18 minimum.

## 0.1.0 - 2026-04-01

Initial npm release.

### Added

- `OpenMultiAgent` with `runAgent()` for one-shot work, `runTeam()` for
  coordinator-planned teams, and `runTasks()` for explicit task pipelines.
- Role-based teams with shared memory, inter-agent messaging,
  dependency-aware scheduling, and parallel execution.
- Anthropic and OpenAI adapters, a public custom-adapter contract, and a typed
  tool framework with five built-in tools.
