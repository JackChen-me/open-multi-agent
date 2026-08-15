import { describe, expect, it } from 'vitest'
import { buildExecutionReceipt } from '../src/index.js'
import type {
  AgentRunResult,
  AgentTrace,
  TaskExecutionRecord,
  TeamRunResult,
} from '../src/types.js'

function agentResult(output: string): AgentRunResult {
  return {
    success: true,
    output,
    messages: [],
    tokenUsage: { input_tokens: 7, output_tokens: 3 },
    toolCalls: [],
  }
}

function agentTrace(agent: string): AgentTrace {
  return {
    type: 'agent',
    runId: 'run-1',
    spanId: 'span-1',
    agent,
    startMs: 100,
    endMs: 125,
    durationMs: 25,
    turns: 1,
    tokens: { input_tokens: 7, output_tokens: 3 },
    toolCalls: 0,
  }
}

function task(
  id: string,
  assignee: string,
  dependsOn: readonly string[],
  startMs: number,
  role?: string,
): TaskExecutionRecord {
  return {
    id,
    title: id,
    assignee,
    status: 'completed',
    dependsOn,
    ...(role ? { role } : {}),
    metrics: {
      startMs,
      endMs: startMs + 10,
      durationMs: 10,
      tokenUsage: { input_tokens: 1, output_tokens: 1 },
      toolCalls: [],
      retries: 0,
    },
  }
}

function teamResult(tasks: readonly TaskExecutionRecord[]): TeamRunResult {
  return {
    success: true,
    tasks,
    agentResults: new Map(),
    totalTokenUsage: { input_tokens: 20, output_tokens: 10 },
    metrics: {
      totalTokens: { input_tokens: 20, output_tokens: 10 },
      totalRetries: 0,
      errorCount: 0,
      failureCount: 0,
      completedCount: tasks.length,
      totalDurationMs: 40,
    },
  }
}

describe('buildExecutionReceipt', () => {
  it('does not treat multi-role answer text as independent execution', () => {
    const receipt = buildExecutionReceipt(
      agentResult('ROLLBACK_MISSING HOLD_ROTATION NOT_EXECUTED'),
      [agentTrace('security')],
    )

    expect(receipt).toMatchObject({
      mode: 'single',
      rolesExecuted: ['security'],
      executionOrder: ['security'],
      independentRolesCount: 1,
      independentReviewOccurred: false,
      totalTokens: { input: 7, output: 3 },
      durationMs: 25,
      partial: false,
    })
  })

  it('derives an ordered cross-role dependency chain from a DAG result', () => {
    const receipt = buildExecutionReceipt(teamResult([
      task('review', 'reviewer', [], 100),
      task('secure', 'security', ['review'], 200),
      task('operate', 'operator', ['secure'], 300),
    ]))

    expect(receipt.rolesExecuted).toEqual(['reviewer', 'security', 'operator'])
    expect(receipt.executionOrder).toEqual(['reviewer', 'security', 'operator'])
    expect(receipt.dependencyEdges).toEqual([
      { from: 'reviewer', to: 'security' },
      { from: 'security', to: 'operator' },
    ])
    expect(receipt.independentReviewOccurred).toBe(true)
    expect(receipt.partial).toBe(false)
  })

  it('reports a short-circuited team result as one executed role', () => {
    const result = {
      ...teamResult([
      task('short-circuit', 'security', [], 100),
      ]),
      routingDecision: {
        decisionId: 'decision-1',
        receiptId: 'receipt-1',
        traceSpanId: 'span-routing',
        source: 'router',
        mode: 'single',
        reasons: ['simple goal'],
        routerVersion: 'deterministic-v1',
      },
    } satisfies TeamRunResult
    const receipt = buildExecutionReceipt(result)

    expect(receipt.id).toBe('receipt-1')
    expect(receipt.routingDecisionId).toBe('decision-1')
    expect(receipt.routingDecisionSpanId).toBe('span-routing')
    expect(receipt.mode).toBe('single')
    expect(receipt.rolesExecuted).toEqual(['security'])
    expect(receipt.independentReviewOccurred).toBe(false)
  })

  it('does not report independent review for parallel roles without dependency edges', () => {
    const roles = ['reviewer', 'security', 'operator', 'legal', 'finance', 'auditor']
    const receipt = buildExecutionReceipt(teamResult(
      roles.map((role, index) => task(`task-${index}`, role, [], 100 + index)),
    ))

    expect(receipt.rolesExecuted).toEqual(roles)
    expect(receipt.independentRolesCount).toBe(6)
    expect(receipt.dependencyEdges).toEqual([])
    expect(receipt.independentReviewOccurred).toBe(false)
  })

  it('keeps worker instances distinct from repeated logical task roles', () => {
    const receipt = buildExecutionReceipt(teamResult([
      task('supplier-1', 'supplier-reader-01', [], 100, 'supplier-extraction'),
      task('supplier-2', 'supplier-reader-02', [], 101, 'supplier-extraction'),
      task('supplier-3', 'supplier-reader-03', [], 102, 'supplier-extraction'),
      task('review', 'evidence-reviewer', ['supplier-1', 'supplier-2', 'supplier-3'], 200, 'evidence-review'),
    ]))

    expect(receipt.rolesExecuted).toEqual([
      'supplier-reader-01',
      'supplier-reader-02',
      'supplier-reader-03',
      'evidence-reviewer',
    ])
    expect(receipt.workerInstancesExecuted).toEqual(receipt.rolesExecuted)
    expect(receipt.taskRolesExecuted).toEqual(['supplier-extraction', 'evidence-review'])
    expect(receipt.independentRolesCount).toBe(4)
  })

  it('excludes coordinator planning records from executed worker roles', () => {
    const receipt = buildExecutionReceipt(teamResult([
      task('plan', 'coordinator', [], 50),
      task('decompose', 'coordinator:decompose', [], 60),
      task('work', 'security', ['plan'], 100),
    ]))

    expect(receipt.rolesExecuted).toEqual(['security'])
    expect(receipt.executionOrder).toEqual(['security'])
    expect(receipt.dependencyEdges).toEqual([])
    expect(receipt.independentReviewOccurred).toBe(false)
  })

  it('returns a partial receipt instead of throwing when execution fields are missing', () => {
    const incomplete = {
      success: true,
      tasks: [{
        id: 'review',
        title: 'review',
        assignee: 'reviewer',
        status: 'completed',
        dependsOn: [],
      }],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 1, output_tokens: 1 },
    } as TeamRunResult

    expect(() => buildExecutionReceipt(incomplete)).not.toThrow()
    expect(buildExecutionReceipt(incomplete)).toMatchObject({
      rolesExecuted: ['reviewer'],
      executionOrder: [],
      durationMs: null,
      partial: true,
    })
  })
})
