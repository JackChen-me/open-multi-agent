# Checkpoint & resume

Long-running task workflows can persist their progress and resume after a crash, an abort, or a process restart. Checkpointing is **opt-in** and runs entirely over the existing [`MemoryStore`](shared-memory.md) interface, so the same in-memory, Redis, Postgres, or custom backend that holds shared memory also holds checkpoints — no extra storage layer.

It covers the orchestration paths (`runTeam`, `runTasks`, `runFromPlan`, and `restore`). A single `runAgent` call has nothing to resume and is not checkpointed.

Checkpoint schema v4 and later also carry suspended continuation state for
[durable approval gates](durable-approvals.md). Approval decisions live in
separate primary records in the same store; they are not telemetry.

## Enable it

Pass `checkpoint` per call, or set a default for every run via `OrchestratorConfig.checkpoint`. Per-call options override the config default.

```typescript
import { OpenMultiAgent, Team, InMemoryStore } from '@open-multi-agent/core'

const store = new InMemoryStore() // for durability across restarts, use FileStore (below) or a custom MemoryStore

const team = new Team({
  name: 'research',
  agents: [researcher, writer],
  sharedMemoryStore: store,
})

const orchestrator = new OpenMultiAgent()

// Snapshots are written at safe in-flight boundaries and after completed tasks.
await orchestrator.runTasks(team, tasks, { checkpoint: { store } })
```

`checkpoint: true` is shorthand: it reuses the team's shared-memory store when the team has one, otherwise a private in-memory store scoped to the orchestrator instance.

```typescript
const orchestrator = new OpenMultiAgent({ checkpoint: true }) // default for all runs
```

### `CheckpointOptions`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `enabled` | `boolean` | `true` | Set `false` to disable for a single run when a config default is on. |
| `store` | `MemoryStore` | team's shared-memory store | Durable backend for checkpoint records. |
| `runId` | `string` | — | Logical run id; derives a per-run checkpoint key. |
| `key` | `string` | — | Exact store key. Takes precedence over `runId`. |

> **A `runId`, `key`, or explicit `store` is required when the team has no shared-memory store.** The instance-level fallback store is shared across every run on the orchestrator, so without a distinct key two concurrent runs would overwrite each other at the default checkpoint key. The call throws rather than risk a silent stomp.

## Durable persistence: `FileStore`

`InMemoryStore` is a plain `Map` — it dies with the process, so a checkpoint held there does not survive a restart. For durability out of the box, use the bundled **`FileStore`**: a zero-dependency, filesystem-backed `MemoryStore` that uses only Node built-ins and adds no runtime dependency to core. Each write lands atomically — temp file → `fsync` → `rename` — so a reader never sees a half-written file, even across a power loss, not just a process crash.

```typescript
import { OpenMultiAgent, Team, InMemoryStore, FileStore } from '@open-multi-agent/core'

const team = new Team({
  name: 'research',
  agents: [researcher, writer],
  sharedMemoryStore: new InMemoryStore(), // hot-path memory stays in RAM
})

const orchestrator = new OpenMultiAgent()

// Checkpoints are durable; a fresh process can resume from the same path.
await orchestrator.runTasks(team, tasks, {
  checkpoint: { store: new FileStore('./.oma/checkpoint.json') },
})
```

**Which store gets the `FileStore`.** Prefer it as the *checkpoint* store, leaving shared memory on a fast `InMemoryStore` (above). A separate checkpoint store self-embeds the shared-memory snapshot (see [What gets saved](#what-gets-saved)), so resume rebuilds everything from the one file — while durability I/O stays at checkpoint cadence (safe agent/tool boundaries and completed tasks) instead of firing on every agent memory write. Using `FileStore` as `sharedMemoryStore` also works and is durable, but then *every* shared-memory write rewrites the whole file; reach for that only when shared memory itself must survive a restart independently of checkpoints.

**Scope.** One process at a time — there is no cross-process file lock, so this is not a shared database. Concurrent writes *within* a process are serialized and safe. That matches the resume story, which is inherently sequential (process A crashes, process B resumes). A corrupt or unreadable state file makes the store throw rather than silently start empty, so durable data is never quietly discarded.

## Resume

`restore()` loads the latest checkpoint, rebuilds the task queue and shared memory, skips completed tasks, and runs the remainder. If a built-in LLM runner stopped mid-task, restore also reloads its completed turns, token usage, and tool-call state before continuing.

```typescript
// After a crash/restart: same team wiring, same store.
const resumedTeam = new Team({
  name: 'research',
  agents: [researcher, writer],
  sharedMemoryStore: store,
})

const result = await orchestrator.restore(resumedTeam, { checkpoint: { store } })
```

A restored `runTeam` run re-runs the coordinator synthesis, so you get the same synthesized final answer (under `result.agentResults.get('coordinator')`) as a fresh `runTeam`, not just the raw per-task outputs. Re-supply the coordinator config you used originally — the checkpoint can't persist a live adapter:

```typescript
const result = await orchestrator.restore(resumedTeam, {
  checkpoint: { store },
  coordinator: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, // same as the original runTeam
})
```

If synthesis can't run (no usable coordinator config or credentials) or the synthesis call fails, restore is best-effort: it returns the raw per-task outputs without a `'coordinator'` entry and emits an `onProgress` `synthesis_failed` event. `runTasks` / `runFromPlan` runs never synthesize.

If no checkpoint is found, `restore()` falls back to a normal run of the tasks or plan you pass — so the same call works for both first run and resume:

```typescript
// Fresh store → runs all tasks. Existing checkpoint → resumes, skipping done tasks.
await orchestrator.restore(team, tasks, { checkpoint: { store } })
await orchestrator.restore(team, plan,  { checkpoint: { store } })  // PlanArtifact
await orchestrator.restore(team,        { checkpoint: { store } })  // resume-only, no-op on empty store
```

## What gets saved

At each safe in-flight runner boundary and after each successfully completed task, the orchestrator writes the latest `CheckpointSnapshot`:

- **Execution identity (schema v4 and later)** — `runId`, current `attempt`,
  `lastTraceId`, and `lastRootSpanId`. Restore preserves the logical `runId`,
  increments `attempt`, creates fresh trace/root IDs, and returns a
  `continued_from` link to the prior attempt.
- **Task queue state** — every task and its status partition (pending / in-progress / completed / failed / blocked / skipped).
- **Shared memory** — the turn counter is always recorded. The full entry snapshot is embedded **only when the checkpoint store differs from the team's shared-memory store**. When they are the same store (the default for `checkpoint: true`), the entries are already durable there, so re-embedding them at every safe boundary would be wasted write volume across a long run; resume reads them straight from the store instead. Either way, resume rehydrates shared memory correctly.
- **Completed task results** — `taskId`, `assignee`, raw `result`, and the
  JSON-safe `AgentRunResult` for each finished task. This preserves per-task
  `structured`, normalized status/error details, token usage, tool calls, and
  messages so `TeamRunResult.taskResults` can be rebuilt after restore. The
  in-process-only raw `error` object is not persisted. If caller-added result
  data cannot be JSON-serialized, checkpoint durability wins: the full result
  is omitted for that task and restore rebuilds the legacy minimal result.
- **In-flight runner state** — for every active built-in LLM worker: the full
  model conversation, messages produced by the task, completed turn count,
  token usage, tool-call records, the next recovery phase, and any pending tool
  calls. Tool results are committed independently by model-issued tool-call ID,
  so a parallel turn may contain both replayable results and calls that still
  need execution. Model-visible image/file tool results are part of those
  messages: inline base64 is embedded in checkpoint JSON, while URL references
  are stored as URLs. Application-owned `ToolResult.data` is not part of the
  conversation unless the application separately puts it there.
- **Approval continuation state** — exact pending approval requests plus the
  decisions already consumed by this logical run. The authoritative request /
  decision row is stored separately under `__oma_approval__/<requestId>` and is
  checked against the checkpoint during restore.
- **Task handoff/provenance config** — `dependencyPayload`, logical `role`, and
  validated task `metadata` remain on the queue snapshot, so resumed consumers
  use the same data-flow and trace references as the original run.
- **Journal watermark (schema v5 only)** — `journalWatermarkSeq`, the highest
  [run journal](run-journal.md) sequence this snapshot folds, plus an
  informational `journalRef` naming the backend. Each in-flight entry also
  carries its own `journalSeq`. Present only when the run had journaling
  enabled; see [Tail replay](#tail-replay).

Snapshots are stored as JSON under a reserved namespace: `__oma_checkpoint__/<runId>/latest` (or `__oma_checkpoint__/latest` when no `runId` is set). Keys under `__oma_checkpoint__/` and `__oma_approval__/` are reserved — shared-memory snapshot/restore deliberately skips them so one store can hold agent memory, checkpoints, and primary approval records.

A run with a journal writes checkpoint schema v5; a run without one keeps
writing v4 exactly as before, so enabling the journal is the only thing that
changes the schema. Schemas v1 through v4 remain readable; v1 and v2 contain no
in-flight runner state, so their active tasks resume from the task boundary.
Schema v3 retains mid-task tool recovery but has no durable approval
continuation. A v1 checkpoint's optional top-level `runId` is preserved, and
restore treats the saved execution as attempt 1. A v1 checkpoint without
`runId` receives a new logical run ID. If a caller-supplied restore `runId`
conflicts with the snapshot, restore throws a validation error instead of
joining unrelated runs.

### Tail replay

A snapshot is written at safe boundaries, so a crash between two boundaries
loses whatever happened in between — most expensively, a tool that ran and
returned but whose result was never persisted. When a run journal is supplied
to `restore()` **and** the snapshot is v5, restore replays the journal past what
the snapshot already holds and folds those events into the in-flight state
before resuming. In practice that turns "re-execute the tool call" into "replay
its recorded result".

**Each task is folded against its own watermark, not the snapshot's.** A
snapshot refreshes an in-flight entry only at that task's own boundaries, so
with `maxConcurrency` above 1 the snapshot can be written while another task is
mid-turn: its entry is then many events staler than `journalWatermarkSeq`.
Every entry therefore carries a `journalSeq` of its own — every one of that
task's events at or below it is already in the entry, and every one above it is
not — and the replay window starts at the stalest entry. Events another task
has long since absorbed are recognised and skipped rather than re-applied. An
entry with no `journalSeq` (written before the field existed) falls back to the
snapshot-wide watermark, which is safe but folds less.

The fold is deliberately narrow. It folds **only in-flight runner state**:
assistant and user messages appended to a conversation, the turn counter from
`turn/end`, pending calls from `tool/call`, and committed results from
`tool/result`. It does **not** fold `task/status`, `memory/set`, or
`approval/request` / `approval/decision` — the queue, the shared-memory store,
and the durable approval ledger are each already the authority for those, and a
second source of truth for them would be a way to disagree, not a way to
recover.

Folding is defensive. An event has to name a task the snapshot is resuming
(matched on task **and** assignee, so a delegated child's events never land in
its parent's state), extend the journal append-only, be anchored by the state it
builds on — a tool call by the assistant turn that requested it, a tool-results
message by an open round — and leave a state the runner can actually resume
from. If any event fails those checks, the **entire** tail is discarded, an `onProgress`
warning with code `JOURNAL_TAIL_DISCARDED` is emitted, and the run resumes from
the snapshot alone — which is exactly today's behavior. The snapshot stays the
recovery anchor; the tail is an upgrade to its granularity, never a replacement.

```typescript
const orchestrator = new OpenMultiAgent({
  onProgress(event) {
    if (event.type === 'warning' && event.data?.code === 'JOURNAL_TAIL_DISCARDED') {
      console.warn('journal tail rejected, resuming from the snapshot:', event.data.reason)
    }
  },
})
await orchestrator.restore(team, { checkpoint: { store }, journal })
```

A v5 snapshot also carries per-block journal lineage for its conversation, so a
resumed run can still explain where each block the model sees came from. Without
it a restored conversation would be unexplainable — every block would be a gap.

### Saves are best-effort

An ordinary checkpoint write must never take down the run it protects. If the store rejects (a transient Redis/SQLite error), the failure is surfaced via `onProgress` and the run continues; the next safe runner boundary or completed task retries the write.

Suspension is the exception: OMA cannot return a resumable approval request
until the exact pending boundary has been saved. That save is strict and fails
closed. See [durable approvals](durable-approvals.md#rejection-and-recovery-semantics).

[Run journal](run-journal.md) appends follow the same contract, with no
exception at all: a failed append is reported and dropped, never escalated. That
is why the journal can only ever extend a snapshot on restore and never replace
it — a record that is allowed to go missing cannot be the recovery anchor.

```typescript
const orchestrator = new OpenMultiAgent({
  onProgress(event) {
    if (event.type === 'error' && event.data?.kind === 'checkpoint_save_failed') {
      console.warn('checkpoint write failed, run continues:', event.data.error)
    }
  },
})
```

## Redacting persisted secrets

A checkpoint stores completed task results and in-flight runner state —
including structured values, messages, tool inputs/results, and tool-call
records — and, for a separate checkpoint store, the shared-memory snapshot
**verbatim**. Task metadata has its own validation and credential redaction
boundary, but agent-produced results do not. Redaction elsewhere (traces,
dashboard) does **not** reach this path, so a secret an agent emits into its
answer lands on disk. To scrub it, wrap the durable store with
**`RedactingStore`**:

```typescript
import { RedactingStore, FileStore } from '@open-multi-agent/core'

await orchestrator.runTasks(team, tasks, {
  checkpoint: { store: new RedactingStore(new FileStore('./.oma/checkpoint.json')) },
})
```

`RedactingStore` redacts values on write at the store boundary, so it covers **both** persistence paths through the same primitive:

- Wrap the **checkpoint store** (above) to scrub the checkpoint's own results and any embedded shared-memory snapshot.
- Wrap the **shared-memory store** (`sharedMemoryStore: new RedactingStore(...)`) to scrub the `<agent>/<key>` entries. In the default `checkpoint: true` reuse case the checkpoint store *is* that store, so one wrap scrubs both.

Wrap **every durable store you persist to**: in a split setup — wrapped shared store, separate *unwrapped* checkpoint store — the checkpoint's `completedTaskResults` (sourced from the queue, not the store) would still be raw. Add custom value patterns (e.g. PII) via `new RedactingStore(store, { patterns: [/…/] })`.

Redaction is opt-in by construction and lossy on purpose: a **resumed** run sees `[redacted]` in place of the masked values. Don't enable it if a downstream agent legitimately needs a persisted secret on resume.

The same lossiness makes `RedactingStore` unsuitable for durable approvals,
whose hash must bind verbatim reviewed content. It deliberately does not expose
`compareAndSet`, so a suspend decision fails closed before OMA reports a pending
request. Use a protected, non-redacting checkpoint/approval store for those
runs.

## Mid-task tool recovery

For the built-in LLM runner, a tool-use turn crosses three durable boundaries:

1. The assistant message and every requested tool call are saved before tools execute.
2. Each returned `ToolResult` is saved separately as a per-call commit record.
3. Once all calls have committed, their result blocks are saved as the next user message and the model continues at the following turn.

On restore, committed results are replayed verbatim — including normal error
results — without invoking the tool again. Calls with no commit record are run
conservatively. Parallel tool calls are independent: one committed result does
not force a missing sibling to be skipped or an already committed sibling to
run twice. The completed turn count and accumulated token usage also resume, so
`maxTurns` and token budgets do not restart from zero.

Every tool receives the model-issued call ID as `context.toolCallId`. OMA
persists that ID and reuses it when a missing call runs after restore. A
consequential tool can pass it to the external system as an idempotency key:

```typescript
import { defineTool } from '@open-multi-agent/core'
import { z } from 'zod'

const charge = defineTool({
  name: 'charge',
  description: 'Create a charge.',
  inputSchema: z.object({ amount: z.number() }),
  execute: async ({ amount }, context) => {
    const idempotencyKey = [context.runId, context.taskId, context.toolCallId]
      .filter(Boolean)
      .join(':')
    const result = await payments.charge({ amount, idempotencyKey })
    return { data: JSON.stringify(result) }
  },
})
```

This key matters because OMA cannot make an arbitrary external side effect and
a `MemoryStore.set()` one cross-system transaction. If the process dies after
the external service commits but before the tool returns and its checkpoint
write succeeds, the snapshot still shows a missing result and restore runs the
call again. Use `toolCallId` (or another domain idempotency key) for operations
where duplicates are unsafe. The bundled `FileStore` makes each local snapshot
write atomic, but it cannot close that external transaction window.

## Advanced: the `Checkpoint` class

For inspecting or managing checkpoints directly, the manager and key helpers are exported:

```typescript
import {
  Checkpoint,
  checkpointKey,
  isCheckpointKey,
  CHECKPOINT_KEY_PREFIX,
  DEFAULT_CHECKPOINT_KEY,
} from '@open-multi-agent/core'

const cp = new Checkpoint(store, { runId: 'nightly-2026-06-18' })
const snapshot = await cp.loadLatest() // CheckpointSnapshot | null
await cp.delete()                      // drop the persisted checkpoint
```

## Limitations

Per-run snapshot/restore over `MemoryStore`. What it does *not* yet do:

- **Snapshot-based, not event-sourced.** Each checkpoint overwrites the previous one. Enabling a [run journal](run-journal.md) adds a replayable tail after the latest snapshot ([Tail replay](#tail-replay)), but the snapshot remains the anchor and the journal is never required to recover.
- **External agent backends remain task-grained.** Process and ACP backends own
  their own loops, so OMA cannot persist their private mid-task conversation or
  tool state.
- **Suspendable tool gates require the built-in LLM runner.** Standalone agents,
  the simple-goal short circuit, and external backends fail closed on a tool
  `suspend` decision because they have no resumable private tool-loop state.
- **Only runner tool results have per-call commit records.** Application hooks,
  custom context-strategy callbacks, and an LLM request interrupted before a
  response may run again from the last safe boundary.

Two notes on the shared-memory optimization described above:

- A *separate* durable checkpoint store (shared memory in store X, `checkpoint: { store: Y }`) still embeds the full memory snapshot on each save — necessary, since Y holds no other copy of the entries.
- The reused-store path does not point-in-time roll back shared memory. A custom tool that writes to shared memory mid-task leaves that write in the reused store; use the same idempotency discipline as for any other external side effect.

Append-only transition replay shipped as the opt-in [run journal](run-journal.md) ([#527](https://github.com/open-multi-agent/open-multi-agent/issues/527)), which adds the tail replay described above and lets `verifyRun()` audit a finished run offline. The earlier proposal to replace snapshots with it outright ([#313](https://github.com/open-multi-agent/open-multi-agent/issues/313)) stays closed: the snapshot remains the recovery anchor.
