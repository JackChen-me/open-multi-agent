/**
 * @fileoverview Execution ownership over an authoritative {@link RunStore}.
 *
 * {@link RunLedger} issues and reclaims run leases; {@link RunLeaseHandle} is
 * the capability a worker holds while it is the single owner of a run. Every
 * write in this module is a compare-and-set against the record version, and
 * every write a handle makes additionally checks that the record still carries
 * the fencing token that handle acquired. That is what makes a worker whose
 * lease expired unable to advance, checkpoint, or complete a run another worker
 * has since taken over.
 *
 * Nothing here is best-effort. A failed ownership or lifecycle write throws;
 * callers are expected to stop rather than continue on an unowned run.
 */

import { randomUUID } from 'node:crypto'
import {
  RunStoreError,
  assertRunTransition,
  isRunLeaseLive,
  isTerminalRunStatus,
  type RunCheckpointRef,
  type RunLifecycleStatus,
  type RunOutcome,
  type RunRecord,
} from './record.js'
import type { RunStore } from './store.js'

/** Default lease duration. A worker renews well inside this window. */
export const DEFAULT_RUN_LEASE_TTL_MS = 60_000

/** Bounded retry budget for a losing compare-and-set under contention. */
const CAS_RETRY_LIMIT = 5

/** Fraction of the TTL between background renewals. */
const HEARTBEAT_DIVISOR = 3

const MIN_HEARTBEAT_MS = 250

export interface RunLedgerOptions {
  /**
   * Opaque identity of this worker. Two live processes must never share one.
   * Defaults to a per-instance value derived from the pid and a random suffix.
   */
  readonly owner?: string
  /** Lease duration in milliseconds. Defaults to {@link DEFAULT_RUN_LEASE_TTL_MS}. */
  readonly leaseTtlMs?: number
  /** Clock seam. Tests inject a controllable clock; production uses `Date`. */
  readonly now?: () => Date
}

export interface AcquireRunLeaseOptions {
  /**
   * Keep the lease alive with a background timer while the handle is open.
   * Defaults to `true`. Turn it off when the caller renews explicitly, or in
   * tests that drive an injected clock.
   */
  readonly heartbeat?: boolean
}

/**
 * Orchestrator-facing run-store configuration.
 *
 * Pass a bare {@link RunStore} for the defaults, or this object to name the
 * worker, widen the lease, or turn the background renewal off.
 */
export interface RunStoreConfig extends RunLedgerOptions, AcquireRunLeaseOptions {
  readonly store: RunStore
}

/**
 * Normalise the `runStore` config accepted by `OrchestratorConfig` and the
 * per-run options into a single shape. `false` disables the run store for one
 * call even when the orchestrator configures one.
 */
export function resolveRunStoreConfig(
  ...layers: ReadonlyArray<RunStore | RunStoreConfig | false | undefined>
): RunStoreConfig | undefined {
  for (const layer of layers) {
    if (layer === undefined) continue
    if (layer === false) return undefined
    // Discriminate structurally on a RunStore method rather than on a `store`
    // field: a RunStore implementation is very likely to hold its own backend
    // under exactly that name.
    return typeof (layer as RunStore).compareAndSet === 'function'
      ? { store: layer as RunStore }
      : layer as RunStoreConfig
  }
  return undefined
}

function defaultOwner(): string {
  const pid = typeof process === 'undefined' ? 'node' : String(process.pid)
  return `oma-worker-${pid}-${randomUUID().slice(0, 8)}`
}

/**
 * Issues, renews, and reclaims execution leases for logical runs.
 *
 * One ledger represents one worker: its {@link owner} is stamped on every lease
 * it takes, so a second worker means a second ledger (usually a second process).
 */
export class RunLedger {
  readonly owner: string
  readonly leaseTtlMs: number
  private readonly clock: () => Date

  constructor(
    readonly store: RunStore,
    options: RunLedgerOptions = {},
  ) {
    const ttl = options.leaseTtlMs ?? DEFAULT_RUN_LEASE_TTL_MS
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RunStoreError('RUN_VALIDATION_ERROR', 'leaseTtlMs must be a positive number.')
    }
    const owner = options.owner ?? defaultOwner()
    if (owner.trim().length === 0) {
      throw new RunStoreError('RUN_VALIDATION_ERROR', 'Run lease owner must be a non-empty string.')
    }
    this.owner = owner
    this.leaseTtlMs = ttl
    this.clock = options.now ?? (() => new Date())
  }

  /** Current instant from the injected clock. */
  now(): Date {
    return this.clock()
  }

  /** Read the authoritative record without taking ownership. */
  async get(runId: string): Promise<RunRecord | null> {
    return this.store.get(runId)
  }

  /**
   * Become the single active owner of `runId`, creating the run when it is new.
   *
   * Refuses a run that is already terminal, held by a live lease belonging to
   * another worker, or suspended — a suspended run must first be made eligible
   * by {@link requestResume}, so a resume is an explicit, idempotent command
   * rather than a side effect of a worker waking up.
   */
  async acquire(runId: string, options: AcquireRunLeaseOptions = {}): Promise<RunLeaseHandle> {
    if (runId.trim().length === 0) {
      throw new RunStoreError('RUN_VALIDATION_ERROR', 'Run lease requires a non-empty runId.')
    }
    for (let attempt = 0; attempt <= CAS_RETRY_LIMIT; attempt++) {
      const now = this.now()
      const current = await this.store.get(runId)

      if (current === null) {
        const created = this.newRecord(runId, now)
        if (await this.store.create(created)) return this.handle(created, options)
        continue
      }

      if (isTerminalRunStatus(current.status)) {
        throw new RunStoreError(
          'RUN_ALREADY_TERMINAL',
          `Run "${runId}" already finished as "${current.status}" and cannot be acquired.`,
          current,
        )
      }
      if (current.status === 'suspended') {
        throw new RunStoreError(
          'RUN_SUSPENDED',
          `Run "${runId}" is suspended. Record the pending decision and resume it before acquiring.`,
          current,
        )
      }
      const leaseLive = isRunLeaseLive(current, now)
      if (leaseLive && current.lease!.owner !== this.owner) {
        throw new RunStoreError(
          'RUN_LEASE_HELD',
          `Run "${runId}" is leased by "${current.lease!.owner}" until ${current.lease!.expiresAt}.`,
          current,
        )
      }

      // A live lease we already hold is a renewal; anything else is a takeover
      // of an abandoned run and starts a new attempt.
      const renewal = leaseLive && current.lease!.owner === this.owner
      const next: RunRecord = {
        ...current,
        version: current.version + 1,
        status: 'running',
        attempt: renewal || current.lease === undefined ? current.attempt : current.attempt + 1,
        fencingToken: current.fencingToken + 1,
        lease: this.newLease(now),
        updatedAt: now.toISOString(),
      }
      // Re-acquiring an already-`running` record is a renewal or a takeover,
      // not a transition; only a genuine status change is checked.
      if (current.status !== 'running') assertRunTransition(runId, current.status, 'running')
      if (await this.store.compareAndSet(runId, current.version, next)) {
        return this.handle(next, options)
      }
    }
    throw new RunStoreError(
      'RUN_CONFLICT',
      `Run "${runId}" lease could not be acquired after ${CAS_RETRY_LIMIT} contended attempts.`,
    )
  }

  /**
   * Make a suspended or abandoned run eligible for a new lease.
   *
   * Idempotent: a run already `queued` converges without a write, and repeating
   * the command never executes work or reopens a terminal run.
   */
  async requestResume(runId: string): Promise<RunRecord> {
    return this.mutate(runId, (current, now) => {
      if (current.status === 'queued') return null
      if (isTerminalRunStatus(current.status)) {
        throw new RunStoreError(
          'RUN_ALREADY_TERMINAL',
          `Run "${runId}" already finished as "${current.status}" and cannot be resumed.`,
          current,
        )
      }
      if (current.status === 'running' && isRunLeaseLive(current, now)) {
        throw new RunStoreError(
          'RUN_LEASE_HELD',
          `Run "${runId}" is still executing under "${current.lease!.owner}".`,
          current,
        )
      }
      assertRunTransition(runId, current.status, 'queued')
      const { lease: _lease, suspension: _suspension, ...rest } = current
      return {
        ...rest,
        version: current.version + 1,
        status: 'queued',
        updatedAt: now.toISOString(),
      }
    })
  }

  /**
   * Cancel a run from outside its worker.
   *
   * Bumping the fencing token is what stops the current owner: its next fenced
   * write is rejected and it stops rather than finishing a cancelled run.
   * Repeating the command on an already-cancelled run converges.
   */
  async cancel(runId: string, message?: string): Promise<RunRecord> {
    return this.mutate(runId, (current, now) => {
      if (current.status === 'cancelled') return null
      if (isTerminalRunStatus(current.status)) {
        throw new RunStoreError(
          'RUN_ALREADY_TERMINAL',
          `Run "${runId}" already finished as "${current.status}" and cannot be cancelled.`,
          current,
        )
      }
      assertRunTransition(runId, current.status, 'cancelled')
      const { lease: _lease, ...rest } = current
      return {
        ...rest,
        version: current.version + 1,
        status: 'cancelled',
        fencingToken: current.fencingToken + 1,
        outcome: {
          code: 'cancelled' as const,
          ...(message !== undefined ? { message } : {}),
        },
        updatedAt: now.toISOString(),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Internals shared with RunLeaseHandle
  // -------------------------------------------------------------------------

  /** @internal */
  newLease(now: Date) {
    return {
      owner: this.owner,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
    }
  }

  private newRecord(runId: string, now: Date): RunRecord {
    const iso = now.toISOString()
    return {
      schema: 1,
      runId,
      version: 1,
      status: 'running',
      attempt: 1,
      fencingToken: 1,
      lease: this.newLease(now),
      createdAt: iso,
      updatedAt: iso,
    }
  }

  private handle(record: RunRecord, options: AcquireRunLeaseOptions): RunLeaseHandle {
    const handle = new RunLeaseHandle(this, record)
    if (options.heartbeat !== false) handle.startHeartbeat()
    return handle
  }

  /**
   * Read-modify-CAS with a bounded retry budget. A `null` from `build` means
   * the record already satisfies the command, so no write is issued.
   */
  private async mutate(
    runId: string,
    build: (current: RunRecord, now: Date) => RunRecord | null,
  ): Promise<RunRecord> {
    for (let attempt = 0; attempt <= CAS_RETRY_LIMIT; attempt++) {
      const current = await this.store.get(runId)
      if (current === null) {
        throw new RunStoreError('RUN_NOT_FOUND', `Run "${runId}" has no authoritative record.`)
      }
      const next = build(current, this.now())
      if (next === null) return current
      if (await this.store.compareAndSet(runId, current.version, next)) return next
    }
    throw new RunStoreError(
      'RUN_CONFLICT',
      `Run "${runId}" could not be updated after ${CAS_RETRY_LIMIT} contended attempts.`,
    )
  }
}

/**
 * The capability a worker holds while it owns a run.
 *
 * Every method fences: it re-reads the authoritative record and rejects the
 * write unless the record still carries this handle's fencing token and owner.
 * The first rejection latches {@link lost}, after which the handle refuses to
 * write anything at all — a fenced-out worker must not race the new owner even
 * once more.
 */
export class RunLeaseHandle {
  readonly runId: string
  readonly owner: string
  /** Ownership token this handle acquired. Rejected once the record moves past it. */
  readonly fencingToken: number

  private current: RunRecord
  private lostError: RunStoreError | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ledger: RunLedger,
    record: RunRecord,
  ) {
    this.runId = record.runId
    this.owner = ledger.owner
    this.fencingToken = record.fencingToken
    this.current = record
  }

  /** Latest record this handle wrote or read. */
  get record(): RunRecord {
    return this.current
  }

  /** Execution attempt this lease represents. */
  get attempt(): number {
    return this.current.attempt
  }

  /** Set once the lease is provably gone. Every later write throws it. */
  get lost(): RunStoreError | undefined {
    return this.lostError
  }

  /** True while this handle is still the authoritative owner as far as it knows. */
  get held(): boolean {
    return this.lostError === undefined
  }

  /** Extend the lease. Throws {@link RunStoreError} once ownership is gone. */
  async renew(): Promise<RunRecord> {
    return this.fencedWrite((current, now) => ({
      ...current,
      version: current.version + 1,
      lease: this.ledger.newLease(now),
      updatedAt: now.toISOString(),
    }))
  }

  /**
   * Point the record at the checkpoint this worker is about to write, renewing
   * the lease in the same compare-and-set.
   *
   * Callers fence here immediately before the snapshot write so a worker that
   * has been taken over cannot overwrite the new owner's checkpoint. The two
   * rows are separate, so a takeover landing between this call and the snapshot
   * write leaves a narrow window in which one stale snapshot can still be
   * written; the new owner's own next checkpoint supersedes it, and the run
   * record — which decides who may advance — is already unambiguous.
   */
  async recordCheckpoint(ref: RunCheckpointRef): Promise<RunRecord> {
    return this.fencedWrite((current, now) => ({
      ...current,
      version: current.version + 1,
      checkpointRef: ref,
      lease: this.ledger.newLease(now),
      updatedAt: now.toISOString(),
    }))
  }

  /**
   * Record a durable suspension boundary and drop the lease.
   *
   * The suspended run no longer depends on this process: a decision can be
   * recorded while nothing is running, and `requestResume` then makes it
   * eligible for a new lease.
   */
  async suspend(pendingApprovalIds: readonly string[] = []): Promise<RunRecord> {
    return this.terminalish('suspended', (current, now) => {
      const { lease: _lease, ...rest } = current
      return {
        ...rest,
        version: current.version + 1,
        status: 'suspended' as const,
        suspension: {
          suspendedAt: now.toISOString(),
          pendingApprovalIds: [...pendingApprovalIds],
        },
        updatedAt: now.toISOString(),
      }
    })
  }

  /** Close the run as finished. Repeating it on an already-completed run converges. */
  async complete(outcome: RunOutcome = { code: 'ok' }): Promise<RunRecord> {
    return this.finish('completed', outcome)
  }

  /** Close the run as failed. */
  async fail(outcome: RunOutcome): Promise<RunRecord> {
    return this.finish('failed', outcome)
  }

  /** Close the run as cancelled by its own worker. */
  async cancel(outcome: RunOutcome = { code: 'cancelled' }): Promise<RunRecord> {
    return this.finish('cancelled', outcome)
  }

  /**
   * Give the run up without finishing it, so another worker can pick it up
   * immediately instead of waiting out the lease TTL.
   */
  async release(): Promise<RunRecord> {
    return this.terminalish('queued', (current, now) => {
      const { lease: _lease, ...rest } = current
      return {
        ...rest,
        version: current.version + 1,
        status: 'queued' as const,
        updatedAt: now.toISOString(),
      }
    })
  }

  /** Start renewing in the background. Idempotent. */
  startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined || this.lostError !== undefined) return
    const interval = Math.max(MIN_HEARTBEAT_MS, Math.floor(this.ledger.leaseTtlMs / HEARTBEAT_DIVISOR))
    const timer = setInterval(() => {
      // A renewal failure has already latched `lost`; the run's dispatch gate
      // observes that and stops. Nothing here should raise unhandled.
      void this.renew().catch(() => undefined)
    }, interval)
    timer.unref?.()
    this.heartbeatTimer = timer
  }

  /** Stop background renewal. Always called on a finished run. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private finish(status: RunLifecycleStatus, outcome: RunOutcome): Promise<RunRecord> {
    return this.terminalish(status, (current, now) => {
      const { lease: _lease, ...rest } = current
      return {
        ...rest,
        version: current.version + 1,
        status,
        outcome,
        updatedAt: now.toISOString(),
      }
    })
  }

  /** A transition that ends this handle's ownership: stop the heartbeat too. */
  private async terminalish(
    target: RunLifecycleStatus,
    build: (current: RunRecord, now: Date) => RunRecord,
  ): Promise<RunRecord> {
    try {
      // These transitions drop the lease, so the ordinary fence would reject
      // the handle's own second call. Converge first: the same status at the
      // same fencing token means this handle already issued the command. A
      // token that moved on means somebody else did, which is still a loss.
      if (this.lostError === undefined) {
        const observed = await this.ledger.store.get(this.runId)
        if (
          observed !== null
          && observed.status === target
          && observed.fencingToken === this.fencingToken
        ) {
          this.current = observed
          return observed
        }
      }
      return await this.fencedWrite((current, now) => {
        if (current.status === target) return null
        assertRunTransition(this.runId, current.status, target)
        return build(current, now)
      })
    } finally {
      this.stopHeartbeat()
    }
  }

  /**
   * Read the authoritative record, verify this handle still owns it, and write
   * under optimistic concurrency. `build` may return `null` to converge without
   * a write when the record already satisfies the command.
   */
  private async fencedWrite(
    build: (current: RunRecord, now: Date) => RunRecord | null,
  ): Promise<RunRecord> {
    if (this.lostError) throw this.lostError
    for (let attempt = 0; attempt <= CAS_RETRY_LIMIT; attempt++) {
      const current = await this.ledger.store.get(this.runId)
      const fenceError = this.fenceViolation(current)
      if (fenceError) throw this.markLost(fenceError)
      this.current = current!
      const next = build(current!, this.ledger.now())
      if (next === null) return current!
      if (await this.ledger.store.compareAndSet(this.runId, current!.version, next)) {
        this.current = next
        return next
      }
    }
    throw new RunStoreError(
      'RUN_CONFLICT',
      `Run "${this.runId}" could not be updated after ${CAS_RETRY_LIMIT} contended attempts.`,
    )
  }

  /** The reason this handle no longer owns `record`, or `undefined` if it does. */
  private fenceViolation(record: RunRecord | null): RunStoreError | undefined {
    if (record === null) {
      return new RunStoreError(
        'RUN_LEASE_LOST',
        `Run "${this.runId}" no longer has an authoritative record.`,
      )
    }
    if (record.fencingToken !== this.fencingToken) {
      return new RunStoreError(
        'RUN_LEASE_LOST',
        `Run "${this.runId}" moved to fencing token ${record.fencingToken}; ` +
          `this worker holds ${this.fencingToken} and may no longer write.`,
        record,
      )
    }
    if (record.lease?.owner !== this.owner) {
      return new RunStoreError(
        'RUN_LEASE_LOST',
        `Run "${this.runId}" is no longer leased by "${this.owner}".`,
        record,
      )
    }
    return undefined
  }

  private markLost(error: RunStoreError): RunStoreError {
    this.lostError ??= error
    this.stopHeartbeat()
    return this.lostError
  }
}
