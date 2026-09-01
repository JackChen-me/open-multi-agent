/**
 * @fileoverview `verifyRun()` — the offline half of the "model-visible means
 * logged" invariant.
 *
 * The runner enforces lineage in process, where it can only ever record what it
 * knows: a block either names the event it came from or names nothing. It has
 * no way to record a *wrong* lineage. This module asks the harder question of a
 * journal read back cold — does the event a block names actually reproduce that
 * block, byte for byte? — which is what catches a conversation rewritten
 * without a `context/replace`, and what a checkpoint-restored lineage needs
 * audited before anyone trusts it.
 *
 * Three verdicts, deliberately distinct:
 *
 * - **failure** — the journal contradicts itself. A block names a lineage that
 *   provably does not produce it, or names nothing at all, or the sequence
 *   stream is not a stream.
 * - **inconclusive** — the journal cannot answer. A ring buffer evicted the
 *   head, or a best-effort append dropped a batch, so the named event is simply
 *   not in the readable window. Absence of evidence is reported as such rather
 *   than counted against the run.
 * - **ok** — every model-visible block in the window reproduces from what the
 *   journal retained.
 *
 * Pure apart from a single `readFrom(0)`. Intended for tests, CI gates, and
 * post-mortems, not for a hot path.
 */

import { canonicalContentHash } from './hash.js'
import { isMessageEvent, type RunEvent } from './events.js'
import type { RunJournal } from './journal.js'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** What a {@link VerifyRunFailure} claims is wrong. */
export type VerifyRunFailureCode =
  /** A model-visible block cannot be reproduced from the journal. */
  | 'MISSING_CONTEXT_REPLACE'
  /** Two events share a sequence, or the stream moves backwards. */
  | 'SEQ_NOT_MONOTONIC'
  /** A `sourceEventSeqs` reference cannot be an earlier event. */
  | 'BROKEN_LINK'

/** Why the check failed, distinguishing the modes that share a code. */
export type VerifyRunFailureReason =
  /** The block recorded `sourceEventSeqs: null`. */
  | 'no-lineage'
  /** The block named events, none of which carries its content. */
  | 'not-reproducible'
  | 'duplicate-sequence'
  | 'out-of-order-sequence'
  /** A reference at or above the sequence citing it, so never resolvable. */
  | 'forward-reference'

/** One contradiction found in a journal. */
export interface VerifyRunFailure {
  readonly code: VerifyRunFailureCode
  readonly reason: VerifyRunFailureReason
  /** Sequence of the event the failure was found on. */
  readonly seq?: number
  /** Position of the offending block within its `llm/request`. */
  readonly messageIndex?: number
  readonly blockIndex?: number
  readonly detail: string
}

/**
 * One question the readable window could not answer. Not a failure: a bounded
 * journal is supposed to drop its head, and a best-effort append is allowed to
 * lose a batch.
 */
export interface VerifyRunGap {
  /** Sequence of the event whose reference could not be resolved. */
  readonly seq: number
  /** Referenced sequences the window does not contain, ascending. */
  readonly missingSeqs: readonly number[]
  readonly messageIndex?: number
  readonly blockIndex?: number
  readonly detail: string
}

/** How much of the journal the verdict is based on. */
export interface VerifyRunStats {
  /** Events in the readable window. */
  readonly events: number
  /** `llm/request` events among them. */
  readonly requests: number
  /** Block descriptors examined across those requests. */
  readonly blocksChecked: number
}

export interface VerifyRunResult {
  /** True when nothing was contradicted. Equivalent to `failures.length === 0`. */
  readonly ok: boolean
  readonly failures: readonly VerifyRunFailure[]
  readonly inconclusive: readonly VerifyRunGap[]
  readonly stats: VerifyRunStats
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** How a set of `sourceEventSeqs` landed against the readable window. */
interface ResolvedRefs {
  readonly resolved: readonly RunEvent[]
  /** Below the citing sequence but absent: evicted or dropped. */
  readonly missing: readonly number[]
  /** At or above the citing sequence, so structurally impossible. */
  readonly forward: readonly number[]
}

function isJournal(
  input: RunJournal | { readonly events: readonly RunEvent[] },
): input is RunJournal {
  return typeof (input as RunJournal).readFrom === 'function'
}

function list(seqs: readonly number[]): string {
  return seqs.join(', ')
}

function describeBlock(
  request: RunEvent & { type: 'llm/request' },
  messageIndex: number,
  blockIndex: number,
  blockType: string,
): string {
  return `Request ${request.seq} block at message ${messageIndex}, block ${blockIndex} (${blockType})`
}

/**
 * Verify that every block the model saw is reproducible from the journal.
 *
 * Checks run in order — sequence integrity, then referential integrity, then
 * per-block reproducibility — so a journal that is not a coherent stream says
 * so before it is interrogated about content.
 *
 * @param input - A journal to read (`readFrom(0)`), or events already in hand.
 */
export async function verifyRun(
  input: RunJournal | { readonly events: readonly RunEvent[] },
): Promise<VerifyRunResult> {
  const events = isJournal(input) ? await input.readFrom(0) : input.events
  const failures: VerifyRunFailure[] = []
  const inconclusive: VerifyRunGap[] = []

  // --- Sequence integrity ---------------------------------------------------
  // A forward gap is legal: eviction drops the head, and a failed best-effort
  // append drops a batch. Repeating or reversing a sequence is not.
  const bySeq = new Map<number, RunEvent>()
  let previous: number | undefined
  for (const event of events) {
    if (previous !== undefined && event.seq <= previous) {
      failures.push({
        code: 'SEQ_NOT_MONOTONIC',
        reason: event.seq === previous ? 'duplicate-sequence' : 'out-of-order-sequence',
        seq: event.seq,
        detail: event.seq === previous
          ? `Sequence ${event.seq} appears more than once.`
          : `Sequence ${event.seq} follows ${previous}.`,
      })
    }
    previous = event.seq
    // First occurrence wins: in an append-only log the original write is the
    // authoritative one, and the repeat has already been reported.
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
  }

  const classify = (citingSeq: number, refs: readonly number[]): ResolvedRefs => {
    const resolved: RunEvent[] = []
    const missing: number[] = []
    const forward: number[] = []
    for (const seq of refs) {
      if (seq >= citingSeq) {
        forward.push(seq)
        continue
      }
      const source = bySeq.get(seq)
      if (source === undefined) missing.push(seq)
      else resolved.push(source)
    }
    return { resolved, missing, forward }
  }

  // --- Referential integrity ------------------------------------------------
  // Covers every `sourceEventSeqs` outside an `llm/request`; the request's own
  // per-block references are resolved during the reproducibility pass below, so
  // a gap there is reported once, with the block position attached.
  const checkRefs = (citingSeq: number, refs: readonly number[], what: string): void => {
    const { missing, forward } = classify(citingSeq, refs)
    if (forward.length > 0) {
      failures.push({
        code: 'BROKEN_LINK',
        reason: 'forward-reference',
        seq: citingSeq,
        detail: `${what} names ${list(forward)}, which cannot precede event ${citingSeq}.`,
      })
    }
    if (missing.length > 0) {
      inconclusive.push({
        seq: citingSeq,
        missingSeqs: missing,
        detail: `${what} names ${list(missing)}, which the readable window does not contain.`,
      })
    }
  }

  for (const event of events) {
    if (event.sourceEventSeqs !== undefined) {
      checkRefs(event.seq, event.sourceEventSeqs, `Event ${event.seq}`)
    }
    if (event.type !== 'context/replace') continue
    if (event.dropped !== undefined) {
      checkRefs(event.seq, event.dropped.sourceEventSeqs, `Event ${event.seq} dropped range`)
    }
    event.replacements.forEach((replacement, index) => {
      checkRefs(event.seq, replacement.sourceEventSeqs, `Event ${event.seq} replacement ${index}`)
    })
  }

  // --- Per-block reproducibility -------------------------------------------
  // Hashes are indexed per source event rather than per reference: a summarize
  // cache hit means one `context/replace` is named by blocks in many later
  // requests, and the whole conversation is re-sent every turn.
  const hashIndex = new Map<RunEvent, ReadonlySet<string>>()
  const reproduces = (event: RunEvent): ReadonlySet<string> => {
    const cached = hashIndex.get(event)
    if (cached !== undefined) return cached
    const hashes = new Set<string>()
    if (isMessageEvent(event)) {
      for (const block of event.message.content) hashes.add(canonicalContentHash(block))
    } else if (event.type === 'context/replace') {
      // The derived block is stored verbatim, which is what turns
      // reproducibility into a comparison instead of a re-execution.
      for (const replacement of event.replacements) {
        hashes.add(canonicalContentHash(replacement.block))
      }
    }
    // Every other event type carries no model-visible block, so it reproduces
    // nothing and a block naming only those is unexplained.
    hashIndex.set(event, hashes)
    return hashes
  }

  let requests = 0
  let blocksChecked = 0
  for (const event of events) {
    if (event.type !== 'llm/request') continue
    requests += 1
    for (const block of event.blocks) {
      blocksChecked += 1
      const where = describeBlock(event, block.messageIndex, block.blockIndex, block.blockType)
      const position = { messageIndex: block.messageIndex, blockIndex: block.blockIndex }

      if (block.sourceEventSeqs === null) {
        failures.push({
          code: 'MISSING_CONTEXT_REPLACE',
          reason: 'no-lineage',
          seq: event.seq,
          ...position,
          detail: `${where} records no lineage, so nothing in the journal explains what the model saw.`,
        })
        continue
      }

      const { resolved, missing, forward } = classify(event.seq, block.sourceEventSeqs)
      if (forward.length > 0) {
        failures.push({
          code: 'BROKEN_LINK',
          reason: 'forward-reference',
          seq: event.seq,
          ...position,
          detail: `${where} names ${list(forward)}, which cannot precede event ${event.seq}.`,
        })
      }
      if (resolved.some((source) => reproduces(source).has(block.contentHash))) continue

      if (missing.length > 0) {
        // One of the events that could have carried this block is outside the
        // window, so non-reproducibility is unproven rather than established.
        inconclusive.push({
          seq: event.seq,
          missingSeqs: missing,
          ...position,
          detail: `${where} names ${list(missing)}, which the readable window does not contain.`,
        })
        continue
      }
      if (forward.length > 0) continue

      failures.push({
        code: 'MISSING_CONTEXT_REPLACE',
        reason: 'not-reproducible',
        seq: event.seq,
        ...position,
        detail: `${where} names ${list(block.sourceEventSeqs)}, and none of those events reproduces its content.`,
      })
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    inconclusive,
    stats: { events: events.length, requests, blocksChecked },
  }
}
