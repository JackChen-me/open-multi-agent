# Task scheduling and dispatch

`runTeam()`, `runTasks()`, `runFromPlan()`, and `restore()` execute task DAGs
through the same scheduler and queue. The default executor is event-driven: a
downstream task starts as soon as its dependencies are satisfied; it does not
wait for unrelated tasks that became ready at the same time.

## Event-driven execution

The executor maintains a ready set and an in-flight map:

1. `TaskQueue` emits `task:ready` when a task has no unresolved dependencies.
2. The scheduler assigns that one ready task against the current DAG snapshot.
3. The dispatch gate checks cancellation, budget state, approval state, and
   AgentPool capacity.
4. The task is dispatched through `AgentPool`.
5. Completion immediately unblocks dependents and wakes the executor.

`AgentPool`'s semaphore remains the concurrency authority, including ephemeral
`delegate_to_agent` runs. The dispatch gate is an integration seam; it does not
add resource locks or a second concurrency system.

Task failure and skip propagation still belong to `TaskQueue`. A failed or
skipped task cascades to its dependents immediately, while unrelated branches
continue.

## Task retry boundaries

Task retry is opt-in through `maxRetries`. The executor prefers the stable
`AgentRunResult.errorInfo.retryable` classification and falls back to the
in-process `error` object when needed. Validation, caller cancellation, and
budget exhaustion are terminal; provider rate limits, server failures, network
errors, and call timeouts remain retryable. This classification survives hooks
or serialization seams that do not retain the original Error instance.

An agent configured with `outputSchema` has a separate, single in-run
correction: if its first response is invalid, the same agent receives schema
feedback once. If that correction also fails, OMA returns
`StructuredOutputValidationError`; task-level retry does not restart the whole
prompt. Whole-run timeout, caller cancellation, and the cumulative token budget
remain authoritative across both structured-output attempts.

## Task results and dependency payloads

`TeamRunResult.agentResults` remains keyed by agent name and preserves its
existing merge behavior when one agent executes multiple tasks. Task runs also
populate `TeamRunResult.taskResults`, keyed by stable task ID, so every task's
unmerged `AgentRunResult` remains available:

```ts
const result = await orchestrator.runTasks(team, tasks)
const extractTask = result.tasks?.find(task => task.title === 'Extract')
const extracted = extractTask
  ? result.taskResults?.get(extractTask.id)?.structured
  : undefined
```

The two indexes reference the same underlying executions. Run-level token usage
and metrics are calculated once from the internal results; exposing
`taskResults` does not count usage twice.

Direct dependencies still inject raw `output` by default. An explicit task can
opt into validated structured handoff:

```ts
{
  title: 'Review',
  description: 'Review validated extraction records.',
  dependsOn: ['Extract'],
  dependencyPayload: 'structured', // 'output' (default) | 'structured' | 'both'
}
```

`structured` injects only canonical JSON derived from the dependency's
successful `AgentRunResult.structured`; narrative text in `output` is excluded.
`both` injects labeled raw and structured sections. A missing or non-serializable
structured value fails the dependent task with
`DEPENDENCY_STRUCTURED_RESULT_MISSING`; OMA never silently falls back to raw
output. Each opt-in dependency payload is limited to 64 KiB before the consumer
agent is invoked, and a larger one fails with `DEPENDENCY_PAYLOAD_TOO_LARGE`.
The default `output` path is unchanged for 1.x compatibility.

## Task role and provenance metadata

`assignee` identifies the concrete worker instance. `role` can separately name
the logical business function, and bounded `metadata` can carry references such
as `sourceFile`, `supplierId`, or `documentId`:

```ts
{
  title: 'Read supplier reply 01',
  description: 'Extract the simulated quote.',
  assignee: 'supplier-reader-01',
  role: 'supplier-extraction',
  metadata: {
    sourceFile: 'fixtures/supplier-01.json',
    supplierId: 'supplier-01',
  },
}
```

Task metadata allows at most 16 entries. Keys are 1–64 characters, begin with a
letter, and otherwise use letters, digits, `.`, `_`, or `-`; each string is at
most 1024 characters and each homogeneous scalar array at most 16 values.
Credential-like keys and the reserved `oma.` prefix are rejected.
Credential-like text in allowed string values is redacted before the metadata
enters results, task trace attributes, checkpoint snapshots, or plan artifacts.

`TaskExecutionRecord` retains `role` and `metadata`. Task spans expose
`oma.task.role` and `oma.task.meta.<key>`, while legacy task trace events expose
`taskRole` and `taskMetadata`. Execution receipts keep the legacy
`rolesExecuted` assignee semantics and add `workerInstancesExecuted` plus
`taskRolesExecuted` so worker replicas are not confused with business roles.

## Assignment strategies

Before any task is dispatched, the complete plan is validated against explicit
task requirements. Every scheduling strategy filters to eligible agents first;
the configured strategy only ranks or rotates within that eligible set.
`dependency-first` and `composite` order the current ready set by downstream
criticality, `round-robin` retains its cursor, and `least-busy` reads current
`in_progress` load.

Agents may declare `description`, `capabilities`, `costTier`, and
`latencyClass`; none is inferred when omitted. Explicit `runTasks()` specs and
coordinator-generated tasks may add `requires` with `requiredTools`,
`requiredCapabilities`, `requiredBackend`, and `requiredProvider`. Tool
requirements are checked against the final resolved grant set, after presets,
allowlists, denylists, and framework rails.
Provider requirements are also checked after worker model routing. Incompatible
fallback routes are removed rather than crossing the declared provider boundary.

When no roster candidate satisfies an unassigned task, validation fails with
`INVALID_TASK_REQUIREMENTS` and an issue code of `NO_ELIGIBLE_AGENT`. When an
explicit assignee exists but does not satisfy the requirements, the issue code
is `ASSIGNEE_REQUIREMENTS_MISMATCH`. Both cases fail before worker execution;
hard requirements never fall back to an ineligible agent.

`composite` maximizes `fitWeight * fit + loadWeight * (1 - normalizedCurrentLoad)`.
`schedulingWeights.fit` and `schedulingWeights.load` default to `0.7` and `0.3`,
and current load is the agent's `in_progress` task count normalized within the
roster at scheduling time. Composite load is a snapshot of the supplied DAG
state. Assignments earlier in one scheduler call are not folded into that same
call; in event-driven execution the next ready-task call can observe tasks
already marked `in_progress`.

Coordinator plans that name an agent outside the roster fail validation before
task execution by default. Set `strictAssignees: false` only to retain the
legacy behavior of emitting an `INVALID_ASSIGNEE` warning, clearing that
assignment, and using the configured scheduler.

## Approval modes

Two mutually exclusive approval modes are available:

```ts
const pipeline = new OpenMultiAgent({
  onTaskDispatch: async (task) => approveTask(task),
})
```

`onTaskDispatch` runs after a ready task has an assignee and immediately before
dispatch. Returning `false`, or throwing, stops new dispatches. Tasks already in
flight settle before all remaining tasks are marked `skipped`.

```ts
const rounds = new OpenMultiAgent({
  onApproval: async (completedRound, nextRound) =>
    approveRound(completedRound, nextRound),
})
```

Configuring the existing `onApproval` callback automatically selects legacy
round semantics. Its arguments, callback timing, assignment timing, and batch
barrier remain unchanged. Configuring both callbacks throws a configuration
error.

There is no separate `legacyBatchScheduling` option. `onApproval` is already
the compatibility switch required by callers that depend on round boundaries;
a no-op callback returning `true` retains batch scheduling without introducing
a second overlapping mode flag.

For each callback's arguments, timing, and throw behavior alongside the other
approval hooks, see [hooks and callbacks](hooks-and-callbacks.md#approval-gates).

## Interruption, budgets, and checkpoints

Abort, budget exhaustion, and approval rejection share one
**drain-then-skip** path:

1. stop admitting new tasks;
2. wait for every in-flight task to settle;
3. mark all remaining pending or blocked tasks `skipped`.

This prevents a task from being reported as skipped while its agent continues
running. Budget state is checked before dispatch and again after each completion.
Crossing a budget stops new tasks; already-started work still settles. Every
ceiling that can trigger this path is in
[budgets and limits](budgets-and-limits.md).

Checkpointing persists safe built-in-runner turn/tool boundaries as well as
task completions. Writes are serialized through the existing save chain;
restore skips tasks already recorded as completed, replays committed tool
results without re-executing them, and conservatively runs calls that have no
commit record. External agent backends remain task-grained because they own
their private execution loops.

## Progress-event migration

`task_start`, `agent_start`, terminal task events, and their trace spans remain
paired. Their order is no longer grouped into rounds: events from independent
branches can interleave, and a downstream `task_start` can appear before an
unrelated task's terminal event.

Custom UIs should correlate events by `task` ID and derive branch state from
task status and `dependsOn`; do not infer a round boundary from adjacent events.
If a UI must retain round grouping during migration, configure `onApproval` and
return `true`.

See
[`examples/patterns/event-driven-dag.ts`](../packages/core/examples/patterns/event-driven-dag.ts)
for a no-key deferred-promise demonstration. It shows only the supported claim:
the downstream task starts when its dependency is satisfied, without waiting
for an unrelated task from the same ready set.
