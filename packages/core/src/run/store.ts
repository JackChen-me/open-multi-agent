/**
 * @fileoverview The {@link RunStore} seam and its {@link MemoryStore}-backed
 * adapter.
 *
 * `RunStore` is deliberately tiny: read one record, create it if absent, and
 * replace it only when the stored version still matches. Everything that makes
 * a run safe to own — lease expiry, fencing, legal transitions, idempotent
 * commands — lives above it in {@link RunLedger}, so an implementer porting
 * this to Postgres, Redis, DynamoDB, or etcd reproduces three methods rather
 * than a state machine.
 */

import type { MemoryStore } from '../types.js'
import { RunStoreError, assertRunRecord, type RunRecord } from './record.js'

export const RUN_KEY_PREFIX = '__oma_run__/'

/** Store key holding the authoritative record for `runId`. */
export function runRecordKey(runId: string): string {
  return `${RUN_KEY_PREFIX}${runId}`
}

/** True for a key in the reserved run-record namespace. */
export function isRunRecordKey(key: string): boolean {
  return key.startsWith(RUN_KEY_PREFIX)
}

/**
 * How far an implementation's compare-and-set actually reaches.
 *
 * `'process'` means writes are only serialised inside one Node process — the
 * shipped {@link InMemoryStore} and {@link FileStore} are both in this class.
 * They are honest reference backends for sequential restart recovery and must
 * not be presented as multi-worker lease backends. `'cross-process'` claims the
 * compare-and-set is atomic against every concurrent writer, which is what
 * single-active execution across workers actually requires.
 */
export type RunStoreAtomicity = 'process' | 'cross-process'

/**
 * Strongly consistent, versioned storage for {@link RunRecord}.
 *
 * Implementations must make {@link RunStore.create} and
 * {@link RunStore.compareAndSet} atomic to the extent {@link atomicity}
 * declares, and must not silently coerce a stale write into a successful one.
 */
export interface RunStore {
  /**
   * Reach of this store's atomicity. Callers that need single-active execution
   * across workers reject a `'process'` store rather than assume.
   */
  readonly atomicity: RunStoreAtomicity
  /** Read the authoritative record, or `null` when the run is unknown. */
  get(runId: string): Promise<RunRecord | null>
  /** Insert `record` only when no record exists. Returns `false` on a race. */
  create(record: RunRecord): Promise<boolean>
  /**
   * Replace the record for `runId` only when its stored `version` is
   * `expectedVersion`. Returns `false` when it is not. `next.version` must be
   * `expectedVersion + 1`.
   */
  compareAndSet(runId: string, expectedVersion: number, next: RunRecord): Promise<boolean>
  /** Optional hard delete, for retention or test teardown. */
  delete?(runId: string): Promise<void>
}

export interface MemoryStoreRunStoreOptions {
  /**
   * Reach of the backing store's `compareAndSet`. Defaults to `'process'`
   * because the adapter cannot inspect the backend: declare `'cross-process'`
   * only for a store whose compare-and-set is atomic against every writer
   * (a Redis `WATCH`/Lua swap, a Postgres conditional `UPDATE`, and so on).
   */
  readonly atomicity?: RunStoreAtomicity
}

/**
 * {@link RunStore} over any {@link MemoryStore} that implements
 * `compareAndSet`, using the reserved `__oma_run__/` key namespace.
 *
 * This is the adapter that lets one durable backend hold checkpoints, the
 * approval ledger, and run records together. It inherits the backing store's
 * atomicity exactly, which is why {@link MemoryStoreRunStoreOptions.atomicity}
 * is the caller's declaration rather than a guess.
 */
export class MemoryStoreRunStore implements RunStore {
  readonly atomicity: RunStoreAtomicity

  constructor(
    private readonly store: MemoryStore,
    options: MemoryStoreRunStoreOptions = {},
  ) {
    if (!store.compareAndSet) {
      throw new RunStoreError(
        'RUN_STORE_ATOMIC_REQUIRED',
        'A run store requires MemoryStore.compareAndSet for versioned run-record writes.',
      )
    }
    this.atomicity = options.atomicity ?? 'process'
  }

  async get(runId: string): Promise<RunRecord | null> {
    const read = await this.read(runId)
    return read?.record ?? null
  }

  async create(record: RunRecord): Promise<boolean> {
    assertRunRecord(record)
    if (record.version !== 1) {
      throw new RunStoreError(
        'RUN_VALIDATION_ERROR',
        `Run record "${record.runId}" must be created at version 1, not ${record.version}.`,
      )
    }
    return this.swap(record.runId, null, record)
  }

  async compareAndSet(
    runId: string,
    expectedVersion: number,
    next: RunRecord,
  ): Promise<boolean> {
    assertRunRecord(next)
    if (next.runId !== runId) {
      throw new RunStoreError(
        'RUN_VALIDATION_ERROR',
        `Run record "${next.runId}" cannot be written under run id "${runId}".`,
      )
    }
    if (next.version !== expectedVersion + 1) {
      throw new RunStoreError(
        'RUN_VALIDATION_ERROR',
        `Run record "${runId}" write expected version ${expectedVersion + 1}, got ${next.version}.`,
      )
    }
    const read = await this.read(runId)
    if (read === null || read.record.version !== expectedVersion) return false
    return this.swap(runId, read.raw, next)
  }

  async delete(runId: string): Promise<void> {
    await this.store.delete(runRecordKey(runId))
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async read(runId: string): Promise<{ record: RunRecord; raw: string } | null> {
    const entry = await this.store.get(runRecordKey(runId))
    if (entry === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(entry.value)
    } catch {
      throw new RunStoreError(
        'RUN_INTEGRITY_ERROR',
        `Run record "${runId}" is not valid JSON.`,
      )
    }
    assertRunRecord(parsed)
    if (parsed.runId !== runId) {
      throw new RunStoreError(
        'RUN_INTEGRITY_ERROR',
        `Run record key does not match record "${parsed.runId}".`,
      )
    }
    return { record: parsed, raw: entry.value }
  }

  private swap(
    runId: string,
    expectedRaw: string | null,
    next: RunRecord,
  ): Promise<boolean> {
    return this.store.compareAndSet!(runRecordKey(runId), expectedRaw, JSON.stringify(next), {
      namespace: 'run',
      schema: 1,
      runId,
      version: next.version,
      status: next.status,
      attempt: next.attempt,
      fencingToken: next.fencingToken,
      updatedAt: next.updatedAt,
    })
  }
}
