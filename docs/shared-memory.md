# Shared memory

Teams can share a namespaced key-value store so later agents see earlier agents' findings. Enable it with a boolean for the default in-process store:

```typescript
const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [researcher, writer],
  sharedMemory: true,
})
```

For durable persistence without writing any storage code, pass the bundled **`FileStore`** — a zero-dependency, filesystem-backed `MemoryStore` with atomic writes (see [Checkpoint & resume](checkpoint.md#durable-persistence-filestore)). For cross-process or infrastructure backends (Redis, Postgres, Engram, etc.), implement the `MemoryStore` interface yourself and pass it via `sharedMemoryStore`. Keys are still namespaced as `<agentName>/<key>` before reaching the store:

```typescript
import type { MemoryStore } from '@open-multi-agent/core'

class RedisStore implements MemoryStore { /* get/set/list/delete/clear */ }

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedisStore(),
})
```

When both are provided, `sharedMemoryStore` wins, and it enables shared memory on its own: a team that sets only `sharedMemoryStore` gets shared memory even with `sharedMemory` absent or `false`. Passing neither leaves the team without shared memory. SDK-only: the CLI cannot pass runtime objects.

## The `MemoryStore` interface

A store is a flat string-to-string key-value map. Five methods are required:

```typescript
interface MemoryStore {
  get(key: string): Promise<MemoryEntry | null>
  set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void>
  list(): Promise<MemoryEntry[]>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}
```

`MemoryEntry` is `{ key, value, metadata?, createdAt }` plus an optional `expiresAtTurn`. `value` is always a `string` at this boundary; `createdAt` is a `Date`, and the built-in stores preserve it when a key is overwritten so callers can tell when a value was first written.

The shape is checked at construction, not on first use. `SharedMemory` (and `Team`, on your behalf) throws a `TypeError` when a supplied store does not have all five methods, so a plain object deserialized from JSON config fails immediately rather than mid-run.

Two methods are optional, and omitting each has a defined consequence:

| Optional method | Signature | Omitting it |
|---|---|---|
| `compareAndSet` | `(key, expectedValue: string \| null, value, metadata?) => Promise<boolean>` | Suspendable approvals fail closed. |
| `setWithExpiry` | `(key, value, expiresAtTurn: number, metadata?) => Promise<void>` | `writeExpiring` falls back to a plain `set` and the entry never expires. |

`compareAndSet` replaces a value only when the stored string matches `expectedValue` exactly, with `expectedValue: null` meaning the key must not exist. It is the atomicity primitive behind durable approval decisions, and a store that cannot make the comparison and the write atomic across its writer scope must omit the method rather than approximate it: see [Store requirements](durable-approvals.md#store-requirements) for what each built-in store guarantees and when an out-of-process reviewer needs a database-backed store.

Custom stores never see turn counters. `SharedMemory` owns the counter and computes `expiresAtTurn` as `currentTurn + ttlTurns` at write time, then filters expired entries out of reads itself; a store that implements `setWithExpiry` only has to persist that number and hand it back on `MemoryEntry.expiresAtTurn`. Expired entries are filtered, not deleted, so a backend with native TTL (Redis) or a cleanup job (Postgres) owns reclamation.

## Keys and metadata

Every write is namespaced as `<agentName>/<key>` before it reaches the store, so entries never collide across agents and stay attributable. Reads accept the fully qualified key, which is what makes cross-agent reads ordinary: `read('researcher/findings')` from any agent.

Metadata rides alongside the value and is merged with an `{ agent: agentName }` marker on write, so a store that only iterates `list()` can still attribute every entry. The framework also uses metadata as its own encoding channel (see [Structured values](#structured-values)), and reserves two key prefixes for its own records: `__oma_checkpoint__/` and `__oma_approval__/`. Those are filtered out of agent-visible reads, listings, and summaries, and survive a snapshot restore that clears everything else, which is what lets one store hold agent memory, checkpoints, and approvals at once.

`getSummary()` renders the store as a markdown digest grouped by agent, truncating any value longer than 200 characters, and is what the orchestrator injects for a task with `memoryScope: 'all'`.

## Structured values

`SharedMemory.write()` accepts any JSON-serializable value, not just a string:

```typescript
await memory.write('extractor', 'invoice', { total: 1299, currency: 'USD' })

const entry = await memory.read('extractor/invoice')
// entry.value is the object again, not a string the reader has to re-parse.
```

The `MemoryStore` boundary stays string-only: a non-string value is `JSON.stringify`-ed and the entry is tagged with the metadata marker `sharedMemoryValueEncoding: 'json'`, which `read`, `listAll`, `listByAgent`, and `getSummary` use to parse it back. Because the marker drives the parse, a plain string that merely looks like JSON is returned unchanged, so entries written by an earlier version, or directly into the store by other software, keep their exact string value.

Values are validated before they are serialized. A circular reference or a non-finite number throws a `TypeError` naming the offending path, and passing `{ schema }` runs a Zod schema first:

```typescript
import { z } from 'zod'

await memory.write('extractor', 'invoice', value, undefined, {
  schema: z.object({ total: z.number(), currency: z.string() }),
})
```

A schema failure throws and nothing is written, so a malformed handoff never becomes a downstream agent's input.

### How a dependency's result reaches the next task

Handoff between tasks does not go through key naming conventions you have to agree on. After each successful task, the orchestrator writes the task's output to shared memory under the assignee's namespace with the key `task:<taskId>:result`, and advances the shared-memory turn counter.

What the *next* task sees is chosen by two task fields rather than by reading the store itself:

- `memoryScope: 'all'` injects the full `getSummary()` digest, which is every agent's memory.
- Otherwise (the default) only direct dependencies are injected, and `dependencyPayload` selects the form: `'output'` (default) for the raw text, `'structured'` for the dependency's validated structured value serialized with stable key ordering, or `'both'` for the two under labelled headings.

`'structured'` and `'both'` fail the dependent task rather than injecting an empty section, and a single payload is size-capped; see [task scheduling](task-scheduling.md#task-results-and-dependency-payloads) for the field on the task spec, the failure codes, and the limit.

## Built-in stores

| Store | Import | What it is for |
|---|---|---|
| `InMemoryStore` | `@open-multi-agent/core` | The default. A `Map` that dies with the process; implements `compareAndSet` and `setWithExpiry` process-locally. |
| `FileStore` | `@open-multi-agent/core` | Durable with no dependency: one JSON file per store, rewritten atomically (temp file, `fsync`, `rename`) on every mutation, with reads served from an in-memory mirror. Single Node process at a time; there is no cross-process lock. |
| `RedactingStore` | `@open-multi-agent/core` | A decorator, not a backend. Wraps any store and scrubs credentials from values on write. |

`FileStore` takes the file path directly: `new FileStore('./.oma/memory.json')`. Wiring it as `sharedMemoryStore` is durable but flushes the whole file on every agent memory write; wiring it as the *checkpoint* store instead keeps durability I/O at checkpoint cadence while still capturing the shared-memory snapshot. [Checkpoint & resume](checkpoint.md#durable-persistence-filestore) has the comparison.

## Third-party stores

Two runnable integrations implement `MemoryStore` against a real backend and are worth reading before writing your own:

- [`integrations/with-engram`](../packages/core/examples/integrations/with-engram/) backs shared memory with Engram's REST API, where facts committed by one agent are visible to every agent in the workspace.
- [`integrations/with-tencentdb-memory`](../packages/core/examples/integrations/with-tencentdb-memory/) pairs the exact key-value semantics OMA needs with TencentDB-Agent-Memory's distillation pipeline, and shows what to do when a backend cannot read a stored value back by key.

## Redacting persisted secrets

Shared-memory writes persist agent output **verbatim**, and redaction elsewhere (trace spans, the dashboard) stops at the telemetry layer without reaching the store. Wrap the store with **`RedactingStore`** to scrub credentials, plus any custom patterns you add, at the one choke point every write passes through:

```typescript
import { RedactingStore, FileStore } from '@open-multi-agent/core'

const team = orchestrator.createTeam('durable-team', {
  name: 'durable-team',
  agents: [researcher, writer],
  sharedMemoryStore: new RedactingStore(new FileStore('./.oma/memory.json'), {
    // Optional: extra value patterns (e.g. PII) on top of built-in credential redaction.
    patterns: [/\b\d{3}-\d{2}-\d{4}\b/],
  }),
})
```

Redaction is write-time and lossy on purpose, so a downstream agent (or a resumed run) reads `[redacted]` where the secret was, while the caller-facing run result is untouched because it never passes through the store. Because checkpoints default to the team's shared-memory store, this one wrap also covers the checkpoint written to it, and `RedactingStore` deliberately exposes no `compareAndSet`, which is what makes durable approvals fail closed rather than hash redacted content. [Checkpoint & resume](checkpoint.md#redacting-persisted-secrets) is the full treatment, including what a split shared-store/checkpoint-store setup still leaves unredacted.
