import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  APPROVAL_KEY_PREFIX,
  DurableApprovalLedger,
  DurableApprovalError,
  approvalKey,
  buildExecutionReceipt,
  createApprovalRequest,
  decideApproval,
  defineTool,
  getApprovalRecord,
  InMemoryStore,
  OpenMultiAgent,
} from '../src/index.js'
import { Checkpoint } from '../src/memory/checkpoint.js'
import type {
  AgentConfig,
  ApprovalRequest,
  CheckpointSnapshotV4,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  MemoryStore,
} from '../src/index.js'

function textResponse(text: string): LLMResponse {
  return {
    id: `text-${text}`,
    content: [{ type: 'text', text }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function toolResponse(
  name: string,
  input: Record<string, unknown>,
  id = 'tool-call-1',
): LLMResponse {
  return {
    id: `tool-${id}`,
    content: [{ type: 'tool_use', id, name, input }],
    model: 'mock-model',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(responses: readonly LLMResponse[]) {
  let index = 0
  const inputs: LLMMessage[][] = []
  const adapter: LLMAdapter = {
    name: 'durable-approval-test',
    async chat(messages: LLMMessage[], _options: LLMChatOptions): Promise<LLMResponse> {
      inputs.push(messages)
      const response = responses[index]
      if (!response) throw new Error(`No scripted response for call ${index + 1}.`)
      index++
      return response
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('unused') }
    },
  }
  return { adapter, calls: () => index, inputs }
}

function worker(name: string, adapter: LLMAdapter, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    model: 'mock-model',
    adapter,
    systemPrompt: `You are ${name}.`,
    ...extra,
  }
}

function onePending(result: { readonly pendingApprovals?: readonly ApprovalRequest[] }): ApprovalRequest {
  expect(result.pendingApprovals).toHaveLength(1)
  return result.pendingApprovals![0]!
}

async function approve(store: MemoryStore, request: ApprovalRequest, reviewer = 'reviewer-1') {
  return decideApproval(store, {
    requestId: request.id,
    requestHash: request.requestHash,
    decision: 'approve',
    reviewer: { id: reviewer, displayName: 'Release reviewer' },
  })
}

function ledgerRequest(): ApprovalRequest {
  return createApprovalRequest({
    runId: 'run-ledger',
    scope: 'tool_call',
    boundary: 'task-1:call-1',
    content: {
      kind: 'tool_call',
      toolName: 'deploy',
      rawInput: { environment: 'staging' },
      input: { environment: 'staging' },
      agentName: 'operator',
      taskId: 'task-1',
      toolCallId: 'call-1',
      consequential: true,
    },
    requestedAt: new Date('2026-08-08T00:00:00.000Z'),
  })
}

describe('durable approval ledger', () => {
  it('binds decisions to the reviewed hash and resolves concurrent reviewers first-wins', async () => {
    const store = new InMemoryStore()
    const request = ledgerRequest()
    await new DurableApprovalLedger(store).ensureRequest(request)

    await expect(decideApproval(store, {
      requestId: request.id,
      requestHash: '0'.repeat(64),
      decision: 'approve',
      reviewer: { id: 'stale-reviewer' },
    })).rejects.toMatchObject({ code: 'APPROVAL_STALE_DECISION' })

    const decisions = await Promise.allSettled([
      approve(store, request, 'reviewer-a'),
      decideApproval(store, {
        requestId: request.id,
        requestHash: request.requestHash,
        decision: 'reject',
        reviewer: { id: 'reviewer-b' },
      }),
    ])

    expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = decisions.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'APPROVAL_CONFLICT' },
    })
    const record = await getApprovalRecord(store, request.id)
    expect(record?.decision).toMatchObject({
      requestId: request.id,
      requestHash: request.requestHash,
      decision: 'approved',
      reviewer: { id: 'reviewer-a' },
    })
    expect(Date.parse(record!.decision!.decidedAt)).not.toBeNaN()
  })

  it('rejects a tampered primary record instead of trusting it as execution state', async () => {
    const store = new InMemoryStore()
    const request = ledgerRequest()
    await new DurableApprovalLedger(store).ensureRequest(request)
    const entry = await store.get(approvalKey(request.id))
    const record = JSON.parse(entry!.value) as { request: ApprovalRequest }
    await store.set(approvalKey(request.id), JSON.stringify({
      ...record,
      request: {
        ...record.request,
        content: { ...record.request.content, toolName: 'delete_everything' },
      },
    }))

    await expect(getApprovalRecord(store, request.id)).rejects.toBeInstanceOf(DurableApprovalError)
  })

  it('fails closed when the configured store has no atomic compare-and-set', async () => {
    const base = new InMemoryStore()
    const store: MemoryStore = {
      get: (key) => base.get(key),
      set: (key, value, metadata) => base.set(key, value, metadata),
      list: () => base.list(),
      delete: (key) => base.delete(key),
      clear: () => base.clear(),
    }

    await expect(new DurableApprovalLedger(store).ensureRequest(ledgerRequest()))
      .rejects.toMatchObject({ code: 'APPROVAL_ATOMIC_STORE_REQUIRED' })
  })
})

describe('durable orchestration boundaries', () => {
  it('fails closed before exposing a pending request when checkpoint storage has no CAS', async () => {
    const base = new InMemoryStore()
    const store: MemoryStore = {
      get: (key) => base.get(key),
      set: (key, value, metadata) => base.set(key, value, metadata),
      list: () => base.list(),
      delete: (key) => base.delete(key),
      clear: () => base.clear(),
    }
    const adapter = scriptedAdapter([textResponse('must not run')])
    const oma = new OpenMultiAgent({
      onTaskDispatch: async () => ({ action: 'suspend' }),
    })
    const team = oma.createTeam('no-cas', {
      name: 'no-cas',
      agents: [worker('worker', adapter.adapter)],
      sharedMemory: false,
    })

    const result = await oma.runTasks(team, [
      { title: 'Protected', description: 'Must wait.', assignee: 'worker' },
    ], { checkpoint: { store } })

    expect(result.success).toBe(false)
    expect(result.pendingApprovals).toBeUndefined()
    expect(adapter.calls()).toBe(0)
    expect((await store.list()).some((entry) => entry.key.startsWith(APPROVAL_KEY_PREFIX)))
      .toBe(false)
  })

  it('suspends a generated plan, then restores and executes the exact approved plan', async () => {
    const store = new InMemoryStore()
    const coordinator = scriptedAdapter([
      textResponse('[{"title":"Research","description":"Research first","assignee":"worker"}]'),
    ])
    const initialWorker = scriptedAdapter([textResponse('must not run')])
    const onPlanReady = vi.fn(async () => ({ action: 'suspend' as const, reason: 'Human review' }))
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model', onPlanReady })
    const team = oma.createTeam('plan-approval', {
      name: 'plan-approval',
      agents: [worker('worker', initialWorker.adapter)],
      sharedMemory: false,
    })

    const suspended = await oma.runTeam(
      team,
      'Research the topic, then prepare a guide from the findings.',
      {
        mode: 'team',
        checkpoint: { store },
        coordinator: { model: 'mock-model', adapter: coordinator.adapter },
      },
    )
    expect(onPlanReady).toHaveBeenCalledTimes(1)
    expect(suspended.status?.code).toBe('suspended')
    const request = onePending(suspended)
    expect(suspended).toMatchObject({ success: false, status: { code: 'suspended' } })
    expect(request).toMatchObject({ scope: 'plan', content: { kind: 'plan', continuation: 'execute' } })
    expect(initialWorker.calls()).toBe(0)
    await approve(store, request)

    const resumedWorker = scriptedAdapter([textResponse('researched')])
    const synthesis = scriptedAdapter([textResponse('final guide')])
    const restoredGate = vi.fn(async () => false)
    const resumedOma = new OpenMultiAgent({ defaultModel: 'mock-model', onPlanReady: restoredGate })
    const resumedTeam = resumedOma.createTeam('plan-approval', {
      name: 'plan-approval',
      agents: [worker('worker', resumedWorker.adapter)],
      sharedMemory: false,
    })
    const result = await resumedOma.restore(resumedTeam, {
      checkpoint: { store },
      coordinator: { model: 'mock-model', adapter: synthesis.adapter },
    })

    expect(result.success).toBe(true)
    expect(result.tasks?.map((task) => [task.title, task.status])).toEqual([['Research', 'completed']])
    expect(result.approvalDecisions?.[0]).toMatchObject({
      requestId: request.id,
      decision: 'approved',
      reviewer: { id: 'reviewer-1' },
    })
    expect(resumedWorker.calls()).toBe(1)
    expect(synthesis.calls()).toBe(1)
    expect(restoredGate).not.toHaveBeenCalled()
  })

  it('restores an approved planOnly request without dispatching the plan', async () => {
    const store = new InMemoryStore()
    const coordinator = scriptedAdapter([
      textResponse('[{"title":"Review","description":"Review only","assignee":"worker"}]'),
    ])
    const initialWorker = scriptedAdapter([textResponse('must not run')])
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      onPlanReady: async () => ({ action: 'suspend' }),
    })
    const team = oma.createTeam('plan-only-approval', {
      name: 'plan-only-approval',
      agents: [worker('worker', initialWorker.adapter)],
      sharedMemory: false,
    })

    const suspended = await oma.runTeam(team, 'Prepare a review plan.', {
      mode: 'team',
      planOnly: true,
      checkpoint: { store },
      coordinator: { model: 'mock-model', adapter: coordinator.adapter },
    })
    const request = onePending(suspended)
    expect(request).toMatchObject({
      scope: 'plan',
      content: { kind: 'plan', continuation: 'plan_only' },
    })
    expect(suspended.status?.code).toBe('suspended')
    expect(initialWorker.calls()).toBe(0)
    await approve(store, request)

    const resumedWorker = scriptedAdapter([textResponse('must not run')])
    const resumedGate = vi.fn(async () => false)
    const resumed = new OpenMultiAgent({ onPlanReady: resumedGate })
    const resumedTeam = resumed.createTeam('plan-only-approval', {
      name: 'plan-only-approval',
      agents: [worker('worker', resumedWorker.adapter)],
      sharedMemory: false,
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await resumed.restore(resumedTeam, { checkpoint: { store } })
      expect(result).toMatchObject({ success: true, planOnly: true, status: { code: 'ok' } })
      expect(result.tasks?.[0]?.status).toBe('pending')
    }
    expect(resumedWorker.calls()).toBe(0)
    expect(resumedGate).not.toHaveBeenCalled()
  })

  it('fails closed when a suspended task contains non-resumable verify wiring', async () => {
    const store = new InMemoryStore()
    const workerAdapter = scriptedAdapter([textResponse('must not run')])
    const judgeAdapter = scriptedAdapter([textResponse('must not run')])
    const judge = worker('judge', judgeAdapter.adapter)
    const oma = new OpenMultiAgent({
      onTaskDispatch: async () => ({ action: 'suspend' }),
    })
    const team = oma.createTeam('verify-approval', {
      name: 'verify-approval',
      agents: [worker('worker', workerAdapter.adapter), judge],
      sharedMemory: false,
    })

    const result = await oma.runTasks(team, [{
      title: 'Verified task',
      description: 'This task has live verifier wiring.',
      assignee: 'worker',
      verify: { judges: [judge] },
    }], { checkpoint: { store } })

    expect(result.status?.code).toBe('error')
    expect(result.pendingApprovals).toBeUndefined()
    expect(workerAdapter.calls()).toBe(0)
    expect(judgeAdapter.calls()).toBe(0)
    expect((await store.list()).some((entry) => entry.key.startsWith(APPROVAL_KEY_PREFIX)))
      .toBe(false)
  })

  it('suspends task dispatch before work and consumes that exact approval once after restart', async () => {
    const store = new InMemoryStore()
    const initialWorker = scriptedAdapter([textResponse('must not run')])
    const dispatchGate = vi.fn(async () => ({ action: 'suspend' as const }))
    const oma = new OpenMultiAgent({ onTaskDispatch: dispatchGate })
    const team = oma.createTeam('dispatch-approval', {
      name: 'dispatch-approval',
      agents: [worker('worker', initialWorker.adapter)],
      sharedMemory: false,
    })

    const suspended = await oma.runTasks(team, [
      { title: 'Deploy', description: 'Deploy the reviewed build.', assignee: 'worker' },
    ], { checkpoint: { store } })
    const request = onePending(suspended)
    expect(suspended.status?.code).toBe('suspended')
    expect(request.scope).toBe('task_dispatch')
    expect(initialWorker.calls()).toBe(0)
    await approve(store, request)

    const resumedWorker = scriptedAdapter([textResponse('deployed')])
    const restoredGate = vi.fn(async () => false)
    const resumedOma = new OpenMultiAgent({ onTaskDispatch: restoredGate })
    const resumedTeam = resumedOma.createTeam('dispatch-approval', {
      name: 'dispatch-approval',
      agents: [worker('worker', resumedWorker.adapter)],
      sharedMemory: false,
    })
    const result = await resumedOma.restore(resumedTeam, { checkpoint: { store } })

    expect(result.success).toBe(true)
    expect(result.tasks?.[0]?.status).toBe('completed')
    expect(resumedWorker.calls()).toBe(1)
    expect(restoredGate).not.toHaveBeenCalled()
  })

  it('keeps a rejected dispatch terminal across repeated restores', async () => {
    const store = new InMemoryStore()
    const initialWorker = scriptedAdapter([textResponse('must not run')])
    const oma = new OpenMultiAgent({
      onTaskDispatch: async () => ({ action: 'suspend' }),
    })
    const team = oma.createTeam('dispatch-rejection', {
      name: 'dispatch-rejection',
      agents: [worker('worker', initialWorker.adapter)],
      sharedMemory: false,
    })
    const suspended = await oma.runTasks(team, [
      { title: 'Deploy', description: 'Deploy.', assignee: 'worker' },
    ], { checkpoint: { store } })
    const request = onePending(suspended)
    await decideApproval(store, {
      requestId: request.id,
      requestHash: request.requestHash,
      decision: 'reject',
      reviewer: { id: 'reviewer-1' },
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      const adapter = scriptedAdapter([textResponse('must not run')])
      const resumed = new OpenMultiAgent({ onTaskDispatch: async () => true })
      const resumedTeam = resumed.createTeam('dispatch-rejection', {
        name: 'dispatch-rejection',
        agents: [worker('worker', adapter.adapter)],
        sharedMemory: false,
      })
      const result = await resumed.restore(resumedTeam, { checkpoint: { store } })
      expect(result.status?.code).toBe('rejected')
      expect(result.tasks?.[0]?.status).toBe('skipped')
      expect(adapter.calls()).toBe(0)
    }
  })

  it('suspends a legacy round after completed work and resumes only the approved next round', async () => {
    const store = new InMemoryStore()
    const firstRun = scriptedAdapter([textResponse('first complete')])
    const roundGate = vi.fn(async () => ({ action: 'suspend' as const }))
    const oma = new OpenMultiAgent({ onApproval: roundGate })
    const team = oma.createTeam('round-approval', {
      name: 'round-approval',
      agents: [worker('worker', firstRun.adapter)],
      sharedMemory: false,
    })

    const suspended = await oma.runTasks(team, [
      { title: 'Prepare', description: 'Prepare.', assignee: 'worker' },
      { title: 'Publish', description: 'Publish.', assignee: 'worker', dependsOn: ['Prepare'] },
    ], { checkpoint: { store } })
    const request = onePending(suspended)
    expect(suspended.status?.code).toBe('suspended')
    expect(suspended.tasks?.map((task) => [task.title, task.status])).toEqual([
      ['Prepare', 'completed'],
      ['Publish', 'pending'],
    ])
    expect(request.scope).toBe('task_round')
    expect(firstRun.calls()).toBe(1)
    await approve(store, request)

    const secondRun = scriptedAdapter([textResponse('published')])
    const restoredGate = vi.fn(async () => false)
    const resumedOma = new OpenMultiAgent({ onApproval: restoredGate })
    const resumedTeam = resumedOma.createTeam('round-approval', {
      name: 'round-approval',
      agents: [worker('worker', secondRun.adapter)],
      sharedMemory: false,
    })
    const result = await resumedOma.restore(resumedTeam, { checkpoint: { store } })

    expect(result.success).toBe(true)
    expect(result.tasks?.every((task) => task.status === 'completed')).toBe(true)
    expect(secondRun.calls()).toBe(1)
    expect(restoredGate).not.toHaveBeenCalled()
  })
})

describe('durable tool-call approval', () => {
  function toolHarness(store: InMemoryStore) {
    const executions: number[] = []
    const tool = defineTool({
      name: 'charge_card',
      description: 'Charge a card.',
      consequential: true,
      inputSchema: z.object({ amount: z.coerce.number().int().positive() }),
      execute: async ({ amount }) => {
        executions.push(amount)
        return { data: `charged:${amount}`, isError: false }
      },
    })
    const initialAdapter = scriptedAdapter([
      toolResponse('charge_card', { amount: '7' }),
    ])
    const gate = vi.fn(async () => ({ action: 'suspend' as const, reason: 'Finance review' }))
    const oma = new OpenMultiAgent({ onToolCall: gate })
    const team = oma.createTeam('tool-approval', {
      name: 'tool-approval',
      agents: [worker('operator', initialAdapter.adapter, { customTools: [tool] })],
      sharedMemory: false,
    })
    return { executions, tool, initialAdapter, gate, oma, team, store }
  }

  it('does not execute before suspension and executes the exact validated invocation once after approval', async () => {
    const store = new InMemoryStore()
    const harness = toolHarness(store)
    const suspended = await harness.oma.runTasks(harness.team, [
      {
        title: 'Charge',
        description: 'Charge the approved amount.',
        assignee: 'operator',
        maxRetries: 2,
        retryDelayMs: 0,
      },
    ], { checkpoint: { store } })
    const request = onePending(suspended)

    expect(suspended.status?.code).toBe('suspended')
    expect(harness.executions).toEqual([])
    expect(request).toMatchObject({
      scope: 'tool_call',
      content: {
        kind: 'tool_call',
        toolName: 'charge_card',
        rawInput: { amount: '7' },
        input: { amount: 7 },
        consequential: true,
      },
    })
    expect(harness.gate).toHaveBeenCalledTimes(1)
    await approve(store, request, 'finance@example.com')

    const resumedAdapter = scriptedAdapter([textResponse('charge complete')])
    const restoredGate = vi.fn(async () => ({ action: 'deny' as const }))
    const resumedOma = new OpenMultiAgent({ onToolCall: restoredGate })
    const resumedTeam = resumedOma.createTeam('tool-approval', {
      name: 'tool-approval',
      agents: [worker('operator', resumedAdapter.adapter, { customTools: [harness.tool] })],
      sharedMemory: false,
    })
    const result = await resumedOma.restore(resumedTeam, { checkpoint: { store } })

    expect(result.success).toBe(true)
    expect(harness.executions).toEqual([7])
    expect(restoredGate).not.toHaveBeenCalled()
    expect(result.approvalDecisions?.[0]).toMatchObject({
      requestId: request.id,
      decision: 'approved',
      reviewer: { id: 'finance@example.com' },
    })
    expect(buildExecutionReceipt(result).approvalDecisions).toEqual([
      expect.objectContaining({
        requestId: request.id,
        decision: 'approved',
        reviewerId: 'finance@example.com',
      }),
    ])
  })

  it('turns a durable rejection into a denied tool result without executing the side effect', async () => {
    const store = new InMemoryStore()
    const harness = toolHarness(store)
    const suspended = await harness.oma.runTasks(harness.team, [
      { title: 'Charge', description: 'Charge the approved amount.', assignee: 'operator' },
    ], { checkpoint: { store } })
    const request = onePending(suspended)
    await decideApproval(store, {
      requestId: request.id,
      requestHash: request.requestHash,
      decision: 'reject',
      reviewer: { id: 'finance-reviewer' },
    })

    const resumedAdapter = scriptedAdapter([textResponse('charge cancelled')])
    const resumedOma = new OpenMultiAgent({ onToolCall: async () => ({ action: 'allow' }) })
    const resumedTeam = resumedOma.createTeam('tool-approval', {
      name: 'tool-approval',
      agents: [worker('operator', resumedAdapter.adapter, { customTools: [harness.tool] })],
      sharedMemory: false,
    })
    const result = await resumedOma.restore(resumedTeam, { checkpoint: { store } })

    expect(result.success).toBe(true)
    expect(harness.executions).toEqual([])
    expect(JSON.stringify(resumedAdapter.inputs[0])).toContain('denied by durable approval')
    expect(result.approvalDecisions?.[0]?.decision).toBe('rejected')
  })

  it('rejects approval when the current tool schema no longer accepts the reviewed input', async () => {
    const store = new InMemoryStore()
    const harness = toolHarness(store)
    const suspended = await harness.oma.runTasks(harness.team, [
      {
        title: 'Charge',
        description: 'Charge the approved amount.',
        assignee: 'operator',
        maxRetries: 2,
        retryDelayMs: 0,
      },
    ], { checkpoint: { store } })
    const request = onePending(suspended)
    await approve(store, request)

    const replacementExecutions: number[] = []
    const replacementTool = defineTool({
      name: 'charge_card',
      description: 'Charge a card under the new limit.',
      consequential: true,
      inputSchema: z.object({ amount: z.coerce.number().int().positive().max(5) }),
      execute: async ({ amount }) => {
        replacementExecutions.push(amount)
        return { data: `charged:${amount}`, isError: false }
      },
    })
    const resumedAdapter = scriptedAdapter([textResponse('must not run')])
    const resumedOma = new OpenMultiAgent({ onToolCall: async () => ({ action: 'allow' }) })
    const resumedTeam = resumedOma.createTeam('tool-approval', {
      name: 'tool-approval',
      agents: [worker('operator', resumedAdapter.adapter, { customTools: [replacementTool] })],
      sharedMemory: false,
    })

    await expect(resumedOma.restore(resumedTeam, { checkpoint: { store } }))
      .rejects.toMatchObject({ code: 'APPROVAL_STALE_DECISION' })
    expect(harness.executions).toEqual([])
    expect(replacementExecutions).toEqual([])
    expect(resumedAdapter.calls()).toBe(0)
  })

  it('rejects a checkpoint whose pending tool input changed after review', async () => {
    const store = new InMemoryStore()
    const harness = toolHarness(store)
    const suspended = await harness.oma.runTasks(harness.team, [
      { title: 'Charge', description: 'Charge the approved amount.', assignee: 'operator' },
    ], { checkpoint: { store } })
    const request = onePending(suspended)
    await approve(store, request)

    const checkpoint = new Checkpoint(store)
    const snapshot = await checkpoint.loadLatest()
    expect(snapshot?.version).toBe(4)
    const tampered = structuredClone(snapshot) as CheckpointSnapshotV4
    const state = tampered.inFlightTasks[0]!
    const pending = state.pendingToolCalls![0]!
    ;(pending.call.input as Record<string, unknown>)['amount'] = '7000'
    await checkpoint.save(tampered)

    const resumedAdapter = scriptedAdapter([textResponse('must not run')])
    const resumedOma = new OpenMultiAgent({ onToolCall: async () => ({ action: 'allow' }) })
    const resumedTeam = resumedOma.createTeam('tool-approval', {
      name: 'tool-approval',
      agents: [worker('operator', resumedAdapter.adapter, { customTools: [harness.tool] })],
      sharedMemory: false,
    })

    await expect(resumedOma.restore(resumedTeam, { checkpoint: { store } }))
      .rejects.toMatchObject({ code: 'APPROVAL_STALE_DECISION' })
    expect(harness.executions).toEqual([])
    expect(resumedAdapter.calls()).toBe(0)
  })

  it('rejects a checkpoint that hides an in-flight approval from the top-level pending set', async () => {
    const store = new InMemoryStore()
    const harness = toolHarness(store)
    const suspended = await harness.oma.runTasks(harness.team, [
      { title: 'Charge', description: 'Charge the approved amount.', assignee: 'operator' },
    ], { checkpoint: { store } })
    onePending(suspended)

    const checkpoint = new Checkpoint(store)
    const snapshot = await checkpoint.loadLatest()
    expect(snapshot?.version).toBe(4)
    const tampered = structuredClone(snapshot) as CheckpointSnapshotV4
    ;(tampered as { pendingApprovals: ApprovalRequest[] }).pendingApprovals = []
    await checkpoint.save(tampered)

    const resumedAdapter = scriptedAdapter([textResponse('must not run')])
    const resumedOma = new OpenMultiAgent({ onToolCall: async () => ({ action: 'allow' }) })
    const resumedTeam = resumedOma.createTeam('tool-approval', {
      name: 'tool-approval',
      agents: [worker('operator', resumedAdapter.adapter, { customTools: [harness.tool] })],
      sharedMemory: false,
    })

    await expect(resumedOma.restore(resumedTeam, { checkpoint: { store } }))
      .rejects.toThrow('not a checkpoint snapshot')
    expect(harness.executions).toEqual([])
    expect(resumedAdapter.calls()).toBe(0)
  })
})

describe('approval key namespace', () => {
  it('keeps approval facts separate from checkpoint and telemetry keys', () => {
    expect(approvalKey('apr_test')).toBe(`${APPROVAL_KEY_PREFIX}apr_test`)
  })
})
