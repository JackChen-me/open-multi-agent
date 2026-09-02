/**
 * @fileoverview Per-run execution context and identity/metadata helpers shared
 * across the orchestrator's run modes.
 *
 * Holds the {@link RunContext} assembled once per `runTeam` / `runTasks` call,
 * the {@link ActiveCheckpoint} handle, run-identity/metadata resolution, and the
 * small token/error utilities that every downstream module depends on. This is
 * the dependency-free base of the orchestrator module graph.
 */

import type {
  AgentRunResult,
  ApprovalDecisionRecord,
  ApprovalRequest,
  CheckpointSnapshot,
  InFlightTaskCheckpoint,
  ModelRoutingPolicy,
  OrchestratorConfig,
  RunIdentity,
  RunIdentityOptions,
  RunStatus,
  RunTasksOptions,
  StructuredTraceError,
  Task,
  TaskExecutionMetrics,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'
import type { AgentPool } from '../agent/pool.js'
import type { Team } from '../team/team.js'
import type { Scheduler } from './scheduler.js'
import type { Checkpoint } from '../memory/checkpoint.js'
import type { JournalRecorder } from '../journal/journal.js'
import type { DurableApprovalLedger } from '../approval/durable.js'
import type { TraceRuntime, TraceSpan } from '../observability/runtime.js'
import type { ResolvedRecoveryOptions } from './recovery.js'
import { createRunIdentity, validateRunMetadata } from '../observability/identity.js'

export const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
export const DEFAULT_MAX_CONCURRENCY = 5
export const DEFAULT_MAX_DELEGATION_DEPTH = 3
export const DEFAULT_MODEL = 'claude-opus-4-6'

export type RunMetadata = Readonly<Record<string, TraceAttributeValue>>

export interface RunFacts {
  readonly identity: RunIdentity
  readonly metadata?: RunMetadata
}

export function identityOptionsForRun(options?: RunTasksOptions): RunIdentityOptions {
  const checkpointRunId = options?.checkpoint && typeof options.checkpoint === 'object'
    ? options.checkpoint.runId
    : undefined
  if (
    options?.runId !== undefined
    && checkpointRunId !== undefined
    && options.runId !== checkpointRunId
  ) {
    throw new Error(
      `runId conflict: run options requested "${options.runId}" but checkpoint options requested "${checkpointRunId}".`,
    )
  }
  const runId = options?.runId ?? checkpointRunId
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
  }
}

export function createRunFacts(options: RunIdentityOptions = {}): RunFacts {
  const metadata = validateRunMetadata(options.metadata)
  return {
    identity: createRunIdentity(options),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

export function metadataAttributes(
  metadata: RunMetadata | undefined,
  overridden = false,
): Readonly<Record<string, TraceAttributeValue>> {
  const attributes: Record<string, TraceAttributeValue> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    attributes[`oma.meta.${key}`] = value
  }
  if (overridden) attributes['oma.meta._overridden'] = true
  return attributes
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.output_tokens
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Team-level context optionally injected into every worker prompt when
 * `RunTeamOptions.revealCoordinator` is true.
 */
export interface RevealCoordinatorContext {
  readonly goal: string
  readonly rosterNames: readonly string[]
}

export function buildRevealCoordinatorLines(
  revealContext: RevealCoordinatorContext,
  assignee: string,
): string[] {
  return [
    '## Team context',
    `Goal: ${revealContext.goal}`,
    `Team: ${revealContext.rosterNames.join(', ')}`,
    `Your role in this team: ${assignee}`,
    'Assignment: You are responsible for the prompt below in this team run.',
    '',
  ]
}

export function prependRevealCoordinatorContext(
  prompt: string,
  revealContext: RevealCoordinatorContext | undefined,
  assignee: string,
): string {
  return revealContext
    ? [...buildRevealCoordinatorLines(revealContext, assignee), prompt].join('\n')
    : prompt
}

/**
 * Internal execution context assembled once per `runTeam` / `runTasks` call.
 */
export interface RunContext {
  readonly team: Team
  readonly pool: AgentPool
  readonly scheduler: Scheduler
  readonly agentResults: Map<string, AgentRunResult>
  readonly config: OrchestratorConfig
  readonly checkpoint?: ActiveCheckpoint
  /** Present only when the run resolved a journal. Every emission guards on it. */
  readonly journal?: JournalRecorder
  /** Stable top-level execution identity, independent of trace callbacks. */
  readonly identity: RunIdentity
  /** Validated facts echoed on the result and persisted with checkpoints. */
  readonly metadata?: RunMetadata
  /** Legacy trace correlation alias. */
  readonly runId: string
  readonly traceRuntime?: TraceRuntime
  readonly taskSpans: Map<string, TraceSpan>
  /** AbortSignal for run-level cancellation. Checked by the task dispatch gate. */
  readonly abortSignal?: AbortSignal
  cumulativeUsage: TokenUsage
  cumulativeCost: number
  readonly maxTokenBudget?: number
  readonly maxCostBudget?: number
  readonly estimateCost?: OrchestratorConfig['estimateCost']
  budgetExceededTriggered: boolean
  budgetExceededReason?: string
  outcomeStatus?: RunStatus
  outcomeErrorInfo?: StructuredTraceError
  readonly taskMetrics: Map<string, TaskExecutionMetrics>
  /**
   * Present only when `runTeam` is called with `{ revealCoordinator: true }`.
   * `runTasks` omits this entirely (no goal concept).
   */
  readonly revealCoordinatorContext?: RevealCoordinatorContext
  readonly modelRouting?: ModelRoutingPolicy
  readonly taskById: Map<string, Task>
  readonly taskLeafById: Map<string, boolean>
  readonly recovery: ResolvedRecoveryOptions
  readonly recoveryPatchSignatures: Set<string>
}

export interface ActiveCheckpoint {
  readonly manager: Checkpoint
  readonly approvalLedger: DurableApprovalLedger
  readonly mode: CheckpointSnapshot['mode']
  readonly goal?: string
  readonly runId?: string
  /**
   * True when the checkpoint store is the same object as the team's
   * shared-memory store. In that case the memory entries are already durable
   * in the store, so the checkpoint omits the full shared-memory snapshot
   * (avoids ~O(N^2) write volume) and persists only the turn counter.
   */
  readonly reusesSharedMemoryStore: boolean
  /** Latest safe runner state for every task currently between queue boundaries. */
  readonly inFlightTasks: Map<string, InFlightTaskCheckpoint>
  /**
   * Journal watermark of the v5 snapshot this run resumed from. Present only on
   * a restore, and only when that snapshot carried one; it is what the tail
   * replay reads from and where the recorder continues numbering.
   */
  readonly journalWatermarkSeq?: number
  /** Reviewed boundaries not yet durably consumed by execution. */
  readonly pendingApprovals: Map<string, ApprovalRequest>
  /** Primary decisions loaded from the approval ledger and copied into results/checkpoints. */
  readonly approvalDecisions: Map<string, ApprovalDecisionRecord>
  /** Approved task/round boundaries that the execution loop may consume once. */
  readonly approvedBoundaries: Map<string, ApprovalDecisionRecord>
  saveChain: Promise<void>
}
