/**
 * @fileoverview Authoritative run record: the durable lifecycle and ownership
 * row for one logical run.
 *
 * A checkpoint answers "what state can execution resume from"; this record
 * answers "who is allowed to advance that state, and is the run still open".
 * The two are deliberately separate rows: a checkpoint is the latest recovery
 * snapshot and its write stays best-effort, while a lifecycle or ownership
 * write here is a primary fact and fails closed.
 *
 * The record carries two independent counters. `version` increments on every
 * write and is the optimistic-concurrency token a {@link RunStore} compares
 * against. `fencingToken` increments only when execution ownership changes, so
 * a worker that held token N can be rejected after another worker acquired
 * N+1 even though many unrelated writes happened in between.
 */

import type { RunStatusCode } from '../types.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RunStoreErrorCode =
  /** The backing store cannot perform the compare-and-set these writes need. */
  | 'RUN_STORE_ATOMIC_REQUIRED'
  /** Another worker holds an unexpired lease on the run. */
  | 'RUN_LEASE_HELD'
  /** This worker's lease was taken over, released, or cancelled. */
  | 'RUN_LEASE_LOST'
  /** The run already reached a terminal status and must not reopen. */
  | 'RUN_ALREADY_TERMINAL'
  /** The run is suspended; an explicit resume must make it eligible first. */
  | 'RUN_SUSPENDED'
  /** The requested lifecycle transition is not legal. */
  | 'RUN_INVALID_TRANSITION'
  /** A stored record is malformed or does not match its key. */
  | 'RUN_INTEGRITY_ERROR'
  /** Caller input is malformed. */
  | 'RUN_VALIDATION_ERROR'
  /** Contention exhausted the bounded compare-and-set retry budget. */
  | 'RUN_CONFLICT'
  /** No record exists for the run id. */
  | 'RUN_NOT_FOUND'

/** Stable public error for run-record persistence, ownership, and lifecycle failures. */
export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode
  /** The record observed when the failure was detected, when one was read. */
  readonly record?: RunRecord

  constructor(code: RunStoreErrorCode, message: string, record?: RunRecord) {
    super(message)
    this.name = 'RunStoreError'
    this.code = code
    if (record !== undefined) this.record = record
  }
}

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

/**
 * Durable lifecycle status of a logical run.
 *
 * This is deliberately not {@link RunStatusCode}. `RunStatus` normalises the
 * outcome a caller receives from one invocation; this vocabulary describes the
 * durable state machine an out-of-process worker or operator sees, and is kept
 * small so every legal transition can be enumerated.
 */
export type RunLifecycleStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const RUN_LIFECYCLE_STATUSES: readonly RunLifecycleStatus[] = [
  'queued',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
]

const TERMINAL_STATUSES: ReadonlySet<RunLifecycleStatus> = new Set<RunLifecycleStatus>([
  'completed',
  'failed',
  'cancelled',
])

/** True for a status that must never reopen. */
export function isTerminalRunStatus(status: RunLifecycleStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Legal durable transitions. Terminal statuses have no outgoing edge, so a
 * finished run cannot be reopened by a late or duplicate command.
 */
const LEGAL_TRANSITIONS: Readonly<Record<RunLifecycleStatus, readonly RunLifecycleStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['queued', 'suspended', 'completed', 'failed', 'cancelled'],
  suspended: ['queued', 'running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** True when `from -> to` is a legal durable transition. Same-status is not a transition. */
export function canTransitionRun(from: RunLifecycleStatus, to: RunLifecycleStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

/** Throw unless `from -> to` is legal. */
export function assertRunTransition(
  runId: string,
  from: RunLifecycleStatus,
  to: RunLifecycleStatus,
): void {
  if (canTransitionRun(from, to)) return
  throw new RunStoreError(
    isTerminalRunStatus(from) ? 'RUN_ALREADY_TERMINAL' : 'RUN_INVALID_TRANSITION',
    `Run "${runId}" cannot transition from "${from}" to "${to}".`,
  )
}

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

/** The worker currently permitted to advance the run, and until when. */
export interface RunLease {
  /** Opaque worker identity. Two live processes must never share one. */
  readonly owner: string
  readonly acquiredAt: string
  /** ISO instant after which another worker may take the run over. */
  readonly expiresAt: string
}

/**
 * Pointer to the checkpoint write the owner last fenced.
 *
 * Advisory, for operators and dashboards. It is recorded just before the
 * snapshot write, so a snapshot write that then fails leaves this one write
 * ahead of the stored checkpoint. Recovery never reads it: `restore()` reads
 * the checkpoint key directly.
 */
export interface RunCheckpointRef {
  /** Store key the snapshot was written to. */
  readonly key: string
  /** {@link CheckpointSnapshot} schema version of that write. */
  readonly snapshotVersion: number
  readonly savedAt: string
}

/** Terminal outcome copied from the run's normalised {@link RunStatus}. */
export interface RunOutcome {
  readonly code: RunStatusCode
  readonly message?: string
}

/** Durable suspension boundary, so a resume does not need a live worker. */
export interface RunSuspension {
  readonly suspendedAt: string
  /** Approval requests the run is waiting on, in the order it reported them. */
  readonly pendingApprovalIds: readonly string[]
}

/**
 * Authoritative durable state of one logical run.
 *
 * Every field is JSON-serialisable so any strongly consistent key/value or
 * relational backend can hold it without a custom codec.
 */
export interface RunRecord {
  readonly schema: 1
  readonly runId: string
  /** Optimistic-concurrency version. Starts at 1 and increments on every write. */
  readonly version: number
  readonly status: RunLifecycleStatus
  /** Execution attempt. Increments when a new worker takes an expired run over. */
  readonly attempt: number
  /** Monotonic ownership token. Increments only when the lease changes hands. */
  readonly fencingToken: number
  readonly lease?: RunLease
  readonly checkpointRef?: RunCheckpointRef
  readonly outcome?: RunOutcome
  readonly suspension?: RunSuspension
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1
}

function assertLease(value: unknown, runId: string): asserts value is RunLease {
  if (
    !isRecordObject(value)
    || typeof value['owner'] !== 'string'
    || value['owner'].trim().length === 0
    || !isIsoDate(value['acquiredAt'])
    || !isIsoDate(value['expiresAt'])
  ) {
    throw new RunStoreError(
      'RUN_INTEGRITY_ERROR',
      `Run record "${runId}" has a malformed lease.`,
    )
  }
}

/** Throw when a stored value is not a well-formed {@link RunRecord}. */
export function assertRunRecord(value: unknown): asserts value is RunRecord {
  if (!isRecordObject(value) || value['schema'] !== 1) {
    throw new RunStoreError('RUN_INTEGRITY_ERROR', 'Run record schema is invalid.')
  }
  const runId = typeof value['runId'] === 'string' ? value['runId'] : '<unknown>'
  if (typeof value['runId'] !== 'string' || value['runId'].trim().length === 0) {
    throw new RunStoreError('RUN_INTEGRITY_ERROR', 'Run record runId must be a non-empty string.')
  }
  if (!isPositiveInteger(value['version'])) {
    throw new RunStoreError('RUN_INTEGRITY_ERROR', `Run record "${runId}" has an invalid version.`)
  }
  if (!isPositiveInteger(value['attempt'])) {
    throw new RunStoreError('RUN_INTEGRITY_ERROR', `Run record "${runId}" has an invalid attempt.`)
  }
  if (!Number.isInteger(value['fencingToken']) || (value['fencingToken'] as number) < 0) {
    throw new RunStoreError(
      'RUN_INTEGRITY_ERROR',
      `Run record "${runId}" has an invalid fencing token.`,
    )
  }
  if (!RUN_LIFECYCLE_STATUSES.includes(value['status'] as RunLifecycleStatus)) {
    throw new RunStoreError(
      'RUN_INTEGRITY_ERROR',
      `Run record "${runId}" has an unknown status "${String(value['status'])}".`,
    )
  }
  if (!isIsoDate(value['createdAt']) || !isIsoDate(value['updatedAt'])) {
    throw new RunStoreError(
      'RUN_INTEGRITY_ERROR',
      `Run record "${runId}" has an invalid timestamp.`,
    )
  }
  if (value['lease'] !== undefined) assertLease(value['lease'], runId)
  const checkpointRef = value['checkpointRef']
  if (checkpointRef !== undefined) {
    if (
      !isRecordObject(checkpointRef)
      || typeof checkpointRef['key'] !== 'string'
      || !Number.isInteger(checkpointRef['snapshotVersion'])
      || !isIsoDate(checkpointRef['savedAt'])
    ) {
      throw new RunStoreError(
        'RUN_INTEGRITY_ERROR',
        `Run record "${runId}" has a malformed checkpoint reference.`,
      )
    }
  }
  const outcome = value['outcome']
  if (outcome !== undefined) {
    if (
      !isRecordObject(outcome)
      || typeof outcome['code'] !== 'string'
      || (outcome['message'] !== undefined && typeof outcome['message'] !== 'string')
    ) {
      throw new RunStoreError(
        'RUN_INTEGRITY_ERROR',
        `Run record "${runId}" has a malformed outcome.`,
      )
    }
  }
  const suspension = value['suspension']
  if (suspension !== undefined) {
    if (
      !isRecordObject(suspension)
      || !isIsoDate(suspension['suspendedAt'])
      || !Array.isArray(suspension['pendingApprovalIds'])
      || !suspension['pendingApprovalIds'].every((id) => typeof id === 'string')
    ) {
      throw new RunStoreError(
        'RUN_INTEGRITY_ERROR',
        `Run record "${runId}" has a malformed suspension boundary.`,
      )
    }
  }
}

/** Non-throwing form of {@link assertRunRecord}. */
export function isRunRecord(value: unknown): value is RunRecord {
  try {
    assertRunRecord(value)
    return true
  } catch {
    return false
  }
}

/**
 * True when the record's lease has not expired at `now`.
 *
 * A record with no lease is never live, which is what makes a released or
 * cancelled run immediately acquirable rather than waiting out a TTL.
 */
export function isRunLeaseLive(record: RunRecord, now: Date): boolean {
  if (!record.lease) return false
  return Date.parse(record.lease.expiresAt) > now.getTime()
}
