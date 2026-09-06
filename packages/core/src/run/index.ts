/**
 * @fileoverview Barrel for the authoritative run record, its store seam, and
 * the execution lease built over them.
 *
 * See [docs/run-store.md](../../../../docs/run-store.md) for the lifecycle,
 * fencing rules, and what a cross-process backend has to guarantee.
 */

export {
  RUN_LIFECYCLE_STATUSES,
  RunStoreError,
  assertRunRecord,
  assertRunTransition,
  canTransitionRun,
  isRunLeaseLive,
  isRunRecord,
  isTerminalRunStatus,
} from './record.js'
export type {
  RunCheckpointRef,
  RunLease,
  RunLifecycleStatus,
  RunOutcome,
  RunRecord,
  RunStoreErrorCode,
  RunSuspension,
} from './record.js'

export {
  MemoryStoreRunStore,
  RUN_KEY_PREFIX,
  isRunRecordKey,
  runRecordKey,
} from './store.js'
export type {
  MemoryStoreRunStoreOptions,
  RunStore,
  RunStoreAtomicity,
} from './store.js'

export {
  DEFAULT_RUN_LEASE_TTL_MS,
  RunLeaseHandle,
  RunLedger,
  resolveRunStoreConfig,
} from './ledger.js'
export type {
  AcquireRunLeaseOptions,
  RunLedgerOptions,
  RunStoreConfig,
} from './ledger.js'
