/**
 * @fileoverview Content-bound durable approval requests and atomic decisions.
 *
 * Approval rows are primary execution facts stored beside (not inside
 * telemetry or receipts) the checkpoint that owns the pending continuation.
 */

import { createHash } from 'node:crypto'
import type {
  ApprovalDecisionInput,
  ApprovalDecisionRecord,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalRequestContent,
  ApprovalReviewer,
  ApprovalScope,
  MemoryStore,
  Task,
} from '../types.js'

export const APPROVAL_KEY_PREFIX = '__oma_approval__/'

export type DurableApprovalErrorCode =
  | 'APPROVAL_ATOMIC_STORE_REQUIRED'
  | 'APPROVAL_CONFLICT'
  | 'APPROVAL_INTEGRITY_ERROR'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_STALE_DECISION'
  | 'APPROVAL_VALIDATION_ERROR'

/** Stable public error for approval persistence, integrity, and concurrency failures. */
export class DurableApprovalError extends Error {
  readonly code: DurableApprovalErrorCode

  constructor(code: DurableApprovalErrorCode, message: string) {
    super(message)
    this.name = 'DurableApprovalError'
    this.code = code
  }
}

export function approvalKey(requestId: string): string {
  return `${APPROVAL_KEY_PREFIX}${requestId}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new DurableApprovalError(
          'APPROVAL_VALIDATION_ERROR',
          'Approval content contains a non-finite number.',
        )
      }
      return JSON.stringify(value)
    case 'object': {
      const object = value as object
      if (seen.has(object)) {
        throw new DurableApprovalError(
          'APPROVAL_VALIDATION_ERROR',
          'Approval content contains a cycle.',
        )
      }
      seen.add(object)
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => stableJson(item, seen)).join(',')}]`
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new DurableApprovalError(
            'APPROVAL_VALIDATION_ERROR',
            'Approval content must contain only JSON-compatible plain objects.',
          )
        }
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        const fields = keys.map((key) => {
          const item = record[key]
          if (item === undefined) {
            throw new DurableApprovalError(
              'APPROVAL_VALIDATION_ERROR',
              `Approval content field "${key}" is undefined.`,
            )
          }
          return `${JSON.stringify(key)}:${stableJson(item, seen)}`
        })
        return `{${fields.join(',')}}`
      } finally {
        seen.delete(object)
      }
    }
    default:
      throw new DurableApprovalError(
        'APPROVAL_VALIDATION_ERROR',
        `Approval content contains unsupported ${typeof value} data.`,
      )
  }
}

function requestPayload(
  scope: ApprovalScope,
  boundary: string,
  content: ApprovalRequestContent,
): Record<string, unknown> {
  return {
    scope,
    boundary,
    content,
  }
}

export function hashApprovalRequest(
  scope: ApprovalScope,
  boundary: string,
  content: ApprovalRequestContent,
): string {
  return sha256(stableJson(requestPayload(scope, boundary, content)))
}

/**
 * Fail closed when a task boundary contains live verification wiring that the
 * checkpoint schema cannot reconstruct after a process restart.
 */
export function assertDurableTaskApprovalSupport(tasks: readonly Task[]): void {
  const unsupported = tasks.find((task) => task.verify !== undefined)
  if (!unsupported) return
  throw new DurableApprovalError(
    'APPROVAL_VALIDATION_ERROR',
    `Task "${unsupported.title}" cannot use durable suspension because its verify config ` +
      'contains live judge/schema/callback wiring that checkpoints do not persist.',
  )
}

export interface CreateApprovalRequestInput {
  readonly runId: string
  readonly scope: ApprovalScope
  readonly boundary: string
  readonly content: ApprovalRequestContent
  readonly reason?: string
  /** Internal deterministic-time seam used by tests. */
  readonly requestedAt?: Date
}

/** Create a deterministic identity for one exact reviewed boundary. */
export function createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequest {
  const runId = input.runId.trim()
  const boundary = input.boundary.trim()
  if (!runId || !boundary) {
    throw new DurableApprovalError(
      'APPROVAL_VALIDATION_ERROR',
      'Approval runId and boundary must be non-empty strings.',
    )
  }
  if (input.content.kind !== input.scope) {
    throw new DurableApprovalError(
      'APPROVAL_VALIDATION_ERROR',
      `Approval scope "${input.scope}" does not match content kind "${input.content.kind}".`,
    )
  }
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw new DurableApprovalError(
      'APPROVAL_VALIDATION_ERROR',
      'Approval reason must be a string when provided.',
    )
  }
  const requestHash = hashApprovalRequest(
    input.scope,
    boundary,
    input.content,
  )
  const id = `apr_${sha256(`${runId}\n${input.scope}\n${boundary}\n${requestHash}`).slice(0, 32)}`
  return {
    version: 1,
    id,
    runId,
    scope: input.scope,
    boundary,
    requestHash,
    requestedAt: (input.requestedAt ?? new Date()).toISOString(),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    content: input.content,
  }
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      `Approval ${field} must be an ISO-compatible timestamp.`,
    )
  }
}

function assertReviewer(value: unknown): asserts value is ApprovalReviewer {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].trim().length === 0) {
    throw new DurableApprovalError(
      'APPROVAL_VALIDATION_ERROR',
      'Approval reviewer.id must be a non-empty string.',
    )
  }
  if (value['displayName'] !== undefined && typeof value['displayName'] !== 'string') {
    throw new DurableApprovalError(
      'APPROVAL_VALIDATION_ERROR',
      'Approval reviewer.displayName must be a string when provided.',
    )
  }
}

function assertTaskSnapshot(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['title'] !== 'string'
    || typeof value['description'] !== 'string'
    || typeof value['status'] !== 'string'
    || typeof value['createdAt'] !== 'string'
    || typeof value['updatedAt'] !== 'string'
  ) {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      'Approval content contains an invalid task snapshot.',
    )
  }
  stableJson(value)
}

function assertContent(value: unknown): asserts value is ApprovalRequestContent {
  if (!isRecord(value) || typeof value['kind'] !== 'string') {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      'Approval request content is not an object with a kind.',
    )
  }
  switch (value['kind']) {
    case 'plan': {
      if (
        value['continuation'] !== 'execute'
        && value['continuation'] !== 'plan_only'
      ) {
        throw new DurableApprovalError(
          'APPROVAL_INTEGRITY_ERROR',
          'Plan approval has an invalid continuation.',
        )
      }
      if (!Array.isArray(value['tasks'])) {
        throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', 'Plan approval has no tasks array.')
      }
      value['tasks'].forEach(assertTaskSnapshot)
      break
    }
    case 'task_round': {
      if (!Array.isArray(value['completedTasks']) || !Array.isArray(value['nextTasks'])) {
        throw new DurableApprovalError(
          'APPROVAL_INTEGRITY_ERROR',
          'Round approval has invalid completedTasks/nextTasks arrays.',
        )
      }
      value['completedTasks'].forEach(assertTaskSnapshot)
      value['nextTasks'].forEach(assertTaskSnapshot)
      break
    }
    case 'task_dispatch':
      assertTaskSnapshot(value['task'])
      break
    case 'tool_call':
      if (
        typeof value['toolName'] !== 'string'
        || !isRecord(value['rawInput'])
        || !isRecord(value['input'])
        || typeof value['agentName'] !== 'string'
        || typeof value['taskId'] !== 'string'
        || typeof value['toolCallId'] !== 'string'
        || typeof value['consequential'] !== 'boolean'
      ) {
        throw new DurableApprovalError(
          'APPROVAL_INTEGRITY_ERROR',
          'Tool-call approval content is malformed.',
        )
      }
      stableJson(value['rawInput'])
      stableJson(value['input'])
      break
    default:
      throw new DurableApprovalError(
        'APPROVAL_INTEGRITY_ERROR',
        `Unsupported approval content kind "${String(value['kind'])}".`,
      )
  }
}

/** Throw when a stored/checkpointed request is malformed or content-tampered. */
export function assertApprovalRequest(value: unknown): asserts value is ApprovalRequest {
  if (!isRecord(value) || value['version'] !== 1) {
    throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', 'Approval request version is invalid.')
  }
  const scope = value['scope']
  if (
    typeof value['id'] !== 'string'
    || !/^apr_[0-9a-f]{32}$/.test(value['id'])
    || typeof value['runId'] !== 'string'
    || (scope !== 'plan' && scope !== 'task_round' && scope !== 'task_dispatch' && scope !== 'tool_call')
    || typeof value['boundary'] !== 'string'
    || typeof value['requestHash'] !== 'string'
    || !/^[0-9a-f]{64}$/.test(value['requestHash'])
    || (value['reason'] !== undefined && typeof value['reason'] !== 'string')
  ) {
    throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', 'Approval request fields are invalid.')
  }
  assertIsoDate(value['requestedAt'], 'requestedAt')
  assertContent(value['content'])
  if (value['content'].kind !== scope) {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      'Approval request scope does not match its content kind.',
    )
  }
  const expectedHash = hashApprovalRequest(
    scope,
    value['boundary'],
    value['content'],
  )
  if (expectedHash !== value['requestHash']) {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      `Approval request "${value['id']}" does not match its content hash.`,
    )
  }
  const expectedId = createApprovalRequest({
    runId: value['runId'],
    scope,
    boundary: value['boundary'],
    content: value['content'],
    ...(value['reason'] !== undefined ? { reason: value['reason'] } : {}),
    requestedAt: new Date(value['requestedAt']),
  }).id
  if (expectedId !== value['id']) {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      `Approval request "${value['id']}" has an invalid identity.`,
    )
  }
}

export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  try {
    assertApprovalRequest(value)
    return true
  } catch {
    return false
  }
}

/** Throw when a durable decision is malformed or does not bind its request. */
export function assertApprovalDecision(
  value: unknown,
  request?: ApprovalRequest,
): asserts value is ApprovalDecisionRecord {
  if (!isRecord(value) || value['version'] !== 1) {
    throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', 'Approval decision version is invalid.')
  }
  if (
    typeof value['requestId'] !== 'string'
    || !/^apr_[0-9a-f]{32}$/.test(value['requestId'])
    || typeof value['runId'] !== 'string'
    || value['runId'].trim().length === 0
    || (value['scope'] !== 'plan'
      && value['scope'] !== 'task_round'
      && value['scope'] !== 'task_dispatch'
      && value['scope'] !== 'tool_call')
    || typeof value['requestHash'] !== 'string'
    || !/^[0-9a-f]{64}$/.test(value['requestHash'])
    || (value['decision'] !== 'approved' && value['decision'] !== 'rejected')
  ) {
    throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', 'Approval decision fields are invalid.')
  }
  assertReviewer(value['reviewer'])
  assertIsoDate(value['decidedAt'], 'decidedAt')
  if (request && (
    value['requestId'] !== request.id
    || value['runId'] !== request.runId
    || value['scope'] !== request.scope
    || value['requestHash'] !== request.requestHash
  )) {
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      `Approval decision for "${value['requestId']}" does not bind the pending request.`,
    )
  }
}

function assertApprovalRecord(value: unknown): asserts value is ApprovalRecord {
  if (!isRecord(value) || value['version'] !== 1) {
    throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', 'Approval record version is invalid.')
  }
  assertApprovalRequest(value['request'])
  if (value['decision'] !== undefined) {
    assertApprovalDecision(value['decision'], value['request'])
  }
}

/** Primary-ledger access over a MemoryStore with atomic decision writes. */
export class DurableApprovalLedger {
  constructor(private readonly store: MemoryStore) {}

  /** Fail before writing a pending checkpoint when the store cannot decide atomically. */
  assertAtomicSupport(): void {
    if (!this.store.compareAndSet) {
      throw new DurableApprovalError(
        'APPROVAL_ATOMIC_STORE_REQUIRED',
        'Suspendable approvals require MemoryStore.compareAndSet for atomic decisions.',
      )
    }
  }

  private compareAndSet(
    key: string,
    expectedValue: string | null,
    value: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    this.assertAtomicSupport()
    return this.store.compareAndSet!(key, expectedValue, value, metadata)
  }

  async ensureRequest(request: ApprovalRequest): Promise<ApprovalRecord> {
    assertApprovalRequest(request)
    const record: ApprovalRecord = { version: 1, request }
    const key = approvalKey(request.id)
    const value = JSON.stringify(record)
    const created = await this.compareAndSet(key, null, value, {
      namespace: 'approval',
      version: 1,
      runId: request.runId,
      scope: request.scope,
      requestHash: request.requestHash,
      requestedAt: request.requestedAt,
    })
    if (created) return record

    const existing = await this.get(request.id)
    if (existing && stableJson(existing.request) === stableJson(request)) return existing
    throw new DurableApprovalError(
      'APPROVAL_CONFLICT',
      `Approval request "${request.id}" already exists with different content.`,
    )
  }

  async get(requestId: string): Promise<ApprovalRecord | null> {
    const entry = await this.store.get(approvalKey(requestId))
    if (!entry) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(entry.value)
    } catch {
      throw new DurableApprovalError(
        'APPROVAL_INTEGRITY_ERROR',
        `Approval record "${requestId}" is not valid JSON.`,
      )
    }
    assertApprovalRecord(parsed)
    if (parsed.request.id !== requestId) {
      throw new DurableApprovalError(
        'APPROVAL_INTEGRITY_ERROR',
        `Approval record key does not match request "${parsed.request.id}".`,
      )
    }
    return parsed
  }

  async decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionRecord> {
    assertReviewer(input.reviewer)
    if (input.decision !== 'approve' && input.decision !== 'reject') {
      throw new DurableApprovalError(
        'APPROVAL_VALIDATION_ERROR',
        'Approval decision must be "approve" or "reject".',
      )
    }
    const key = approvalKey(input.requestId)
    const entry = await this.store.get(key)
    if (!entry) {
      throw new DurableApprovalError(
        'APPROVAL_NOT_FOUND',
        `Approval request "${input.requestId}" was not found.`,
      )
    }
    let record: unknown
    try {
      record = JSON.parse(entry.value)
    } catch {
      throw new DurableApprovalError(
        'APPROVAL_INTEGRITY_ERROR',
        `Approval record "${input.requestId}" is not valid JSON.`,
      )
    }
    assertApprovalRecord(record)
    if (record.request.id !== input.requestId) {
      throw new DurableApprovalError(
        'APPROVAL_INTEGRITY_ERROR',
        `Approval record key does not match request "${record.request.id}".`,
      )
    }
    if (record.request.requestHash !== input.requestHash) {
      throw new DurableApprovalError(
        'APPROVAL_STALE_DECISION',
        `Approval request "${input.requestId}" changed after review; decision rejected.`,
      )
    }
    if (record.decision) {
      throw new DurableApprovalError(
        'APPROVAL_CONFLICT',
        `Approval request "${input.requestId}" already has a decision.`,
      )
    }

    const decision: ApprovalDecisionRecord = {
      version: 1,
      requestId: record.request.id,
      runId: record.request.runId,
      scope: record.request.scope,
      requestHash: record.request.requestHash,
      decision: input.decision === 'approve' ? 'approved' : 'rejected',
      reviewer: {
        id: input.reviewer.id.trim(),
        ...(input.reviewer.displayName !== undefined
          ? { displayName: input.reviewer.displayName }
          : {}),
      },
      decidedAt: new Date().toISOString(),
    }
    const updated: ApprovalRecord = { ...record, decision }
    const swapped = await this.compareAndSet(key, entry.value, JSON.stringify(updated), {
      namespace: 'approval',
      version: 1,
      runId: record.request.runId,
      scope: record.request.scope,
      requestHash: record.request.requestHash,
      decision: decision.decision,
      reviewerId: decision.reviewer.id,
      decidedAt: decision.decidedAt,
    })
    if (!swapped) {
      throw new DurableApprovalError(
        'APPROVAL_CONFLICT',
        `Approval request "${input.requestId}" was decided concurrently.`,
      )
    }
    return decision
  }
}

/** Read one primary approval ledger row. */
export async function getApprovalRecord(
  store: MemoryStore,
  requestId: string,
): Promise<ApprovalRecord | null> {
  return new DurableApprovalLedger(store).get(requestId)
}

/** Atomically approve or reject an exact durable request. First decision wins. */
export async function decideApproval(
  store: MemoryStore,
  input: ApprovalDecisionInput,
): Promise<ApprovalDecisionRecord> {
  return new DurableApprovalLedger(store).decide(input)
}
