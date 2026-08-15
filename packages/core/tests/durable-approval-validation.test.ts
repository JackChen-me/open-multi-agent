import { describe, expect, it } from 'vitest'
import {
  DurableApprovalError,
  DurableApprovalLedger,
  approvalKey,
  createApprovalRequest,
  InMemoryStore,
} from '../src/index.js'
import {
  assertApprovalDecision,
  assertApprovalRequest,
  isApprovalRequest,
} from '../src/approval/durable.js'
import type {
  ApprovalDecisionRecord,
  ApprovalRequest,
  ApprovalRequestContent,
} from '../src/types.js'

const requestedAt = new Date('2026-08-08T00:00:00.000Z')

function toolContent(rawInput: unknown = { environment: 'staging' }): ApprovalRequestContent {
  const input = rawInput as Record<string, unknown>
  return {
    kind: 'tool_call',
    toolName: 'deploy',
    rawInput: input,
    input,
    agentName: 'operator',
    taskId: 'task-1',
    toolCallId: 'call-1',
    consequential: true,
  }
}

function request(
  overrides: Partial<Parameters<typeof createApprovalRequest>[0]> = {},
): ApprovalRequest {
  return createApprovalRequest({
    runId: 'run-validation',
    scope: 'tool_call',
    boundary: 'task-1:call-1',
    content: toolContent(),
    requestedAt,
    ...overrides,
  })
}

function decisionFor(approval: ApprovalRequest): ApprovalDecisionRecord {
  return {
    version: 1,
    requestId: approval.id,
    runId: approval.runId,
    scope: approval.scope,
    requestHash: approval.requestHash,
    decision: 'approved',
    reviewer: { id: 'reviewer-1', displayName: 'Release reviewer' },
    decidedAt: '2026-08-08T00:01:00.000Z',
  }
}

describe('durable approval validation', () => {
  it('rejects non-JSON approval payloads before hashing them', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const invalidPayloads: unknown[] = [
      { amount: Number.NaN },
      cyclic,
      new Date('2026-08-08T00:00:00.000Z'),
      { amount: undefined },
      { amount: 1n },
    ]

    for (const rawInput of invalidPayloads) {
      expect(() => request({ content: toolContent(rawInput) }))
        .toThrowError(DurableApprovalError)
    }
  })

  it('rejects invalid request creation inputs', () => {
    expect(() => request({ runId: ' ' })).toThrow('runId and boundary must be non-empty')
    expect(() => request({ boundary: ' ' })).toThrow('runId and boundary must be non-empty')
    expect(() => request({ scope: 'plan' })).toThrow('does not match content kind')
    expect(() => request({ reason: 42 as unknown as string })).toThrow('reason must be a string')
  })

  it('rejects malformed or content-inconsistent persisted requests', () => {
    const valid = request()
    const malformed: unknown[] = [
      { ...valid, version: 2 },
      { ...valid, id: 'not-an-approval-id' },
      { ...valid, requestedAt: 'not-a-date' },
      { ...valid, scope: 'plan', content: null },
      {
        ...valid,
        scope: 'plan',
        content: { kind: 'plan', continuation: 'later', tasks: [] },
      },
      {
        ...valid,
        scope: 'plan',
        content: { kind: 'plan', continuation: 'execute', tasks: 'not-an-array' },
      },
      {
        ...valid,
        scope: 'plan',
        content: { kind: 'plan', continuation: 'execute', tasks: [{}] },
      },
      {
        ...valid,
        scope: 'task_round',
        content: { kind: 'task_round', completedTasks: [], nextTasks: 'not-an-array' },
      },
      { ...valid, content: { kind: 'tool_call' } },
      { ...valid, scope: 'plan', content: { kind: 'unknown' } },
      { ...valid, scope: 'plan' },
      { ...valid, id: `apr_${'f'.repeat(32)}` },
    ]

    for (const value of malformed) {
      expect(() => assertApprovalRequest(value)).toThrowError(DurableApprovalError)
      expect(isApprovalRequest(value)).toBe(false)
    }
    expect(isApprovalRequest(valid)).toBe(true)
  })

  it('rejects malformed decisions and decisions bound to another request', () => {
    const approval = request()
    const valid = decisionFor(approval)
    const malformed: unknown[] = [
      { ...valid, version: 2 },
      { ...valid, decision: 'pending' },
      { ...valid, reviewer: { id: ' ' } },
      { ...valid, reviewer: { id: 'reviewer-1', displayName: 42 } },
      { ...valid, decidedAt: 'not-a-date' },
    ]

    for (const value of malformed) {
      expect(() => assertApprovalDecision(value)).toThrowError(DurableApprovalError)
    }
    expect(() => assertApprovalDecision({ ...valid, runId: 'another-run' }, approval))
      .toThrow('does not bind the pending request')
    expect(() => assertApprovalDecision(valid, approval)).not.toThrow()
  })
})

describe('durable approval ledger edge cases', () => {
  it('treats the same request as idempotent and rejects conflicting metadata', async () => {
    const store = new InMemoryStore()
    const ledger = new DurableApprovalLedger(store)
    const approval = request()

    await expect(ledger.ensureRequest(approval)).resolves.toEqual({ version: 1, request: approval })
    await expect(ledger.ensureRequest(approval)).resolves.toEqual({ version: 1, request: approval })
    await expect(ledger.ensureRequest({ ...approval, reason: 'different review context' }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' })
  })

  it('fails closed for missing, malformed, and mis-keyed ledger records', async () => {
    const missing = new DurableApprovalLedger(new InMemoryStore())
    await expect(missing.get(request().id)).resolves.toBeNull()

    const malformedStore = new InMemoryStore()
    const approval = request()
    await malformedStore.set(approvalKey(approval.id), '{not-json')
    await expect(new DurableApprovalLedger(malformedStore).get(approval.id))
      .rejects.toMatchObject({ code: 'APPROVAL_INTEGRITY_ERROR' })

    const misKeyedStore = new InMemoryStore()
    const otherId = `apr_${'f'.repeat(32)}`
    await misKeyedStore.set(
      approvalKey(otherId),
      JSON.stringify({ version: 1, request: approval }),
    )
    await expect(new DurableApprovalLedger(misKeyedStore).get(otherId))
      .rejects.toMatchObject({ code: 'APPROVAL_INTEGRITY_ERROR' })
  })

  it('rejects invalid, missing, corrupt, mis-keyed, and repeated decisions', async () => {
    const approval = request()
    const ledger = new DurableApprovalLedger(new InMemoryStore())
    await expect(ledger.decide({
      requestId: approval.id,
      requestHash: approval.requestHash,
      decision: 'invalid' as 'approve',
      reviewer: { id: 'reviewer-1' },
    })).rejects.toMatchObject({ code: 'APPROVAL_VALIDATION_ERROR' })
    await expect(ledger.decide({
      requestId: approval.id,
      requestHash: approval.requestHash,
      decision: 'approve',
      reviewer: { id: 'reviewer-1' },
    })).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })

    const corruptStore = new InMemoryStore()
    await corruptStore.set(approvalKey(approval.id), '{not-json')
    await expect(new DurableApprovalLedger(corruptStore).decide({
      requestId: approval.id,
      requestHash: approval.requestHash,
      decision: 'approve',
      reviewer: { id: 'reviewer-1' },
    })).rejects.toMatchObject({ code: 'APPROVAL_INTEGRITY_ERROR' })

    const misKeyedStore = new InMemoryStore()
    const otherId = `apr_${'f'.repeat(32)}`
    await misKeyedStore.set(
      approvalKey(otherId),
      JSON.stringify({ version: 1, request: approval }),
    )
    await expect(new DurableApprovalLedger(misKeyedStore).decide({
      requestId: otherId,
      requestHash: approval.requestHash,
      decision: 'approve',
      reviewer: { id: 'reviewer-1' },
    })).rejects.toMatchObject({ code: 'APPROVAL_INTEGRITY_ERROR' })

    const decidedStore = new InMemoryStore()
    const decidedLedger = new DurableApprovalLedger(decidedStore)
    await decidedLedger.ensureRequest(approval)
    await decidedLedger.decide({
      requestId: approval.id,
      requestHash: approval.requestHash,
      decision: 'approve',
      reviewer: { id: 'reviewer-1' },
    })
    await expect(decidedLedger.decide({
      requestId: approval.id,
      requestHash: approval.requestHash,
      decision: 'reject',
      reviewer: { id: 'reviewer-2' },
    })).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' })
  })
})
