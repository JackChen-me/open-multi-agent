# Run Event Journal

The run journal is an append-only log of what happened inside one run: which messages entered a conversation, which blocks the model actually saw, which tools ran and what they returned, what a context strategy replaced them with, how the plan and task states moved, and where checkpoints landed. It answers a question the other three records cannot — **why did the model see this?**

It is **opt-in and off by default**, and costs nothing when it is off: no recorder is allocated, no rewrite metadata is collected, and every emission site is guarded, so a run without a journal behaves exactly as it did before the feature existed — down to still writing checkpoint schema v4.

The journal is not the recovery mechanism. [Checkpoint snapshots](checkpoint.md) remain the durable recovery anchor; the journal adds an audit trail alongside them and, on restore, a replayable tail after the last snapshot.

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
  /** Optional. Recorded in a v5 checkpoint as `journalRef`, informational only. */
  describe?(): RunJournalRef  // { kind: string; path?: string }
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
| `tool/result` | `toolCallId`, `result`, `record?`, `delegationUsage?` | A tool result committed |
| `context/replace` | `strategy`, `dropped?`, `replacements`, `detail?` | A context strategy rewrote the conversation |
| `memory/set` | `agent`, `key`, `valueBytes?` | A task result was written to shared memory |
| `approval/request` | `request` | A durable approval boundary was persisted |
| `approval/decision` | `decision` | A durable decision was reconciled or made |
| `checkpoint/saved` | `mode`, `version`, `watermarkSeq` | A snapshot was persisted |

`sourceEventSeqs` conventions: an `assistant/message` names its `llm/request`; a `tool/call` names its `assistant/message`; a `tool/result` names its `tool/call`; a `user/message` with `origin: 'tool_results'` names the `tool/result` events assembled into it; a block a context strategy derived names the single `context/replace` event that carries it.

**`task/status` records four states, not six.** The `pending` and `blocked` starting states are already carried by `plan/set`, so the journal does not repeat them. Terminal transitions are recorded from the task queue rather than the dispatch loop, which is why cascaded failures and skips — transitions no dispatch site ever sees — appear too.

**`checkpoint/saved.watermarkSeq`** names the last event the snapshot folds, captured while the snapshot was built rather than after the store write, so concurrent tasks appending during the write cannot inflate it. A journaled run writes [checkpoint schema v5](checkpoint.md#tail-replay), which persists that same watermark; an unjournaled run still writes v4.

### `context/replace`

Context strategies rewrite the conversation destructively, and this is the event that keeps the rewrite auditable:

```typescript
{
  type: 'context/replace',
  strategy: 'summarize',
  dropped: { sourceEventSeqs: [/* blocks removed with nothing in their place */] },
  replacements: [{ sourceEventSeqs: [12, 14], block: { type: 'text', text: '[Conversation summary]…' } }],
  detail: { summaryModel: 'claude-haiku-4-5', usage: { input_tokens: 900, output_tokens: 60 } },
}
```

One event per strategy application. Each replacement stores the derived block **verbatim** rather than a description of how to rebuild it, which is what makes reproducibility a byte comparison instead of a re-execution: a request block naming this event passes when the event carries a block equal to it, matched on content, not position. Per-strategy behavior is tabulated in [context management](context-management.md#auditing-what-a-strategy-replaced).

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

**`enforceLineage: true` passes with every built-in context strategy.** `sliding-window`, `summarize`, `compact`, `compressToolResults`, and custom strategies each emit a [`context/replace`](#contextreplace) naming the blocks they derived, so a rewritten conversation stays explainable rather than becoming a wall of gaps.

**Restored runs keep their lineage too.** A run resumed from a v5 checkpoint does not re-emit the conversation the previous attempt journaled — that would duplicate the events the seqs point at. Instead the snapshot carries per-block lineage positionally and restore re-attaches it to the parsed blocks, and any events the journal recorded after the snapshot's watermark are folded in with lineage of their own. See [tail replay](checkpoint.md#tail-replay). Resuming from a v4 or older snapshot has no persisted lineage to re-attach, so those blocks are recorded as the gaps they are — and `enforceLineage: true` fails such a resume, correctly.

One other gap is worth naming while it exists:

- **Structured-output repair.** The corrective retry behind `outputSchema` is a second model-visible conversation, so it is journaled as one: its messages are re-seeded rather than deduplicated against the first attempt.

## Verifying a journal

`enforceLineage` is an in-process check, and it can only ever record what the runner knows: a block names the event it came from, or it names nothing. The runner has no way to record a *wrong* lineage. `verifyRun()` asks the harder question of a journal read back cold — does the event a block names actually reproduce that block, byte for byte?

```typescript
import { verifyRun, JsonlRunJournal } from '@open-multi-agent/core'

const result = await verifyRun(new JsonlRunJournal('./.oma/run.jsonl'))
if (!result.ok) {
  for (const failure of result.failures) console.error(failure.code, failure.detail)
}
```

It takes a `RunJournal` (read once with `readFrom(0)`) or events you already hold as `{ events }`, and is otherwise pure. It is meant for tests, CI gates, and post-mortems, not a hot path.

Three verdicts, deliberately distinct:

| Verdict | Meaning |
|---|---|
| `failures` | The journal contradicts itself. `ok` is `false` exactly when this is non-empty. |
| `inconclusive` | The journal cannot answer, because the named event is not in the readable window. Not counted against the run. |
| `stats` | `events`, `requests`, and `blocksChecked`, so an `ok` verdict says how much it was based on. |

Checks run in a fixed order, so a journal that is not a coherent stream says so before it is interrogated about content:

- **Sequence integrity.** A repeated or reversed sequence is `SEQ_NOT_MONOTONIC`. A *forward gap* is not a failure: a bounded journal evicts its head, and a best-effort append may drop a batch.
- **Referential integrity.** A `sourceEventSeqs` entry at or above the sequence citing it can never resolve, so it is `BROKEN_LINK`. One that is merely absent is a window gap, below.
- **Per-block reproducibility.** For every block of every `llm/request`: `sourceEventSeqs: null` fails as `MISSING_CONTEXT_REPLACE` with `reason: 'no-lineage'`. A named lineage passes when a message-bearing event contains a block whose [`canonicalContentHash`](#lineage-and-the-model-visible-boundary) equals the recorded `contentHash`, or a `context/replace` event carries a replacement that hashes to it. Anything else is `MISSING_CONTEXT_REPLACE` with `reason: 'not-reproducible'` — the same code, because both are the same hole, and the reason is what tells them apart.

That last distinction is the point of the check. A rewrite that silently replaces a conversation still *names* prior events, so a predicate that only asked whether lineage was present would accept it. Requiring the named event to reproduce the bytes is what makes an unrecorded rewrite structurally detectable rather than something only a full replay would notice.

### What lands in `inconclusive`

A gap is recorded, with the events it names, when the window cannot decide:

- An `InMemoryRunJournal` evicted the events a retained request still cites.
- A best-effort append dropped a batch, leaving a hole a later event points into.
- A restored attempt was handed a fresh journal rather than the one the earlier attempt wrote, so its checkpoint-restored lineage names sequences this file never held.

A block that reproduces from one named event passes even when another is missing. When it reproduces from none of the events that *are* present but some named event is absent, the verdict is inconclusive rather than a failure, because the missing event could have been the one carrying it. Non-reproducibility is claimed only when every named event was available and none of them matched.

### What it does not prove

- **It is a lineage audit, not a schema validator.** Turns are not paired, `run/start` and `run/end` are not required, and the `sourceEventSeqs` conventions in the table above are not enforced. A journal from a crashed run — an open `turn/start`, no `run/end` — verifies normally.
- **It verifies the window, not the run.** Everything eviction removed is unexamined, which is what `stats` and `inconclusive` are for.
- **Redaction and byte-level reproducibility are in tension.** `contentHash` is computed in process, before a `JsonlRunJournal` redacts at write time. A pattern that rewrites a block the model actually saw leaves the persisted event no longer reproducing it, and `verifyRun` reports `not-reproducible` for content that was recorded correctly. Blocks no pattern touched are unaffected, so a redacted journal verifies partially at best.

An `oma verify-run` CLI command is planned and deliberately not built yet; the exported function is the whole surface for now.

## Resuming with a journal

Pass the same journal to `restore()` that the crashed attempt wrote to, and recovery gets finer than the last safe boundary:

```typescript
const journal = new JsonlRunJournal('./.oma/run.jsonl')
await orchestrator.restore(team, { checkpoint: { store }, journal })
```

The snapshot is still what recovery is anchored on. On top of it, restore replays the journal past what the snapshot already holds and folds the in-flight runner events it finds — most usefully, a tool that ran and returned in the window the snapshot never captured, which is then replayed as data instead of executed again. Task status, memory writes, and approvals are deliberately not folded; each already has its own durable record. A tail that does not fit the snapshot is discarded whole with an `onProgress` warning, and the run resumes exactly as it would with no journal at all. [Checkpoint & Resume](checkpoint.md#tail-replay) has the precise fold scope and the defensive checks.

"What the snapshot already holds" is decided per task, not per snapshot. A v5 snapshot refreshes each in-flight entry at that task's own boundaries, so with concurrency above 1 an entry can be many events staler than the snapshot's `journalWatermarkSeq`. Each entry records its own `journalSeq`, the replay window opens at the stalest one, and events another task has already absorbed are recognised and skipped rather than folded twice.

Sequence numbers continue across attempts, so one logical run reads as one stream even when it was resumed several times. A restored attempt numbers from whichever is higher: the journal's own tail, or the snapshot's watermark — the latter matters when the journal handed to `restore()` is a fresh file rather than the one that crashed.

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
