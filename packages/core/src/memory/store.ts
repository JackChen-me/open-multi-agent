/**
 * @fileoverview In-memory implementation of {@link MemoryStore}.
 *
 * All data lives in a plain `Map` and is never persisted to disk. This is the
 * default store used by {@link SharedMemory} and is suitable for testing and
 * single-process use-cases. Swap it for a Redis or SQLite-backed implementation
 * in production by satisfying the same {@link MemoryStore} interface.
 */

import type { MemoryEntry, MemoryStore } from '../types.js'

// ---------------------------------------------------------------------------
// InMemoryStore
// ---------------------------------------------------------------------------

/**
 * Synchronous-under-the-hood key/value store that exposes an `async` surface
 * so implementations can be swapped for async-native backends without changing
 * callers.
 *
 * All keys are treated as opaque strings. Values are always strings; structured
 * data must be serialised by the caller (e.g. `JSON.stringify`).
 *
 * @example
 * ```ts
 * const store = new InMemoryStore()
 * await store.set('config', JSON.stringify({ model: 'claude-opus-4-6' }))
 * const entry = await store.get('config')
 * ```
 */
export class InMemoryStore implements MemoryStore {
  private readonly data = new Map<string, MemoryEntry>()

  // ---------------------------------------------------------------------------
  // MemoryStore interface
  // ---------------------------------------------------------------------------

  /** Returns the entry for `key`, or `null` if not present. */
  async get(key: string): Promise<MemoryEntry | null> {
    return this.data.get(key) ?? null
  }

  /**
   * Upserts `key` with `value` and optional `metadata`.
   *
   * If the key already exists its `createdAt` is **preserved** so callers can
   * detect when a value was first written.
   */
  async set(
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.data.get(key)
    const entry: MemoryEntry = {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
    }
    this.data.set(key, entry)
  }

  /** Atomically replace one value when its current string matches exactly. */
  async compareAndSet(
    key: string,
    expectedValue: string | null,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const existing = this.data.get(key)
    if ((existing?.value ?? null) !== expectedValue) return false
    this.data.set(key, {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
    })
    return true
  }

  /**
   * Like {@link set}, but also records a turn-count expiry. The entry is
   * stored as-is — expiry filtering is the caller's responsibility (typically
   * {@link SharedMemory}, which owns the turn counter).
   *
   * `createdAt` is preserved on update, matching {@link set}.
   */
  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.data.get(key)
    const entry: MemoryEntry = {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAtTurn,
    }
    this.data.set(key, entry)
  }

  /** Returns a snapshot of all entries in insertion order. */
  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.data.values())
  }

  /**
   * Removes the entry for `key`.
   * Deleting a non-existent key is a no-op.
   */
  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  /** Removes **all** entries from the store. */
  async clear(): Promise<void> {
    this.data.clear()
  }

  // ---------------------------------------------------------------------------
  // Extensions beyond the base MemoryStore interface
  // ---------------------------------------------------------------------------

  /**
   * Returns entries whose `key` starts with `query` **or** whose `value`
   * contains `query` (case-insensitive substring match).
   *
   * This is a simple linear scan; it is not suitable for very large stores
   * without an index layer on top.
   *
   * @example
   * ```ts
   * // Find all entries related to "research"
   * const hits = await store.search('research')
   * ```
   */
  async search(query: string): Promise<MemoryEntry[]> {
    if (query.length === 0) {
      return this.list()
    }
    const lower = query.toLowerCase()
    return Array.from(this.data.values()).filter(
      (entry) =>
        entry.key.toLowerCase().includes(lower) ||
        entry.value.toLowerCase().includes(lower),
    )
  }

  // ---------------------------------------------------------------------------
  // Convenience helpers (not part of MemoryStore)
  // ---------------------------------------------------------------------------

  /** Returns the number of entries currently held in the store. */
  get size(): number {
    return this.data.size
  }

  /** Returns `true` if `key` exists in the store. */
  has(key: string): boolean {
    return this.data.has(key)
  }
}
