/**
 * @fileoverview Filesystem-backed {@link MemoryStore} — the zero-dependency,
 * durable reference store so checkpoint/resume survives a process restart out
 * of the box.
 *
 * {@link InMemoryStore} lives in a `Map` and dies with the process, so the
 * checkpoint it holds does not outlive a crash. `FileStore` closes that gap
 * using only Node built-ins, so it adds no runtime dependency to core.
 *
 * **Design.** One JSON file holds the whole store. An in-memory `Map` mirrors
 * it, so reads (`get`/`list`) are served from memory and match
 * {@link InMemoryStore} semantics exactly (including `createdAt` preservation);
 * only mutations touch disk. Each mutation rewrites the file **atomically**:
 * write a sibling temp file, `fsync` it so the bytes are on stable storage,
 * then `rename` it over the target. A reader therefore always sees either the
 * whole previous state or the whole next one, never a half-written file — even
 * across a power loss, not just a process crash.
 *
 * **Where to wire it.** Prefer it as the *checkpoint* store
 * (`checkpoint: { store: new FileStore(path) }`) and leave shared memory on a
 * fast {@link InMemoryStore}: a separate checkpoint store self-embeds the
 * shared-memory snapshot, so resume rebuilds everything from the one file while
 * durability I/O stays at checkpoint cadence (safe runner boundaries and task
 * completion) instead of on every agent memory write. Using it as
 * `sharedMemoryStore` also works
 * and is durable, but then every shared-memory write flushes the whole file.
 *
 * **Scope.** Single Node process at a time — there is no cross-process file
 * lock. Concurrent writes *within* a process are serialized and safe. The
 * resume story ("process A crashes, process B resumes") is inherently
 * sequential, which is exactly this scope.
 *
 * @example
 * ```ts
 * import { OpenMultiAgent, Team, InMemoryStore, FileStore } from '@open-multi-agent/core'
 *
 * const team = new Team({ name: 'research', agents: [...], sharedMemoryStore: new InMemoryStore() })
 * const orchestrator = new OpenMultiAgent()
 *
 * // Durable checkpoints; resume works after a restart from the same path.
 * await orchestrator.runTasks(team, tasks, {
 *   checkpoint: { store: new FileStore('./.oma/checkpoint.json') },
 * })
 * ```
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { MemoryEntry, MemoryStore } from '../types.js'

// ---------------------------------------------------------------------------
// On-disk format
// ---------------------------------------------------------------------------

/** Bump when the on-disk shape changes; {@link FileStore} rejects other versions. */
const FILE_FORMAT_VERSION = 1

/**
 * A single {@link MemoryEntry} as stored on disk. JSON has no `Date`, so
 * `createdAt` is persisted as an ISO string and revived on load.
 */
interface StoredEntry {
  key: string
  value: string
  metadata?: Record<string, unknown>
  createdAt: string
  expiresAtTurn?: number
}

/** The whole file: a version tag plus every entry, in insertion order. */
interface StoreFile {
  version: number
  entries: StoredEntry[]
}

// ---------------------------------------------------------------------------
// FileStore
// ---------------------------------------------------------------------------

export class FileStore implements MemoryStore {
  private readonly filePath: string
  private readonly data = new Map<string, MemoryEntry>()
  /** Memoized one-time load of the on-disk state into {@link data}. */
  private loadPromise: Promise<void> | null = null
  /** Serializes flushes so concurrent writes rename in enqueue order (no lost writes). */
  private writeChain: Promise<void> = Promise.resolve()
  /** Makes each in-flight temp file name unique within this process. */
  private tempCounter = 0

  /**
   * @param filePath - Path to the single JSON state file. Parent directories
   *   are created on first write; a missing file is treated as an empty store.
   */
  constructor(filePath: string) {
    this.filePath = resolve(filePath)
  }

  // ---------------------------------------------------------------------------
  // MemoryStore interface
  // ---------------------------------------------------------------------------

  /** Returns the entry for `key`, or `null` if not present. */
  async get(key: string): Promise<MemoryEntry | null> {
    await this.ensureLoaded()
    return this.data.get(key) ?? null
  }

  /**
   * Upserts `key`, then flushes atomically. `createdAt` is **preserved** on
   * update, matching {@link InMemoryStore}.
   */
  async set(
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureLoaded()
    const existing = this.data.get(key)
    this.data.set(key, {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
    })
    await this.persist()
  }

  /**
   * Atomically replace one value within this FileStore instance.
   *
   * FileStore remains a single-process writer (see the module scope note);
   * cross-process reviewers should decide only after the suspended runner has
   * exited, or use a database-backed MemoryStore with cross-process CAS.
   */
  compareAndSet(
    key: string,
    expectedValue: string | null,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded()
      const existing = this.data.get(key)
      if ((existing?.value ?? null) !== expectedValue) return false
      this.data.set(key, {
        key,
        value,
        metadata: metadata !== undefined ? { ...metadata } : undefined,
        createdAt: existing?.createdAt ?? new Date(),
      })
      await this.flush()
      return true
    })
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Like {@link set}, but also records a turn-count expiry. Expiry filtering is
   * the caller's responsibility (typically {@link SharedMemory}); this store
   * only persists the field. `createdAt` is preserved on update.
   */
  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureLoaded()
    const existing = this.data.get(key)
    this.data.set(key, {
      key,
      value,
      metadata: metadata !== undefined ? { ...metadata } : undefined,
      createdAt: existing?.createdAt ?? new Date(),
      expiresAtTurn,
    })
    await this.persist()
  }

  /** Returns a snapshot of all entries in insertion order. */
  async list(): Promise<MemoryEntry[]> {
    await this.ensureLoaded()
    return Array.from(this.data.values())
  }

  /**
   * Removes the entry for `key`, flushing only when something changed.
   * Deleting a non-existent key is a no-op and touches no disk.
   */
  async delete(key: string): Promise<void> {
    await this.ensureLoaded()
    if (this.data.delete(key)) {
      await this.persist()
    }
  }

  /** Removes **all** entries and persists the now-empty store. */
  async clear(): Promise<void> {
    await this.ensureLoaded()
    this.data.clear()
    await this.persist()
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /** Loads the on-disk state exactly once; subsequent calls reuse the promise. */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.load()
    }
    return this.loadPromise
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (err) {
      // A missing file is a fresh store (first run); anything else is real.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        `FileStore: state file at "${this.filePath}" is not valid JSON. ` +
          `Refusing to start with a fresh store so durable data is not silently discarded; ` +
          `inspect, move, or delete the file to reset.`,
      )
    }

    const file = FileStore.assertStoreFile(parsed, this.filePath)
    for (const row of file.entries) {
      const entry = FileStore.reviveEntry(row, this.filePath)
      this.data.set(entry.key, entry)
    }
  }

  private static assertStoreFile(value: unknown, path: string): StoreFile {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`FileStore: state file at "${path}" is not a store object.`)
    }
    const obj = value as Record<string, unknown>
    if (obj['version'] !== FILE_FORMAT_VERSION) {
      throw new Error(
        `FileStore: unsupported state file version ${String(obj['version'])} at "${path}" ` +
          `(expected ${FILE_FORMAT_VERSION}).`,
      )
    }
    if (!Array.isArray(obj['entries'])) {
      throw new Error(`FileStore: state file at "${path}" has no "entries" array.`)
    }
    return obj as unknown as StoreFile
  }

  private static reviveEntry(row: unknown, path: string): MemoryEntry {
    if (row === null || typeof row !== 'object') {
      throw new Error(`FileStore: malformed entry in "${path}".`)
    }
    const r = row as Record<string, unknown>
    if (
      typeof r['key'] !== 'string' ||
      typeof r['value'] !== 'string' ||
      typeof r['createdAt'] !== 'string'
    ) {
      throw new Error(`FileStore: malformed entry in "${path}" (missing key/value/createdAt).`)
    }
    const createdAt = new Date(r['createdAt'])
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error(`FileStore: entry "${r['key']}" in "${path}" has an invalid createdAt.`)
    }
    // metadata, if present, must be a plain object. A non-object value (null,
    // array, or primitive) would be silently shredded by `{ ...metadata }` on
    // the next flush, so reject it loudly to honor the fail-on-corruption
    // contract. FileStore's own writes never produce non-object metadata, so
    // this only guards hand-edited or foreign files.
    let metadata: Record<string, unknown> | undefined
    if (r['metadata'] !== undefined) {
      const raw = r['metadata']
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`FileStore: entry "${r['key']}" in "${path}" has non-object metadata.`)
      }
      metadata = raw as Record<string, unknown>
    }
    return {
      key: r['key'],
      value: r['value'],
      ...(metadata !== undefined ? { metadata } : {}),
      createdAt,
      // Unlike metadata, a malformed expiresAtTurn cannot corrupt into garbage:
      // the numeric guard safely degrades it to "no expiry", so no throw needed.
      ...(typeof r['expiresAtTurn'] === 'number' ? { expiresAtTurn: r['expiresAtTurn'] } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Enqueues a flush. Chaining serializes the atomic renames so that, under
   * concurrent mutations, the last-enqueued flush (which re-serializes the live
   * `Map`) lands last — no write is lost. A failed flush rejects its own
   * caller but does not poison the chain for later writes.
   */
  private persist(): Promise<void> {
    const run = this.writeChain.then(() => this.flush())
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async flush(): Promise<void> {
    const file: StoreFile = {
      version: FILE_FORMAT_VERSION,
      entries: Array.from(this.data.values()).map(FileStore.toStored),
    }
    const json = JSON.stringify(file)
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })

    // Same-directory temp so the rename stays on one filesystem (atomic).
    const tempPath = `${this.filePath}.tmp-${String(process.pid)}-${String(this.tempCounter++)}`
    try {
      const handle = await open(tempPath, 'w')
      try {
        await handle.writeFile(json, 'utf8')
        // fsync the data before the swap: covers power loss / OS crash, not
        // just a process crash (which the rename alone would survive).
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, this.filePath)
    } catch (err) {
      await unlink(tempPath).catch(() => undefined) // best-effort temp cleanup
      throw err
    }
    await FileStore.syncDir(dir)
  }

  /**
   * Best-effort `fsync` of the directory so the rename itself is durable across
   * a power loss. Some platforms/filesystems reject directory fsync; the
   * temp-file fsync + rename already give crash consistency, so a failure here
   * is non-fatal and swallowed.
   */
  private static async syncDir(dir: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(dir, 'r')
      await handle.sync()
    } catch {
      // ignore — see doc comment
    } finally {
      await handle?.close()
    }
  }

  private static toStored(entry: MemoryEntry): StoredEntry {
    return {
      key: entry.key,
      value: entry.value,
      ...(entry.metadata !== undefined ? { metadata: { ...entry.metadata } } : {}),
      createdAt: entry.createdAt.toISOString(),
      ...(entry.expiresAtTurn !== undefined ? { expiresAtTurn: entry.expiresAtTurn } : {}),
    }
  }
}
