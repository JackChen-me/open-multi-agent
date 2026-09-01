/**
 * @fileoverview Zero-dependency JSONL {@link RunJournal} — one event per line,
 * append-only, using only Node built-ins.
 *
 * Writes are batched behind a fixed deadline: the first pending event opens the
 * window and later events do not reset it, so a burst of turns costs one write
 * instead of one per event while a quiet run still lands within the interval.
 * Each batch is a single `write` to an fd opened `'a'` followed by `fsync`,
 * which is the same "a reader sees whole records, never half of one" property
 * `FileStore` gets from its temp-file rename.
 *
 * **Crash window.** Everything up to the last completed batch is on disk; the
 * batch still inside the current window is not. `close()` flushes it.
 * `readFrom` tolerates one trailing partial line, which is what a crash in the
 * middle of a write leaves behind.
 *
 * **Scope.** One writer per file, no cross-process lock — the same statement
 * `FileStore` makes, and the same reason: the resume story it serves is
 * inherently sequential.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { RedactingStoreOptions } from '../memory/redacting-store.js'
import { redactSensitiveObject } from '../utils/redaction.js'
import { isRunEvent, type RunEvent } from './events.js'
import type { RunJournalRef } from '../types.js'
import type { RunJournal } from './journal.js'

/** Default batching deadline in milliseconds. */
const DEFAULT_FLUSH_INTERVAL_MS = 50

/** Options for {@link JsonlRunJournal}. */
export interface JsonlRunJournalOptions {
  /** Batching deadline in milliseconds. Defaults to 50. */
  readonly flushIntervalMs?: number
  /**
   * Scrub secrets from each event before it is written, using the same option
   * shape as `RedactingStore`. Redaction happens at write time, so `readFrom`
   * returns what was persisted, not the original.
   */
  readonly redact?: RedactingStoreOptions
}

interface PendingBatchWaiter {
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

export class JsonlRunJournal implements RunJournal {
  private readonly filePath: string
  private readonly flushIntervalMs: number
  private readonly redactPatterns: readonly RegExp[] | undefined

  private pendingLines: string[] = []
  private waiters: PendingBatchWaiter[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private handle: FileHandle | null = null
  /** Serializes batch writes so appended lines land in emission order. */
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * @param path - JSONL file to append to. Parent directories are created on
   *   the first write; a missing file is an empty journal.
   */
  constructor(path: string, options: JsonlRunJournalOptions = {}) {
    this.filePath = resolve(path)
    const interval = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    if (!Number.isFinite(interval) || interval < 0) {
      throw new Error('JsonlRunJournal: flushIntervalMs must be a non-negative finite number.')
    }
    this.flushIntervalMs = interval
    this.redactPatterns = options.redact === undefined
      ? undefined
      : options.redact.patterns ?? []
  }

  /**
   * Queue `events` for the current batch. The returned promise settles when the
   * batch containing them has been written and synced, so an append failure
   * reaches the caller rather than disappearing into a timer.
   */
  append(events: readonly RunEvent[]): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('JsonlRunJournal: journal is closed.'))
    }
    if (events.length === 0) return Promise.resolve()
    for (const event of events) {
      this.pendingLines.push(JSON.stringify(this.redactEvent(event)))
    }
    const settled = new Promise<void>((resolve_, reject) => {
      this.waiters.push({ resolve: resolve_, reject })
    })
    // The first pending event opens the window; later events do not reset it.
    this.timer ??= setTimeout(() => {
      void this.flushPending()
    }, this.flushIntervalMs)
    return settled
  }

  /**
   * Parse the persisted file and return every event with `seq >= seq`.
   *
   * Reads what is on disk: events still inside the current batching window are
   * not visible until they flush or the journal is closed.
   */
  async readFrom(seq: number): Promise<RunEvent[]> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const lines = raw.split('\n')
    const events: RunEvent[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.length === 0) continue
      // Only the final line can be a torn write; anything else is corruption.
      const trailing = i === lines.length - 1
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        if (trailing) continue
        throw new Error(
          `JsonlRunJournal: line ${i + 1} of "${this.filePath}" is not valid JSON.`,
        )
      }
      if (!isRunEvent(parsed)) {
        if (trailing) continue
        throw new Error(
          `JsonlRunJournal: line ${i + 1} of "${this.filePath}" is not a run event.`,
        )
      }
      if (parsed.seq >= seq) events.push(parsed)
    }
    return events
  }

  /** Flush the open batch, then close the file descriptor. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const settled = this.pendingLines.length > 0
      ? new Promise<void>((resolve_, reject) => {
          this.waiters.push({ resolve: resolve_, reject })
        })
      : Promise.resolve()
    await this.flushPending()
    await this.writeChain
    const handle = this.handle
    this.handle = null
    try {
      await settled
    } finally {
      await handle?.close()
    }
  }

  describe(): RunJournalRef {
    return { kind: 'JsonlRunJournal', path: this.filePath }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private redactEvent(event: RunEvent): RunEvent {
    return this.redactPatterns === undefined
      ? event
      : redactSensitiveObject(event, this.redactPatterns)
  }

  /**
   * Write everything accumulated so far as one batch and settle its waiters.
   * Never rejects: a write failure is delivered to the waiters instead, so the
   * timer callback cannot produce an unhandled rejection.
   */
  private async flushPending(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const lines = this.pendingLines
    const waiters = this.waiters
    this.pendingLines = []
    this.waiters = []
    if (lines.length === 0) {
      for (const waiter of waiters) waiter.resolve()
      return
    }

    const payload = `${lines.join('\n')}\n`
    const write = this.writeChain.then(() => this.writeBatch(payload))
    this.writeChain = write.then(() => undefined, () => undefined)
    try {
      await write
      for (const waiter of waiters) waiter.resolve()
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error)
    }
  }

  private async writeBatch(payload: string): Promise<void> {
    const handle = await this.ensureHandle()
    await handle.write(payload, null, 'utf8')
    // fsync the batch so a power loss cannot leave the run resuming from
    // events the OS never wrote.
    await handle.sync()
  }

  private async ensureHandle(): Promise<FileHandle> {
    if (this.handle === null) {
      await mkdir(dirname(this.filePath), { recursive: true })
      this.handle = await open(this.filePath, 'a')
    }
    return this.handle
  }
}
