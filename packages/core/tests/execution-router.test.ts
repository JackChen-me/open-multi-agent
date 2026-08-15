import { describe, expect, it, vi } from 'vitest'

import {
  DETERMINISTIC_ROUTER_VERSION,
  DeterministicRouter,
} from '../src/orchestrator/execution-router.js'
import { buildExecutionReceipt } from '../src/observability/execution-receipt.js'
import { BatchingTraceSink } from '../src/observability/batching.js'
import { InMemoryTraceStore } from '../src/observability/in-memory-store.js'
import { TRACE_RECORD_OBSERVER } from '../src/observability/runtime.js'
import { TraceStoreExporter } from '../src/observability/store-exporter.js'
import type { TraceRecord } from '../src/observability/records.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { RoutingTimeoutError } from '../src/errors.js'
import type {
  AgentConfig,
  ExecutionRouter,
  LLMAdapter,
  LLMResponse,
  OrchestratorConfig,
  RoutingContext,
  RoutingDecision,
  RunTeamOptions,
  TraceEvent,
} from '../src/types.js'

const PLAN = `\`\`\`json
[{"title":"Do work","description":"Do the requested work.","assignee":"alpha"}]
\`\`\``

function response(output = PLAN): LLMResponse {
  return {
    id: 'execution-router-response',
    content: [{ type: 'text', text: output }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function fixedAdapter(output = PLAN): LLMAdapter {
  return {
    name: 'execution-router-test',
    async chat(): Promise<LLMResponse> {
      return response(output)
    },
    async *stream() { /* unused */ },
  }
}

function agents(count = 2): AgentConfig[] {
  const adapter = fixedAdapter()
  return [
    {
      name: 'alpha',
      model: 'mock-model',
      systemPrompt: 'SECRET_ALPHA_PROMPT',
      tools: ['file_read'],
      adapter,
    },
    {
      name: 'beta',
      model: 'mock-model',
      systemPrompt: 'SECRET_BETA_PROMPT',
      adapter,
    },
  ].slice(0, count)
}

async function run(
  goal: string,
  options?: RunTeamOptions,
  configRouter?: ExecutionRouter,
  roster = agents(),
  extraConfig: OrchestratorConfig = {},
) {
  const orchestrator = new OpenMultiAgent({
    defaultModel: 'mock-model',
    ...extraConfig,
    ...(configRouter ? { executionRouter: configRouter } : {}),
  })
  const team = orchestrator.createTeam('routing-team', {
    name: 'routing-team',
    agents: roster,
  })
  return orchestrator.runTeam(team, goal, {
    coordinator: { model: 'mock-model', adapter: fixedAdapter() },
    ...options,
  })
}

function decision(
  routerVersion: string,
  mode: RoutingDecision['mode'],
  reason = `${mode} by test`,
): RoutingDecision {
  return { mode, reasons: [reason], routerVersion }
}

describe('DeterministicRouter', () => {
  it('returns Team for a one-agent roster when the goal is multi-stage', () => {
    const router = new DeterministicRouter()
    expect(router.decide({
      goal: 'First research the topic, then write and review the report.',
      roster: [{ name: 'solo', model: 'mock-model' }],
    })).toMatchObject({
      mode: 'team',
      routerVersion: DETERMINISTIC_ROUTER_VERSION,
    })
  })

  it('returns Team for an empty roster because Single cannot execute', () => {
    const router = new DeterministicRouter()
    expect(router.decide({ goal: 'Say hello', roster: [] })).toMatchObject({
      mode: 'team',
      routerVersion: DETERMINISTIC_ROUTER_VERSION,
    })
  })
})

describe('runTeam execution routing', () => {
  it('exposes the built-in decision on auto routes', async () => {
    const result = await run('Say hello', {
      executionRouting: { strategy: 'deterministic' },
    })

    expect(result.routingDecision).toMatchObject({
      mode: 'single',
      source: 'router',
      routerVersion: DETERMINISTIC_ROUTER_VERSION,
    })
    expect(result.tasks?.[0]?.id).toBe('short-circuit')
  })

  it('passes only the structured roster summary and remaining budget', async () => {
    let observed: RoutingContext | undefined
    const router: ExecutionRouter = {
      version: 'capture-v1',
      decide(context) {
        observed = context
        return decision(this.version, 'single')
      },
    }

    const result = await run('Say hello', {
      executionRouter: router,
      maxTokenBudget: 100,
    })

    expect(result.routingDecision?.routerVersion).toBe('capture-v1')
    expect(observed).toEqual({
      goal: 'Say hello',
      roster: [
        { name: 'alpha', model: 'mock-model', toolCount: 1 },
        { name: 'beta', model: 'mock-model' },
      ],
      budget: { tokenRemaining: 100 },
    })
    expect(JSON.stringify(observed)).not.toContain('SECRET_')
    expect(JSON.stringify(observed)).not.toContain('systemPrompt')
  })

  it('records the routing decision in legacy and v2 traces and links its receipt', async () => {
    const traces: TraceEvent[] = []
    const records: TraceRecord[] = []
    const tracedRouter = {
      version: 'trace-router-v1',
      decide: () => ({
        mode: 'single' as const,
        confidence: 0.85,
        reasons: ['Single route chosen for trace coverage.'],
        routerVersion: 'trace-router-v1',
      }),
    } satisfies ExecutionRouter
    const result = await run(
      'Say hello',
      undefined,
      tracedRouter,
      agents(),
      {
        onTrace: (event) => { traces.push(event) },
        [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => { records.push(record) },
      } as OrchestratorConfig & {
        [TRACE_RECORD_OBSERVER]: (record: TraceRecord) => void
      },
    )

    const routingTrace = traces.find(
      (event): event is Extract<TraceEvent, { type: 'routing_decision' }> =>
        event.type === 'routing_decision',
    )
    expect(routingTrace).toMatchObject({
      source: 'router',
      mode: 'single',
      routerVersion: 'trace-router-v1',
      confidence: 0.85,
      reasons: ['Single route chosen for trace coverage.'],
      receiptId: result.routingDecision?.receiptId,
      decisionId: result.routingDecision?.decisionId,
    })

    const routingSpan = records.find((record) =>
      record.recordType === 'span_end'
      && record.kind === 'routing'
      && record.name === 'decide_execution_route')
    expect(routingSpan?.attributes).toMatchObject({
      'oma.routing.mode': 'single',
      'oma.routing.source': 'router',
      'oma.routing.router_version': 'trace-router-v1',
      'oma.routing.confidence': 0.85,
      'oma.routing.reasons': ['Single route chosen for trace coverage.'],
      'oma.routing.receipt_id': result.routingDecision?.receiptId,
    })

    const receipt = buildExecutionReceipt(result)
    expect(result.routingDecision?.traceSpanId).toBe(routingSpan?.spanId)
    expect(result.routingDecision?.receiptId).toBe(receipt.id)
    expect(receipt.routingDecisionId).toBe(result.routingDecision?.decisionId)
    expect(receipt.routingDecisionSpanId).toBe(result.routingDecision?.traceSpanId)
  })

  it('lets a per-run router override the orchestrator router', async () => {
    const configured = {
      version: 'configured-v1',
      decide: vi.fn(() => decision('configured-v1', 'team')),
    } satisfies ExecutionRouter
    const perRun = {
      version: 'per-run-v1',
      decide: vi.fn(() => decision('per-run-v1', 'single')),
    } satisfies ExecutionRouter

    const result = await run('Say hello', { executionRouter: perRun }, configured)

    expect(result.routingDecision?.routerVersion).toBe('per-run-v1')
    expect(perRun.decide).toHaveBeenCalledOnce()
    expect(configured.decide).not.toHaveBeenCalled()
  })

  it('honors a custom Team decision for a simple goal', async () => {
    const router: ExecutionRouter = {
      version: 'team-first-v1',
      decide: () => decision('team-first-v1', 'team'),
    }

    const result = await run('Say hello', { executionRouter: router })

    expect(result.routingDecision).toMatchObject({
      ...decision('team-first-v1', 'team'),
      source: 'router',
    })
    expect(result.agentResults.has('coordinator')).toBe(true)
    expect(result.tasks?.[0]?.id).not.toBe('short-circuit')
  })

  it.each([
    {
      name: 'throws',
      router: {
        version: 'throwing-v1',
        decide: () => {
          throw new Error('router unavailable')
        },
      } satisfies ExecutionRouter,
      reason: 'custom decision failed',
      fallbackCode: 'router-error',
    },
    {
      name: 'rejects',
      router: {
        version: 'rejecting-v1',
        decide: async () => Promise.reject(new Error('router unavailable')),
      } satisfies ExecutionRouter,
      reason: 'custom decision failed',
      fallbackCode: 'router-error',
    },
    {
      name: 'returns an unsupported mode',
      router: {
        version: 'invalid-v1',
        decide: () => ({
          mode: 'unsupported',
          reasons: [],
          routerVersion: 'invalid-v1',
        }),
      } as unknown as ExecutionRouter,
      reason: 'invalid decision',
      fallbackCode: 'invalid-decision',
    },
  ])('falls back to DeterministicRouter when a custom router $name', async ({
    router,
    reason,
    fallbackCode,
  }) => {
    const result = await run('Say hello', { executionRouter: router })

    expect(result.success).toBe(true)
    expect(result.routingDecision).toMatchObject({
      mode: 'single',
      routerVersion: DETERMINISTIC_ROUTER_VERSION,
      status: 'fallback',
      fallbackCode,
    })
    expect(result.routingDecision?.reasons.join(' ')).toContain(reason)
  })

  it('reports Router timeout and honors fallback/fail policies', async () => {
    const stalled: ExecutionRouter = {
      version: 'stalled-router-v1',
      decide: () => new Promise(() => {}),
    }
    const fallback = await run('Say hello', {
      executionRouter: stalled,
      executionRouting: { timeoutMs: 1 },
    })
    expect(fallback.routingDecision).toMatchObject({
      status: 'fallback',
      requestedRouterVersion: 'stalled-router-v1',
      fallbackCode: 'router-timeout',
    })

    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    await expect(run(
      'Say hello',
      {
        runId: 'execution-router-fail',
        executionRouter: stalled,
        executionRouting: { timeoutMs: 1, failurePolicy: 'fail' },
      },
      undefined,
      agents(),
      { observability: { sinks: [sink] } },
    )).rejects.toBeInstanceOf(RoutingTimeoutError)
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({
      status: 'ok',
    })
    await expect(store.getRun('execution-router-fail')).resolves.toMatchObject({
      incomplete: false,
      status: 'timeout',
    })
    await sink.shutdown({ timeoutMs: 500 })
  })

  it('bypasses routers and marks an explicit mode as an override', async () => {
    const router = {
      version: 'unused-v1',
      decide: vi.fn(() => decision('unused-v1', 'team')),
    } satisfies ExecutionRouter

    const result = await run('Say hello', {
      mode: 'single',
      executionRouter: router,
    })

    expect(router.decide).not.toHaveBeenCalled()
    expect(result.routingDecision).toMatchObject({
      source: 'override',
      mode: 'single',
    })
    expect(result.routingDecision?.routerVersion).toBeUndefined()
    expect(result.tasks?.[0]?.id).toBe('short-circuit')
  })

  it('bypasses routers and marks a declared role topology', async () => {
    const router = {
      version: 'unused-v1',
      decide: vi.fn(() => decision('unused-v1', 'single')),
    } satisfies ExecutionRouter

    const result = await run('Review this change.', {
      governanceIntent: 'required',
      requiredRoles: ['alpha', 'beta'],
      executionRouter: router,
    })

    expect(router.decide).not.toHaveBeenCalled()
    expect(result.routingDecision).toMatchObject({
      source: 'declared',
      mode: 'team',
    })
    expect(result.routingDecision?.routerVersion).toBeUndefined()
    expect(result.tasks?.map((task) => task.assignee)).toEqual(['alpha', 'beta'])
  })

  it('bypasses routers and marks planOnly as a topology policy', async () => {
    const router = {
      version: 'unused-v1',
      decide: vi.fn(() => decision('unused-v1', 'single')),
    } satisfies ExecutionRouter

    const result = await run('Plan this work.', {
      planOnly: true,
      executionRouter: router,
    })

    expect(router.decide).not.toHaveBeenCalled()
    expect(result.routingDecision).toMatchObject({
      source: 'policy',
      mode: 'team',
    })
    expect(result.planOnly).toBe(true)
  })
})
