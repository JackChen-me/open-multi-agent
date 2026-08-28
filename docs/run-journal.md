# Run Event Journal

The run journal is an append-only log of what happened inside one run: which messages entered a conversation, which blocks the model actually saw, which tools ran and what they returned, how the plan and task states moved, and where checkpoints landed. It answers a question the other three records cannot — **why did the model see this?**

It is **opt-in and off by default**, and costs nothing when it is off: no recorder is allocated and every emission site is guarded, so a run without a journal behaves exactly as it did before the feature existed.

The journal is not the recovery mechanism. [Checkpoint snapshots](checkpoint.md) remain the durable recovery anchor; the journal is additive audit state alongside them.

## Enable it

Pass a backend per call, or set a default for every run via `OrchestratorConfig.journal`. Per-call values override the config default, and `journal: false` disables it for one run.

```typescript
import { OpenMultiAgent, Team, InMemoryRunJournal } from '@open-multi-agent/core'

const journal = new InMemoryRunJournal()
const orchestrator = new OpenMultiAgent()

await orchestrator.runTasks(team, tasks, { journal })

for (const event of await journal.readFrom(0)) {
  console.log(event.seq, event.type)
}
```

You always supply the instance, because a journal nobody can read back is useless. There is deliberately no `journal: true` shorthand, and the framework never calls `close()` on your backend — you own its lifecycle, exactly as you own a `MemoryStore`.

`runAgent`, `runTeam`, `runTasks`, `runFromPlan`, and `restore` all accept `journal`. `RestoreOptions` inherits the field from `RunTasksOptions`.

### `RunJournalOptions`

Pass a bare backend for the common case, or the options object when you need the switches:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `journal` | `RunJournal` | — | The backend. Required. |
| `enabled` | `boolean` | `true` | Set `false` to disable while keeping the field. |
| `enforceLineage` | `boolean` | `false` | Throw instead of recording an unexplained model-visible block. See [Lineage](#lineage-and-the-model-visible-boundary). |

```typescript
await orchestrator.runTasks(team, tasks, {
  journal: { journal, enforceLineage: true },
})
```

## Backends

`RunJournal` is a small append-only interface, deliberately separate from `MemoryStore`: `MemoryStore` is key/value shaped and `FileStore` rewrites its whole file per write, so appending one event per model call through either would cost O(store size) per event.

```typescript
interface RunJournal {
  append(events: readonly RunEvent[]): Promise<void>
  readFrom(seq: number): Promise<RunEvent[]>
  close(): Promise<void>
}
```

### `InMemoryRunJournal`

A bounded ring buffer for auditing a run inside one process. `maxEvents` defaults to 10 000; eviction drops the oldest events, so `readFrom` returns the retained tail rather than the whole run. Exposes `size`.

```typescript
const journal = new InMemoryRunJournal({ maxEvents: 50_000 })
```

### `JsonlRunJournal`

A zero-dependency JSONL file — one event per line, append-only, Node built-ins only.

```typescript
import { JsonlRunJournal } from '@open-multi-agent/core'

const journal = new JsonlRunJournal('./.oma/run.jsonl', { flushIntervalMs: 50 })
try {
  await orchestrator.runTasks(team, tasks, { journal })
} finally {
  await journal.close() // flushes the open batch and closes the fd
}
```

- **Batched flush with a fixed deadline.** The first pending event opens the window; later events do not reset it. A burst of turns costs one write instead of one per event, while a quiet run still lands within `flushIntervalMs` (default 50 ms).
- **One write per batch, then `fsync`.** A reader sees whole records, never half of one.
- **Crash window = the current unflushed batch.** Everything up to the last completed batch is on disk. `close()` flushes the rest.
- **`readFrom` tolerates one trailing partial line**, which is what a crash mid-write leaves behind. Corruption anywhere else throws rather than silently dropping events.
- **One writer per file, no cross-process lock** — the same scope statement `FileStore` makes.

Redaction uses the same option shape as [`RedactingStore`](shared-memory.md) and runs at write time, so `readFrom` returns what was persisted:

```typescript
new JsonlRunJournal('./.oma/run.jsonl', { redact: { patterns: [/\bcust-\d+\b/g] } })
```

## Event vocabulary

Every event carries `seq` (1-based, strictly increasing per `runId` across attempts), `timestampUnixMs`, `runId`, `attempt`, and — where they apply — `taskId`, `agentName`, `traceId`/`spanId`, and `sourceEventSeqs`.

| `type` | Payload beyond the base | Emitted when |
|---|---|---|
| `run/start` | `mode`, `goal?`, `metadata?` | A run begins, once per entry point |
| `run/end` | `status`, `error?` | The run's trace closes, on every exit path |
| `plan/set` | `revision`, `source`, `tasks`, `detail?` | A plan is loaded (`'initial'`) or repaired (`'recovery'`) |
| `task/status` | `status`, `reason?` | A task moves to `in_progress`, `completed`, `failed`, or `skipped` |
| `turn/start` | `turn` | A model turn opens |
| `turn/end` | `turn`, `outcome` | A model turn closes, with why |
| `user/message` | `message`, `origin` | A user-role message enters the conversation |
| `assistant/message` | `message`, `origin`, `usage?`, `model?`, `stopReason?` | An assistant message enters the conversation |
| `llm/request` | `turn`, `model`, `blocks`, `systemPromptHash?`, `toolsHash?` | Immediately before an adapter call |
| `tool/call` | `call` | The model requested a tool, before execution |
| `tool/result` | `toolCallId`, `result`, `record?` | A tool result committed |
| `memory/set` | `agent`, `key`, `valueBytes?` | A task result was written to shared memory |
| `approval/request` | `request` | A durable approval boundary was persisted |
| `approval/decision` | `decision` | A durable decision was reconciled or made |
| `checkpoint/saved` | `mode`, `version`, `watermarkSeq` | A snapshot was persisted |

`sourceEventSeqs` conventions: an `assistant/message` names its `llm/request`; a `tool/call` names its `assistant/message`; a `tool/result` names its `tool/call`; a `user/message` with `origin: 'tool_results'` names the `tool/result` events assembled into it.

**`task/status` records four states, not six.** The `pending` and `blocked` starting states are already carried by `plan/set`, so the journal does not repeat them. Terminal transitions are recorded from the task queue rather than the dispatch loop, which is why cascaded failures and skips — transitions no dispatch site ever sees — appear too.

**`checkpoint/saved.watermarkSeq`** names the last event the snapshot folds, which is the event before the save record itself. Snapshots stay at schema v4 in this release; the watermark becomes part of the snapshot in a later one.

### Scope

Journaling follows the standard runner plumbing, so it covers `runAgent`, coordinator decomposition and synthesis, `runTeam` short-circuit runs, worker tasks, and delegated child runs. Delegated conversations journal under their own `agentName` within the same task scope, interleaved into one ordered stream — which is the correct reading of a run where several agents were live at once.

Not journaled in this release: `runConsensus` and per-task consensus judges, the semantic execution-router profiler, and orchestrator decision events (`routing/decision`, `consensus/verdict`, `recovery/decision`). Plan repairs still land as `plan/set` with `source: 'recovery'`.

## Lineage and the model-visible boundary

**The model-visible boundary is the IR conversation (`LLMMessage[]`) handed to `adapter.chat()` / `adapter.stream()`.** Everything below it — provider wire format, reasoning echo and downgrade rules, `preserveReasoningAsText` — is deterministic per adapter and out of scope. The system prompt and tool definitions are caller-supplied config rather than conversation state, so `llm/request` records `systemPromptHash` and `toolsHash` instead of their bytes.

`llm/request` does not store the conversation. The conversation is re-sent every turn, so storing it verbatim would grow the journal with the square of the turn count. It stores one descriptor per block:

```typescript
interface RequestBlockDescriptor {
  messageIndex: number
  blockIndex: number
  role: 'user' | 'assistant'
  blockType: ContentBlock['type']
  sourceEventSeqs: readonly number[] | null  // null = no recorded lineage
  contentHash: string                        // sha256 of canonical JSON
}
```

Lineage is keyed on **block identity**, not message identity: context strategies rebuild message objects but pass untouched blocks through by reference, so block identity survives a rewrite where message identity does not. `canonicalContentHash` is exported so an offline reader can recompute the same digest from a journal read cold off disk.

### `enforceLineage`

With `enforceLineage: false` (the default), a block whose origin was never recorded is written as the gap it is: `sourceEventSeqs: null`. With `enforceLineage: true`, it throws `JournalLineageError` (`code: 'MISSING_CONTEXT_REPLACE'`, carrying `messageIndex`, `blockIndex`, and `blockType`) before the adapter call, at the exact request that would otherwise have hidden it. The error is terminal for orchestrator retries — the same conversation would fail identically on every attempt.

**In this release, `enforceLineage: true` correctly fails any run that configures a context strategy.** `sliding-window`, `summarize`, `compact`, `compressToolResults`, and custom strategies all rewrite the conversation into blocks no journal event produced, and there is no event yet that can name a rewrite. That is the invariant working, not a bug: the journal is telling you it cannot explain what the model saw. A later release adds a `context/replace` event that gives each derived block a lineage, after which enforcement passes with every built-in strategy.

Two other gaps are worth naming while they exist:

- **Restored runs.** A run resumed from a checkpoint does not re-emit the conversation the previous attempt journaled — that would duplicate the events the seqs point at — so the restored blocks carry no lineage until checkpoint-persisted lineage lands.
- **Structured-output repair.** The corrective retry behind `outputSchema` is a second model-visible conversation, so it is journaled as one: its messages are re-seeded rather than deduplicated against the first attempt.

## Writes are best-effort

A failed append is reported once per failure through `onProgress` and never fails the run:

```typescript
new OpenMultiAgent({
  onProgress(event) {
    if (event.type === 'error' && (event.data as { kind?: string }).kind === 'journal_append_failed') {
      metrics.increment('oma.journal.append_failed')
    }
  },
})
```

This holds at approval boundaries too, where ordinary checkpoint saves escalate. Durability there is the [durable approval ledger](durable-approvals.md)'s job; the journal only records that the boundary existed. Losing the audit trail must never roll back a run that actually happened.

## Journal versus telemetry

[Trace records](observability.md) and journal events describe the same run and deliberately do not depend on each other. Traces are **telemetry**: losing them must never roll back durable state, and they may be sampled, batched, exported, or dropped. Journal events are **execution state**: they record what the run did and what the model saw. The `journal/` module does not import from `observability/`, so trace loss cannot imply journal loss and neither can the reverse. Events carry `traceId`/`spanId` when a trace runtime is active, which is enough to join the two streams without coupling them.
