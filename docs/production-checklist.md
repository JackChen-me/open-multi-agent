# Production checklist

This page is a go-live review for an OMA deployment: the decisions that are
easy to leave at a default, where that default is deliberately permissive or
deliberately absent, and which page owns the detail. Each item is one or two
sentences plus a link. Nothing here restates a linked page, and nothing here is
a substitute for reading the one that matters to you.

Every item names a real configuration field or a documented behavior. Items
marked **default is permissive** are the ones most likely to surprise a first
production run.

## Models and credentials

- [ ] **Pin a provider and model.** Set `provider` and `model` per agent, or
  set `defaultProvider` / `defaultModel` once on the orchestrator and let
  agents inherit. A standalone `new Agent(...)` has no orchestrator to inherit
  from, so it must declare its own `model` unless it runs on an external
  `backend`. See [providers](providers.md).
- [ ] **Decide where credentials come from.** Provider keys resolve from
  `apiKey` / `defaultApiKey` or the provider's environment variable. Tool code
  should read `AgentConfig.credentials` through the tool context rather than
  closing over a module-level secret, so each agent holds only what it was
  assigned. See
  [per-agent tool credentials](tool-configuration.md#per-agent-tool-credentials).
- [ ] **Configure `egressPolicy`, or accept that there is none.** **Default is
  permissive:** omitting it preserves unrestricted behavior. Once set, scopes
  intersect and a more specific scope can only narrow. Read the enforcement
  matrix before relying on it: it guards framework-owned LLM requests, not
  tools, subprocesses, MCP servers, or your own exporters. See
  [egress policy](egress-policy.md#enforcement-matrix).
- [ ] **Check the runtime and network footprint if you self-host.** Dependency
  surface, which components open sockets, and what an air-gapped deployment
  requires are enumerated in
  [self-hosting](self-hosting.md#what-connects-to-the-network).

## Tools and sandbox

- [ ] **Audit every tool grant.** Built-in tools are default-deny: an agent
  with neither `tools` nor `toolPreset` gets zero of them. Confirm that any
  `defaultToolPreset` you set is intentional, because it widens every agent
  that declares no grant of its own. See
  [tool configuration](tool-configuration.md#built-in-tools-are-opt-in-default-deny).
- [ ] **Accept that tool output reaches your provider.** Every tool result is
  appended to the conversation and sent to the model on the next turn, so file
  contents, command output, and fetched pages leave your process. Grant read
  access deliberately.
- [ ] **Decide the containment story for `bash`.** Filesystem built-ins resolve
  inside `cwd` / `defaultCwd`, defaulting to `<cwd>/.agent-workspace`. Granted
  `bash` is contained by nothing OMA owns, and a `ShellExecutor` changes the
  execution target rather than adding a boundary. For untrusted commands, use
  process-level isolation. See [sandbox and shell](sandbox-and-shell.md).
- [ ] **Add a per-call gate if a granted name is too coarse.** **Default is
  permissive:** `onToolCall` is off. When set it runs after input validation
  and before execution, fails closed on a throw or an invalid decision, and can
  `suspend` for durable review. It is a policy layer, not containment. See
  [per-call gating](tool-configuration.md#per-call-gating-with-ontoolcall).
- [ ] **Treat an MCP server as a separate trust boundary.** Argument validation
  is delegated to the server, and the server is its own process with its own
  network behavior outside `egressPolicy`. See
  [MCP tools](mcp.md#egress-and-process-boundaries).
- [ ] **Cap tool output.** `maxToolOutputChars` on the agent, or
  `maxOutputChars` per tool, bounds what a single result can push into the
  context. Neither has a default.

## Budgets and limits

- [ ] **Bound the loop.** Set `maxTurns`, `timeoutMs`, and `callTimeoutMs`
  explicitly. Only `maxTurns` has a default; without the two timeouts, a
  stalled provider is bounded only by its SDK.
- [ ] **Set a token or cost ceiling.** `maxTokenBudget` works on its own;
  `maxCostBudget` requires an application-owned `estimateCost`, because OMA
  ships no price table. Budgets are checked at turn and task boundaries, so
  treat them as bounds, not exact stops.
- [ ] **Turn on `loopDetection` for long-running agents.** Off by default. It
  stops a repeating agent before `maxTurns` would, and its default action warns
  once before terminating.
- [ ] **Know that two stop conditions look like success.** Exhausting
  `maxTurns` and terminating on a detected loop both return `success: true`.
  Check `result.loopDetected`, and treat a truncated answer as unfinished if
  that matters.

All four items are detailed in [budgets and limits](budgets-and-limits.md).

## Approvals and governance

- [ ] **Pick one task-level approval mode.** `onApproval` (round-based) and
  `onTaskDispatch` (per ready task) are mutually exclusive and the constructor
  throws if both are set. `onPlanReady` gates the coordinator's plan once,
  before execution. See [approval modes](task-scheduling.md#approval-modes) and
  [hooks and callbacks](hooks-and-callbacks.md#approval-gates).
- [ ] **If a decision must outlive the process, use durable approvals.** They
  need a `MemoryStore` whose `compareAndSet` is atomic across every writer;
  `FileStore` has no cross-process lock, and suspension fails closed with
  `APPROVAL_ATOMIC_STORE_REQUIRED` when the store cannot decide atomically.
  `RedactingStore` is unsupported there because its lossiness would break the
  content hash. See
  [store requirements](durable-approvals.md#store-requirements).
- [ ] **Build the reviewer surface yourself.** OMA provides the mechanism and
  the durable record only: no UI, no CLI command, no transport, no
  notification. See
  [what the framework provides](durable-approvals.md#what-the-framework-provides-and-what-you-build).
- [ ] **Declare governance roles when a goal must pass through named agents,
  and check the verdict.** `governanceIntent: 'required'` with `requiredRoles`
  builds the topology structurally instead of letting the coordinator choose,
  and the result's `governanceConclusion` is what tells you whether it held.
  See
  [declared governance roles](tool-configuration.md#declared-governance-roles-in-runteam).
- [ ] **Consider `requireConsequentialConfirmation`.** **Default is
  permissive:** it is `false`. See
  [consequential tools](tool-configuration.md#consequential-tools-on-undeclared-runs).

## Recovery and durability

- [ ] **Enable checkpointing if a run must survive a crash.** Off by default.
  Choose the store deliberately: `checkpoint: true` reuses the team's
  shared-memory store when one exists and otherwise uses a private in-memory
  store for that run, neither of which survives the process. See
  [checkpoint](checkpoint.md#enable-it).
- [ ] **Understand mid-task recovery before relying on it.** A restore replays
  committed tool results without re-executing them and conservatively re-runs a
  call that has no commit record, reusing the same `toolCallId` so a
  consequential tool can key on it. External backends checkpoint at task
  boundaries only. See
  [mid-task tool recovery](checkpoint.md#mid-task-tool-recovery).
- [ ] **Set `maxRetries` where a transient provider failure is expected.**
  **Default is permissive in the other direction:** retry is off
  (`maxRetries: 0`). When enabled it is error-aware, with jittered backoff, and
  validation, cancellation, and budget exhaustion are terminal. See
  [task retry boundaries](task-scheduling.md#task-retry-boundaries) and
  [errors](errors.md#retry-classification).
- [ ] **Decide whether the plan may repair itself.** Recovery mode defaults to
  `'fixed'`; `'repairable'` is opt-in and bounded by `maxPlanRevisions`
  (default `3`) and `maxAddedTasks` (default `20`). See
  [adaptive recovery](adaptive-recovery.md).
- [ ] **Rehearse the resume path.** `restore()` needs the team wiring rebuilt
  and, for a `runTeam` run, the same `coordinator` config, because a checkpoint
  cannot persist a live adapter. Without it, restore falls back to raw per-task
  output. See [resume](checkpoint.md#resume).

## Observability and audit

- [ ] **Wire progress events, traces, or both.** `onProgress` gives lifecycle
  events for logs and live UIs; `observability.sinks` gives structured records.
  Neither is on by default. See [observability](observability.md).
- [ ] **Own the sink lifecycle.** OMA never shuts down an injected sink,
  installs a signal handler, or calls `process.exit()`. Call `forceFlush()` in
  a serverless invocation and `shutdown()` before a short-lived process exits,
  or you will lose the tail of every run. See
  [flush and shutdown](observability.md#flush-and-shutdown).
- [ ] **Accept that telemetry is not execution state.** Delivery and export
  failures never become run failures, and deleting traces never deletes
  checkpoints or shared memory.
- [ ] **Know exactly what redaction covers.** A shared credential redactor runs
  over trace attributes, tool I/O, status messages, task metadata, `bash`
  output, process-backend stderr, and evaluation payloads. It is
  credential-shaped and best-effort: **PII is not covered by default**, and
  **checkpoints and shared memory are outside it entirely**. Wrap every durable
  store in `RedactingStore` if agent output may carry secrets. See
  [redaction](self-hosting.md#redaction),
  [the default privacy boundary](observability.md#default-privacy-boundary),
  and [redacting persisted secrets](checkpoint.md#redacting-persisted-secrets).
- [ ] **Turn on the run journal if you need to reconstruct what a model saw.**
  Opt-in, and you supply the backend instance; `verifyRun()` then checks
  offline that every model-visible block is reproducible from the log. See
  [run journal](run-journal.md#enable-it).
- [ ] **Decide how a finished run gets inspected.** The Run Viewer is a
  self-contained offline HTML artifact built from an allowlisted payload, with
  no remote loads and no write path back into the run. See
  [Run Viewer](run-viewer.md#privacy-boundary).
- [ ] **Add the OpenTelemetry adapter only if you already run an OTel stack.**
  It is a separate optional package on its own version track, and the
  application owns the `TracerProvider` and its lifecycle. See
  [`packages/otel/README.md`](../packages/otel/README.md).

## Evaluation

- [ ] **Have an EvalSet before you have a regression.** Offline evaluation runs
  scorers over cases independently of production traffic. See
  [evaluation](evaluation.md).
- [ ] **Gate CI on a policy, not on a glance at the numbers.** `evaluateGate()`
  turns a report plus thresholds and an accepted baseline into a pass/fail
  verdict a job can act on. See
  [evaluation in CI](evaluation-ci.md#gate-quality-in-ci).
- [ ] **Keep online sampling out of the request path.** Sampling, scoring, and
  persistence are best-effort and isolated from the business response, and a
  scorer failure is recorded as `scorer_error` rather than a zero, so it cannot
  quietly drag an average down. See
  [scorer failures are not zero scores](evaluation.md#scorer-failures-are-not-zero-scores).
- [ ] **Check `storePayloads` against your retention rules.** It defaults to
  `'none'`, so records carry scores and references but no input/output
  snapshots. A model-based judge still sends the evaluated output to the judge
  model regardless. See [privacy](evaluation.md#privacy).

## External agent boundaries

Skip this section if no agent sets `AgentConfig.backend`.

- [ ] **Re-check which controls still apply.** Task DAG placement, dependency
  cascade, the plan and dispatch gates, shared memory, run and task journal
  events, and abort propagation all still work. The `onToolCall` gate, the
  filesystem sandbox, `egressPolicy`, tool-level journal events, and mid-task
  checkpoints do not, and no configuration makes them. See
  [control boundary](external-agents.md#control-boundary).
- [ ] **Change the ACP permission default.** **Default is permissive:**
  `permission` is `'auto-approve'`, so every prompt the agent raises is
  answered yes. Only `'reject'` or a callback makes it a real gate.
- [ ] **Do not rely on a budget to bound an external agent.** A process-backend
  agent reports zero tokens and an ACP agent reports none unless it emits
  `usage_update`, so neither is budget-gated in practice. Bound them with their
  own flags. See
  [ACP token accounting](external-agents.md#acp-token-accounting-caveat).

## Before the first production run

A short smoke pass that exercises the decisions above end to end:

1. Run the real goal with `planOnly: true` and read the plan.
2. Run it once with a deliberately low `maxTokenBudget` and confirm your
   handler sees `budget_exceeded` and the skipped tasks.
3. Kill the process mid-run and resume from the checkpoint.
4. Deny one tool call from `onToolCall` and confirm the agent adapts instead of
   crashing.
5. Flush the sink and confirm the last records actually arrived.

## Related pages

- [Budgets and limits](budgets-and-limits.md)
- [Tool configuration](tool-configuration.md) and
  [sandbox and shell](sandbox-and-shell.md)
- [Egress policy](egress-policy.md) and [self-hosting](self-hosting.md)
- [Durable approvals](durable-approvals.md) and
  [hooks and callbacks](hooks-and-callbacks.md)
- [Checkpoint](checkpoint.md), [adaptive recovery](adaptive-recovery.md), and
  [task scheduling](task-scheduling.md)
- [Observability](observability.md), [run journal](run-journal.md), and
  [Run Viewer](run-viewer.md)
- [Errors](errors.md) for the full error taxonomy
- [External agents](external-agents.md)
