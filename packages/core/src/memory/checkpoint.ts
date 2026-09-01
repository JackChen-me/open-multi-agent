/**
 * @fileoverview Durable checkpoint persistence over the public MemoryStore API.
 *
 * Checkpoints are stored as JSON under a reserved key namespace. The module
 * intentionally depends only on {@link MemoryStore}, so in-memory, Redis,
 * SQLite, or any custom backend work without extra hooks.
 */

import type {
  ApprovalRequest,
  CheckpointOptions,
  CheckpointSnapshot,
  MemoryStore,
} from '../types.js'
import { validateRunMetadata } from '../observability/identity.js'
import {
  assertApprovalDecision,
  isApprovalRequest,
} from '../approval/durable.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHECKPOINT_KEY_PREFIX = '__oma_checkpoint__/'
export const DEFAULT_CHECKPOINT_KEY = `${CHECKPOINT_KEY_PREFIX}latest`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function checkpointKey(runId?: string): string {
  if (!runId) return DEFAULT_CHECKPOINT_KEY
  return `${CHECKPOINT_KEY_PREFIX}${runId}/latest`
}

export function isCheckpointKey(key: string): boolean {
  return key.startsWith(CHECKPOINT_KEY_PREFIX)
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export class Checkpoint {
  readonly key: string
  private readonly runId: string | undefined

  constructor(
    private readonly store: MemoryStore,
    options: Pick<CheckpointOptions, 'key' | 'runId'> = {},
  ) {
    this.key = options.key ?? checkpointKey(options.runId)
    this.runId = options.runId
  }

  /** Persist `snapshot` as the latest checkpoint. */
  async save(snapshot: CheckpointSnapshot): Promise<void> {
    const stored: CheckpointSnapshot = snapshot.version === 1
      ? {
          ...snapshot,
          ...(snapshot.runId !== undefined || this.runId === undefined
            ? {}
            : { runId: this.runId }),
        }
      : snapshot
    const storedRunId = stored.version === 1 ? stored.runId : stored.identity.runId
    await this.store.set(this.key, JSON.stringify(stored), {
      namespace: 'checkpoint',
      version: stored.version,
      ...(storedRunId !== undefined ? { runId: storedRunId } : {}),
      createdAt: stored.createdAt,
    })
  }

  /** Load the latest checkpoint, or `null` when no checkpoint exists. */
  async loadLatest(): Promise<CheckpointSnapshot | null> {
    const entry = await this.store.get(this.key)
    if (entry === null) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(entry.value)
    } catch {
      throw new Error(`Checkpoint: stored value at "${this.key}" is not valid JSON.`)
    }

    if (!Checkpoint.isSnapshot(parsed)) {
      throw new Error(`Checkpoint: stored value at "${this.key}" is not a checkpoint snapshot.`)
    }
    return parsed
  }

  /** Alias for {@link loadLatest}. */
  async load(): Promise<CheckpointSnapshot | null> {
    return this.loadLatest()
  }

  /** Delete the persisted checkpoint key. */
  async delete(): Promise<void> {
    await this.store.delete(this.key)
  }

  private static isSnapshot(value: unknown): value is CheckpointSnapshot {
    if (value === null || typeof value !== 'object') return false
    const snapshot = value as Record<string, unknown>
    if (
      snapshot['version'] !== 1
      && snapshot['version'] !== 2
      && snapshot['version'] !== 3
      && snapshot['version'] !== 4
      && snapshot['version'] !== 5
    ) return false
    if (
      snapshot['mode'] !== 'runTeam'
      && snapshot['mode'] !== 'runTasks'
      && snapshot['mode'] !== 'runFromPlan'
    ) return false
    if (typeof snapshot['createdAt'] !== 'string') return false
    if (!Array.isArray(snapshot['completedTaskResults'])) return false
    if (snapshot['metadata'] !== undefined) {
      try {
        validateRunMetadata(snapshot['metadata'] as CheckpointSnapshot['metadata'])
      } catch {
        return false
      }
    }

    if (snapshot['version'] !== 1) {
      const identity = snapshot['identity']
      if (identity === null || typeof identity !== 'object') return false
      const record = identity as Record<string, unknown>
      if (typeof record['runId'] !== 'string') return false
      if (!Number.isInteger(record['attempt']) || (record['attempt'] as number) < 1) return false
      if (typeof record['lastTraceId'] !== 'string') return false
      if (typeof record['lastRootSpanId'] !== 'string') return false
    }

    if (
      snapshot['version'] === 3
      || snapshot['version'] === 4
      || snapshot['version'] === 5
    ) {
      const inFlightTasks = snapshot['inFlightTasks']
      if (!Array.isArray(inFlightTasks)) return false
      const taskIds = new Set<string>()
      for (const state of inFlightTasks) {
        if (!Checkpoint.isInFlightTask(state)) return false
        if (taskIds.has(state.taskId)) return false
        taskIds.add(state.taskId)
      }
    }

    if (snapshot['version'] === 5) {
      const watermark = snapshot['journalWatermarkSeq']
      if (!Number.isInteger(watermark) || (watermark as number) < 0) return false
      const journalRef = snapshot['journalRef']
      if (journalRef !== undefined) {
        if (!Checkpoint.isRecord(journalRef)) return false
        if (typeof journalRef['kind'] !== 'string') return false
        if (journalRef['path'] !== undefined && typeof journalRef['path'] !== 'string') return false
      }
    }

    if (snapshot['version'] === 4 || snapshot['version'] === 5) {
      const pendingApprovals = snapshot['pendingApprovals']
      const approvalDecisions = snapshot['approvalDecisions']
      const identity = snapshot['identity'] as Record<string, unknown>
      if (!Array.isArray(pendingApprovals) || !Array.isArray(approvalDecisions)) return false
      const pendingIds = new Set<string>()
      for (const request of pendingApprovals) {
        if (!isApprovalRequest(request) || request.runId !== identity['runId']) return false
        if (pendingIds.has(request.id)) return false
        pendingIds.add(request.id)
      }
      const decisionIds = new Set<string>()
      for (const decision of approvalDecisions) {
        try {
          assertApprovalDecision(decision)
        } catch {
          return false
        }
        if (decision.runId !== identity['runId']) return false
        if (decisionIds.has(decision.requestId)) return false
        decisionIds.add(decision.requestId)
      }
      for (const state of snapshot['inFlightTasks'] as Array<Record<string, unknown>>) {
        const pendingToolCalls = state['pendingToolCalls']
        if (!Array.isArray(pendingToolCalls)) continue
        for (const pending of pendingToolCalls as Array<Record<string, unknown>>) {
          const request = pending['approvalRequest']
          const decision = pending['approvalDecision']
          if (request !== undefined) {
            if (!isApprovalRequest(request) || !pendingIds.has(request.id)) return false
          }
          if (decision !== undefined) {
            try {
              assertApprovalDecision(decision, request as ApprovalRequest)
            } catch {
              return false
            }
            if (!decisionIds.has(decision.requestId)) return false
          }
        }
      }
    }

    const queue = snapshot['queue']
    if (queue === null || typeof queue !== 'object') return false
    const queueRecord = queue as Record<string, unknown>
    if (queueRecord['version'] !== 1 && queueRecord['version'] !== 2) return false
    if (!Array.isArray(queueRecord['tasks'])) return false
    if (queueRecord['version'] === 2) {
      if (!Number.isInteger(queueRecord['planRevision'])) return false
      if (!Array.isArray(queueRecord['planRevisions'])) return false
    }
    return true
  }

  private static isInFlightTask(value: unknown): value is {
    readonly taskId: string
  } {
    if (value === null || typeof value !== 'object') return false
    const state = value as Record<string, unknown>
    if (typeof state['taskId'] !== 'string' || state['taskId'].length === 0) return false
    if (typeof state['assignee'] !== 'string' || state['assignee'].length === 0) return false
    if (
      state['phase'] !== 'awaiting_model'
      && state['phase'] !== 'executing_tools'
      && state['phase'] !== 'completed'
    ) return false
    if (!Array.isArray(state['conversationMessages'])) return false
    if (!Checkpoint.isConversationLineage(
      state['conversationLineage'],
      state['conversationMessages'].length,
    )) return false
    if (
      state['journalSeq'] !== undefined
      && (!Number.isInteger(state['journalSeq']) || (state['journalSeq'] as number) < 0)
    ) return false
    if (!Array.isArray(state['messages'])) return false
    if (!Array.isArray(state['toolCalls'])) return false
    if (!Number.isInteger(state['turns']) || (state['turns'] as number) < 0) return false
    if (!Checkpoint.isTokenUsage(state['tokenUsage'])) return false
    for (const flag of ['loopWarned', 'loopDetected', 'budgetExceeded']) {
      if (state[flag] !== undefined && typeof state[flag] !== 'boolean') return false
    }

    const pending = state['pendingToolCalls']
    if (state['phase'] === 'executing_tools') {
      if (!Array.isArray(pending) || pending.length === 0) return false
      if (!pending.every(item => Checkpoint.isPendingToolCall(item))) return false
      if (
        state['pendingToolResultText'] !== undefined
        && typeof state['pendingToolResultText'] !== 'string'
      ) return false
    } else if (pending !== undefined) {
      return false
    } else if (state['pendingToolResultText'] !== undefined) {
      return false
    }
    if (state['phase'] === 'completed' && typeof state['finalOutput'] !== 'string') return false
    if (state['phase'] !== 'completed' && state['finalOutput'] !== undefined) return false
    return true
  }

  /**
   * Optional per-block journal lineage, positional against the conversation.
   * A length mismatch is corruption rather than an older schema: the field is
   * only ever written together with the messages it indexes.
   */
  private static isConversationLineage(value: unknown, messageCount: number): boolean {
    if (value === undefined) return true
    if (!Array.isArray(value) || value.length !== messageCount) return false
    for (const perMessage of value) {
      if (!Array.isArray(perMessage)) return false
      for (const seqs of perMessage) {
        if (seqs === null) continue
        if (!Array.isArray(seqs)) return false
        if (!seqs.every(seq => Number.isInteger(seq) && (seq as number) > 0)) return false
      }
    }
    return true
  }

  private static isPendingToolCall(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false
    const pending = value as Record<string, unknown>
    const call = pending['call']
    if (call === null || typeof call !== 'object') return false
    const callRecord = call as Record<string, unknown>
    if (callRecord['type'] !== 'tool_use') return false
    if (typeof callRecord['id'] !== 'string' || callRecord['id'].length === 0) return false
    if (typeof callRecord['name'] !== 'string' || callRecord['name'].length === 0) return false
    if (!Checkpoint.isRecord(callRecord['input'])) return false

    const commit = pending['commit']
    const approvalRequest = pending['approvalRequest']
    const approvalDecision = pending['approvalDecision']
    if (approvalRequest !== undefined) {
      if (!isApprovalRequest(approvalRequest) || approvalRequest.scope !== 'tool_call') return false
      const content = approvalRequest.content
      if (
        content.kind !== 'tool_call'
        || content.toolCallId !== callRecord['id']
        || content.toolName !== callRecord['name']
      ) return false
      if (approvalDecision !== undefined) {
        try {
          assertApprovalDecision(approvalDecision, approvalRequest)
        } catch {
          return false
        }
      }
    } else if (approvalDecision !== undefined) {
      return false
    }
    if (commit === undefined) return true
    if (approvalRequest !== undefined || approvalDecision !== undefined) return false
    if (commit === null || typeof commit !== 'object') return false
    const commitRecord = commit as Record<string, unknown>
    const result = commitRecord['result']
    if (result === null || typeof result !== 'object') return false
    const resultRecord = result as Record<string, unknown>
    if (resultRecord['type'] !== 'tool_result') return false
    if (resultRecord['tool_use_id'] !== callRecord['id']) return false
    if (typeof resultRecord['content'] !== 'string') return false
    if (resultRecord['is_error'] !== undefined && typeof resultRecord['is_error'] !== 'boolean') {
      return false
    }

    const toolCall = commitRecord['record']
    if (toolCall === null || typeof toolCall !== 'object') return false
    const toolCallRecord = toolCall as Record<string, unknown>
    if (toolCallRecord['toolName'] !== callRecord['name']) return false
    if (!Checkpoint.isRecord(toolCallRecord['input'])) return false
    if (typeof toolCallRecord['output'] !== 'string') return false
    if (!Number.isFinite(toolCallRecord['duration']) || (toolCallRecord['duration'] as number) < 0) {
      return false
    }
    return commitRecord['delegationUsage'] === undefined
      || Checkpoint.isTokenUsage(commitRecord['delegationUsage'])
  }

  private static isTokenUsage(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return Number.isFinite(record['input_tokens'])
      && (record['input_tokens'] as number) >= 0
      && Number.isFinite(record['output_tokens'])
      && (record['output_tokens'] as number) >= 0
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
}
