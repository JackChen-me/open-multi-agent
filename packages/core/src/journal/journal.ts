/**
 * @fileoverview The run journal side channel: the {@link RunJournal} backend
 * contract, the bundled in-memory backend, and the per-run
 * {@link JournalRecorder} that stamps and orders every emission.
 *
 * `MemoryStore` is key/value shaped and `FileStore` rewrites its whole file per
 * write, so appending one event per model call through either would cost
 * O(store size) per event. The journal therefore owns a small append-only
 * interface of its own and leaves the KV stores untouched.
 *
 * Journal writes are best-effort, exactly like checkpoint saves: a failed
 * append is surfaced to the caller and never fails the run it observes. That
 * holds at approval boundaries too — durability there is the
 * `DurableApprovalLedger`'s job, not the journal's.
 */

import type { ContentBlock, LLMMessage } from '../types.js'
import { canonicalContentHash } from './hash.js'
import type { RunEvent } from './events.js'

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

/**
 * Append-only per-run event log.
 *
 * The caller owns the instance's lifecycle. The orchestrator never calls
 * {@link RunJournal.close}, the same contract memory stores already have.
 */
export interface RunJournal {
  /** Append events in the given order. Rejecting reports a write failure. */
  append(events: readonly RunEvent[]): Promise<void>
  /** Every retained event with `seq >= seq`, in order. */
  readFrom(seq: number): Promise<RunEvent[]>
  /** Flush anything pending and release resources. */
  close(): Promise<void>
}

/** Journal configuration with the per-run switches spelled out. */
export interface RunJournalOptions {
  /** Defaults to `true`. Set `false` to keep the field but disable journaling. */
  readonly enabled?: boolean
  readonly journal: RunJournal
  /**
   * Throw {@link JournalLineageError} instead of recording `null` lineage when
   * a model-visible block cannot name the event it came from. Defaults to
   * `false`; see `docs/run-journal.md` for what currently passes.
   */
  readonly enforceLineage?: boolean
}

/** Journal configuration accepted by orchestrator config and run options. */
export type RunJournalConfig = RunJournal | RunJournalOptions

/** The journal and switches a single run resolved to. */
export interface ResolvedRunJournal {
  readonly journal: RunJournal
  readonly enforceLineage: boolean
}

function isRunJournal(value: RunJournalConfig): value is RunJournal {
  return typeof (value as RunJournal).append === 'function'
}

/**
 * Resolve the journal for one run: a per-call value overrides orchestrator
 * config, and `false` disables journaling for that call only. Mirrors how
 * `checkpoint` resolves.
 */
export function resolveRunJournal(
  configured: RunJournalConfig | undefined,
  override: RunJournalConfig | false | undefined,
): ResolvedRunJournal | undefined {
  if (override === false) return undefined
  const selected = override ?? configured
  if (selected === undefined) return undefined
  if (isRunJournal(selected)) return { journal: selected, enforceLineage: false }
  if (selected.enabled === false) return undefined
  return {
    journal: selected.journal,
    enforceLineage: selected.enforceLineage ?? false,
  }
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENTS = 10_000

/** Options for {@link InMemoryRunJournal}. */
export interface InMemoryRunJournalOptions {
  /** Retained event ceiling. Defaults to 10 000; oldest events are evicted. */
  readonly maxEvents?: number
}

/**
 * Bounded ring buffer, for auditing a run inside one process.
 *
 * Eviction drops the oldest events, so `readFrom` returns the retained tail
 * rather than the whole run. That gap is legal and detectable: a verification
 * pass reports a reference into an evicted window as inconclusive, not as a
 * lineage failure.
 */
export class InMemoryRunJournal implements RunJournal {
  private readonly capacity: number
  private readonly buffer: RunEvent[] = []
  /** Index of the oldest retained event once the buffer is full. */
  private start = 0

  constructor(options: InMemoryRunJournalOptions = {}) {
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error('InMemoryRunJournal: maxEvents must be a positive integer.')
    }
    this.capacity = maxEvents
  }

  /** Number of retained events. */
  get size(): number {
    return this.buffer.length
  }

  append(events: readonly RunEvent[]): Promise<void> {
    for (const event of events) {
      if (this.buffer.length < this.capacity) {
        this.buffer.push(event)
        continue
      }
      this.buffer[this.start] = event
      this.start = (this.start + 1) % this.capacity
    }
    return Promise.resolve()
  }

  readFrom(seq: number): Promise<RunEvent[]> {
    const retained: RunEvent[] = []
    const length = this.buffer.length
    for (let i = 0; i < length; i++) {
      const event = this.buffer[(this.start + i) % length]!
      if (event.seq >= seq) retained.push(event)
    }
    return Promise.resolve(retained)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Fields {@link JournalRecorder} stamps; callers supply everything else. */
type RecorderAssignedField = 'seq' | 'timestampUnixMs' | 'runId' | 'attempt'

/** A {@link RunEvent} minus the fields the recorder fills in. */
export type RunEventDraft<E extends RunEvent = RunEvent> =
  E extends RunEvent ? Omit<E, RecorderAssignedField> : never

/** Construction inputs for {@link JournalRecorder.open}. */
export interface JournalRecorderOptions {
  readonly journal: RunJournal
  readonly runId: string
  readonly attempt: number
  /** Stamped on every event when a trace runtime is active. */
  readonly traceId?: string
  readonly enforceLineage?: boolean
  /** Called once per append failure. Must not throw. */
  readonly onError?: (error: unknown) => void
}

interface BlockLineage {
  /** `null` when the block entered the conversation with no recorded event. */
  readonly seqs: readonly number[] | null
  /** Filled lazily on first request walk; blocks are immutable by convention. */
  hash?: string
}

/**
 * Per-run emitter shared by the orchestrator and every runner beneath it.
 *
 * `emit` assigns `seq` synchronously before any `await`, so concurrent tasks
 * sharing one recorder still produce a strictly increasing stream. Appends are
 * then drained through a single non-rejecting chain (modelled on
 * `ActiveCheckpoint.saveChain`), batching whatever accumulated while the
 * previous append was in flight.
 */
export class JournalRecorder {
  private readonly journal: RunJournal
  private readonly runId: string
  private readonly attempt: number
  private readonly traceId: string | undefined
  private readonly onError: ((error: unknown) => void) | undefined

  /** See {@link RunJournalOptions.enforceLineage}. */
  readonly enforceLineage: boolean

  private seq: number
  private pending: RunEvent[] = []
  private draining = false
  private chain: Promise<void> = Promise.resolve()

  private readonly lineage = new WeakMap<ContentBlock, BlockLineage>()
  private readonly toolCallSeqs = new Map<string, number>()

  private constructor(options: JournalRecorderOptions, startSeq: number) {
    this.journal = options.journal
    this.runId = options.runId
    this.attempt = options.attempt
    this.traceId = options.traceId
    this.onError = options.onError
    this.enforceLineage = options.enforceLineage ?? false
    this.seq = startSeq
  }

  /**
   * Attach a recorder to a journal, continuing its sequence.
   *
   * A restored attempt shares the logical run's numbering, so the tail is read
   * once at run start to find the high-water mark. One full read per run is
   * acceptable at this size; a backend-supplied `lastSeq()` would remove it.
   */
  static async open(options: JournalRecorderOptions): Promise<JournalRecorder> {
    let startSeq = 0
    try {
      for (const event of await options.journal.readFrom(0)) {
        if (event.seq > startSeq) startSeq = event.seq
      }
    } catch (error) {
      // A journal that cannot be read is still worth writing to; report the
      // failure and number from scratch rather than failing the run.
      options.onError?.(error)
    }
    return new JournalRecorder(options, startSeq)
  }

  /** Highest sequence number assigned so far. */
  get lastSeq(): number {
    return this.seq
  }

  /** Stamp and enqueue one event. Returns the sequence number assigned to it. */
  emit(draft: RunEventDraft): number {
    const seq = ++this.seq
    const event = {
      ...draft,
      seq,
      timestampUnixMs: Date.now(),
      runId: this.runId,
      attempt: this.attempt,
      ...(this.traceId !== undefined && draft.traceId === undefined
        ? { traceId: this.traceId }
        : {}),
    } as RunEvent
    this.pending.push(event)
    if (!this.draining) {
      this.draining = true
      this.chain = this.chain.then(() => this.drain())
    }
    return seq
  }

  /** Wait until every emitted event has been handed to the backend. */
  async flush(): Promise<void> {
    let awaited: Promise<void> | undefined
    while (awaited !== this.chain) {
      awaited = this.chain
      await awaited
    }
  }

  // -------------------------------------------------------------------------
  // Lineage tracking
  // -------------------------------------------------------------------------

  /**
   * Record that `blocks` entered the conversation through the events named by
   * `seqs`. Keyed on block identity: context strategies rebuild message
   * objects but pass untouched blocks through by reference, so block identity
   * survives a rewrite where message identity does not.
   */
  registerBlocks(blocks: readonly ContentBlock[], seqs: readonly number[]): void {
    for (const block of blocks) {
      this.lineage.set(block, { seqs })
    }
  }

  /** Convenience wrapper for the common "register a whole message" case. */
  registerMessage(message: LLMMessage, seqs: readonly number[]): void {
    this.registerBlocks(message.content, seqs)
  }

  /** Events that produced `block`, or `null` when none was recorded. */
  lineageFor(block: ContentBlock): readonly number[] | null {
    return this.lineage.get(block)?.seqs ?? null
  }

  /**
   * Canonical hash of `block`, cached per block. The conversation is re-sent
   * every turn, so without the cache a long run would rehash its whole history
   * on every request.
   */
  hashFor(block: ContentBlock): string {
    const existing = this.lineage.get(block)
    if (existing !== undefined) {
      existing.hash ??= canonicalContentHash(block)
      return existing.hash
    }
    const entry: BlockLineage = { seqs: null, hash: canonicalContentHash(block) }
    this.lineage.set(block, entry)
    return entry.hash!
  }

  /** Remember which `tool/call` event announced `toolCallId`. */
  recordToolCallSeq(toolCallId: string, seq: number): void {
    this.toolCallSeqs.set(toolCallId, seq)
  }

  /** Sequence of the `tool/call` event for `toolCallId`, when this run emitted one. */
  toolCallSeq(toolCallId: string): number | undefined {
    return this.toolCallSeqs.get(toolCallId)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending
        this.pending = []
        await this.journal.append(batch)
      }
    } catch (error) {
      this.onError?.(error)
    } finally {
      this.draining = false
    }
  }
}
