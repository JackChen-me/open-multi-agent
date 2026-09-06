# Authoritative run store and execution leases

A [checkpoint](checkpoint.md) answers *what state can execution resume from*. It
does not answer *who is allowed to advance it*. Nothing stops two processes from
loading the same snapshot and both continuing it, and nothing stops a worker
that stalled past its own liveness from waking up and overwriting the state a
replacement worker has since written.

The **run store** closes that gap. It holds one authoritative record per logical
run — lifecycle status, execution lease, and a monotonic fencing token — so a
long-running workflow becomes a durably managed job rather than a function call
one process has to babysit. It is opt-in: with no run store configured, every
existing single-process checkpoint and restore behavior is unchanged.

## Enable it

```typescript
import { MemoryStoreRunStore, OpenMultiAgent } from '@open-multi-agent/core'

// `durableStore` is your own cross-process MemoryStore (Redis, Postgres, ...).
const orchestrator = new OpenMultiAgent({
  runStore: new MemoryStoreRunStore(durableStore, { atomicity: 'cross-process' }),
  checkpoint: true,
})
```

Pass an object to name the worker or widen the lease:

```typescript
const orchestrator = new OpenMultiAgent({
  runStore: {
    store: runStore,
    owner: `worker-${process.env['HOSTNAME']}`,
    leaseTtlMs: 120_000,
  },
})
```

`RunTasksOptions.runStore` overrides the orchestrator default for one call, and
`runStore: false` opts a single call out of a configured store.

| Field | Default | Meaning |
|---|---|---|
| `store` | — | The `RunStore` implementation. Required. |
| `owner` | pid plus a random suffix | Opaque worker identity. Two live processes must never share one. |
| `leaseTtlMs` | `60000` | How long a lease stays valid without renewal. |
| `heartbeat` | `true` | Renew in the background while the run is open. |
| `now` | `Date` | Clock seam for tests. |

## What a run record holds

```typescript
interface RunRecord {
  schema: 1
  runId: string
  version: number          // optimistic concurrency; increments on every write
  status: RunLifecycleStatus
  attempt: number          // increments when a worker takes an abandoned run over
  fencingToken: number     // increments only when ownership changes hands
  lease?: { owner: string; acquiredAt: string; expiresAt: string }
  checkpointRef?: { key: string; snapshotVersion: number; savedAt: string }
  outcome?: { code: RunStatusCode; message?: string }
  suspension?: { suspendedAt: string; pendingApprovalIds: readonly string[] }
  createdAt: string
  updatedAt: string
}
```

The two counters are deliberately separate. `version` is what a store compares
against to reject a stale write. `fencingToken` moves only when the lease
changes hands, so a worker holding token `N` can still be recognised as stale
after any number of unrelated writes.

`RunLifecycleStatus` is a small, closed vocabulary, and not the same thing as
the `RunStatus` a caller receives. `RunStatus` normalises one invocation's
outcome; this describes the durable state machine an operator or another worker
sees.

| From | May become |
|---|---|
| `queued` | `running`, `cancelled`, `failed` |
| `running` | `suspended`, `completed`, `failed`, `cancelled`, or back to `queued` when a worker releases it unfinished |
| `suspended` | `queued`, `running`, `cancelled`, `failed` |
| `completed`, `failed`, `cancelled` | nothing |

Terminal statuses have no outgoing edge: a late or duplicate command cannot
reopen a finished run. `canTransitionRun()` and `isTerminalRunStatus()` are
exported so an external store or dashboard can apply the same rules.

## Execution ownership

1. A worker must acquire the lease before it executes or restores work.
2. It renews while it is active; an expired lease may be taken over by anyone.
3. Every checkpoint and lifecycle write carries the fencing token, so a worker
   that has been taken over cannot write after the takeover.
4. A suspended run does not depend on a live worker. After a decision is
   recorded, an idempotent resume makes it eligible for a new lease.
5. Duplicate start, resume, cancel, and completion commands converge on one
   legal state instead of executing twice.

`RunLedger` issues leases and `RunLeaseHandle` is the capability a worker holds
while it owns one. The orchestrator drives both for you; reach for them directly
to run an operator command from outside the worker:

```typescript
import { RunLedger } from '@open-multi-agent/core'

const ledger = new RunLedger(runStore, { owner: 'operator' })

await ledger.get('run-42')                 // read without taking ownership
await ledger.cancel('run-42', 'superseded')// stop the active worker
await ledger.requestResume('run-42')       // make a suspended run eligible again
```

Cancelling bumps the fencing token, so the running worker is fenced at its next
write and stops rather than finishing a cancelled run.

## Where fencing is enforced

- **Before execution.** `runTeam`, `runTasks`, `runFromPlan`, and `restore`
  acquire the lease before the first task is dispatched. A run another worker
  holds, a run already terminal, or a suspended run with no recorded resume
  throws `RunStoreError` and dispatches nothing. `runTasks`, `runFromPlan`, and
  `restore` acquire before any work at all; `runTeam` acquires after the
  coordinator has produced a plan and before the plan-approval boundary, so a
  `runTeam` call given a contended `runId` still spends the planning call.
- **At every checkpoint boundary.** The checkpoint write fences first: the run
  record is updated with the new checkpoint reference under the worker's token,
  and only then is the snapshot written. A rejected fence means no snapshot is
  written at all. `checkpointRef` is advisory for operators — recovery reads the
  checkpoint key directly — so a snapshot write that fails after a successful
  fence leaves the pointer one write ahead of the stored snapshot.
- **At the dispatch gate.** A lost lease stops the run the same way an abort or
  an exhausted budget does. No further task is dispatched.
- **At the terminal transition.** The run's final status is written under the
  same token before the result is returned.

`restore()` is itself the resume command: it makes a suspended record eligible
and takes the lease before it reconciles the approval ledger, so two workers
restoring the same checkpoint cannot both advance it.

### The one residual window

The run record and the checkpoint are separate rows, and OMA does not require a
transaction spanning both. A takeover that lands between a successful fence and
the snapshot write can leave one stale snapshot behind. The new owner's next
checkpoint supersedes it, and the run record — the row that decides who may
advance — is unambiguous throughout. This is the same class of window as the
[external-side-effect idempotency window](checkpoint.md#mid-task-tool-recovery),
and it is why a run store does not make arbitrary external side effects
exactly-once. Payments, messages, and tickets still need the stable tool-call ID
or another domain idempotency key.

## Failure semantics: not best-effort

An ordinary [checkpoint write is best-effort](checkpoint.md#saves-are-best-effort):
a store error is reported and the run continues. Ownership and lifecycle writes
are not.

- A fenced-out checkpoint write does not fall through to the store, and the run
  stops at the next dispatch gate.
- A worker that discovers it lost the lease writes no terminal status — the run
  belongs to whoever took it over — and its own result is reported as the
  failure the fence detected, never as success.
- A terminal transition that cannot be written throws. OMA does not report an
  outcome the authoritative record does not carry.

`RunStoreError.code` names the reason: `RUN_LEASE_HELD`, `RUN_LEASE_LOST`,
`RUN_ALREADY_TERMINAL`, `RUN_SUSPENDED`, `RUN_INVALID_TRANSITION`,
`RUN_INTEGRITY_ERROR`, `RUN_VALIDATION_ERROR`, `RUN_CONFLICT`, `RUN_NOT_FOUND`,
and `RUN_STORE_ATOMIC_REQUIRED`. When the failure was detected against a record
that was read, `RunStoreError.record` carries it.

## Implementing a store

`RunStore` is three methods plus a declaration:

```typescript
interface RunStore {
  readonly atomicity: 'process' | 'cross-process'
  get(runId: string): Promise<RunRecord | null>
  create(record: RunRecord): Promise<boolean>
  compareAndSet(runId: string, expectedVersion: number, next: RunRecord): Promise<boolean>
  delete?(runId: string): Promise<void>
}
```

Lease expiry, fencing, transition legality, and command idempotency all live
above the seam in `RunLedger`, so an implementation reproduces storage
semantics rather than a state machine. `create` inserts only when absent;
`compareAndSet` swaps only when the stored version matches, and `next.version`
must be `expectedVersion + 1`.

### `atomicity` is a claim, not a hint

`MemoryStoreRunStore` adapts any [`MemoryStore`](shared-memory.md) that
implements `compareAndSet`, which lets one backend hold checkpoints, the
approval ledger, and run records together. It cannot inspect that backend, so it
defaults to `atomicity: 'process'` and takes `'cross-process'` only as an
explicit declaration from you.

| Backing store | Honest atomicity | Use it for |
|---|---|---|
| `InMemoryStore` | `process` | tests, single-process development |
| `FileStore` | `process` | sequential restart recovery on one machine |
| Redis (`WATCH`/Lua), Postgres (conditional `UPDATE`), DynamoDB (conditional write) | `cross-process` | multiple workers |

`FileStore` remains the local sequential-restart reference store. It serialises
writes inside one Node process and has no cross-process lock, so it must not be
presented as a multi-worker lease backend — two processes sharing one file can
both believe they hold the lease.

### Conformance suite

`packages/core/tests/helpers/run-store-contract.ts` is a reusable Vitest suite
covering create races, version-matched compare-and-set, concurrent swaps, lease
expiry and takeover, stale-writer rejection, suspend/resume, and terminal
closure. Point it at your implementation:

```typescript
import { runRunStoreContractSuite } from './helpers/run-store-contract.js'

runRunStoreContractSuite('PostgresRunStore', () => new PostgresRunStore(pool))
```

The suite cannot prove real cross-process atomicity from inside one process —
that claim needs its own integration test against the live backend.

## What this is not

- **Not an event log.** The record is the current authoritative state, not a
  history. Append-only history is the opt-in [run journal](run-journal.md).
- **Not a scheduler or queue.** OMA does not dispatch runs to workers, retry
  them on a timer, or run a control plane. It tells one worker whether it may
  proceed.
- **Not exactly-once side effects.** See [the residual window](#the-one-residual-window).
- **Not an approval product.** Reviewer UI, RBAC, notification, and escalation
  remain outside the framework; see
  [durable approvals](durable-approvals.md#what-the-framework-provides-and-what-you-build).

## Related

- [Checkpoint and resume](checkpoint.md) — the snapshot a lease protects.
- [Durable approval gates](durable-approvals.md) — what a suspended run is waiting on.
- [Observability](observability.md#dashboard-tracestore-checkpointstore-and-runstore) — how this data plane differs from telemetry.
- [Shared memory](shared-memory.md) — the `MemoryStore` interface the bundled adapter sits on.
