/**
 * @fileoverview The `RunEvent` vocabulary — one append-only record per thing
 * that happened inside a run.
 *
 * Every payload here must stay JSON-safe: {@link JsonlRunJournal} serializes
 * events verbatim, and `verifyRun()` re-reads them cold. Shared shapes are
 * imported from `types.ts` rather than redeclared, so an event and the run
 * result it describes never drift apart.
 *
 * This module deliberately does not import from `observability/`. Trace records
 * are telemetry and may be lost without affecting a run; journal events are
 * execution state. Keeping the two module graphs separate is what makes
 * "losing telemetry never loses the journal" a structural fact rather than a
 * convention.
 */

import type {
  ApprovalDecisionRecord,
  ApprovalRequest,
  CheckpointSnapshot,
  ContentBlock,
  LLMMessage,
  PlanRevision,
  RunStatus,
  StructuredTraceError,
  TaskStatus,
  TokenUsage,
  ToolCallRecord,
  ToolResultBlock,
  ToolUseBlock,
  TraceAttributeValue,
} from '../types.js'

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** Top-level entry point that produced the run a journal describes. */
export type RunJournalMode =
  | 'runAgent'
  | 'runTeam'
  | 'runTasks'
  | 'runFromPlan'
  | 'restore'

/** Fields carried by every {@link RunEvent}. */
export interface RunEventBase {
  /** 1-based, strictly increasing per `runId` across attempts. */
  readonly seq: number
  readonly timestampUnixMs: number
  readonly runId: string
  readonly attempt: number
  readonly taskId?: string
  readonly agentName?: string
  /** Link to telemetry when a trace runtime is active. Never required. */
  readonly traceId?: string
  readonly spanId?: string
  /** Journal events this one derives from. See the conventions below. */
  readonly sourceEventSeqs?: readonly number[]
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export interface RunStartEvent extends RunEventBase {
  readonly type: 'run/start'
  readonly mode: RunJournalMode
  readonly goal?: string
  readonly metadata?: Readonly<Record<string, TraceAttributeValue>>
}

export interface RunEndEvent extends RunEventBase {
  readonly type: 'run/end'
  readonly status: RunStatus
  readonly error?: StructuredTraceError
}

/** One task as it stood when a plan was set or revised. */
export interface PlanSetTask {
  readonly taskId: string
  readonly description?: string
  readonly assignee?: string
  readonly dependsOn?: readonly string[]
}

export interface PlanSetEvent extends RunEventBase {
  readonly type: 'plan/set'
  readonly revision: number
  readonly source: 'initial' | 'recovery'
  readonly tasks: readonly PlanSetTask[]
  readonly detail?: PlanRevision
}

/**
 * A task transition the run observed. v1 records `in_progress`, `completed`,
 * `failed`, and `skipped`; the `pending` / `blocked` starting states are
 * already carried by `plan/set`.
 */
export interface TaskStatusEvent extends RunEventBase {
  readonly type: 'task/status'
  readonly status: TaskStatus
  readonly reason?: string
}

export interface TurnStartEvent extends RunEventBase {
  readonly type: 'turn/start'
  readonly turn: number
}

/** Why a turn stopped. Mirrors the runner's phase-transition boundaries. */
export type TurnOutcome =
  | 'tool_use'
  | 'completed'
  | 'loop_detected'
  | 'budget_exceeded'
  | 'suspended'
  | 'aborted'
  | 'error'

export interface TurnEndEvent extends RunEventBase {
  readonly type: 'turn/end'
  readonly turn: number
  readonly outcome: TurnOutcome
}

export interface UserMessageEvent extends RunEventBase {
  readonly type: 'user/message'
  readonly message: LLMMessage
  readonly origin: 'input' | 'seed' | 'tool_results'
}

export interface AssistantMessageEvent extends RunEventBase {
  readonly type: 'assistant/message'
  readonly message: LLMMessage
  readonly origin: 'response' | 'seed'
  readonly usage?: TokenUsage
  readonly model?: string
  readonly stopReason?: string
}

/**
 * Per-block lineage for one model-visible request.
 *
 * The request itself is not stored: the conversation is re-sent every turn, so
 * recording it verbatim would grow the journal with the square of the turn
 * count. A descriptor names where each block came from and hashes what it
 * contained, which is what reproducibility checks actually need.
 */
export interface RequestBlockDescriptor {
  readonly messageIndex: number
  readonly blockIndex: number
  readonly role: 'user' | 'assistant'
  readonly blockType: ContentBlock['type']
  /** `null` when no journal event is known to have produced this block. */
  readonly sourceEventSeqs: readonly number[] | null
  /** sha256 hex of the block's canonical JSON encoding. */
  readonly contentHash: string
}

export interface LLMRequestEvent extends RunEventBase {
  readonly type: 'llm/request'
  readonly turn: number
  readonly model: string
  readonly blocks: readonly RequestBlockDescriptor[]
  /** System prompt and tool definitions are caller config, not conversation. */
  readonly systemPromptHash?: string
  readonly toolsHash?: string
}

export interface ToolCallEvent extends RunEventBase {
  readonly type: 'tool/call'
  readonly call: ToolUseBlock
}

export interface ToolResultEvent extends RunEventBase {
  readonly type: 'tool/result'
  readonly toolCallId: string
  readonly result: ToolResultBlock
  readonly record?: ToolCallRecord
}

/** A shared-memory write attributable to a task. The store owns the value. */
export interface MemorySetEvent extends RunEventBase {
  readonly type: 'memory/set'
  readonly agent: string
  readonly key: string
  readonly valueBytes?: number
}

export interface ApprovalRequestEvent extends RunEventBase {
  readonly type: 'approval/request'
  readonly request: ApprovalRequest
}

export interface ApprovalDecisionEvent extends RunEventBase {
  readonly type: 'approval/decision'
  readonly decision: ApprovalDecisionRecord
}

export interface CheckpointSavedEvent extends RunEventBase {
  readonly type: 'checkpoint/saved'
  readonly mode: CheckpointSnapshot['mode']
  readonly version: number
  /** Recorder high-water mark at snapshot build time. */
  readonly watermarkSeq: number
}

/**
 * One append-only record of run execution state.
 *
 * `sourceEventSeqs` conventions: `assistant/message` names its `llm/request`;
 * `tool/call` names its `assistant/message`; `tool/result` names its
 * `tool/call`; a `user/message` with `origin: 'tool_results'` names the
 * `tool/result` events assembled into it.
 */
export type RunEvent =
  | RunStartEvent
  | RunEndEvent
  | PlanSetEvent
  | TaskStatusEvent
  | TurnStartEvent
  | TurnEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | LLMRequestEvent
  | ToolCallEvent
  | ToolResultEvent
  | MemorySetEvent
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
  | CheckpointSavedEvent

/** Every `type` discriminator in the {@link RunEvent} union. */
export const RUN_EVENT_TYPES = [
  'run/start',
  'run/end',
  'plan/set',
  'task/status',
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/message',
  'llm/request',
  'tool/call',
  'tool/result',
  'memory/set',
  'approval/request',
  'approval/decision',
  'checkpoint/saved',
] as const satisfies readonly RunEvent['type'][]

const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES)

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Structural check applied to anything parsed back from a persisted journal.
 *
 * Validates the base envelope only. A stricter per-variant schema would reject
 * events written by a newer minor version that added an optional payload
 * field, which is the opposite of what an append-only log needs.
 */
export function isRunEvent(value: unknown): value is RunEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<RunEventBase> & { type?: unknown }
  return typeof event.type === 'string'
    && RUN_EVENT_TYPE_SET.has(event.type)
    && typeof event.seq === 'number'
    && Number.isInteger(event.seq)
    && event.seq > 0
    && typeof event.timestampUnixMs === 'number'
    && typeof event.runId === 'string'
    && typeof event.attempt === 'number'
}

/** True for the two events that carry a full {@link LLMMessage} payload. */
export function isMessageEvent(
  event: RunEvent,
): event is UserMessageEvent | AssistantMessageEvent {
  return event.type === 'user/message' || event.type === 'assistant/message'
}
