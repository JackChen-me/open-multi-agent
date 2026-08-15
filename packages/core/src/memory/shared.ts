/**
 * @fileoverview Shared memory layer for teams of cooperating agents.
 *
 * Each agent writes under its own namespace (`<agentName>/<key>`) so entries
 * remain attributable, while any agent may read any entry. The
 * {@link SharedMemory.getSummary} method produces a human-readable digest
 * suitable for injecting into an agent's context window.
 */

import type {
  MemoryEntrySnapshot,
  MemoryEntry,
  MemoryStore,
  SharedMemorySnapshot,
  SharedMemoryEntry,
  SharedMemoryValue,
  SharedMemoryWriteOptions,
} from '../types.js'
import { InMemoryStore } from './store.js'
import { APPROVAL_KEY_PREFIX } from '../approval/durable.js'

// ---------------------------------------------------------------------------
// Runtime shape check
// ---------------------------------------------------------------------------

const STORE_METHODS = ['get', 'set', 'list', 'delete', 'clear'] as const
const STRUCTURED_VALUE_ENCODING = 'json'
const STRUCTURED_VALUE_METADATA_KEY = 'sharedMemoryValueEncoding'
const RESERVED_STORE_PREFIXES = ['__oma_checkpoint__/', APPROVAL_KEY_PREFIX] as const


/**
 * Returns true when `v` structurally implements {@link MemoryStore}.
 *
 * Used to defend against malformed `sharedMemoryStore` values reaching
 * {@link SharedMemory} (e.g. a plain object deserialized from JSON that
 * cannot actually satisfy the interface at runtime).
 */
function isMemoryStore(v: unknown): v is MemoryStore {
  if (v === null || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  return STORE_METHODS.every((m) => typeof obj[m] === 'function')
}

// ---------------------------------------------------------------------------
// SharedMemory
// ---------------------------------------------------------------------------

/**
 * Namespaced shared memory for a team of agents.
 *
 * Writes are namespaced as `<agentName>/<key>` so that entries from different
 * agents never collide and are always attributable. Reads are namespace-aware
 * but also accept fully-qualified keys, making cross-agent reads straightforward.
 *
 * @example
 * ```ts
 * const mem = new SharedMemory()
 *
 * await mem.write('researcher', 'findings', 'TypeScript 5.5 ships const type params')
 * await mem.write('coder', 'plan', 'Implement feature X using const type params')
 *
 * const entry = await mem.read('researcher/findings')
 * const all = await mem.listByAgent('researcher')
 * const summary = await mem.getSummary()
 * ```
 */
export class SharedMemory {
  private readonly store: MemoryStore
  /**
   * Monotonic turn counter used to evaluate per-entry `expiresAtTurn`.
   * Advanced explicitly via {@link advanceTurn}; not bound to any specific
   * unit (the orchestrator drives it once per completed task in `runTeam` /
   * `runTasks`).
   */
  private turnCount = 0

  /**
   * @param store - Optional custom {@link MemoryStore} backing this shared memory.
   *                Defaults to an in-process {@link InMemoryStore}. Custom stores
   *                receive namespaced keys (`<agentName>/<key>`) opaque to them.
   *                Stores that don't implement {@link MemoryStore.setWithExpiry}
   *                still work — `writeExpiring` falls back to plain `set` on
   *                them and the entry never expires.
   *
   * @throws {TypeError} when `store` is provided but does not structurally
   *                     implement {@link MemoryStore} (fails fast on malformed
   *                     values, e.g. plain objects from untrusted JSON config).
   */
  constructor(store?: MemoryStore) {
    if (store !== undefined && !isMemoryStore(store)) {
      throw new TypeError(
        'SharedMemory: `store` must implement the MemoryStore interface ' +
          `(methods: ${STORE_METHODS.join(', ')}).`,
      )
    }
    this.store = store ?? new InMemoryStore()
  }

  // ---------------------------------------------------------------------------
  // Turn counter
  // ---------------------------------------------------------------------------

  /**
   * Advance the turn counter by one. Entries previously written via
   * {@link writeExpiring} with `ttlTurns: N` expire once the counter reaches
   * `(write-time count) + N`.
   *
   * Called by the orchestrator after each completed task in `runTeam` and
   * `runTasks`. Standalone `runAgent` does not advance the counter — there
   * is no team turn boundary in single-agent runs.
   */
  advanceTurn(): void {
    this.turnCount++
  }

  /** Current turn count. Useful for tests and observability. */
  getTurnCount(): number {
    return this.turnCount
  }

  /**
   * Restore the turn counter without rehydrating entries. Used on checkpoint
   * resume when the shared-memory store is reused: the entries are already
   * durable in the store, so only the counter needs restoring to keep TTL
   * expiry correct.
   */
  setTurnCount(turnCount: number): void {
    this.turnCount = turnCount
  }

  // ---------------------------------------------------------------------------
  // Snapshot / restore
  // ---------------------------------------------------------------------------

  /** Returns a serializable snapshot of all non-expired shared-memory entries. */
  async snapshot(): Promise<SharedMemorySnapshot> {
    return {
      version: 1,
      turnCount: this.turnCount,
      entries: this.filterExpired(await this.store.list()).map(SharedMemory.entryToSnapshot),
    }
  }

  /**
   * Rebuilds a {@link SharedMemory} instance from a snapshot.
   *
   * Snapshot entry values remain string-only at the {@link MemoryStore}
   * boundary; structured values are recovered through their metadata when read.
   */
  static async fromSnapshot(
    snapshot: SharedMemorySnapshot,
    store?: MemoryStore,
  ): Promise<SharedMemory> {
    const memory = new SharedMemory(store)
    await memory.restore(snapshot)
    return memory
  }

  /**
   * Restores this instance from a snapshot. Existing non-checkpoint entries in
   * the backing store are replaced; reserved checkpoint records are preserved
   * so the same store can hold both agent memory and checkpoints.
   */
  async restore(snapshot: SharedMemorySnapshot): Promise<void> {
    if (snapshot.version !== 1) {
      throw new Error(`SharedMemory.restore: unsupported snapshot version ${String(snapshot.version)}.`)
    }

    const existing = await this.store.list()
    for (const entry of existing) {
      if (!SharedMemory.isReservedStoreKey(entry.key)) {
        await this.store.delete(entry.key)
      }
    }

    for (const entry of snapshot.entries) {
      if (SharedMemory.isReservedStoreKey(entry.key)) continue
      if (entry.expiresAtTurn !== undefined && typeof this.store.setWithExpiry === 'function') {
        await this.store.setWithExpiry(entry.key, entry.value, entry.expiresAtTurn, entry.metadata)
      } else {
        await this.store.set(entry.key, entry.value, entry.metadata)
      }
    }
    this.turnCount = snapshot.turnCount
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Write `value` under the namespaced key `<agentName>/<key>`.
   *
   * Metadata is merged with a `{ agent: agentName }` marker so consumers can
   * identify provenance when iterating all entries.
   *
   * @param agentName - The writing agent's name (used as a namespace prefix).
   * @param key       - Logical key within the agent's namespace.
   * @param value     - JSON-serializable value to store.
   * @param metadata  - Optional extra metadata stored alongside the entry.
   * @param options   - Optional write-time validation.
   */
  async write<TValue extends SharedMemoryValue>(
    agentName: string,
    key: string,
    value: TValue,
    metadata?: Record<string, unknown>,
    options?: SharedMemoryWriteOptions,
  ): Promise<void> {
    const serialized = SharedMemory.serializeValue(value, options)
    const namespacedKey = SharedMemory.namespaceKey(agentName, key)
    await this.store.set(namespacedKey, serialized.value, {
      ...SharedMemory.cleanMetadata(metadata),
      ...serialized.metadata,
      agent: agentName,
    })
  }

  /**
   * Like {@link write}, but tags the entry with a turn-count expiry so it is
   * automatically dropped from reads once the {@link advanceTurn} counter has
   * advanced `ttlTurns` steps.
   *
   * Backends that don't implement {@link MemoryStore.setWithExpiry} fall back
   * to a plain write — the entry persists indefinitely and `ttlTurns` is
   * effectively ignored. Custom store authors who need TTL must implement
   * the optional method.
   *
   * @param ttlTurns - Number of turns the entry should remain readable for.
   *                   Must be an integer ≥ 1; throws {@link RangeError}
   *                   otherwise.
   *
   * @throws {RangeError} when `ttlTurns` is not an integer or is less than 1.
   *
   * @remarks
   * In parallel batch execution (`runTasks` / `runTeam` running multiple
   * tasks in one batch) the turn counter advances per *completed* task, not
   * per *invoked* task. So if task A writes a TTL entry while task B is
   * still running, B completing first will advance the counter and may
   * expire A's entry sooner than wall-clock intuition suggests. For
   * cross-task hand-off semantics that need stricter ordering, write the
   * entry without TTL and delete explicitly.
   */
  async writeExpiring(
    agentName: string,
    key: string,
    value: SharedMemoryValue,
    ttlTurns: number,
    metadata?: Record<string, unknown>,
    options?: SharedMemoryWriteOptions,
  ): Promise<void> {
    if (!Number.isInteger(ttlTurns) || ttlTurns < 1) {
      throw new RangeError(
        `SharedMemory.writeExpiring: ttlTurns must be an integer ≥ 1 (got ${ttlTurns}). ` +
          'Use write() for entries that should never expire.',
      )
    }
    const serialized = SharedMemory.serializeValue(value, options)
    const namespacedKey = SharedMemory.namespaceKey(agentName, key)
    const fullMetadata = { ...SharedMemory.cleanMetadata(metadata), ...serialized.metadata, agent: agentName }
    if (typeof this.store.setWithExpiry === 'function') {
      const expiresAtTurn = this.turnCount + ttlTurns
      await this.store.setWithExpiry(namespacedKey, serialized.value, expiresAtTurn, fullMetadata)
    } else {
      // Custom store doesn't support TTL — degrade to plain set.
      await this.store.set(namespacedKey, serialized.value, fullMetadata)
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Read an entry by its fully-qualified key (`<agentName>/<key>`).
   *
   * Returns `null` when the key is absent **or** when the entry has expired
   * (per its `expiresAtTurn` against the current turn counter). Expired
   * entries are filtered out but **not** deleted from the underlying store —
   * deletion is left to the store impl (Redis has native TTL, Postgres a
   * cron, etc.). Reading is therefore safe to call from concurrent processes
   * without the risk of stomping on a fresh write to the same key.
   */
  async read(key: string): Promise<SharedMemoryEntry | null> {
    if (SharedMemory.isReservedStoreKey(key)) return null
    const entry = await this.store.get(key)
    if (entry === null) return null
    if (this.isExpired(entry)) return null
    return SharedMemory.parseEntry(entry)
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /** Returns every non-expired entry in the shared store, regardless of agent. */
  async listAll(): Promise<SharedMemoryEntry[]> {
    return this.filterExpired(await this.store.list()).map(SharedMemory.parseEntry)
  }

  /**
   * Returns all non-expired entries written by `agentName` (i.e. those whose
   * key starts with `<agentName>/`).
   */
  async listByAgent(agentName: string): Promise<SharedMemoryEntry[]> {
    const prefix = SharedMemory.namespaceKey(agentName, '')
    const all = await this.store.list()
    const live = this.filterExpired(all)
    return live.filter((entry) => entry.key.startsWith(prefix)).map(SharedMemory.parseEntry)
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  /**
   * Produces a human-readable summary of all entries in the store.
   *
   * The output is structured as a markdown-style block, grouped by agent, and
   * is designed to be prepended to an agent's system prompt or injected as a
   * user turn so the agent has context about what its teammates know.
   *
   * Returns an empty string when the store is empty.
   *
   * @example
   * ```
   * ## Shared Team Memory
   *
   * ### researcher
   * - findings: TypeScript 5.5 ships const type params
   *
   * ### coder
   * - plan: Implement feature X using const type params
   * ```
   */
  async getSummary(filter?: { taskIds?: string[] }): Promise<string> {
    let all = await this.store.list()
    all = this.filterExpired(all)
    if (filter?.taskIds && filter.taskIds.length > 0) {
      const taskIds = new Set(filter.taskIds)
      all = all.filter((entry) => {
        const slashIdx = entry.key.indexOf('/')
        const localKey = slashIdx === -1 ? entry.key : entry.key.slice(slashIdx + 1)
        if (!localKey.startsWith('task:') || !localKey.endsWith(':result')) return false
        const taskId = localKey.slice('task:'.length, localKey.length - ':result'.length)
        return taskIds.has(taskId)
      })
    }
    if (all.length === 0) return ''

    // Group entries by agent name.
    const byAgent = new Map<string, Array<{ localKey: string; value: SharedMemoryValue }>>()
    for (const entry of all) {
      const slashIdx = entry.key.indexOf('/')
      const agent = slashIdx === -1 ? '_unknown' : entry.key.slice(0, slashIdx)
      const localKey = slashIdx === -1 ? entry.key : entry.key.slice(slashIdx + 1)

      let group = byAgent.get(agent)
      if (!group) {
        group = []
        byAgent.set(agent, group)
      }
      group.push({ localKey, value: SharedMemory.parseEntry(entry).value })
    }

    const lines: string[] = ['## Shared Team Memory', '']
    for (const [agent, entries] of byAgent) {
      lines.push(`### ${agent}`)
      for (const { localKey, value } of entries) {
        // Truncate long values so the summary stays readable in a context window.
        const displayValue = SharedMemory.formatValueForSummary(value)
        const truncated =
          displayValue.length > 200 ? `${displayValue.slice(0, 197)}…` : displayValue
        lines.push(`- ${localKey}: ${truncated}`)
      }
      lines.push('')
    }

    return lines.join('\n').trimEnd()
  }

  // ---------------------------------------------------------------------------
  // Store access
  // ---------------------------------------------------------------------------

  /**
   * Returns the underlying {@link MemoryStore} so callers that only need the
   * raw key-value interface can receive a properly typed reference without
   * accessing private fields via bracket notation.
   */
  getStore(): MemoryStore {
    return this.store
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private static namespaceKey(agentName: string, key: string): string {
    return `${agentName}/${key}`
  }

  private static isReservedStoreKey(key: string): boolean {
    return RESERVED_STORE_PREFIXES.some((prefix) => key.startsWith(prefix))
  }

  private static entryToSnapshot(entry: MemoryEntry): MemoryEntrySnapshot {
    return {
      key: entry.key,
      value: entry.value,
      ...(entry.metadata !== undefined ? { metadata: { ...entry.metadata } } : {}),
      createdAt: entry.createdAt.toISOString(),
      ...(entry.expiresAtTurn !== undefined ? { expiresAtTurn: entry.expiresAtTurn } : {}),
    }
  }

  private static serializeValue<TValue extends SharedMemoryValue>(
    value: TValue,
    options?: SharedMemoryWriteOptions,
  ): { value: string; metadata?: Record<string, unknown> } {
    if (options?.schema) {
      const result = options.schema.safeParse(value)
      if (!result.success) {
        const issues = result.error.issues
          .map((issue) => `  • ${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('\n')
        throw new TypeError(`SharedMemory.write: value failed schema validation:\n${issues}`)
      }
      value = result.data as TValue
    }

    SharedMemory.assertJsonSerializable(value)
    if (typeof value === 'string') return { value }
    return {
      value: JSON.stringify(value),
      metadata: { [STRUCTURED_VALUE_METADATA_KEY]: STRUCTURED_VALUE_ENCODING },
    }
  }

  private static cleanMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (metadata === undefined || !(STRUCTURED_VALUE_METADATA_KEY in metadata)) {
      return metadata
    }

    const { [STRUCTURED_VALUE_METADATA_KEY]: _reserved, ...cleaned } = metadata
    return cleaned
  }

  private static parseEntry(entry: MemoryEntry): SharedMemoryEntry {
    const metadata = entry.metadata
    if (metadata?.[STRUCTURED_VALUE_METADATA_KEY] !== STRUCTURED_VALUE_ENCODING) {
      return entry
    }

    try {
      return { ...entry, value: JSON.parse(entry.value) as SharedMemoryValue }
    } catch {
      return entry
    }
  }

  private static formatValueForSummary(value: SharedMemoryValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  private static assertJsonSerializable(value: SharedMemoryValue): void {
    SharedMemory.assertJsonSerializableValue(value, new WeakSet<object>(), '<root>')
  }

  private static assertJsonSerializableValue(
    value: SharedMemoryValue,
    seen: WeakSet<object>,
    path: string,
  ): void {
    if (value === null) return

    const type = typeof value
    if (type === 'string' || type === 'boolean') return
    if (type === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError(`SharedMemory.write: value at ${path} must be a finite number.`)
      }
      return
    }

    if (type !== 'object') {
      throw new TypeError(`SharedMemory.write: value at ${path} is not JSON-serializable.`)
    }

    const objectValue = value as object
    if (seen.has(objectValue)) {
      throw new TypeError(`SharedMemory.write: value at ${path} contains a circular reference.`)
    }
    seen.add(objectValue)

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        SharedMemory.assertJsonSerializableValue(value[i], seen, `${path}[${i}]`)
      }
      seen.delete(objectValue)
      return
    }

    for (const [key, child] of Object.entries(value)) {
      SharedMemory.assertJsonSerializableValue(child, seen, `${path}.${key}`)
    }
    seen.delete(objectValue)
  }

  /** True when `entry.expiresAtTurn` is set and has been reached. */
  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAtTurn !== undefined && this.turnCount >= entry.expiresAtTurn
  }

  /**
   * Drops expired entries from `entries`. **Does not delete from the
   * underlying store** — that would race with concurrent writers in
   * distributed backends (the entry being deleted may have been
   * overwritten with a fresh value between our read and our delete).
   * Stores that want active cleanup should implement their own TTL sweep
   * (Redis: native EXPIRE; Postgres: a cron). Entries without
   * `expiresAtTurn` are always kept.
   */
  private filterExpired(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter((entry) => !SharedMemory.isReservedStoreKey(entry.key) && !this.isExpired(entry))
  }
}
