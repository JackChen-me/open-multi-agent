import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  DeterministicRouter,
  evaluateSemanticRoutingPolicy,
  LLMTaskProfiler,
  OpenMultiAgent,
  RoutingDeclarationRequiredError,
  RoutingProfilerFailedError,
  RoutingTimeoutError,
  taskProfileSchema,
  validateTaskProfilerResult,
} from '../src/index.js'
import type {
  AgentConfig,
  ExecutionRoutingConfig,
  LLMAdapter,
  LLMResponse,
  RunTeamOptions,
  TaskProfile,
  TaskProfiler,
} from '../src/index.js'
import { loadEvalSet } from '../src/eval/file.js'
import { BatchingTraceSink } from '../src/observability/batching.js'
import { InMemoryTraceStore } from '../src/observability/in-memory-store.js'
import { TraceStoreExporter } from '../src/observability/store-exporter.js'

const SEMANTIC_EVAL_SET_PATH = fileURLToPath(
  new URL('./fixtures/eval/semantic-routing-set.json', import.meta.url),
)

const PLAN = `\`\`\`json
[{"title":"Do work","description":"Do the requested work.","assignee":"alpha"}]
\`\`\``

function response(output: string, input = 1, outputTokens = 1): LLMResponse {
  return {
    id: 'semantic-routing-test',
    content: [{ type: 'text', text: output }],
    model: 'mock-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: outputTokens },
  }
}

function adapter(output = 'done'): LLMAdapter & { chat: ReturnType<typeof vi.fn> } {
  return {
    name: 'semantic-routing-adapter',
    chat: vi.fn(async () => response(output)),
    async *stream() { /* unused */ },
  }
}

function profile(overrides: Partial<TaskProfile> = {}): TaskProfile {
  return {
    evidenceSources: 'single',
    independentReview: 'none',
    conflictingObjectives: false,
    sideEffectIntent: 'none',
    permissionIsolation: 'none',
    decomposable: false,
    parallelizable: false,
    complexity: 'low',
    confidence: 0.9,
    reasons: ['Fixture classification.'],
    source: 'inferred',
    ...overrides,
  }
}

function rawProfile(overrides: Partial<TaskProfile> = {}): string {
  const { source: _source, ...raw } = profile(overrides)
  return JSON.stringify(raw)
}

function profiler(
  value: TaskProfile,
  usage = { input_tokens: 2, output_tokens: 1 },
): TaskProfiler & { profile: ReturnType<typeof vi.fn> } {
  return {
    version: 'fixture-profiler-v1',
    profile: vi.fn(async () => ({
      profile: value,
      usage,
      model: 'routing-model',
      provider: 'fixture',
    })),
  }
}

function createRun(
  taskProfiler: TaskProfiler,
  agentOverrides: Partial<AgentConfig> = {},
  extraConfig: ConstructorParameters<typeof OpenMultiAgent>[0] = {},
) {
  const agentAdapter = adapter()
  const coordinatorAdapter = adapter(PLAN)
  const {
    executionRouting: extraExecutionRouting,
    ...remainingConfig
  } = extraConfig
  const oma = new OpenMultiAgent({
    defaultModel: 'mock-model',
    ...remainingConfig,
    executionRouting: {
      strategy: 'hybrid',
      profiler: taskProfiler,
      ...extraExecutionRouting,
    },
  })
  const team = oma.createTeam('semantic-routing', {
    name: 'semantic-routing',
    agents: [{
      name: 'alpha',
      model: 'mock-model',
      adapter: agentAdapter,
      ...agentOverrides,
    }],
  })
  return {
    agentAdapter,
    coordinatorAdapter,
    run: (goal = 'Say hello', options: RunTeamOptions = {}) => oma.runTeam(team, goal, {
      coordinator: { model: 'mock-model', adapter: coordinatorAdapter },
      ...options,
    }),
  }
}

describe('TaskProfile schema and deterministic policy', () => {
  it('accepts only strict, bounded inferred profiles', () => {
    expect(taskProfileSchema.parse(profile()).source).toBe('inferred')
    expect(() => validateTaskProfilerResult({
      profile: { ...profile(), extra: true },
    })).toThrow(/invalid profile/i)
    expect(() => validateTaskProfilerResult({
      profile: { ...profile(), confidence: 1.1 },
    })).toThrow(/invalid profile/i)
  })

  it.each([
    [{ evidenceSources: 'multiple' as const }, 'team'],
    [{ independentReview: 'required' as const }, 'team'],
    [{ conflictingObjectives: true }, 'team'],
    [{ decomposable: true, parallelizable: true }, 'team'],
    [{ confidence: 0.69, evidenceSources: 'multiple' as const }, 'single'],
    [{ parallelizable: true }, 'team'],
  ])('maps semantic signals to a bounded recommendation', (overrides, expected) => {
    expect(evaluateSemanticRoutingPolicy(profile(overrides), {
      confidenceThreshold: 0.7,
      hasConsequentialTools: false,
      permissionBoundaryCount: 0,
    }).recommendation).toBe(expected)
  })

  it('requires a declaration only when inferred risk intersects framework facts', () => {
    expect(evaluateSemanticRoutingPolicy(profile({ sideEffectIntent: 'required' }), {
      confidenceThreshold: 0.7,
      hasConsequentialTools: true,
      permissionBoundaryCount: 0,
    }).recommendation).toBe('needs-declaration')
    expect(evaluateSemanticRoutingPolicy(profile({ permissionIsolation: 'required' }), {
      confidenceThreshold: 0.7,
      hasConsequentialTools: false,
      permissionBoundaryCount: 2,
    }).recommendation).toBe('needs-declaration')
    expect(evaluateSemanticRoutingPolicy(profile({ sideEffectIntent: 'required' }), {
      confidenceThreshold: 0.7,
      hasConsequentialTools: false,
      permissionBoundaryCount: 0,
    }).recommendation).toBe('single')
    expect(evaluateSemanticRoutingPolicy(profile(), {
      confidenceThreshold: 0.7,
      hasConsequentialTools: true,
      permissionBoundaryCount: 2,
    }).recommendation).toBe('single')
    expect(evaluateSemanticRoutingPolicy(profile({ permissionIsolation: 'required' }), {
      confidenceThreshold: 0.7,
      hasConsequentialTools: false,
      permissionBoundaryCount: 1,
    }).recommendation).toBe('single')
  })

  it('passes the frozen multilingual and prompt-injection policy EvalSet', async () => {
    const evalSet = await loadEvalSet(SEMANTIC_EVAL_SET_PATH)
    expect(evalSet.name).toBe('semantic-routing-policy')
    expect(evalSet.cases.length).toBeGreaterThanOrEqual(10)
    for (const evalCase of evalSet.cases) {
      const input = evalCase.input as {
        profile: TaskProfile
        facts: {
          confidenceThreshold: number
          hasConsequentialTools: boolean
          permissionBoundaryCount: number
        }
        expected: 'single' | 'team' | 'needs-declaration'
      }
      const parsedProfile = taskProfileSchema.parse(input.profile)
      expect(
        evaluateSemanticRoutingPolicy(parsedProfile, input.facts).recommendation,
        evalCase.id,
      ).toBe(input.expected)
    }
  })
})

describe('LLMTaskProfiler', () => {
  it('uses one no-tool adapter call and validates JSON output', async () => {
    const mockAdapter = adapter(JSON.stringify({
      evidenceSources: 'multiple',
      independentReview: 'none',
      conflictingObjectives: false,
      sideEffectIntent: 'none',
      permissionIsolation: 'none',
      decomposable: true,
      parallelizable: true,
      complexity: 'medium',
      confidence: 0.91,
      reasons: ['Two sources are requested.'],
    }))
    const taskProfiler = new LLMTaskProfiler({
      adapter: mockAdapter,
      model: 'routing-model',
    })

    const result = await taskProfiler.profile({
      goal: 'Compare two independent sources.',
      roster: [{ name: 'alpha', model: 'mock-model' }],
    })

    expect(mockAdapter.chat).toHaveBeenCalledOnce()
    expect(mockAdapter.chat.mock.calls[0]?.[1]).not.toHaveProperty('tools')
    expect(result.profile).toMatchObject({
      evidenceSources: 'multiple',
      source: 'inferred',
    })
  })

  it('disables DeepSeek V4 thinking so profiling returns within its output budget', async () => {
    const mockAdapter = {
      ...adapter(JSON.stringify({
        evidenceSources: 'single',
        independentReview: 'none',
        conflictingObjectives: false,
        sideEffectIntent: 'none',
        permissionIsolation: 'none',
        decomposable: false,
        parallelizable: false,
        complexity: 'low',
        confidence: 0.95,
        reasons: ['The task is a bounded classification request.'],
      })),
      name: 'deepseek',
    }
    const taskProfiler = new LLMTaskProfiler({
      adapter: mockAdapter,
      model: 'deepseek-v4-flash',
    })

    await taskProfiler.profile({
      goal: 'Summarize this note.',
      roster: [{ name: 'alpha', model: 'deepseek-v4-flash' }],
    })

    expect(mockAdapter.chat.mock.calls[0]?.[1]).toMatchObject({
      extraBody: { thinking: { type: 'disabled' } },
    })
  })
})

describe('hybrid runTeam routing', () => {
  it.each([
    [{ strategy: 'hybird' }, /strategy/],
    [{ failurePolicy: 'ignore' }, /failurePolicy/],
    [{ confidenceThreshold: 1.1 }, /confidenceThreshold/],
    [{ timeoutMs: 0 }, /timeoutMs/],
  ])('rejects invalid orchestrator routing config at construction', (config, expected) => {
    expect(() => new OpenMultiAgent({
      executionRouting: config as unknown as ExecutionRoutingConfig,
    })).toThrow(expected)
  })

  it('rejects invalid per-run routing config before starting a run trace', async () => {
    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    const { run } = createRun(profiler(profile()), {}, {
      observability: { sinks: [sink] },
    })

    await expect(run('Say hello', {
      runId: 'invalid-routing-config',
      executionRouting: {
        timeoutMs: 0,
      } as unknown as ExecutionRoutingConfig,
    })).rejects.toThrow(/timeoutMs/)
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({
      status: 'ok',
    })
    await expect(store.getRun('invalid-routing-config')).resolves.toBeNull()
    await sink.shutdown({ timeoutMs: 500 })
  })

  it('upgrades only a deterministic Single to Team when Hybrid is enabled', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const { run } = createRun(taskProfiler)

    const result = await run()

    expect(taskProfiler.profile).toHaveBeenCalledOnce()
    expect(result.routingDecision).toMatchObject({
      mode: 'team',
      routerVersion: 'hybrid-v1',
    })
    expect(result.semanticRoutingAssessment).toMatchObject({
      legacyMode: 'single',
      recommendation: 'team',
      actualMode: 'team',
      outcome: 'applied',
    })
  })

  it('defaults to deterministic routing without creating a profiler call', async () => {
    const agentAdapter = adapter('hello')
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('default-deterministic', {
      name: 'default-deterministic',
      agents: [{ name: 'alpha', model: 'mock-model', adapter: agentAdapter }],
    })

    const result = await oma.runTeam(team, 'Say hello')

    expect(agentAdapter.chat).toHaveBeenCalledOnce()
    expect(result.routingDecision).toMatchObject({
      mode: 'single',
      routerVersion: 'deterministic-v1',
    })
    expect(result.semanticRoutingAssessment).toBeUndefined()
  })

  it('keeps deterministic Team without making a profiler call', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const { run } = createRun(taskProfiler)

    const result = await run('First research the topic, then write a report.')

    expect(taskProfiler.profile).not.toHaveBeenCalled()
    expect(result.routingDecision?.mode).toBe('team')
    expect(result.semanticRoutingAssessment).toBeUndefined()
  })

  it('profiles a deterministic Single reached through custom Router fallback', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const { run } = createRun(taskProfiler)

    const result = await run('Say hello', {
      executionRouter: {
        version: 'broken-router-v1',
        decide: () => { throw new Error('unavailable') },
      },
    })

    expect(taskProfiler.profile).toHaveBeenCalledOnce()
    expect(result.routingDecision).toMatchObject({
      mode: 'team',
      routerVersion: 'hybrid-v1',
      status: 'fallback',
      requestedRouterVersion: 'broken-router-v1',
      fallbackCode: 'router-error',
    })
  })

  it('never overrides explicit mode, declared governance, or valid custom Router decisions', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const explicit = createRun(taskProfiler)
    expect((await explicit.run('Say hello', { mode: 'single' })).routingDecision)
      .toMatchObject({ source: 'override', mode: 'single' })
    expect(taskProfiler.profile).not.toHaveBeenCalled()

    const declared = createRun(taskProfiler)
    expect((await declared.run('Say hello', {
      governanceIntent: 'required',
      requiredRoles: ['alpha'],
    })).routingDecision).toMatchObject({ source: 'declared', mode: 'team' })
    expect(taskProfiler.profile).not.toHaveBeenCalled()

    const custom = createRun(taskProfiler)
    expect((await custom.run('Say hello', {
      executionRouter: {
        version: 'valid-custom-v1',
        decide: () => ({
          mode: 'single',
          reasons: ['Application selected Single.'],
          routerVersion: 'valid-custom-v1',
        }),
      },
    })).routingDecision).toMatchObject({
      mode: 'single',
      routerVersion: 'valid-custom-v1',
    })
    expect(taskProfiler.profile).not.toHaveBeenCalled()
  })

  it('restores the legacy no-profiler path with strategy deterministic', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const { agentAdapter, coordinatorAdapter, run } = createRun(taskProfiler, {}, {
      executionRouting: { strategy: 'deterministic', profiler: taskProfiler },
    })

    const result = await run()

    expect(taskProfiler.profile).not.toHaveBeenCalled()
    expect(coordinatorAdapter.chat).not.toHaveBeenCalled()
    expect(agentAdapter.chat).toHaveBeenCalledOnce()
    expect(result.routingDecision).toMatchObject({
      mode: 'single',
      routerVersion: 'deterministic-v1',
    })
  })

  it('treats an explicitly installed DeterministicRouter as a final Router decision', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const { run } = createRun(taskProfiler, {}, {
      executionRouter: new DeterministicRouter(),
    })

    const result = await run()

    expect(taskProfiler.profile).not.toHaveBeenCalled()
    expect(result.routingDecision).toMatchObject({
      mode: 'single',
      routerVersion: 'deterministic-v1',
      status: 'selected',
    })
  })

  it('keeps legacy custom-Router fallback call counts in deterministic mode', async () => {
    const taskProfiler = profiler(profile({ evidenceSources: 'multiple' }))
    const { agentAdapter, coordinatorAdapter, run } = createRun(taskProfiler)

    const result = await run('Say hello', {
      executionRouter: {
        version: 'broken-router-v1',
        decide: () => { throw new Error('unavailable') },
      },
      executionRouting: { strategy: 'deterministic', profiler: taskProfiler },
    })

    expect(taskProfiler.profile).not.toHaveBeenCalled()
    expect(coordinatorAdapter.chat).not.toHaveBeenCalled()
    expect(agentAdapter.chat).toHaveBeenCalledOnce()
    expect(result.routingDecision).toMatchObject({
      mode: 'single',
      status: 'fallback',
      fallbackCode: 'router-error',
    })
  })

  it('falls back on invalid profiler output and fails when configured', async () => {
    const invalid: TaskProfiler = {
      version: 'invalid-v1',
      profile: async () => ({ profile: { confidence: 2 } as TaskProfile }),
    }
    const fallbackRun = createRun(invalid)
    const fallback = await fallbackRun.run()
    expect(fallback.semanticRoutingAssessment).toMatchObject({
      recommendation: 'single',
      outcome: 'fallback',
      fallbackCode: 'invalid-profile',
    })

    const cause = new Error('invalid profile')
    expect(new RoutingProfilerFailedError('failed', cause).cause).toBe(cause)

    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    const failing = createRun(invalid, {}, {
      executionRouting: { profiler: invalid, failurePolicy: 'fail' },
      observability: { sinks: [sink] },
    })
    await expect(failing.run('Say hello', {
      runId: 'semantic-profiler-fail',
    })).rejects.toBeInstanceOf(RoutingProfilerFailedError)
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({
      status: 'ok',
    })
    await expect(store.getRun('semantic-profiler-fail')).resolves.toMatchObject({
      incomplete: false,
      status: 'error',
    })
    await sink.shutdown({ timeoutMs: 500 })
  })

  it.each([
    {
      name: 'throws',
      profile: () => { throw new Error('profiler unavailable') },
    },
    {
      name: 'rejects',
      profile: async () => Promise.reject(new Error('profiler unavailable')),
    },
  ])('falls back when a custom Profiler $name', async ({ profile: runProfile }) => {
    const broken: TaskProfiler = {
      version: 'broken-profiler-v1',
      profile: runProfile,
    }
    const result = await createRun(broken).run()

    expect(result.semanticRoutingAssessment).toMatchObject({
      profilerVersion: 'none',
      requestedProfilerVersion: 'broken-profiler-v1',
      recommendation: 'single',
      outcome: 'fallback',
      fallbackCode: 'profiler-error',
    })
  })

  it('reports profiler timeout under fallback and fail policies', async () => {
    const stalled: TaskProfiler = {
      version: 'stalled-v1',
      profile: () => new Promise(() => {}),
    }
    const fallback = createRun(stalled, {}, {
      executionRouting: { profiler: stalled, timeoutMs: 1 },
    })
    expect((await fallback.run()).semanticRoutingAssessment).toMatchObject({
      fallbackCode: 'profiler-timeout',
      outcome: 'fallback',
    })
    const failing = createRun(stalled, {}, {
      executionRouting: {
        profiler: stalled,
        timeoutMs: 1,
        failurePolicy: 'fail',
      },
    })
    await expect(failing.run()).rejects.toBeInstanceOf(RoutingTimeoutError)
  })

  it('requires governance before any model or tool-capable agent call', async () => {
    const taskProfiler = profiler(profile({ sideEffectIntent: 'required' }))
    const { agentAdapter, coordinatorAdapter, run } = createRun(taskProfiler, {
      tools: ['file_write'],
    })

    await expect(run()).rejects.toBeInstanceOf(RoutingDeclarationRequiredError)
    expect(agentAdapter.chat).not.toHaveBeenCalled()
    expect(coordinatorAdapter.chat).not.toHaveBeenCalled()
  })

  it('requires governance when inferred isolation crosses declared permission boundaries', async () => {
    const taskProfiler = profiler(profile({ permissionIsolation: 'required' }))
    const firstAdapter = adapter()
    const secondAdapter = adapter()
    const coordinatorAdapter = adapter(PLAN)
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      executionRouting: { strategy: 'hybrid', profiler: taskProfiler },
    })
    const team = oma.createTeam('permission-boundaries', {
      name: 'permission-boundaries',
      agents: [
        {
          name: 'alpha',
          model: 'mock-model',
          adapter: firstAdapter,
          permissionBoundary: 'prepare',
        },
        {
          name: 'beta',
          model: 'mock-model',
          adapter: secondAdapter,
          permissionBoundary: 'approve',
        },
      ],
    })

    await expect(oma.runTeam(team, 'Keep preparation and approval separate.', {
      coordinator: { model: 'mock-model', adapter: coordinatorAdapter },
    })).rejects.toBeInstanceOf(RoutingDeclarationRequiredError)
    expect(firstAdapter.chat).not.toHaveBeenCalled()
    expect(secondAdapter.chat).not.toHaveBeenCalled()
    expect(coordinatorAdapter.chat).not.toHaveBeenCalled()
  })

  it('accounts profiler usage before starting execution', async () => {
    const taskProfiler = profiler(profile(), { input_tokens: 4, output_tokens: 2 })
    const { agentAdapter, coordinatorAdapter, run } = createRun(taskProfiler, {}, {
      maxTokenBudget: 5,
    })

    const result = await run()

    expect(result.success).toBe(false)
    expect(result.status?.code).toBe('budget_exhausted')
    expect(result.totalTokenUsage).toEqual({ input_tokens: 4, output_tokens: 2 })
    expect(result.semanticRoutingAssessment).not.toHaveProperty('actualMode')
    expect(result.routingDecision?.semanticRoutingAssessment).not.toHaveProperty('actualMode')
    expect(agentAdapter.chat).not.toHaveBeenCalled()
    expect(coordinatorAdapter.chat).not.toHaveBeenCalled()
  })

  it('includes profiler usage in result and run metrics', async () => {
    const taskProfiler = profiler(profile(), { input_tokens: 2, output_tokens: 1 })
    const { run } = createRun(taskProfiler)

    const result = await run()

    expect(result.totalTokenUsage).toEqual({ input_tokens: 3, output_tokens: 2 })
    expect(result.metrics?.totalTokens).toEqual({ input_tokens: 3, output_tokens: 2 })
    expect(result.semanticRoutingAssessment?.usage).toEqual({
      input_tokens: 2,
      output_tokens: 1,
    })
  })

  it('charges profiler usage through the existing cost estimator', async () => {
    const taskProfiler = profiler(profile(), { input_tokens: 4, output_tokens: 2 })
    const estimateCost = vi.fn((usage: { input_tokens: number; output_tokens: number }) =>
      (usage.input_tokens + usage.output_tokens) / 100)
    const { agentAdapter, run } = createRun(taskProfiler, {}, {
      maxCostBudget: 0.05,
      estimateCost,
    })

    const result = await run()

    expect(result.status?.code).toBe('budget_exhausted')
    expect(result.semanticRoutingAssessment?.estimatedCost).toBe(0.06)
    expect(estimateCost).toHaveBeenCalledWith(
      { input_tokens: 4, output_tokens: 2 },
      expect.objectContaining({
        agentName: 'semantic-router',
        phase: 'routing',
        model: 'routing-model',
      }),
    )
    expect(agentAdapter.chat).not.toHaveBeenCalled()
  })

  it('records routing spans without persisting inferred secret-like reasons', async () => {
    const secret = 'api_key=semantic-routing-secret'
    const taskProfiler = profiler(profile({ reasons: [secret] }))
    const store = new InMemoryTraceStore()
    const sink = new BatchingTraceSink(new TraceStoreExporter(store), {
      diagnostics: 'silent',
      scheduledDelayMs: 60_000,
    })
    const { run } = createRun(taskProfiler, {}, {
      observability: { sinks: [sink] },
    })

    const result = await run()
    await expect(sink.forceFlush({ timeoutMs: 500 })).resolves.toMatchObject({
      status: 'ok',
    })
    const stored = await store.getRun(result.identity!.runId, {
      includeRecords: true,
    })
    const serialized = JSON.stringify(stored?.records)

    expect(serialized).toContain('profile_execution_route')
    expect(serialized).toContain('decide_execution_route')
    expect(serialized).not.toContain(secret)
    expect(stored?.tokens).toMatchObject(result.totalTokenUsage)
    await sink.shutdown({ timeoutMs: 500 })
  })

  it('resolves a per-run routing adapter before orchestrator and coordinator adapters', async () => {
    const perRunAdapter = adapter(rawProfile())
    const configuredAdapter = adapter(rawProfile())
    const coordinatorAdapter = adapter(PLAN)
    const agentAdapter = adapter()
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      executionRouting: {
        strategy: 'hybrid',
        adapter: configuredAdapter,
        model: 'configured-routing-model',
      },
    })
    const team = oma.createTeam('adapter-precedence', {
      name: 'adapter-precedence',
      agents: [{ name: 'alpha', model: 'mock-model', adapter: agentAdapter }],
    })

    await oma.runTeam(team, 'Say hello', {
      coordinator: { model: 'mock-model', adapter: coordinatorAdapter },
      executionRouting: {
        strategy: 'hybrid',
        adapter: perRunAdapter,
        model: 'per-run-routing-model',
      },
    })

    expect(perRunAdapter.chat).toHaveBeenCalledOnce()
    expect(perRunAdapter.chat.mock.calls[0]?.[1]).toMatchObject({
      model: 'per-run-routing-model',
    })
    expect(configuredAdapter.chat).not.toHaveBeenCalled()
    expect(coordinatorAdapter.chat).not.toHaveBeenCalled()
  })

  it('uses the coordinator adapter when no routing adapter is configured', async () => {
    const coordinatorAdapter = adapter()
    coordinatorAdapter.chat.mockImplementation(async (_messages, options) =>
      response(
        options.systemPrompt?.includes('classify task semantics')
          ? rawProfile()
          : PLAN,
      ))
    const agentAdapter = adapter()
    const oma = new OpenMultiAgent({
      defaultModel: 'mock-model',
      executionRouting: { strategy: 'hybrid' },
    })
    const team = oma.createTeam('coordinator-adapter-fallback', {
      name: 'coordinator-adapter-fallback',
      agents: [{ name: 'alpha', model: 'mock-model', adapter: agentAdapter }],
    })

    await oma.runTeam(team, 'Say hello', {
      coordinator: { model: 'mock-model', adapter: coordinatorAdapter },
    })

    expect(coordinatorAdapter.chat).toHaveBeenCalledOnce()
    expect(coordinatorAdapter.chat.mock.calls[0]?.[1]?.systemPrompt)
      .toContain('classify task semantics')
    expect(agentAdapter.chat).toHaveBeenCalledOnce()
  })
})
