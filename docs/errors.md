# Errors

This page answers one question: when something goes wrong, where does it show up and can a retry help? It lists every error class OMA exports, who raises it, whether the framework treats it as terminal or retryable, and which surface the caller reads it from.

## Three rules that decide where an error lands

**1. Tool failures are values, not exceptions.** `ToolExecutor.execute()` catches unknown tool names, Zod input-validation failures, gate denials, and anything the tool implementation throws, and returns a `ToolResult` with `isError: true` instead of rejecting. The class docstring states it directly, and every path funnels through one private `errorResult()` helper (`packages/core/src/tool/executor.ts`). The agent runner adds two more error results of its own: an ungranted tool name, and an executor call that still managed to throw (`packages/core/src/agent/runner.ts`). The model sees the message as a normal tool result and can adapt.

**2. LLM and framework failures propagate through the runner.** `AgentRunner` does not convert model-call failures into values. `tracedChat()` closes the span with a classified status and rethrows; only `chatWithCallTimeout()` substitutes one error, replacing a provider abort with `LLMCallTimeoutError` when OMA's own per-call deadline fired. The error keeps rising until it reaches `Agent.executeRun()`, whose `catch` block turns it into a failed `AgentRunResult` carrying `status`, `errorInfo`, and the original `error` object. So "propagates" means through the tool loop, not out to your `await`: a single `agent.run()` returns a failed result rather than rejecting. Input preparation is the exception, because `Agent.run()` calls `prepareAgentRunInput()` before the `try`.

**3. Task failures cascade to dependents; independent tasks continue.** `TaskQueue.fail()` marks the task `'failed'`, emits `task:failed`, and calls `cascadeFailure()`, which fires the same event for every transitively dependent task. `skip()` does the same through `cascadeSkip()`, treating a skipped upstream as permanently unsatisfiable. Neither touches tasks on unrelated branches, so a failure in one branch does not stop a sibling (`packages/core/src/task/queue.ts`).

## Where a caller reads an error

| Surface | Shape | Typical source |
|---|---|---|
| Thrown at your `await` | The error object itself | Configuration validation, input validation, a fatal dispatch failure, `RoutingDeclarationRequiredError`, `DurableApprovalError` |
| Run result fields | `result.status.code` and `result.errorInfo` always; `result.error` only where a path preserved the live object | Anything caught by `Agent.executeRun()` or converted by `classifyRunFailure()` |
| Tool result | `ToolResult.isError === true`, message in `data` | Tool execution, grants, gates |
| Progress and stream events | `OrchestratorEvent` of type `error`, `warning`, or `budget_exceeded`; `StreamEvent` of type `error` or `budget_exceeded` | Budget accounting, callback failures, recovery decisions |

`classifyRunFailure()` (`packages/core/src/observability/status.ts`) is the single converter. It produces `{ status, errorInfo }`, redacts and truncates the message (1,024 characters for `errorInfo.message`, 256 for `status.message`), copies a string or numeric `.code` off the error, and records `retryable` from `isRetryableError()`. Its special cases are:

- `TokenBudgetExceededError` or `CostBudgetExceededError` becomes `status.code: 'budget_exhausted'`, `errorInfo.kind: 'budget'`.
- `LLMCallTimeoutError` or `RoutingTimeoutError` becomes `status.code: 'timeout'`, `errorInfo.kind: 'timeout'`.
- `EgressPolicyError` becomes `status.code: 'rejected'`, `errorInfo.kind: 'validation'`.
- A cancellation (`.name === 'AbortError'`, or the OpenAI SDK's `APIUserAbortError`) becomes `status.code: 'cancelled'`, `errorInfo.kind: 'cancellation'`.

Because `errorInfo.code` is copied from the error's own `code` field, it is the most stable thing to branch on across a serialization boundary. `result.error` holds the live error object, but only on the paths that keep one: it is `undefined` for app-level failures, and it collapses to `{}` if the result is JSON-serialized. Read `status` and `errorInfo` unless you specifically need the instance.

## Retry classification

`isRetryableError()` (`packages/core/src/errors.ts`) decides whether another attempt is worth making. It is conservative: it returns `true` unless the error is provably terminal.

Terminal: `InvalidTaskRequirementsError`, `TokenBudgetExceededError`, `CostBudgetExceededError`, `InvalidMessageError`, `StructuredOutputValidationError`, `UnsupportedToolCallError`, `EgressPolicyError`, `UnsupportedToolResultContentError`, `UnsupportedContentBlockError`, `JournalLineageError`, `RoutingProfilerFailedError`, `RoutingDeclarationRequiredError`, any cancellation, and any 4xx status other than 408, 409, and 429.

Retryable: `LLMCallTimeoutError`, `RoutingTimeoutError`, errors carrying no numeric status (network blips), 408, 409, 429, and every 5xx.

`executeWithRetry()` (`packages/core/src/orchestrator/retry.ts`) consumes that classification at the task level. Retry is off by default (`maxRetries: 0`). It prefers `result.errorInfo.retryable === false` over re-classifying `result.error`, so a framework failure whose raw `Error` was stripped by a hook or a serialization seam still skips pointless attempts. Two cases bypass retry entirely: a `'suspended'` status is a durable continuation boundary, and a `DurableApprovalError` is rethrown rather than retried.

## Budget errors

### `TokenBudgetExceededError`

`code: 'TOKEN_BUDGET_EXCEEDED'`. Carries `agent`, `tokensUsed`, `budget`.

The framework never throws this class; it constructs it as a value. `applyBudgetAccounting()` returns it as `exceeded` when cumulative tokens cross `maxTokenBudget` (`packages/core/src/orchestrator/budget.ts`), and `Agent` builds one whenever a run reports `budgetExceeded` so the result carries a classified status.

Caller sees: `result.status.code === 'budget_exhausted'`, `result.errorInfo.kind === 'budget'`, and `result.budgetExceeded === true`. `emitBudgetExceeded()` also fires an `OrchestratorEvent` of type `budget_exceeded` carrying the instance as `data`, and the streaming runner yields a `StreamEvent` of type `budget_exceeded` with the same payload.

`result.error` is **not** the place to look for it. The ordinary budget paths build the result from `classifyRunFailure()`'s `status` and `errorInfo` only, and `Agent`'s post-hook `ensureAgentOutcome()` re-derives those two fields without attaching an instance. Exactly one path differs: `Agent`'s structured-output corrective retry, where the retry attempt itself crosses the ceiling and the returned result carries `error` as well. Branch on `status.code` or `errorInfo.code`, not on `error`.

Terminal: a retry would re-cross the same ceiling.

### `CostBudgetExceededError`

`code: 'COST_BUDGET_EXCEEDED'`. Carries `agent`, `costUsed`, `budget`.

Constructed only by `applyBudgetAccounting()`, and only when both `maxCostBudget` and `estimateCost` are configured. OMA ships no price table, so without `estimateCost` there is no cost to compare.

Visibility matches the token budget error, minus the exception: no path attaches a `CostBudgetExceededError` to `result.error` at all. Every consumer builds the failed result by spreading `classifyRunFailure()`, so it reaches callers only through `status`, `errorInfo`, `budgetExceeded`, and the `budget_exceeded` progress event. Terminal for the same reason.

A related failure is not an OMA error class: if `estimateCost` returns a non-finite or negative number, `estimateIncrementalCost()` throws a plain `Error` naming the agent, which then follows the ordinary failure path.

## Timeout and routing errors

### `LLMCallTimeoutError`

`code: 'LLM_CALL_TIMEOUT'`. Carries `timeoutMs` and optional `agent`.

Thrown by `AgentRunner.chatWithCallTimeout()` when `AgentConfig.callTimeoutMs` elapses for a single `adapter.chat()` request and the caller's own `abortSignal` did not fire. That last condition is what separates a stalled provider from a deliberate abort. It applies to every model call the runner owns, including summarize-based context compaction, so behavior no longer depends on each vendor SDK's default request timeout. It is distinct from `AgentConfig.timeoutMs`, which bounds the whole run.

Caller sees: a failed run result with `status.code: 'timeout'` and `errorInfo.kind: 'timeout'`. Retryable, so an orchestrated task with `maxRetries` set will try again.

### `RoutingTimeoutError`

`code: 'ROUTING_TIMEOUT'`. Carries `timeoutMs` and `stage: 'router' | 'profiler'`.

`stage: 'router'` is rejected inside `decideWithTimeout()` (`packages/core/src/orchestrator/execution-router.ts`) when a custom `ExecutionRouter` exceeds `executionRouting.timeoutMs`. `resolveExecutionRouting()` catches it and falls back to the deterministic router, unless the caller aborted or `failurePolicy: 'fail'` is set, in which case it rethrows.

`stage: 'profiler'` is rejected by the timeout race in `runSemanticProfiler()` (`packages/core/src/orchestrator/orchestrator.ts`) when the hybrid `TaskProfiler` exceeds the same deadline. With the default `failurePolicy: 'fallback'`, the assessment records `outcome: 'fallback'` with `fallback_code: 'profiler-timeout'` and the run continues on the deterministic decision. With `'fail'`, it is rethrown out of `runTeam()`.

Retryable by classification, and mapped to `status.code: 'timeout'` when it reaches a result. See [execution routing](execution-routing.md).

### `RoutingProfilerFailedError`

`code: 'ROUTING_PROFILER_FAILED'`. Carries an optional `cause`.

Constructed in `runSemanticProfiler()` to wrap any non-timeout profiler failure, including a `TaskProfileValidationError` from `LLMTaskProfiler`. Terminal. It only reaches your `await` when `executionRouting.failurePolicy === 'fail'`; otherwise the run continues on the deterministic route and the fallback code (`invalid-profile`, `profiler-unavailable`, or `profiler-error`) is recorded on the routing span and assessment.

### `RoutingDeclarationRequiredError`

`code: 'ROUTING_DECLARATION_REQUIRED'`. Carries `reasons` and an optional `assessment`.

Thrown by `runTeam()` when hybrid semantic routing returns `recommendation: 'needs-declaration'`: inferred high-risk semantics require an explicit governance topology rather than a model-selected route. The run journal and trace root are closed with an error status first, then the error is thrown. Terminal, and it always reaches your `await`. Fix it by declaring `governanceIntent` with `requiredRoles` (see [tool configuration](tool-configuration.md#declared-governance-roles-in-runteam)) or by choosing an explicit `mode`.

## Input and output validation errors

### `InvalidMessageError`

`code: 'INVALID_MESSAGE'`. Message-only.

Raised from three places:

- `assertValidMessages()` in `packages/core/src/llm/validate.ts`, for anything that is not a well-formed `LLMMessage[]`.
- `prepareAgentRunInput()` / `prepareAgentPromptInput()` in `packages/core/src/agent/input.ts`, for input that cannot be structured-cloned, or structured input aimed at a text-only external backend.
- `Agent`'s `beforeRun` plumbing, when a hook returns a non-string `prompt`, or when it rewrites `messages` for an agent whose `backend` accepts prompt rewrites only.

Where it surfaces depends on which one fired. Input preparation runs outside `executeRun()`'s `try`, so it rejects `agent.run()` and `orchestrator.runAgent()` at the caller's `await`. A `beforeRun` failure is caught and classified with `errorInfo.kind: 'callback'`. Terminal in both cases. See [structured input](structured-input.md).

### `StructuredOutputValidationError`

`code: 'STRUCTURED_OUTPUT_VALIDATION_FAILED'`. Carries `cause`.

Constructed by `Agent` when `outputSchema` is set and the output still fails validation after the built-in single corrective retry. It is never thrown: the agent returns a failed result with `status`, `errorInfo` (classified with `kind: 'validation'`), and `error`. Terminal for orchestrator-level retries by design, because re-running the same prompt is not a transport recovery strategy.

### `InvalidTaskRequirementsError`

`code: 'INVALID_TASK_REQUIREMENTS'`. Carries `issues: readonly TaskRequirementIssue[]`.

Raised when a task has no eligible agent, or its explicit assignee does not satisfy the task's hard `requires`. Three call sites use it, and they surface differently:

- Whole-plan validation in the coordinator path of `runTeam()`, after the plan is loaded into the queue. The error is converted by `classifyRunFailure(error, { kind: 'validation' })` into a failed `TeamRunResult`, and an `OrchestratorEvent` of type `error` carries `code` and `issues`.
- Whole-queue validation in the shared explicit-task path (`runTasks()`, `runFromPlan()`, `restore()`, and the declared-governance `runTeam()` topology). Here an `error` progress event fires and the error is then **thrown**, so it reaches the caller's `await`.
- Per-task validation at dispatch time in `executeQueue()` (`packages/core/src/orchestrator/task-execution.ts`). Also thrown. The pipeline records it in `dispatchErrors`, stops admitting new tasks, lets in-flight work settle, skips the remainder, and then rethrows.

Issue codes are `NO_ELIGIBLE_AGENT` and `ASSIGNEE_REQUIREMENTS_MISMATCH`; see [task scheduling](task-scheduling.md#assignment-strategies). Terminal.

## Provider capability errors

All three are raised by adapter code before or while mapping a request or response, and all three are terminal: the block and the adapter are both fixed for the attempt, so a retry re-runs the identical conversion.

### `UnsupportedToolCallError`

`code: 'UNSUPPORTED_TOOL_CALL'`. Carries `provider` and `toolType`.

Thrown by the OpenAI-compatible response mapper (`packages/core/src/llm/openai-common.ts`) when a provider returns a tool-call type OMA cannot execute. OMA exposes JSON-schema function tools only; failing loudly keeps a provider's custom-tool response from being mistaken for a successful empty turn.

### `UnsupportedToolResultContentError`

`code: 'UNSUPPORTED_TOOL_RESULT_CONTENT'`. Carries `provider`, `contentType`, and an optional detail suffix.

Thrown before an SDK request when a built-in adapter cannot faithfully map a model-visible tool-result part. Raised by the Anthropic, OpenAI-compatible, and Bedrock request mappers.

### `UnsupportedContentBlockError`

`code: 'UNSUPPORTED_CONTENT_BLOCK'`. Carries `provider`, `blockType`, and an optional detail suffix.

Thrown before an SDK request when an adapter has no wire mapping for a whole model-visible content block. Raised by the Gemini, Bedrock, Anthropic, and AI SDK adapters. The class exists specifically so this case does not fall through `isRetryableError()`'s conservative default and spend the whole backoff ladder, plus a checkpoint rewrite per attempt, on a capability gap that cannot resolve itself. See [structured input](structured-input.md#which-adapters-accept-which-blocks).

## Egress policy errors

### `EgressPolicyError`

Carries `reason: 'invalid-policy' | 'denied' | 'unsupported' | 'unresolved-target'`, plus optional `provider` and `origin`. `code` is derived from `reason`: `INVALID_EGRESS_POLICY`, `EGRESS_POLICY_DENIED`, `EGRESS_POLICY_UNSUPPORTED`, `EGRESS_POLICY_TARGET_UNRESOLVED`.

Raised in `packages/core/src/llm/egress.ts` before a framework-owned LLM transport opens a request: on an invalid policy shape or allowlist entry, on a resolved origin outside the effective policy, on an adapter whose transport OMA cannot guard, and on a provider whose target cannot be resolved from configuration and environment.

Terminal, and never retried, because another attempt cannot widen a policy. `classifyRunFailure()` maps it to `status.code: 'rejected'` with `errorInfo.kind: 'validation'`. A direct `createAdapter()` call rejects with the same class. See [egress policy](egress-policy.md#errors-and-audit-behavior).

## Journal lineage errors

### `JournalLineageError`

`code: 'MISSING_CONTEXT_REPLACE'`, which deliberately differs from the class name. Carries `messageIndex`, `blockIndex`, and `blockType`.

Thrown by `AgentRunner.describeRequestBlocks()` before an adapter call, when the run journal has `enforceLineage` on and a model-visible block cannot name the journal event it came from. Enforcement is off by default. Failing at the request that would have hidden the gap, rather than at verification time, is the point. Terminal: a lineage gap is a property of the conversation, not the transport, so the same request would fail identically on every attempt. See [run journal](run-journal.md#enforcelineage).

## Store, CLI, and Run Viewer errors

These four are defined outside `errors.ts` and are not part of `isRetryableError()`'s classification.

### `TraceStoreError`

Defined in `packages/core/src/observability/store.ts`. Exported from the package root and from `@open-multi-agent/core/observability`. Carries `code: 'INVALID_ARGUMENT' | 'INVALID_CURSOR' | 'UNSUPPORTED_SCHEMA_VERSION'` and an optional `field`.

The shared validation failure for every `TraceStore` implementation. Thrown synchronously from store methods (append validation, cursor parsing, schema checks) and reaches the caller's `await` on the store call. Losing telemetry must never roll back a durable run, so a store error is not converted into a run failure. See [observability](observability.md#tracestore-query-and-reference-storage).

### `FileTraceStoreError`

Defined in `packages/core/src/observability/file-store.ts`. Exported **only** from `@open-multi-agent/core/observability/file`, not from the package root. Carries `code: FileTraceStoreErrorCode` plus optional `operation`, `path`, `lineNumber`, and `causeCode`.

A payload-free, structured lifecycle or filesystem failure. Its code set covers path validation, open/read/write/sync/close, corrupt files, unsupported file format or trace schema, recovery, compaction and rename, and use after close. See [observability](observability.md#filetracestore-persistent-single-process-reference).

### `RunViewerInputError`

Defined in `packages/core/src/dashboard/run-viewer-model.ts`. Exported from the package root, together with the `RunViewerInputErrorCode` type. Carries `code: 'MISSING_SOURCE' | 'RUN_ID_MISMATCH' | 'UNSUPPORTED_SCHEMA_VERSION'`.

Thrown by `buildRunViewerModel()` (and therefore `renderRunViewer()`) when neither `result` nor `run` is supplied, when the two name different runs, or when the stored run's schema major does not match. See [run viewer](run-viewer.md).

### `OmaValidationError`

Defined in `packages/core/src/cli/oma.ts` and **not exported**. It is internal to the `oma` CLI and has no importable path. It marks bad flags, bad JSON shapes, and unloadable modules; the CLI's error mapper turns it into `kind: 'validation'` and exit code 2. `FileTraceStoreError` is mapped to exit code 2 as well, and `DashboardCliError` supplies its own exit code. See [CLI exit codes](cli.md#exit-codes).

## Other exported error classes

Two more error classes ship on the public surface but belong to their own subsystems:

- **`DurableApprovalError`** (`packages/core/src/approval/durable.ts`, exported from the package root with `DurableApprovalErrorCode`). Codes: `APPROVAL_ATOMIC_STORE_REQUIRED`, `APPROVAL_CONFLICT`, `APPROVAL_INTEGRITY_ERROR`, `APPROVAL_NOT_FOUND`, `APPROVAL_STALE_DECISION`, `APPROVAL_VALIDATION_ERROR`. `executeWithRetry()` rethrows it instead of retrying, so it escapes the task loop. See [durable approvals](durable-approvals.md).
- **`TaskProfileValidationError`** (`packages/core/src/orchestrator/task-profiler.ts`, exported from the package root). Carries optional `usage`, `model`, and `provider` so a failed profile call is still accounted for. It is normally wrapped into `RoutingProfilerFailedError` before it leaves routing.

## Quick reference

| Class | Import path | Raised when | Retryable | Caller reads it at |
|---|---|---|---|---|
| `InvalidTaskRequirementsError` | root | A task has no eligible agent, or its assignee fails `requires` | No | Failed `TeamRunResult` from coordinator plan validation; thrown from the explicit-task path and from dispatch |
| `TokenBudgetExceededError` | root | Cumulative tokens cross `maxTokenBudget` | No | `status.code: 'budget_exhausted'`, `errorInfo.kind: 'budget'`, `budgetExceeded`, `budget_exceeded` progress and stream events |
| `CostBudgetExceededError` | root | Estimated cost crosses `maxCostBudget` (needs `estimateCost`) | No | Same, minus the stream event; never on `result.error` |
| `LLMCallTimeoutError` | root | One `adapter.chat()` exceeds `callTimeoutMs` | Yes | `status.code: 'timeout'` on the run result |
| `RoutingTimeoutError` | root | A router or the semantic profiler exceeds `executionRouting.timeoutMs` | Yes | Deterministic fallback by default; thrown when `failurePolicy: 'fail'` |
| `RoutingProfilerFailedError` | root | The profiler produced no valid task profile | No | Fallback by default; thrown when `failurePolicy: 'fail'` |
| `RoutingDeclarationRequiredError` | root | Hybrid routing infers high-risk semantics needing an explicit topology | No | Thrown from `runTeam` |
| `InvalidMessageError` | root | Malformed `LLMMessage[]`, uncloneable input, or a disallowed `beforeRun` rewrite | No | Thrown from input preparation; a failed result with `kind: 'callback'` from `beforeRun` |
| `StructuredOutputValidationError` | root | `outputSchema` still unsatisfied after the corrective retry | No | Failed run result with `kind: 'validation'` |
| `UnsupportedToolCallError` | root | A provider returned a tool-call type OMA cannot execute | No | Failed run result, `errorInfo.code: 'UNSUPPORTED_TOOL_CALL'` |
| `EgressPolicyError` | root | Invalid policy, denied origin, unenforceable adapter, or unresolved target | No | `status.code: 'rejected'`; also rejects `createAdapter()` |
| `UnsupportedToolResultContentError` | root | An adapter cannot map a model-visible tool-result part | No | Failed run result |
| `UnsupportedContentBlockError` | root | An adapter has no wire mapping for a content block | No | Failed run result |
| `JournalLineageError` | root | `enforceLineage` is on and a model-visible block has no journal lineage | No | Failed run result, `code: 'MISSING_CONTEXT_REPLACE'` |
| `DurableApprovalError` | root | Approval persistence, integrity, or concurrency failure | Rethrown, never retried | Thrown out of the task loop |
| `TaskProfileValidationError` | root | `LLMTaskProfiler` output fails its schema | No | Usually wrapped as `RoutingProfilerFailedError` |
| `TraceStoreError` | root, `/observability` | Invalid store argument, cursor, or schema version | n/a | Thrown from the store call |
| `RunViewerInputError` | root | Missing, mismatched, or unsupported Run Viewer input | n/a | Thrown from `buildRunViewerModel` / `renderRunViewer` |
| `FileTraceStoreError` | `/observability/file` | `FileTraceStore` lifecycle or filesystem failure | n/a | Thrown from the store call; CLI exit code 2 |
| `OmaValidationError` | not exported | Bad CLI flags, JSON shapes, or module loads | n/a | `oma` stderr and exit code 2 |
