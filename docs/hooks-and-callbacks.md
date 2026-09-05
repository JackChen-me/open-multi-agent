# Hooks and callbacks

OMA has no single "middleware" concept. Instead, function-typed fields are spread across `OrchestratorConfig`, `AgentConfig`, `CoordinatorConfig`, the per-call options objects, and `Task`. This page is the map: what each one is called with, when it fires, which of the three run modes reaches it, what a return value can change, and what happens when it throws. It is deliberately shallow; each entry links to the page that owns the behavior.

## All callbacks at a glance

"Fires in" refers to the three primary entry points: `runAgent()`, `runTasks()`, and `runTeam()`. A standalone `new Agent(...)` reaches every `AgentConfig` hook without an orchestrator.

| Callback | Configured on | Fires in | On throw | Detail |
|---|---|---|---|---|
| `beforeRun` | `AgentConfig` | all three | Aborts that agent run (failed result, `errorInfo.kind: 'callback'`) | [structured input](structured-input.md#beforerun-semantics) |
| `afterRun` | `AgentConfig` | all three | Marks the run failed; not called when the run already threw | below |
| `onToolCall` | `AgentConfig`, `CoordinatorConfig`, `OrchestratorConfig` | all three | Fail closed: error `ToolResult` | [tool configuration](tool-configuration.md#per-call-gating-with-ontoolcall) |
| `onPlanReady` | `OrchestratorConfig` | `runTeam()` coordinator path only | Treated as a denial; run ends `success: false` | [plan replay](plan-replay.md) |
| `onTaskDispatch` | `OrchestratorConfig` | `runTasks()`, `runTeam()` | Stops new dispatches; remaining tasks skipped | [task scheduling](task-scheduling.md#approval-modes) |
| `onApproval` | `OrchestratorConfig` | `runTasks()`, `runTeam()` | Skips all remaining tasks, ends the run | [task scheduling](task-scheduling.md#approval-modes) |
| `onProgress` | `OrchestratorConfig` | all three | **Not isolated**: propagates from the call site | [observability](observability.md#progress-events) |
| `onTrace` | `OrchestratorConfig` | all three | Swallowed, including async rejections | [observability](observability.md#trace-spans) |
| `onAgentStream` | `OrchestratorConfig` | task execution (`runTasks()`, `runTeam()`) | Swallowed by `AgentPool` | [streaming](streaming.md) |
| `estimateCost` | `OrchestratorConfig` | all three | Propagates; an invalid return also throws | [budgets and limits](budgets-and-limits.md#estimatecost) |
| `recovery.onTaskOutcome` | `OrchestratorConfig`, `RunTasksOptions` | `runTasks()`, `runTeam()` | Swallowed; no patch is applied, run continues | [adaptive recovery](adaptive-recovery.md) |
| `recovery.replanner` | same | same | Same as `onTaskOutcome` (it is adapted into one) | [adaptive recovery](adaptive-recovery.md#configure-a-replanner) |
| `recovery.onPlanPatch` | same | same | Swallowed; patch rejected, run continues | [adaptive recovery](adaptive-recovery.md) |
| `verify` (per task) | `Task`, `RunTaskSpec`, coordinator JSON | `runTasks()`, `runTeam()` | n/a (config, not a function) | [consensus](consensus.md#per-task-verify-hook) |
| `judgePrompt` | `ConsensusVerifyOptions`, `ConsensusOptions` | wherever verification runs | Propagates through the consensus run | [consensus](consensus.md#options) |
| `executionRouter.decide` | `OrchestratorConfig`, `RunTeamOptions` | `runTeam()` | Falls back to the deterministic router unless `failurePolicy: 'fail'` | [execution routing](execution-routing.md#failure-behavior) |
| `executionRouting.profiler.profile` | `OrchestratorConfig`, `RunTeamOptions` | `runTeam()` with `strategy: 'hybrid'` | Same fallback rule | [execution routing](execution-routing.md#failure-behavior) |
| `backend.permission` | `AgentConfig.backend` (ACP) | all three | Propagates from the ACP session | [external agents](external-agents.md#acp-permissions) |
| `shellExecutor.exec` | `AgentConfig`, `CoordinatorConfig`, `OrchestratorConfig` | all three | Becomes an error `ToolResult` like any tool failure | [sandbox and shell](sandbox-and-shell.md#shell-executors) |
| `customTools[].execute` | `AgentConfig` | all three | Becomes an error `ToolResult` | [tool configuration](tool-configuration.md#custom-tools) |
| `evaluation.sample` (function form) | `OrchestratorConfig` | all top-level runs | Swallowed; the run is not sampled | [evaluation](evaluation.md#sample-production-runs-online) |
| `evaluation.onResult` | `OrchestratorConfig` | all top-level runs | Swallowed; counted in `failed` | [evaluation](evaluation.md#sample-production-runs-online) |
| `evaluation.onDiagnostic` | `OrchestratorConfig` | all top-level runs | Swallowed; counted in `failed` | [evaluation](evaluation.md#sample-production-runs-online) |

`observability.sinks` and `journal` are **not** callbacks. They are objects with a lifecycle (`emit`, `forceFlush`, `shutdown`) that the application owns; see [observability](observability.md#sinks-exporters-and-ownership) and [run journal](run-journal.md).

## Agent lifecycle

### `beforeRun`

```ts
(context: BeforeRunHookContext) => BeforeRunHookResult | Promise<BeforeRunHookResult>
```

Called once per agent run, before the backend is resolved and before the first model call. `context` carries `prompt` (text blocks of the latest user message, concatenated), `messages` (a defensive copy of the complete effective message list), and `agent` (the static config with `beforeRun` and `afterRun` stripped so the object has no self-reference).

The return value is applied in a fixed order: a returned `messages` list replaces the whole input first, then a changed `prompt` replaces the text blocks of the latest user message while non-text blocks keep their relative order. `agent` is informational only. A non-string `prompt` raises `InvalidMessageError`, and an agent with an external `backend` may rewrite `prompt` but not `messages`, because a process or ACP transport cannot carry structured messages without loss.

It is skipped when the run carries `resumeState`, that is, when execution resumes from a checkpointed in-flight agent rather than starting fresh. Throwing aborts the run: `Agent.executeRun()` catches it and classifies with `errorInfo.kind: 'callback'`. In streaming mode this becomes an `error` stream event instead of a `done` event.

See [structured input](structured-input.md#beforerun-semantics).

### `afterRun`

```ts
(result: AgentRunResult) => AgentRunResult | Promise<AgentRunResult>
```

Called after a run produces a result, including the budget-exceeded result. It is **not** called when the run threw, so it is not an error-observation point; handle errors at the call site instead. Return a modified result to change what the caller sees; throwing marks the run failed with `errorInfo.kind: 'callback'`.

The framework restores runtime-required outcome fields after the hook runs (`ensureAgentOutcome`), so `identity`, `status`, and `success` stay internally consistent even if a hook returns a result that contradicts them: `success` is re-derived from `status.code === 'ok'`, and a `budgetExceeded` result is re-classified as `budget_exhausted`. In streaming mode the hook shapes the payload of the `done` event, and a throwing hook suppresses `done` in favor of `error`.

## Tool execution

### `onToolCall`

```ts
type ToolCallGate = (context: ToolCallContext) => ToolCallDecision | Promise<ToolCallDecision>
```

The per-call gate. `context` is `{ toolName, input, agentName, consequential?, runId?, taskId?, toolCallId? }`, where `input` is the **post-validation** parsed object. The decision is `{ action: 'allow' }`, `{ action: 'deny', reason? }`, or `{ action: 'suspend', reason? }`.

Ordering matters: name-based grant resolution runs first, so an ungranted tool is refused before the gate ever sees it; then Zod input validation; then the gate; then execution. A `deny` produces an error `ToolResult` carrying the reason rather than throwing. A gate that throws, or returns something that is not a valid decision, is also turned into an error `ToolResult`, which is what "fail closed" means here. `suspend` requires an orchestrated task with checkpoint persistence and an atomic store; without those the call fails closed and the tool does not run.

Resolution order is `AgentConfig.onToolCall` over `OrchestratorConfig.onToolCall`, applied by `applyAgentDefaults()`. `CoordinatorConfig.onToolCall` follows the same rule for the coordinator agent. The gate is a coordination layer, not a sandbox.

See [tool configuration](tool-configuration.md#per-call-gating-with-ontoolcall) and, for the durable variant, [durable approvals](durable-approvals.md).

### `shellExecutor` and `customTools[].execute`

Neither is a hook in the middleware sense, but both are application functions the runtime calls, and both follow rule 1 of [errors](errors.md): anything they throw becomes a `ToolResult` with `isError: true`, not an exception. `ShellExecutor` has `exec(command, options)` plus optional `start()` and `stop()`; the same instance may serve concurrent agents, so a non-concurrent implementation must serialize internally ([sandbox and shell](sandbox-and-shell.md#shell-executors)). `ToolDefinition.execute(input, context)` receives the Zod-parsed input and a `ToolUseContext` ([tool configuration](tool-configuration.md#custom-tools)).

## Approval gates

All three approval gates return `ApprovalGateDecision`, which is `boolean | ToolCallDecision`. `true` means allow, `false` means deny, and the object form adds `suspend` plus an optional `reason`. `normalizeApprovalDecision()` rejects anything else by throwing, which then follows each gate's own throw behavior.

### `onPlanReady`

```ts
(tasks: readonly Task[]) => ApprovalGateDecision | Promise<ApprovalGateDecision>
```

Called once, after the coordinator decomposes the goal and before execution begins. Only the coordinator path of `runTeam()` reaches it: the simple-goal short circuit returns earlier, the declared-governance topology takes a different branch, and `runAgent()`, `runTasks()`, and `runFromPlan()` never call it.

`deny` ends the run with `status.code: 'rejected'`; a thrown callback is treated the same way but records the classified callback error instead. `suspend` persists the exact plan as an approval request and returns a `suspended` result with `pendingApprovals`. With `planOnly: true` the gate still runs and a denial wins: the result is `success: false` and `planOnly` is unset. Do not mutate the `Task` objects passed in; they are live queue state.

Wiring `onPlanReady` also has a side effect worth knowing: it, `onApproval`, and `planOnly` each cause the scheduler to auto-assign unassigned tasks before the gate sees the plan, so reviewers read assignees rather than blanks.

See [plan replay](plan-replay.md).

### `onTaskDispatch`

```ts
(task: Readonly<Task>) => ApprovalGateDecision | Promise<ApprovalGateDecision>
```

Called after a ready task has an assignee and immediately before it is dispatched. This is the pipeline-mode gate. `deny` stops new dispatches; already-running tasks settle, then every remaining task is marked `skipped` and the run reports `status.code: 'rejected'`. A throwing callback closes the same terminal gate and additionally records the classified callback error on the run outcome. `suspend` persists that one task boundary and drains the run to a `suspended` result.

Mutually exclusive with `onApproval`. A durable decision recorded for this boundary is consumed on restore instead of re-running the gate.

### `onApproval`

```ts
(completedTasks: readonly Task[], nextTasks: readonly Task[]) => ApprovalGateDecision | Promise<ApprovalGateDecision>
```

Configuring this callback selects the legacy round-based executor: the queue runs in batches with a full barrier between rounds. It is not called when no task succeeded in the round, or when no pending tasks remain. `deny` skips the remainder with reason `Skipped: approval rejected.`; a throw skips the remainder with a reason naming the callback error and sets the run status from the classified error. `suspend` persists the round boundary.

Two configuration errors are worth noting. Setting both `onApproval` and `onTaskDispatch` throws from the `OpenMultiAgent` constructor (`onApproval and onTaskDispatch are mutually exclusive approval modes.`). Combining `onApproval` with `recovery.mode: 'repairable'` throws when the queue starts executing (`Runtime recovery is incompatible with legacy onApproval round scheduling.`).

See [task scheduling](task-scheduling.md#approval-modes).

## Planning and recovery

### `recovery.onTaskOutcome` and `recovery.replanner`

```ts
(outcome: TaskOutcome) => PlanPatch | undefined | Promise<PlanPatch | undefined>
// or: { name?: string; replan(outcome: TaskOutcome): PlanPatch | undefined | Promise<...> }
```

The task-outcome barrier. It runs before the triggering task is marked completed or failed, so no dependent can be dispatched ahead of an accepted patch. `outcome.kind` is `'success' | 'failure' | 'verification_rejected'`, and the object carries the task, its result, any verification outcome, the current plan revision, the full task list, and remaining token and cost budget when ceilings are configured.

The two fields are mutually exclusive; supplying both throws at configuration resolution, and supplying neither with `mode: 'repairable'` throws as well. A `replanner` is adapted into an `onTaskOutcome` function internally, so both share every behavior below.

Return `undefined` to decline. Return a `PlanPatch` and it must survive four checks before it applies: the revision limit (`maxPlanRevisions`, default 3), the cumulative added-task limit (`maxAddedTasks`, default 20), a repeated-patch signature check, and `validatePlanPatchEligibility()`. Each rejection emits a `warning` or `recovery_decision` progress event and leaves the plan untouched. A throwing policy is caught, reported as an `error` progress event with `kind: 'recovery_policy_failed'`, and the run continues unpatched.

See [adaptive recovery](adaptive-recovery.md).

### `recovery.onPlanPatch`

```ts
(patch: Readonly<PlanPatch>, outcome: TaskOutcome) => boolean | Promise<boolean>
```

An approval gate for a patch that already passed validation. Omitting it means the policy owns approval. Returning `false` records `decision: 'rejected'`; throwing is caught, reported as `kind: 'recovery_approval_failed'`, and treated as a rejection. Either way the run continues on the unpatched plan.

## Observation

### `onProgress`

```ts
(event: OrchestratorEvent) => void
```

`OrchestratorEvent` is `{ type, agent?, task?, data? }` where `type` is one of `agent_start`, `agent_complete`, `task_start`, `task_complete`, `task_skipped`, `task_retry`, `approval_pending`, `plan_revision`, `recovery_decision`, `budget_exceeded`, `message`, `warning`, `error`. Consumers with exhaustive switches need to handle additive variants.

Unlike `onTrace`, progress callbacks are invoked directly with no guard, so a throwing handler propagates out of whatever code emitted the event. Keep the handler total. `data` is untyped by design and its shape varies per event; treat it as read-only diagnostic material rather than as a contract, because some events carry live queue objects. For `runAgent()`, structured calls emit `{ messages }` and string calls emit `{ prompt }`, and the message payload is a separate copy, so a mutation there cannot reach execution or online evaluation ([structured input](structured-input.md#progress-and-online-evaluation)).

See [observability](observability.md#progress-events).

### `onTrace`

```ts
(event: TraceEvent) => void | Promise<void>
```

The legacy span callback. Every emission goes through `emitTrace()` (`packages/core/src/utils/trace.ts`), which wraps the call in `try/catch` and attaches a `.catch(noop)` to a returned promise, so neither a synchronous throw nor an async rejection can break execution or produce an unhandled rejection. Setting `onTrace` also activates the trace runtime, which is what makes child spans and `TraceRecord` objects get constructed at all.

`TraceEvent` variants are `llm_call`, `tool_call`, `task`, `agent`, `plan_ready`, `agent_stream`, `consensus`, and `routing_decision`. For new work prefer `observability.sinks`; see [observability](observability.md#sinks-exporters-and-ownership) and the [migration guide](observability-migration.md).

### `onAgentStream`

```ts
(agentName: string, event: StreamEvent) => void
```

Forwards each `StreamEvent` from a task worker. Its presence is what switches workers from `agent.run()` to `agent.stream()`, so wiring it changes the execution path, not just observation. It is wired inside `executeQueue`, the shared task executor, so both `runTeam()` and `runTasks()` reach it; `runAgent()` never streams. Errors thrown by the callback are swallowed by `AgentPool` on purpose: a throwing observer would otherwise be caught by `executeWithRetry` and burn another LLM call on every retry.

`StreamEvent.type` is `text`, `reasoning`, `tool_use`, `tool_result`, `loop_detected`, `budget_exceeded`, `done`, or `error`, and an `error` event may carry `errorInfo` so a consumer can tell a provider failure from a callback or framework failure without parsing the message. See [streaming](streaming.md).

## Cost and routing

### `estimateCost`

```ts
(usage: TokenUsage, context: CostEstimateContext) => number
```

Called with the usage of **one** LLM result, not cumulative usage; return the amount to add to the run's running estimate. `context` carries `agentName`, the effective `model` after defaults and model routing, `provider` when known, `taskId` when the usage came from a task, and `phase`, which is one of `agent`, `routing`, `short-circuit`, `coordinator`, `worker`, `synthesis`, `consensus`, `delegated`.

OMA ships no price table by design, so `maxCostBudget` does nothing without this function. A non-finite or negative return causes `estimateIncrementalCost()` to throw an `Error` naming the agent; a throwing estimator propagates the same way. Cost is checked at the same turn and task boundaries as the token budget, so a run may overshoot by up to one model turn. See [budgets and limits](budgets-and-limits.md#estimatecost).

### `executionRouter.decide` and `executionRouting.profiler.profile`

```ts
decide(context: RoutingContext): RoutingDecision | Promise<RoutingDecision>
profile(context: TaskProfilerContext): TaskProfilerResult | Promise<TaskProfilerResult>
```

Both are policy objects with a `version` string rather than bare functions, and both are only consulted by `runTeam()` on the automatic, non-`planOnly` path. The roster they receive is a `RosterSummaryEntry[]` that deliberately excludes `systemPrompt`.

Failure handling is shared: a timeout, an invalid return, or a throw is caught and the run falls back to the built-in deterministic router, unless the caller aborted or `executionRouting.failurePolicy` is `'fail'`. The fallback is recorded on the routing decision and span. See [execution routing](execution-routing.md#failure-behavior) and [errors](errors.md#timeout-and-routing-errors).

## Verification

### `verify` on a task

`verify` is configuration, not a function, but it is the switch that turns a task into a proposer-and-judge loop. On an explicit `runTasks()` spec it is a full `ConsensusVerifyOptions` including `judges`. On a coordinator-generated task it can only be `true` or a partial object with `mode`, `quorum`, `maxRounds`, or `onDissent`, and it is silently ignored unless `RunTeamOptions.verifyJudges` supplies the roster. Judge usage counts against the same parent token budget.

### `judgePrompt`

```ts
string | ((judge: string) => string)
```

Overrides the default verifier instruction. The function form receives the judge's agent name and returns that judge's framing, which is how per-judge angles are expressed when the built-in `mode: 'lens'` rotation is not what you want. When set, it replaces both the `refute` default instruction and the `lens` rotation; the question, proposed answer, and verdict-format sections are still appended.

See [consensus](consensus.md#options).

## External backends

### `backend.permission` (ACP)

```ts
'auto-approve' | 'reject' | ((request: AcpPermissionRequest) => boolean | Promise<boolean>)
```

Answers an ACP agent's `session/request_permission` prompt. `AcpPermissionRequest` is an SDK-agnostic view: `title`, optional `kind`, and the `optionKinds` the agent offered. The function form returns `true` to approve and `false` to reject. The default is `'auto-approve'`, which prefers the least-privilege `allow_once` over a session-wide `allow_always`.

This gate belongs to the external agent's own loop. OMA's `onToolCall` does not apply to a process or ACP backend, because those backends replace the LLM runner and its tool loop entirely. See [external agents](external-agents.md#acp-permissions).

## Evaluation

`OrchestratorConfig.evaluation` carries three optional functions, all of them best-effort and isolated from the business response by contract:

- `sample`, either a number in `[0, 1]` or `(context: OnlineSampleContext) => boolean`. A throwing rule is caught, reported as a `scorer_failed` diagnostic, and the run is not sampled.
- `onResult(record: EvalRecord)`, called once per produced record. A throw is caught and counted in `OnlineEvaluationStats.failed`.
- `onDiagnostic(diagnostic: EvalDiagnostic)`, called for rate-limited diagnostics; when unset and `diagnostics` is not `'silent'`, OMA logs a warning instead. A throw is caught and counted the same way.

Scorers themselves are not callbacks on a config object; a failing scorer produces `status: 'scorer_error'` and is excluded from aggregates rather than scored zero. See [evaluation](evaluation.md).
