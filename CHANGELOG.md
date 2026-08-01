# Changelog

## Unreleased

## 1.14.0 - 2026-08-01

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

- **Node.js 20 or newer is now required.** The `engines` floor moved from 18 to
  20 across `@open-multi-agent/core`, `@open-multi-agent/otel`, and
  `create-oma-app`. Node 18 reached end of life on 2025-04-30.
- The bundled `openai` dependency moved from v4 to v6. OpenAI user aborts are
  now classified as cancellation rather than as a retryable failure, and
  unsupported custom tool calls are rejected explicitly instead of being passed
  through.
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
- Runs that previously succeeded with an invalid task DAG or an unsatisfiable
  task requirement now fail at validation time. This surfaces a defect that was
  previously silent; correct graphs and rosters are unaffected.
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
