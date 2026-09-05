# Durable approval gates

OMA can stop a checkpointed task run at an approval boundary, return a durable
request to the application, and continue from the same reviewed content after a
process restart. Existing synchronous decisions are unchanged: `true` and
`{ action: 'allow' }` continue, while `false` and `{ action: 'deny' }` reject.
Return `{ action: 'suspend' }` only when the decision must happen outside the
current callback lifetime.

Durable approval is an execution-state feature, not a telemetry feature. The
checkpoint owns the suspended continuation. A separate primary approval row in
the same `MemoryStore` owns the immutable request and first-wins decision.
Traces and execution receipts may derive approval facts, but losing telemetry
does not lose or change a decision.

## Supported boundaries

| Gate | Reviewed content | Resume behavior |
|---|---|---|
| `onPlanReady` | The checkpoint-resumable coordinator task snapshots and whether the caller requested execution or `planOnly` | Runs exactly those snapshots, or returns them for `planOnly` |
| `onApproval` | The completed tasks and next pending tasks at a legacy round barrier | Starts the reviewed next round without calling the gate again for that boundary |
| `onTaskDispatch` | One fully assigned task snapshot immediately before dispatch | Dispatches that exact task without calling the gate again for that boundary |
| `onToolCall` | Tool name, model-issued input, Zod-validated input, agent, task, tool-call ID, and `consequential` flag | Applies the durable decision instead of re-running the gate; approval executes the validated invocation, rejection returns a denied `ToolResult` without calling the tool |

Plan, round, and dispatch gates accept `ApprovalGateDecision`. Tool gates accept
`ToolCallDecision`; both include the same `allow`, `deny`, and `suspend` object
forms. The boolean forms remain supported on the three existing orchestration
gates for backward compatibility.

## Suspend, decide, and restore

Suspension requires checkpoint configuration and a checkpoint `MemoryStore`
that implements atomic `compareAndSet`. The store must remain available to the
reviewer and the resumed process.

```typescript
import {
  decideApproval,
  FileStore,
  OpenMultiAgent,
} from '@open-multi-agent/core'

const store = new FileStore('./.oma/release-run.json')
const orchestrator = new OpenMultiAgent({
  onTaskDispatch: async (task) => {
    if (task.priority === 'critical') {
      return { action: 'suspend', reason: 'Critical release review' }
    }
    return true
  },
})

const suspended = await orchestrator.runTasks(team, tasks, {
  checkpoint: { store },
})

if (suspended.status?.code === 'suspended') {
  for (const request of suspended.pendingApprovals ?? []) {
    // Present request.content and request.requestHash to the reviewer.
    await decideApproval(store, {
      requestId: request.id,
      requestHash: request.requestHash,
      decision: 'approve', // or 'reject'
      reviewer: { id: currentUser.id, displayName: currentUser.name },
    })
  }
}

// A fresh process rebuilds the same team/backend wiring and uses the same store.
const result = await new OpenMultiAgent({
  onTaskDispatch: applicationDispatchPolicy,
}).restore(resumedTeam, { checkpoint: { store } })
```

A suspended result has `success: false`, `status.code === 'suspended'`, and one
or more `pendingApprovals`. Do not call `restore()` to force progress while a
request is undecided: it returns `suspended` again and performs no reviewed
work.

The public reviewer helpers are:

- `getApprovalRecord(store, requestId)` — read the primary request and any
  decision;
- `decideApproval(store, input)` — atomically approve or reject an exact
  `requestHash`;
- `DurableApprovalLedger` — the lower-level equivalent for applications that
  want a long-lived ledger object.

`decideApproval` records the reviewer's required `id`, optional `displayName`,
the normalized decision, and the decision-writer's current time. Decisions are
immutable: the first successful compare-and-set wins; concurrent or repeated
decisions fail with `APPROVAL_CONFLICT`.

## Exact-content binding

Every request has a deterministic ID and a SHA-256 `requestHash`. The hash is
computed over canonical JSON containing the approval scope, boundary, and
review content. Object-key ordering cannot change it. The explanatory `reason`
and `requestedAt` are metadata and are not part of the reviewed-content hash.

The binding covers the serialized `request.content`, not live application
wiring. Agent adapters, prompts, tool implementations, schemas, and callbacks
must be rebuilt by the application and remain inside its deployment trust
boundary. Task-level suspension fails closed when a pending task has `verify`
configuration because that object can contain live judges, schemas, and prompt
callbacks that the current checkpoint schema cannot reconstruct.

The reviewer must submit both `requestId` and the hash it inspected. A changed
hash fails with `APPROVAL_STALE_DECISION`. During restore, OMA independently
compares the request with the checkpointed plan, task state, or pending tool
call. It also compares checkpointed decision history with the primary ledger.
A mismatch fails before the approved task or tool can execute.

For tool calls, restore validates the raw input again with the current Zod
schema and compares the resulting validated value with the reviewed content.
This prevents a changed input or changed validation result from inheriting an
old approval. The reviewed content must be JSON-compatible: finite numbers,
strings, booleans, nulls, arrays, and plain objects only.

This is integrity checking across OMA's independent records, not a
cryptographic signature against the storage administrator. A principal that
can rewrite both the checkpoint and primary ledger remains inside the trust
boundary. Protect and audit the store accordingly.

## Rejection and recovery semantics

- Rejecting a plan, round, or task dispatch produces a top-level `rejected`
  result and skips remaining work. The terminal rejection survives repeated
  restores.
- Rejecting a tool call produces the same kind of error `ToolResult` as an
  inline gate denial. The tool is not invoked; the model may adapt on its next
  turn.
- Approving a tool call executes it once, then the mid-task checkpoint records
  its returned result before the model continues. The ordinary
  [external-side-effect idempotency window](checkpoint.md#mid-task-tool-recovery)
  still applies if a process dies after an external system commits but before
  the tool returns.
- An ordinary checkpoint write remains best-effort. The write that makes a
  pending approval resumable is strict: OMA does not report suspension unless
  the exact continuation was saved and the primary request was created.
- A missing checkpoint, missing CAS capability, malformed record, or stale
  content fails closed. The protected task or tool is not executed.

`approvalDecisions` on the final result contains decisions consumed by the
logical run. `buildExecutionReceipt()` copies a bounded approval summary from
that result. The receipt is derived evidence; the primary row under
`__oma_approval__/<requestId>` remains authoritative.

## Store requirements

`InMemoryStore` provides process-local CAS and is useful for tests. `FileStore`
provides CAS for concurrent callers sharing one `FileStore` instance. It is
still a single-writer file store with no cross-process lock: an out-of-process
reviewer should decide after the suspended writer exits, or use a database
store whose `compareAndSet` is atomic across all writers.

Approval requests can contain complete task descriptions and raw/validated
tool arguments. They are persisted verbatim so the approved operation remains
exact. Use access controls and encryption appropriate for that data.
`RedactingStore` is intentionally unsupported for durable approvals because it
is lossy and would change the content hash; it remains available for ordinary
checkpoint and shared-memory redaction.

## What the framework provides, and what you build

The framework's side of an approval is the execution mechanism and the durable
record: the gates that can return `{ action: 'suspend' }`, the primary approval
row keyed under `__oma_approval__/<requestId>`, the exact-content binding, the
`getApprovalRecord` / `decideApproval` / `DurableApprovalLedger` reviewer
helpers, and `OpenMultiAgent.restore()`. That is the whole surface.

There is deliberately no reviewer product on top of it:

- **No approval UI.** Nothing in the package renders a request or collects a
  decision.
- **No CLI command.** The `oma` CLI is a non-interactive wrapper. Its commands
  are `run`, `task`, `dashboard`, `eval run`, `eval gate`, `provider`, and
  `help`; there is no `approve` or `reject`.
- **No transport.** OMA never notifies a reviewer, routes a request to a queue,
  or exposes an HTTP endpoint. A suspended run returns `pendingApprovals` to
  the caller and stops.
- **The dashboard is read-only about approvals.** The Run Viewer maps the
  `oma.approval.approved` and `oma.plan.approved` trace facts to display labels
  and renders them alongside the rest of the run. It is a post-run HTML
  artifact with no write path back into the ledger.

An integrator therefore supplies three things:

1. **A store.** A `MemoryStore` whose `compareAndSet` is atomic across every
   writer that will decide, and that is reachable from both the suspended
   process and the reviewer. Suspension fails closed with
   `APPROVAL_ATOMIC_STORE_REQUIRED` when the store cannot decide atomically.
   See [Store requirements](#store-requirements) for what the bundled stores
   do and do not give you.
2. **A review surface.** Something that shows the reviewer `request.content`
   and `request.requestHash`, and collects back a decision plus a reviewer
   identity. The hash is the part that matters: a reviewer who submits a hash
   they did not inspect defeats the exact-content binding, and OMA cannot tell
   the difference. Authentication, authorization, and the audit trail of who
   was shown what are entirely yours.
3. **A resume path.** A process that calls `decideApproval(store, { requestId,
   requestHash, decision, reviewer })` and then rebuilds the team wiring and
   calls `restore(team, { checkpoint: { store } })`. The two can be the same
   process or different ones, subject to the store's cross-writer guarantees.

## Explicit limits

- Tool-call suspension is supported only inside checkpointed built-in LLM
  workers reached through `runTeam`, `runTasks`, or `runFromPlan`. Standalone
  `runAgent`, the automatic `runTeam` simple-goal short circuit, process
  backends, and ACP backends do not expose resumable private tool-loop state; a
  `suspend` tool decision fails closed there. Orchestration-level plan, round,
  and dispatch gates still apply around eligible external-backend tasks.
- An approval binds the serialized request data, not deployed code or live
  agent configuration. Changing an adapter, prompt, tool implementation, or
  schema is an application deployment boundary. Pin a deployment while a run
  is suspended, or include an application-owned version in reviewed task/tool
  data when that distinction matters.
- A task with `verify` may still use existing inline boolean approval, but its
  plan/round/dispatch gate cannot return `suspend`. Model verification as an
  explicit task when it must be part of a durable approval boundary.
- Adaptive recovery's `onPlanPatch` callback is not suspendable in this
  contract. It remains an inline boolean decision.
- There is no built-in expiry, reassignment, revocation, quorum, or replacement
  of a recorded decision. Applications can decline to resume and start a new
  logical run when policy requires a new request.
- Checkpoints remain latest-snapshot state. Append-only event sourcing and
  transition replay are separate work tracked in
  [#313](https://github.com/open-multi-agent/open-multi-agent/issues/313).

See the no-key runnable
[`durable-approval`](../packages/core/examples/patterns/durable-approval.ts)
example for the complete suspend/decide/fresh-orchestrator flow.
