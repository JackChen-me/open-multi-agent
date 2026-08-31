/**
 * @fileoverview OpenMultiAgent — the top-level multi-agent orchestration class.
 *
 * {@link OpenMultiAgent} is the primary public API of the open-multi-agent framework.
 * It ties together every subsystem:
 *
 *  - {@link Team}       — Agent roster, shared memory, inter-agent messaging
 *  - {@link TaskQueue}  — Dependency-aware work queue
 *  - {@link Scheduler}  — Task-to-agent assignment strategies
 *  - {@link AgentPool}  — Concurrency-controlled execution pool
 *  - {@link Agent}      — Conversation + tool-execution loop
 *
 * ## Quick start
 *
 * ```ts
 * const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-opus-4-6' })
 *
 * const team = orchestrator.createTeam('research', {
 *   name: 'research',
 *   agents: [
 *     { name: 'researcher', model: 'claude-opus-4-6', systemPrompt: 'You are a researcher.' },
 *     { name: 'writer',     model: 'claude-opus-4-6', systemPrompt: 'You are a technical writer.' },
 *   ],
 *   sharedMemory: true,
 * })
 *
 * const result = await orchestrator.runTeam(team, 'Produce a report on TypeScript 5.5.')
 * console.log(result.agentResults.get('coordinator')?.output)
 * ```
 *
 * ## Key design decisions
 *
 * - **Coordinator pattern** — `runTeam()` spins up a temporary "coordinator" agent
 *   that breaks the high-level goal into tasks, assigns them, and synthesises the
 *   final answer. This is the framework's killer feature.
 * - **Parallel-by-default** — Independent tasks (no shared dependency) run in
 *   parallel up to `maxConcurrency`.
 * - **Graceful failure** — A failed task marks itself `'failed'` and its direct
 *   dependents remain `'blocked'` indefinitely; all non-dependent tasks continue.
 * - **Progress callbacks** — Callers can pass `onProgress` in the config to receive
 *   structured {@link OrchestratorEvent}s without polling.
 */

import type {
  AgentConfig,
  AgentRunInput,
  AgentRunResult,
  ApprovalDecisionRecord,
  ApprovalGateDecision,
  ApprovalRequest,
  ApprovalRequestContent,
  CheckpointOptions,
  CheckpointSnapshot,
  InFlightTaskCheckpoint,
  ConsensusOptions,
  ConsensusResult,
  CoordinatorConfig,
  EgressPolicy,
  ExecutionRoutingConfig,
  ModelRoutingPolicy,
  PlanArtifact,
  PlanRevision,
  PlanTaskArtifact,
  OrchestratorConfig,
  OrchestratorEvent,
  RestoreOptions,
  RoutingDecision as ExecutionRoutingDecision,
  RunAgentOptions,
  RunIdentity,
  RunStatus,
  StructuredTraceError,
  RunTaskSpec,
  RunTasksOptions,
  RunTeamOptions,
  SemanticRoutingAssessment,
  Task,
  TaskProfiler,
  TaskExecutionMetrics,
  TaskExecutionRecord,
  TaskStatus,
  TeamConfig,
  TeamRunResult,
  TokenUsage,
} from '../types.js'
import type { RunOptions } from '../agent/runner.js'
import { Agent } from '../agent/agent.js'
import { copyMessages, prepareAgentRunInput } from '../agent/input.js'
import { AgentPool } from '../agent/pool.js'
import { createAdapter } from '../llm/adapter.js'
import {
  intersectEgressPolicies,
  rejectUnsupportedEgress,
} from '../llm/egress.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { mergeAbortSignals } from '../utils/abort.js'
import { defaultWorkspaceDir } from '../tool/built-in/path-safety.js'
import { Team } from '../team/team.js'
import { TaskQueue } from '../task/queue.js'
import { Checkpoint } from '../memory/checkpoint.js'
import { InMemoryStore } from '../memory/store.js'
import type { RunJournalMode } from '../journal/events.js'
import {
  JournalRecorder,
  resolveRunJournal,
  type RunJournalConfig,
} from '../journal/journal.js'
import {
  foldJournalTail,
  journalTailReadFrom,
  restoreConversationLineage,
} from '../journal/tail-replay.js'
import { validateTaskDependencies } from '../task/task.js'
import { validateTaskMetadata } from '../task/metadata.js'
import { Scheduler } from './scheduler.js'
import {
  CostBudgetExceededError,
  InvalidTaskRequirementsError,
  RoutingDeclarationRequiredError,
  RoutingProfilerFailedError,
  RoutingTimeoutError,
  TokenBudgetExceededError,
} from '../errors.js'
import {
  validateTaskRequirements,
  type AgentSelectorContext,
} from './agent-selector.js'
import {
  createRestoreIdentity,
  resolveRestoreMetadata,
  validateRunMetadata,
  type RestoreMetadataResolution,
} from '../observability/identity.js'
import { classifyRunFailure, statusOnly } from '../observability/status.js'
import { buildExecutionReceipt } from '../observability/execution-receipt.js'
import {
  recordRoutingDecision,
  type RoutingDecisionRecordInput,
} from '../observability/routing-decision.js'
import {
  createTraceRuntime,
  LEGACY_TRACE_METADATA_ONLY,
  traceRecordObserverFrom,
  type TraceRecordObserver,
  type TraceRuntime,
} from '../observability/runtime.js'
import { CompositeSink } from '../observability/composite.js'
import type { TraceSink } from '../observability/sink.js'
import { SensitiveDataProcessor } from '../observability/processors.js'
import { LegacyCallbackTraceSink } from '../observability/legacy-callback.js'
import {
  ZERO_USAGE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DELEGATION_DEPTH,
  DEFAULT_MODEL,
  addUsage,
  createRunFacts,
  identityOptionsForRun,
  metadataAttributes,
  type RunMetadata,
  type RunContext,
  type ActiveCheckpoint,
} from './run-context.js'
import {
  computeRunMetrics,
  resolveBudgetCeiling,
  buildCostEstimateContext,
  applyBudgetAccounting,
  emitBudgetExceeded,
} from './budget.js'
import {
  buildAgent,
  applyAgentDefaults,
  applyDefaultToolPreset,
  routeMatches,
  withModelRoute,
  isLeafTask,
} from './agent-config.js'
import { selectBestAgent } from './short-circuit.js'
import {
  buildRoutingContext,
  DeterministicRouter,
  resolveExecutionRouting,
} from './execution-router.js'
import {
  evaluateSemanticRoutingPolicy,
  HYBRID_ROUTER_VERSION,
  LLMTaskProfiler,
  TaskProfileValidationError,
  validateTaskProfilerResult,
} from './task-profiler.js'
import {
  executeQueue,
  persistPendingApproval,
  saveRunCheckpoint,
} from './task-execution.js'
import {
  assertDurableTaskApprovalSupport,
  createApprovalRequest,
  DurableApprovalError,
  DurableApprovalLedger,
  hashApprovalRequest,
} from '../approval/durable.js'
import {
  buildGovernanceTaskSpecs,
  finalizeGovernanceRun,
  type GovernanceDeclaration,
} from './governance.js'
import {
  createConsequentialConfirmationState,
  finalizeConsequentialRun,
  hasGrantedConsequentialTool,
  withConsequentialConfirmation,
  type ConsequentialConfirmationState,
} from './consequential.js'
import { runConsensusCore, applyConsensusDefaults, type ConsensusAgentDefaults } from './consensus.js'
import { resolveRecoveryOptions } from './recovery.js'
import {
  createOnlineEvaluator,
  NOOP_ONLINE_EVALUATION,
  type OnlineEvaluationInput,
  type OnlineEvaluationLifecycle,
  type OnlineEvaluator,
} from '../eval/online.js'

import {
  buildCoordinatorBaseConfig,
  buildCoordinatorTaskSpecsSchema,
  buildDecompositionPrompt,
  runCoordinatorSynthesis,
  loadSpecsIntoQueue,
  findInvalidAssignees,
  type ParsedTaskSpec,
} from './coordinator.js'

// ---------------------------------------------------------------------------
// Re-exports — keep the public import surface stable after the split so callers
// (index.ts barrel and tests) can continue importing these from this module.
// ---------------------------------------------------------------------------

export { isSimpleGoal, selectBestAgent } from './short-circuit.js'
export { computeRetryDelay, executeWithRetry } from './retry.js'
export { DeterministicRouter } from './execution-router.js'
export type {
  ExecutionRouter,
  RoutingBudget,
  RoutingContext,
  RoutingDecision,
  RosterSummaryEntry,
} from './execution-router.js'

// ---------------------------------------------------------------------------
// OpenMultiAgent
// ---------------------------------------------------------------------------

interface PendingOnlineEvaluation {
  readonly input: unknown
  readonly startedAtMs: number
}

interface EffectiveRunBudgets {
  readonly maxTokenBudget?: number
  readonly maxCostBudget?: number
}

type EffectiveOrchestratorConfig = Required<
  Omit<
    OrchestratorConfig,
    | 'onApproval'
    | 'onTaskDispatch'
    | 'onAgentStream'
    | 'onPlanReady'
    | 'onProgress'
    | 'onTrace'
    | 'onToolCall'
    | 'observability'
    | 'evaluation'
    | 'defaultBaseURL'
    | 'defaultApiKey'
    | 'egressPolicy'
    | 'defaultShellExecutor'
    | 'maxTokenBudget'
    | 'maxCostBudget'
    | 'estimateCost'
    | 'defaultToolPreset'
    | 'checkpoint'
    | 'recovery'
    | 'journal'
  >
> & Pick<
  OrchestratorConfig,
  | 'onApproval'
  | 'onTaskDispatch'
  | 'onAgentStream'
  | 'onPlanReady'
  | 'onProgress'
  | 'onTrace'
  | 'onToolCall'
  | 'observability'
  | 'evaluation'
  | 'defaultBaseURL'
  | 'defaultApiKey'
  | 'egressPolicy'
  | 'defaultShellExecutor'
  | 'maxTokenBudget'
  | 'maxCostBudget'
  | 'estimateCost'
  | 'defaultToolPreset'
  | 'checkpoint'
  | 'recovery'
  | 'journal'
>

interface SemanticProfileRun {
  readonly assessment: SemanticRoutingAssessment
  readonly usage?: TokenUsage
  readonly model?: string
  readonly provider?: string
  readonly reasons: readonly string[]
}

function normalizeApprovalDecision(
  value: ApprovalGateDecision,
  callbackName: string,
): { readonly action: 'allow' | 'deny' | 'suspend'; readonly reason?: string } {
  if (value === true) return { action: 'allow' }
  if (value === false) return { action: 'deny' }
  if (
    value === null
    || typeof value !== 'object'
    || (value.action !== 'allow' && value.action !== 'deny' && value.action !== 'suspend')
    || ('reason' in value && value.reason !== undefined && typeof value.reason !== 'string')
  ) {
    throw new Error(`${callbackName} returned an invalid approval decision.`)
  }
  const reason = 'reason' in value ? value.reason : undefined
  return reason === undefined
    ? { action: value.action }
    : { action: value.action, reason }
}

function validateExecutionRoutingConfig(config?: ExecutionRoutingConfig): void {
  if (
    config?.strategy !== undefined
    && config.strategy !== 'hybrid'
    && config.strategy !== 'deterministic'
  ) {
    throw new TypeError("executionRouting.strategy must be 'hybrid' or 'deterministic'.")
  }
  if (
    config?.failurePolicy !== undefined
    && config.failurePolicy !== 'fallback'
    && config.failurePolicy !== 'fail'
  ) {
    throw new TypeError("executionRouting.failurePolicy must be 'fallback' or 'fail'.")
  }
  if (
    config?.confidenceThreshold !== undefined
    && (
      !Number.isFinite(config.confidenceThreshold)
      || config.confidenceThreshold < 0
      || config.confidenceThreshold > 1
    )
  ) {
    throw new TypeError('executionRouting.confidenceThreshold must be between 0 and 1.')
  }
  if (
    config?.timeoutMs !== undefined
    && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new TypeError('executionRouting.timeoutMs must be a positive finite number.')
  }
}

async function closeTraceForFailure(
  traceRuntime: TraceRuntime | undefined,
  error: unknown,
  journal?: JournalRecorder,
): Promise<void> {
  const classified = classifyRunFailure(error)
  journal?.emit({
    type: 'run/end',
    status: classified.status,
    error: classified.errorInfo,
  })
  traceRuntime?.close({
    status: classified.status,
    error: classified.errorInfo,
  })
  await journal?.flush()
}

/**
 * Record the plan a run is about to execute, whatever produced it: a
 * coordinator decomposition, an explicit task list, a frozen plan artifact, or
 * a restored queue. `plan/set` also carries the `pending` / `blocked` starting
 * states, which `task/status` never emits.
 */
function emitInitialPlanSet(
  journal: JournalRecorder | undefined,
  queue: TaskQueue,
): void {
  if (!journal) return
  journal.emit({
    type: 'plan/set',
    revision: queue.getPlanRevision(),
    source: 'initial',
    tasks: queue.list().map((task) => ({
      taskId: task.id,
      ...(task.description !== undefined ? { description: task.description } : {}),
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      ...(task.dependsOn !== undefined ? { dependsOn: task.dependsOn } : {}),
    })),
  })
}

/** Emit `run/end` and drain the journal wherever a run's trace closes. */
async function endRunJournal(
  journal: JournalRecorder | undefined,
  status: RunStatus,
  error?: StructuredTraceError,
): Promise<void> {
  if (!journal) return
  journal.emit({ type: 'run/end', status, ...(error ? { error } : {}) })
  await journal.flush()
}

function resolveRunBudgets(
  config: Pick<OrchestratorConfig, 'maxTokenBudget' | 'maxCostBudget' | 'estimateCost'>,
  options?: Pick<RunTasksOptions, 'maxTokenBudget' | 'maxCostBudget'>,
): EffectiveRunBudgets {
  const maxTokenBudget = resolveBudgetCeiling(
    options?.maxTokenBudget,
    config.maxTokenBudget,
  )
  const maxCostBudget = resolveBudgetCeiling(
    options?.maxCostBudget,
    config.maxCostBudget,
  )
  if (maxCostBudget !== undefined && config.estimateCost === undefined) {
    throw new Error('maxCostBudget requires estimateCost so cost caps cannot be silently ignored.')
  }
  return { maxTokenBudget, maxCostBudget }
}

/**
 * Top-level orchestrator for the open-multi-agent framework.
 *
 * Manages teams, coordinates task execution, and surfaces progress events.
 * Most users will interact with this class exclusively.
 */
export class OpenMultiAgent {
  private readonly config: EffectiveOrchestratorConfig

  private readonly teams: Map<string, Team> = new Map()
  private readonly hasConfiguredCustomExecutionRouter: boolean
  private readonly fallbackCheckpointStore = new InMemoryStore()
  private completedTaskCount = 0
  private readonly traceRecordObserver?: TraceRecordObserver
  private readonly traceSink?: TraceSink
  private readonly traceCapturesToolIO: boolean
  private readonly onlineEvaluator?: OnlineEvaluator
  /** Online evaluation lifecycle. A shared no-op facade is returned when disabled. */
  readonly evaluation: OnlineEvaluationLifecycle

  /**
   * @param config - Optional top-level configuration.
   *
   * Sensible defaults:
   *   - `maxConcurrency`: 5
   *   - `maxDelegationDepth`: 3
   *   - `schedulingStrategy`: `'dependency-first'`
   *   - `schedulingWeights`: `{ fit: 0.7, load: 0.3 }`
   *   - `strictAssignees`: `true`
   *   - `defaultModel`:   `'claude-opus-4-6'`
   *   - `defaultProvider`: `'anthropic'`
   */
  constructor(config: OrchestratorConfig = {}) {
    if (config.maxCostBudget !== undefined && config.estimateCost === undefined) {
      throw new Error('maxCostBudget requires estimateCost so cost caps cannot be silently ignored.')
    }
    if (config.onApproval && config.onTaskDispatch) {
      throw new Error('onApproval and onTaskDispatch are mutually exclusive approval modes.')
    }
    validateExecutionRoutingConfig(config.executionRouting)

    this.traceRecordObserver = traceRecordObserverFrom(config)
    this.hasConfiguredCustomExecutionRouter = config.executionRouter !== undefined
    this.onlineEvaluator = createOnlineEvaluator(config.evaluation, config.estimateCost)
    this.evaluation = this.onlineEvaluator ?? NOOP_ONLINE_EVALUATION
    const hasExplicitLegacyBridge = config.observability?.sinks.some(
      (sink) => sink instanceof LegacyCallbackTraceSink,
    ) ?? false
    this.traceSink = config.observability && config.observability.sinks.length > 0
      ? new CompositeSink(config.observability.sinks.map((sink) =>
          sink instanceof LegacyCallbackTraceSink
            ? sink
            : new SensitiveDataProcessor(sink, { capture: config.observability?.capture })), {
          onDiagnostic: config.observability.onDiagnostic,
          sinkName: 'OpenMultiAgent',
        })
      : undefined
    // Instrumentation only pays to serialize tool content when the policy
    // admits it. Both fields default to 'none', so the default run is
    // byte-for-byte what it was before this opt-in existed.
    this.traceCapturesToolIO = config.observability?.capture?.toolInput === 'redacted'
      || config.observability?.capture?.toolOutput === 'redacted'
    this.config = {
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      maxDelegationDepth: config.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
      schedulingStrategy: config.schedulingStrategy ?? 'dependency-first',
      schedulingWeights: config.schedulingWeights ?? {},
      strictAssignees: config.strictAssignees ?? true,
      executionRouter: config.executionRouter ?? new DeterministicRouter(),
      executionRouting: {
        strategy: config.executionRouting?.strategy ?? 'deterministic',
        confidenceThreshold: config.executionRouting?.confidenceThreshold ?? 0.7,
        failurePolicy: config.executionRouting?.failurePolicy ?? 'fallback',
        ...(config.executionRouting?.profiler !== undefined
          ? { profiler: config.executionRouting.profiler }
          : {}),
        ...(config.executionRouting?.model !== undefined
          ? { model: config.executionRouting.model }
          : {}),
        ...(config.executionRouting?.adapter !== undefined
          ? { adapter: config.executionRouting.adapter }
          : {}),
        ...(config.executionRouting?.timeoutMs !== undefined
          ? { timeoutMs: config.executionRouting.timeoutMs }
          : {}),
      },
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      defaultProvider: config.defaultProvider ?? 'anthropic',
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      egressPolicy: intersectEgressPolicies(config.egressPolicy),
      // `defaultCwd === undefined` means "use the default sandbox rooted at
      // <cwd>/.agent-workspace". An explicit `null` propagates through to
      // disable the filesystem sandbox; a string sets a custom sandbox root.
      defaultCwd: config.defaultCwd === undefined ? defaultWorkspaceDir() : config.defaultCwd,
      defaultShellExecutor: config.defaultShellExecutor,
      maxTokenBudget: config.maxTokenBudget,
      maxCostBudget: config.maxCostBudget,
      estimateCost: config.estimateCost,
      defaultToolPreset: config.defaultToolPreset,
      checkpoint: config.checkpoint,
      recovery: config.recovery,
      journal: config.journal,
      onApproval: config.onApproval,
      onTaskDispatch: config.onTaskDispatch,
      onPlanReady: config.onPlanReady,
      onAgentStream: config.onAgentStream,
      onProgress: config.onProgress,
      evaluation: config.evaluation,
      observability: config.observability,
      onTrace: config.onTrace ?? (hasExplicitLegacyBridge ? LEGACY_TRACE_METADATA_ONLY : undefined),
      onToolCall: config.onToolCall,
      requireConsequentialConfirmation: config.requireConsequentialConfirmation ?? false,
    }
  }

  private configForRun(egressPolicy?: EgressPolicy): EffectiveOrchestratorConfig {
    const effectivePolicy = intersectEgressPolicies(this.config.egressPolicy, egressPolicy)
    return {
      ...this.config,
      egressPolicy: effectivePolicy,
    }
  }

  private createScheduler(
    modelRouting?: ModelRoutingPolicy,
    tasks: () => readonly Task[] = () => [],
  ): Scheduler {
    return new Scheduler(
      this.config.schedulingStrategy,
      this.agentSelectorContext(modelRouting, tasks),
      {
        weights: this.config.schedulingWeights,
        onWarning: (warning) => {
          this.config.onProgress?.({
            type: 'warning',
            task: warning.taskId,
            data: warning,
          })
        },
      },
    )
  }

  private agentSelectorContext(
    modelRouting?: ModelRoutingPolicy,
    tasks: () => readonly Task[] = () => [],
  ): AgentSelectorContext {
    return {
      defaultProvider: this.config.defaultProvider,
      defaultToolPreset: this.config.defaultToolPreset,
      includeDelegateTool: true,
      ...(modelRouting ? {
        resolveCandidate: (task: Task, candidate: AgentConfig): AgentConfig => {
          const base = applyDefaultToolPreset(
            applyAgentDefaults(candidate, this.config),
            this.config.defaultToolPreset,
          )
          return withModelRoute(base, routeMatches(modelRouting, {
            phase: 'worker',
            agent: candidate.name,
            task,
            leaf: isLeafTask(task, tasks()),
          }))
        },
      } : {}),
    }
  }

  private resolveExecutionRoutingConfig(
    override?: ExecutionRoutingConfig,
    coordinator?: CoordinatorConfig,
  ): Required<
    Pick<
      ExecutionRoutingConfig,
      'strategy' | 'confidenceThreshold' | 'failurePolicy'
    >
  > & Omit<ExecutionRoutingConfig, 'strategy' | 'confidenceThreshold' | 'failurePolicy'> {
    const profiler = override?.profiler ?? this.config.executionRouting.profiler
    const model = override?.model ?? this.config.executionRouting.model
    const adapter = override?.adapter ?? this.config.executionRouting.adapter
    const timeoutMs =
      override?.timeoutMs
      ?? this.config.executionRouting.timeoutMs
      ?? coordinator?.callTimeoutMs
    const resolved = {
      strategy: override?.strategy ?? this.config.executionRouting.strategy ?? 'deterministic',
      confidenceThreshold:
        override?.confidenceThreshold
        ?? this.config.executionRouting.confidenceThreshold
        ?? 0.7,
      failurePolicy:
        override?.failurePolicy
        ?? this.config.executionRouting.failurePolicy
        ?? 'fallback',
      ...(profiler !== undefined ? { profiler } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(adapter !== undefined ? { adapter } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
    validateExecutionRoutingConfig(resolved)
    return resolved
  }

  private async resolveTaskProfiler(
    routingConfig: ExecutionRoutingConfig,
    coordinator?: CoordinatorConfig,
    config: EffectiveOrchestratorConfig = this.config,
  ): Promise<TaskProfiler> {
    if (routingConfig.profiler !== undefined) return routingConfig.profiler
    const configuredAdapter = routingConfig.adapter ?? coordinator?.adapter
    if (configuredAdapter !== undefined) {
      rejectUnsupportedEgress(
        config.egressPolicy,
        configuredAdapter.name,
        'custom and AI SDK adapters do not expose an enforceable request transport or target contract to OMA.',
      )
    }
    const adapter = configuredAdapter ?? (
      config.egressPolicy === undefined
        ? await createAdapter(
            config.defaultProvider,
            config.defaultApiKey,
            config.defaultBaseURL,
          )
        : await createAdapter(
            config.defaultProvider,
            config.defaultApiKey,
            config.defaultBaseURL,
            undefined,
            config.egressPolicy,
          )
    )
    return new LLMTaskProfiler({
      adapter,
      model: routingConfig.model ?? coordinator?.model ?? config.defaultModel,
    })
  }

  private async runSemanticProfiler(
    context: ReturnType<typeof buildRoutingContext>,
    routingConfig: ReturnType<OpenMultiAgent['resolveExecutionRoutingConfig']>,
    coordinator: CoordinatorConfig | undefined,
    config: EffectiveOrchestratorConfig,
    traceRuntime: TraceRuntime | undefined,
    facts: {
      readonly hasConsequentialTools: boolean
      readonly permissionBoundaryCount: number
    },
  ): Promise<SemanticProfileRun> {
    let profiler: TaskProfiler | undefined
    const startedAt = Date.now()
    const span = traceRuntime?.startSpan({
      kind: 'routing',
      name: 'profile_execution_route',
      parent: traceRuntime.root,
      attributes: {
        'oma.routing.semantic.strategy': 'hybrid',
        'oma.routing.semantic.confidence_threshold': routingConfig.confidenceThreshold,
      },
    })
    try {
      profiler = await this.resolveTaskProfiler(routingConfig, coordinator, config)
      if (typeof profiler.version !== 'string' || profiler.version.length === 0) {
        throw new TaskProfileValidationError(
          'Task profiler version must be a non-empty string.',
        )
      }
      const timeoutMs = routingConfig.timeoutMs
      let abortSignal = context.abortSignal
      let timeoutSignal: AbortSignal | undefined
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutSignal = AbortSignal.timeout(timeoutMs)
        abortSignal = abortSignal
          ? mergeAbortSignals(abortSignal, timeoutSignal)
          : timeoutSignal
      }
      const profilePromise = Promise.resolve(profiler.profile({
        goal: context.goal,
        roster: context.roster,
        ...(context.budget !== undefined ? { budget: context.budget } : {}),
        ...(abortSignal !== undefined ? { abortSignal } : {}),
      }))
      const rawResult = timeoutSignal === undefined
        ? await profilePromise
        : await Promise.race([
            profilePromise,
            new Promise<never>((_, reject) => {
              timeoutSignal!.addEventListener(
                'abort',
                () => reject(new RoutingTimeoutError(timeoutMs!, 'profiler')),
                { once: true },
              )
            }),
          ])
      const result = validateTaskProfilerResult(rawResult)
      const policy = evaluateSemanticRoutingPolicy(result.profile, {
        confidenceThreshold: routingConfig.confidenceThreshold,
        ...facts,
      })
      const assessment: SemanticRoutingAssessment = {
        profilerVersion: profiler.version,
        profile: result.profile,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.provider !== undefined ? { provider: result.provider } : {}),
        legacyMode: 'single',
        recommendation: policy.recommendation,
        outcome: 'applied',
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      }
      span?.end({
        status: statusOnly('ok'),
        attributes: {
          'oma.routing.semantic.profiler_version': profiler.version,
          'oma.routing.semantic.recommendation': policy.recommendation,
          'oma.routing.semantic.confidence': result.profile.confidence,
          ...(result.model !== undefined
            ? { 'gen_ai.request.model': result.model }
            : {}),
          ...(result.provider !== undefined
            ? { 'gen_ai.provider.name': result.provider }
            : {}),
          ...(result.usage !== undefined
            ? {
                'gen_ai.usage.input_tokens': result.usage.input_tokens,
                'gen_ai.usage.output_tokens': result.usage.output_tokens,
              }
            : {}),
          'oma.routing.semantic.duration_ms': Math.max(0, Date.now() - startedAt),
        },
      })
      return {
        assessment,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.provider !== undefined ? { provider: result.provider } : {}),
        reasons: policy.reasons,
      }
    } catch (error) {
      if (context.abortSignal?.aborted) {
        span?.end({ status: statusOnly('cancelled') })
        throw error
      }
      const fallbackCode = error instanceof RoutingTimeoutError
        ? 'profiler-timeout'
        : error instanceof TaskProfileValidationError
          ? 'invalid-profile'
          : profiler === undefined
            ? 'profiler-unavailable'
            : 'profiler-error'
      const failure = error instanceof RoutingTimeoutError
        ? error
        : new RoutingProfilerFailedError(
            'Semantic routing profiler failed to produce a valid task profile.',
            error,
          )
      const validationFailure = error instanceof TaskProfileValidationError
        ? error
        : undefined
      span?.end({
        status: statusOnly('error'),
        error: classifyRunFailure(failure).errorInfo,
        attributes: {
          'oma.routing.semantic.fallback_code': fallbackCode,
          'oma.routing.semantic.duration_ms': Math.max(0, Date.now() - startedAt),
          ...(validationFailure?.usage !== undefined
            ? {
                'gen_ai.usage.input_tokens': validationFailure.usage.input_tokens,
                'gen_ai.usage.output_tokens': validationFailure.usage.output_tokens,
              }
            : {}),
          ...(validationFailure?.model !== undefined
            ? { 'gen_ai.request.model': validationFailure.model }
            : {}),
          ...(validationFailure?.provider !== undefined
            ? { 'gen_ai.provider.name': validationFailure.provider }
            : {}),
        },
      })
      if (routingConfig.failurePolicy === 'fail') throw failure
      return {
        assessment: {
          profilerVersion: 'none',
          ...(typeof profiler?.version === 'string' && profiler.version.length > 0
            ? { requestedProfilerVersion: profiler.version }
            : {}),
          legacyMode: 'single',
          recommendation: 'single',
          outcome: 'fallback',
          fallbackCode,
          ...(validationFailure?.model !== undefined
            ? { model: validationFailure.model }
            : {}),
          ...(validationFailure?.provider !== undefined
            ? { provider: validationFailure.provider }
            : {}),
          ...(validationFailure?.usage !== undefined
            ? { usage: validationFailure.usage }
            : {}),
        },
        ...(validationFailure?.usage !== undefined
          ? { usage: validationFailure.usage }
          : {}),
        ...(validationFailure?.model !== undefined
          ? { model: validationFailure.model }
          : {}),
        ...(validationFailure?.provider !== undefined
          ? { provider: validationFailure.provider }
          : {}),
        reasons: ['Semantic profiling failed; keeping the deterministic Single route.'],
      }
    }
  }

  private beginOnlineEvaluation(input: unknown): PendingOnlineEvaluation | undefined {
    if (this.onlineEvaluator === undefined) return undefined
    return { input, startedAtMs: Date.now() }
  }

  private completeOnlineEvaluation(
    pending: PendingOnlineEvaluation | undefined,
    result: OnlineEvaluationInput['result'],
  ): void {
    if (pending === undefined || this.onlineEvaluator === undefined) return
    this.onlineEvaluator.enqueue({
      input: pending.input,
      result,
      durationMs: Date.now() - pending.startedAtMs,
    })
  }

  private startTrace(
    identity: RunIdentity,
    metadata?: RunMetadata,
    metadataOverridden = false,
  ): TraceRuntime | undefined {
    return createTraceRuntime(
      identity,
      this.config.onTrace,
      this.traceRecordObserver,
      this.traceSink,
      metadataAttributes(metadata, metadataOverridden),
      this.traceCapturesToolIO,
    )
  }

  /**
   * Resolve the journal for one run and open a recorder on it, emitting
   * `run/start`.
   *
   * Returns `undefined` when no journal is configured, which is the default:
   * every emission site guards on the recorder, so an unjournaled run
   * allocates nothing and behaves exactly as it did before.
   */
  private async startRunJournal(
    override: RunJournalConfig | false | undefined,
    identity: RunIdentity,
    mode: RunJournalMode,
    goal?: string,
    metadata?: RunMetadata,
    startSeqFloor?: number,
  ): Promise<JournalRecorder | undefined> {
    const resolved = resolveRunJournal(this.config.journal, override)
    if (!resolved) return undefined
    const recorder = await JournalRecorder.open({
      journal: resolved.journal,
      runId: identity.runId,
      attempt: identity.attempt,
      traceId: identity.traceId,
      enforceLineage: resolved.enforceLineage,
      ...(startSeqFloor !== undefined ? { startSeqFloor } : {}),
      // A journal write failure is reported and dropped, exactly like a
      // failed checkpoint save. Losing the audit trail cannot fail the run.
      onError: (error) => {
        this.config.onProgress?.({
          type: 'error',
          data: { kind: 'journal_append_failed', error },
        } satisfies OrchestratorEvent)
      },
    })
    recorder.emit({
      type: 'run/start',
      mode,
      ...(goal !== undefined ? { goal } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    })
    return recorder
  }

  /**
   * Rebuild what a journaled run knew when its snapshot was written.
   *
   * Two steps, in order: re-attach the snapshot's per-block lineage so the
   * resumed conversation can still explain itself, then fold whatever the
   * journal recorded after each in-flight entry's own watermark. The fold only
   * extends the snapshot, and a tail that does not fit it is discarded whole —
   * the snapshot remains the recovery anchor either way.
   */
  private async resumeFromJournal(
    journal: JournalRecorder,
    checkpoint: ActiveCheckpoint,
  ): Promise<void> {
    const watermarkSeq = checkpoint.journalWatermarkSeq
    if (watermarkSeq !== undefined && checkpoint.inFlightTasks.size > 0) {
      // The read window starts at the stalest entry rather than at the
      // snapshot-wide mark: entries refresh at their own task's boundaries, so
      // under concurrency one can be well behind the snapshot carrying it.
      const states = [...checkpoint.inFlightTasks.values()]
      const fold = foldJournalTail(
        states,
        await journal.readFrom(journalTailReadFrom(states, watermarkSeq)),
        watermarkSeq,
      )
      if (fold.discardReason !== undefined) {
        this.config.onProgress?.({
          type: 'warning',
          data: { code: 'JOURNAL_TAIL_DISCARDED', reason: fold.discardReason, watermarkSeq },
        } satisfies OrchestratorEvent)
      } else if (fold.foldedEvents > 0) {
        checkpoint.inFlightTasks.clear()
        for (const state of fold.tasks) checkpoint.inFlightTasks.set(state.taskId, state)
      }
    }
    restoreConversationLineage(journal, [...checkpoint.inFlightTasks.values()])
  }

  // -------------------------------------------------------------------------
  // Team management
  // -------------------------------------------------------------------------

  /**
   * Create and register a {@link Team} with the orchestrator.
   *
   * The team is stored internally so {@link getStatus} can report aggregate
   * agent counts. Returns the new {@link Team} for further configuration.
   *
   * @param name   - Unique team identifier. Throws if already registered.
   * @param config - Team configuration (agents, shared memory, concurrency).
   */
  createTeam(name: string, config: TeamConfig): Team {
    if (this.teams.has(name)) {
      throw new Error(
        `OpenMultiAgent: a team named "${name}" already exists. ` +
        `Use a unique name or call shutdown() to clear all teams.`,
      )
    }
    const team = new Team(config)
    this.teams.set(name, team)
    return team
  }

  // -------------------------------------------------------------------------
  // Single-agent convenience
  // -------------------------------------------------------------------------

  /**
   * Run a string prompt or structured message history with a one-off agent.
   *
   * Constructs a fresh agent from `config`, runs `input` in a fresh conversation,
   * and returns the result. The agent is not registered with any pool or team.
   *
   * Useful for simple one-shot queries that do not need team orchestration.
   *
   * @param config - Agent configuration.
   * @param input - A string shorthand or complete caller-owned message list.
   */
  async runAgent(
    config: AgentConfig,
    input: AgentRunInput,
    options?: RunAgentOptions,
  ): Promise<AgentRunResult> {
    const runConfig = this.configForRun(options?.egressPolicy)
    const preparedInput = prepareAgentRunInput(input, config.backend)
    const pendingEvaluation = this.beginOnlineEvaluation(
      preparedInput.structured ? copyMessages(preparedInput.messages) : input,
    )
    const { identity, metadata } = createRunFacts(options)
    const traceRuntime = this.startTrace(identity, metadata)
    const journal = await this.startRunJournal(
      options?.journal, identity, 'runAgent', undefined, metadata,
    )
    const effectiveBudget = resolveBudgetCeiling(config.maxTokenBudget, this.config.maxTokenBudget)
    const effective: AgentConfig = applyDefaultToolPreset({
      ...applyAgentDefaults(config, runConfig),
      maxTokenBudget: effectiveBudget,
    }, runConfig.defaultToolPreset)
    const consequential = hasGrantedConsequentialTool(effective)
    const confirmationState = createConsequentialConfirmationState()
    const guardedEffective = consequential && this.config.requireConsequentialConfirmation
      ? withConsequentialConfirmation(effective, confirmationState)
      : effective
    const agent = buildAgent(guardedEffective)
    this.config.onProgress?.({
      type: 'agent_start',
      agent: config.name,
      data: preparedInput.structured
        ? { messages: copyMessages(preparedInput.messages) }
        : { prompt: input },
    })

    // Build run-time options: trace + optional abort signal. RunOptions has
    // readonly fields, so we assemble the literal in one shot.
    const traceFields = this.config.onTrace
      ? {
          onTrace: this.config.onTrace,
          traceAgent: config.name,
        }
      : null
    const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
    const journalFields = journal ? { journal } : null
    const runOptions: Partial<RunOptions> | undefined =
      traceFields || abortFields
        ? {
            identity,
            runId: identity.runId,
            ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
            tracePhase: 'agent',
            ...(traceFields ?? {}),
            ...(abortFields ?? {}),
            ...(journalFields ?? {}),
          }
        : {
            identity,
            runId: identity.runId,
            ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
            tracePhase: 'agent',
            ...(journalFields ?? {}),
          }

    const result = await agent.run(
      preparedInput.structured ? preparedInput.messages : input,
      runOptions,
    )
    let finalResult = result

    if (result.budgetExceeded) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: config.name,
        data: new TokenBudgetExceededError(
          config.name,
          result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
          effectiveBudget ?? 0,
        ),
      })
    }

    if (!result.budgetExceeded && this.config.estimateCost) {
      const accounting = applyBudgetAccounting({
        currentUsage: ZERO_USAGE,
        currentCost: 0,
        usage: result.tokenUsage,
        maxCostBudget: this.config.maxCostBudget,
        estimateCost: this.config.estimateCost,
        costContext: buildCostEstimateContext({
          agentName: config.name,
          model: effective.model ?? this.config.defaultModel,
          provider: effective.provider,
          phase: 'agent',
        }),
      })
      if (accounting.exceeded instanceof CostBudgetExceededError) {
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: config.name,
          data: accounting.exceeded,
        })
        finalResult = {
          ...result,
          success: false,
          budgetExceeded: true,
          ...classifyRunFailure(accounting.exceeded),
        }
      }
    }

    const completedResult = finalizeConsequentialRun<AgentRunResult>({
      ...finalResult,
      ...(metadata !== undefined ? { metadata } : {}),
    }, consequential, confirmationState)
    this.config.onProgress?.({
      type: 'agent_complete',
      agent: config.name,
      data: completedResult,
    })

    if (completedResult.success) {
      this.completedTaskCount++
    }
    const agentStatus = completedResult.status
      ?? statusOnly(completedResult.success ? 'ok' : 'error')
    await endRunJournal(journal, agentStatus, completedResult.errorInfo)
    traceRuntime?.close({
      status: agentStatus,
      ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
    })
    this.completeOnlineEvaluation(pendingEvaluation, completedResult)
    return completedResult
  }

  // -------------------------------------------------------------------------
  // Auto-orchestrated team run (KILLER FEATURE)
  // -------------------------------------------------------------------------

  /**
   * Run a team on a high-level goal with full automatic orchestration.
   *
   * This is the flagship method of the framework. It works as follows:
   *
   * 1. A temporary "coordinator" agent receives the goal and the team's agent
   *    roster, and is asked to decompose it into an ordered list of tasks with
   *    JSON output.
   * 2. The tasks are loaded into a {@link TaskQueue}. Title-based dependency
   *    tokens in the coordinator's output are resolved to task IDs.
   * 3. The {@link Scheduler} assigns unassigned tasks to team agents.
   * 4. Tasks are executed in dependency order, with independent tasks running
   *    in parallel up to `maxConcurrency`.
   * 5. Results are persisted to shared memory after each task so subsequent
   *    agents can read them.
   * 6. The coordinator synthesises a final answer from all task outputs.
   * 7. A {@link TeamRunResult} is returned.
   *
   * @param team - A team created via {@link createTeam} (or `new Team(...)`).
   * @param goal - High-level natural-language goal for the team.
   */
  async runTeam(
    team: Team,
    goal: string,
    options?: RunTeamOptions,
  ): Promise<TeamRunResult> {
    const runConfig = this.configForRun(options?.egressPolicy)
    const pendingEvaluation = this.beginOnlineEvaluation(goal)
    const agentConfigs = team.getAgents()
    const budgets = resolveRunBudgets(runConfig, options)
    const explicitMode = options?.mode
    if (explicitMode === 'single' && options?.planOnly) {
      throw new Error("runTeam mode 'single' cannot be combined with planOnly.")
    }
    const preferredBudgetDegraded = explicitMode === undefined
      && !options?.planOnly
      && options?.governanceIntent === 'preferred'
      && options.preferredUnderBudget === 'degrade'
      && (budgets.maxTokenBudget !== undefined || budgets.maxCostBudget !== undefined)
    // Always validate declared role names/order, even when an explicit mode
    // selects a different execution topology.
    const declaredGovernanceTaskSpecs = buildGovernanceTaskSpecs(goal, agentConfigs, options)
    const governanceTaskSpecs = explicitMode === undefined && !preferredBudgetDegraded
      ? declaredGovernanceTaskSpecs
      : undefined
    if (
      explicitMode === undefined
      && options?.governanceIntent === 'required'
      && declaredGovernanceTaskSpecs === undefined
    ) {
      throw new Error('Invariant violation: required runTeam governance must use an explicit task topology.')
    }
    if (governanceTaskSpecs !== undefined) {
      const queue = new TaskQueue()
      loadSpecsIntoQueue(governanceTaskSpecs, agentConfigs, queue)
      if (options?.planOnly) {
        const { identity, metadata } = createRunFacts(identityOptionsForRun(options))
        const traceRuntime = this.startTrace(identity, metadata)
        const journal = await this.startRunJournal(
          options.journal, identity, 'runTeam', goal, metadata,
        )
        emitInitialPlanSet(journal, queue)
        const routingDecision = recordRoutingDecision(identity, traceRuntime, {
          source: 'declared',
          mode: 'team',
          reasons: ['Structured governance roles declared the execution topology.'],
        })
        const result = {
          ...this.buildPlanOnlyTeamRunResult(new Map(), identity, goal, queue),
          routingDecision,
          ...(metadata !== undefined ? { metadata } : {}),
        }
        const planOnlyStatus = result.status ?? statusOnly('ok')
        await endRunJournal(journal, planOnlyStatus)
        traceRuntime?.close({ status: planOnlyStatus })
        this.completeOnlineEvaluation(pendingEvaluation, result)
        return result
      }
      return this.executeExplicitTaskQueue(
        team,
        queue,
        options,
        goal,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        pendingEvaluation,
        options,
        {
          source: 'declared',
          mode: 'team',
          reasons: ['Structured governance roles declared the execution topology.'],
        },
        'runTeam',
      )
    }

    const executionRouting = this.resolveExecutionRoutingConfig(
      options?.executionRouting,
      options?.coordinator,
    )
    const { identity, metadata } = createRunFacts(identityOptionsForRun(options))
    const traceRuntime = this.startTrace(identity, metadata)
    const journal = await this.startRunJournal(
      options?.journal, identity, 'runTeam', goal, metadata,
    )
    const routingContext = buildRoutingContext(
      goal,
      agentConfigs,
      this.config.defaultModel,
      budgets,
      options?.abortSignal,
    )
    let routerDecision: ExecutionRoutingDecision | undefined
    try {
      routerDecision = explicitMode === undefined
        && !options?.planOnly
        && !preferredBudgetDegraded
        ? await resolveExecutionRouting(
            options?.executionRouter ?? this.config.executionRouter,
            routingContext,
            new DeterministicRouter(),
            {
              timeoutMs: executionRouting.timeoutMs,
              failurePolicy: executionRouting.failurePolicy,
            },
          )
        : undefined
    } catch (error) {
      await closeTraceForFailure(traceRuntime, error, journal)
      throw error
    }
    let semanticProfileRun: SemanticProfileRun | undefined
    const customRouterSelected = options?.executionRouter !== undefined
      || this.hasConfiguredCustomExecutionRouter
    const shouldProfile = executionRouting.strategy === 'hybrid'
      && routerDecision?.mode === 'single'
      && !options?.abortSignal?.aborted
      && (!customRouterSelected || routerDecision.status === 'fallback')
    if (shouldProfile) {
      const deterministicSingleDecision = routerDecision!
      const effectiveAgents = agentConfigs.map((agentConfig) =>
        applyDefaultToolPreset(
          applyAgentDefaults(agentConfig, runConfig),
          runConfig.defaultToolPreset,
        ))
      try {
        semanticProfileRun = await this.runSemanticProfiler(
          routingContext,
          executionRouting,
          options?.coordinator,
          runConfig,
          traceRuntime,
          {
            hasConsequentialTools: effectiveAgents.some((agentConfig) =>
              hasGrantedConsequentialTool(agentConfig, { includeDelegateTool: true })),
            permissionBoundaryCount: new Set(
              effectiveAgents
                .map((agentConfig) => agentConfig.permissionBoundary)
                .filter((boundary): boundary is string =>
                  typeof boundary === 'string' && boundary.length > 0),
            ).size,
          },
        )
      } catch (error) {
        await closeTraceForFailure(traceRuntime, error, journal)
        throw error
      }
      if (semanticProfileRun.assessment.recommendation === 'team') {
        routerDecision = {
          ...deterministicSingleDecision,
          mode: 'team',
          confidence: semanticProfileRun.assessment.profile?.confidence,
          reasons: [...deterministicSingleDecision.reasons, ...semanticProfileRun.reasons],
          routerVersion: HYBRID_ROUTER_VERSION,
        }
      }
    }
    let routingDecisionInput: RoutingDecisionRecordInput = explicitMode !== undefined
      ? {
          source: 'override',
          mode: explicitMode,
          reasons: [
            options?.governanceIntent !== undefined
              ? `Caller mode '${explicitMode}' overrode the declared governance topology.`
              : `Caller explicitly selected mode '${explicitMode}'.`,
          ],
        }
      : preferredBudgetDegraded
        ? {
            source: 'policy',
            mode: 'single',
            reasons: ['preferredUnderBudget policy degraded the preferred governance topology under a configured budget.'],
          }
        : options?.planOnly
          ? {
              source: 'policy',
              mode: 'team',
              reasons: ['planOnly policy requires coordinator planning without task execution.'],
            }
          : {
              source: 'router',
              mode: routerDecision!.mode,
              reasons: routerDecision!.reasons,
              routerVersion: routerDecision!.routerVersion,
              ...(routerDecision!.status !== undefined
                ? { status: routerDecision!.status }
                : {}),
              ...(routerDecision!.requestedRouterVersion !== undefined
                ? { requestedRouterVersion: routerDecision!.requestedRouterVersion }
                : {}),
              ...(routerDecision!.fallbackCode !== undefined
                ? { fallbackCode: routerDecision!.fallbackCode }
                : {}),
              ...(routerDecision!.confidence !== undefined
                ? { confidence: routerDecision!.confidence }
                : {}),
              ...(semanticProfileRun !== undefined
                ? { semanticRoutingAssessment: semanticProfileRun.assessment }
                : {}),
            }
    const routingBudget = semanticProfileRun?.usage !== undefined
      ? applyBudgetAccounting({
          currentUsage: ZERO_USAGE,
          currentCost: 0,
          usage: semanticProfileRun.usage,
          maxTokenBudget: budgets.maxTokenBudget,
          maxCostBudget: budgets.maxCostBudget,
          estimateCost: this.config.estimateCost,
          costContext: buildCostEstimateContext({
            agentName: 'semantic-router',
            model:
              semanticProfileRun.model
              ?? executionRouting.model
              ?? options?.coordinator?.model
              ?? this.config.defaultModel,
            phase: 'routing',
          }),
        })
      : undefined
    const routingUsage = routingBudget?.cumulativeUsage ?? ZERO_USAGE
    const routingCost = routingBudget?.cumulativeCost ?? 0
    if (
      semanticProfileRun !== undefined
      && routingBudget !== undefined
      && this.config.estimateCost !== undefined
    ) {
      semanticProfileRun = {
        ...semanticProfileRun,
        assessment: {
          ...semanticProfileRun.assessment,
          estimatedCost: routingCost,
        },
      }
      routingDecisionInput = {
        ...routingDecisionInput,
        semanticRoutingAssessment: semanticProfileRun.assessment,
      }
    }
    if (
      semanticProfileRun !== undefined
      && semanticProfileRun.assessment.recommendation !== 'needs-declaration'
      && routingBudget?.exceeded === undefined
    ) {
      semanticProfileRun = {
        ...semanticProfileRun,
        assessment: {
          ...semanticProfileRun.assessment,
          actualMode: routerDecision!.mode,
        },
      }
      routingDecisionInput = {
        ...routingDecisionInput,
        semanticRoutingAssessment: semanticProfileRun.assessment,
      }
    }
    const routingDecision = recordRoutingDecision(identity, traceRuntime, routingDecisionInput)
    if (semanticProfileRun?.assessment.recommendation === 'needs-declaration') {
      const error = new RoutingDeclarationRequiredError(
        semanticProfileRun.reasons,
        semanticProfileRun.assessment,
      )
      const declarationErrorInfo = classifyRunFailure(error).errorInfo
      await endRunJournal(journal, statusOnly('error'), declarationErrorInfo)
      traceRuntime?.close({
        status: statusOnly('error'),
        error: declarationErrorInfo,
      })
      throw error
    }
    const undeclared = options?.governanceIntent === undefined
    const confirmationState = createConsequentialConfirmationState()
    let consequentialUndeclared = undeclared && agentConfigs.some((agentConfig) => {
      const effective = applyDefaultToolPreset(
        applyAgentDefaults(agentConfig, runConfig),
        runConfig.defaultToolPreset,
      )
      return hasGrantedConsequentialTool(effective, { includeDelegateTool: true })
    })

    const finish = async (result: TeamRunResult): Promise<TeamRunResult> => {
      const resultWithRouting = {
        ...result,
        routingDecision,
        ...(semanticProfileRun !== undefined
          ? {
              semanticRoutingAssessment: semanticProfileRun.assessment,
              totalTokenUsage: addUsage(result.totalTokenUsage, routingUsage),
              ...(result.metrics !== undefined
                ? {
                    metrics: {
                      ...result.metrics,
                      totalTokens: addUsage(result.metrics.totalTokens, routingUsage),
                    },
                  }
                : {}),
            }
          : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      }
      const governedResult = finalizeGovernanceRun(
        resultWithRouting,
        options,
        buildExecutionReceipt(resultWithRouting),
        {
          modeOverride: explicitMode !== undefined,
          preferredBudgetDegraded,
        },
      )
      const completedResult = finalizeConsequentialRun<TeamRunResult>(
        governedResult,
        consequentialUndeclared,
        confirmationState,
      )
      const teamStatus = completedResult.status
        ?? statusOnly(completedResult.success ? 'ok' : 'error')
      await endRunJournal(journal, teamStatus, completedResult.errorInfo)
      traceRuntime?.close({
        status: teamStatus,
        ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
      })
      this.completeOnlineEvaluation(pendingEvaluation, completedResult)
      return completedResult
    }
    const coordinatorOverrides = options?.coordinator

    if (routingBudget?.exceeded !== undefined) {
      emitBudgetExceeded(this.config, routingBudget.exceeded, 'semantic-router')
      const classified = classifyRunFailure(routingBudget.exceeded)
      return finish(this.buildTeamRunResult(
        new Map(),
        identity,
        goal,
        [],
        classified.status,
        classified.errorInfo,
      ))
    }

    // ------------------------------------------------------------------
    // Short-circuit: skip coordinator for simple, single-action goals.
    //
    // When the router selects Single, dispatching to one agent is faster and cheaper
    // than spinning up a coordinator for decomposition + synthesis.
    //
    // The best-matching agent is selected via keyword affinity scoring
    // (same algorithm as the `capability-match` scheduler strategy).
    // ------------------------------------------------------------------
    if (
      !options?.planOnly
      && agentConfigs.length > 0
      && (
        explicitMode === 'single'
        || preferredBudgetDegraded
        || routingDecision.mode === 'single'
      )
    ) {
      const bestAgent = selectBestAgent(goal, agentConfigs)

      // Use buildAgent() + agent.run() directly instead of this.runAgent()
      // to avoid duplicate progress events and double completedTaskCount.
      // Events are emitted here; counting is handled by buildTeamRunResult().
      const effectiveBudget = resolveBudgetCeiling(
        bestAgent.maxTokenBudget,
        budgets.maxTokenBudget,
      )
      const effective: AgentConfig = withModelRoute(applyDefaultToolPreset({
        ...applyAgentDefaults(bestAgent, runConfig),
        maxTokenBudget: effectiveBudget,
      }, runConfig.defaultToolPreset), routeMatches(options?.modelRouting, { phase: 'short-circuit', agent: bestAgent.name }))
      const selectedConsequential = undeclared
        && hasGrantedConsequentialTool(effective)
      const guardedEffective = selectedConsequential
        && this.config.requireConsequentialConfirmation
        ? withConsequentialConfirmation(effective, confirmationState)
        : effective
      const agent = buildAgent(guardedEffective)

      this.config.onProgress?.({
        type: 'agent_start',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', goal },
      })

      const traceFields = this.config.onTrace
        ? { onTrace: this.config.onTrace, traceAgent: bestAgent.name }
        : null
      const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
      const journalFields = journal ? { journal } : null
      const runOptions: Partial<RunOptions> | undefined =
        traceFields || abortFields
          ? {
              identity,
              runId: identity.runId,
              ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
              tracePhase: 'short-circuit',
              ...(traceFields ?? {}),
              ...(abortFields ?? {}),
              ...(journalFields ?? {}),
            }
          : {
              identity,
              runId: identity.runId,
              ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
              tracePhase: 'short-circuit',
              ...(journalFields ?? {}),
            }

      const scStartMs = Date.now()
      const result = await agent.run(goal, runOptions)
      const scEndMs = Date.now()
      let finalResult = result

      if (result.budgetExceeded) {
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: bestAgent.name,
          data: new TokenBudgetExceededError(
            bestAgent.name,
            result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
            effectiveBudget ?? 0,
          ),
        })
      }

      if (!result.budgetExceeded) {
        const accounting = applyBudgetAccounting({
          currentUsage: routingUsage,
          currentCost: routingCost,
          usage: result.tokenUsage,
          maxTokenBudget: budgets.maxTokenBudget,
          maxCostBudget: budgets.maxCostBudget,
          estimateCost: this.config.estimateCost,
          costContext: buildCostEstimateContext({
            agentName: bestAgent.name,
            model: effective.model ?? this.config.defaultModel,
            provider: effective.provider,
            phase: 'short-circuit',
          }),
        })
        if (accounting.exceeded !== undefined) {
          this.config.onProgress?.({
            type: 'budget_exceeded',
            agent: bestAgent.name,
            data: accounting.exceeded,
          })
          finalResult = {
            ...result,
            success: false,
            budgetExceeded: true,
            ...classifyRunFailure(accounting.exceeded),
          }
        }
      }

      finalResult = finalizeConsequentialRun(
        finalResult,
        selectedConsequential,
        confirmationState,
      )

      this.config.onProgress?.({
        type: 'agent_complete',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', result: finalResult },
      })

      const agentResults = new Map<string, AgentRunResult>()
      agentResults.set(bestAgent.name, finalResult)


      const tasks: readonly TaskExecutionRecord[] = [{
        id: 'short-circuit',
        title: `Short-circuit: ${bestAgent.name}`,
        assignee: bestAgent.name,
        status: finalResult.success ? 'completed' : 'failed',
        dependsOn: [],
        metrics: {
          startMs: scStartMs,
          endMs: scEndMs,
          durationMs: Math.max(0, scEndMs - scStartMs),
          tokenUsage: finalResult.tokenUsage,
          toolCalls: finalResult.toolCalls,
          retries: 0,
        },
      }]
      return finish(this.buildTeamRunResult(agentResults, identity, goal, tasks))
    }

    // ------------------------------------------------------------------
    // Step 1: Coordinator decomposes goal into tasks
    // ------------------------------------------------------------------
    const unguardedCoordinatorBaseConfig = buildCoordinatorBaseConfig(
      runConfig,
      coordinatorOverrides,
      agentConfigs,
      (options?.verifyJudges?.length ?? 0) > 0,
    )
    const coordinatorConsequential = undeclared
      && hasGrantedConsequentialTool(unguardedCoordinatorBaseConfig)
    if (coordinatorConsequential) consequentialUndeclared = true
    const coordinatorBaseConfig = coordinatorConsequential
      && this.config.requireConsequentialConfirmation
      ? withConsequentialConfirmation(unguardedCoordinatorBaseConfig, confirmationState)
      : unguardedCoordinatorBaseConfig
    const coordinatorConfig = withModelRoute(
      coordinatorBaseConfig,
      routeMatches(options?.modelRouting, { phase: 'coordinator', agent: 'coordinator' }),
    )

    const decompositionPrompt = buildDecompositionPrompt(goal, agentConfigs)
    const coordinatorAgent = buildAgent({
      ...coordinatorConfig,
      outputSchema: buildCoordinatorTaskSpecsSchema(agentConfigs, this.config.strictAssignees),
    })
    const runId = identity.runId
    const coordinatorDecomposeSpanId = this.config.onTrace ? generateSpanId() : undefined

    this.config.onProgress?.({
      type: 'agent_start',
      agent: 'coordinator',
      data: { phase: 'decomposition', goal },
    })

    const decompTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? {
          identity,
          ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
          tracePhase: 'decomposition',
          onTrace: this.config.onTrace,
          runId,
          traceAgent: 'coordinator',
          ...(coordinatorDecomposeSpanId ? { traceSpanId: coordinatorDecomposeSpanId } : {}),
          ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
          ...(journal ? { journal } : {}),
        }
      : {
          identity,
          runId,
          ...(traceRuntime ? { traceRuntime, traceSpan: traceRuntime.root } : {}),
          tracePhase: 'decomposition',
          ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
          ...(journal ? { journal } : {}),
        }
    const decompositionResult = await coordinatorAgent.run(decompositionPrompt, decompTraceOptions)
    const agentResults = new Map<string, AgentRunResult>()
    agentResults.set('coordinator:decompose', decompositionResult)
    const { maxTokenBudget, maxCostBudget } = budgets
    const decompositionBudget = applyBudgetAccounting({
      currentUsage: routingUsage,
      currentCost: routingCost,
      usage: decompositionResult.tokenUsage,
      maxTokenBudget,
      maxCostBudget,
      estimateCost: this.config.estimateCost,
      costContext: buildCostEstimateContext({
        agentName: 'coordinator',
        model: coordinatorConfig.model ?? this.config.defaultModel,
        provider: coordinatorConfig.provider,
        phase: 'coordinator',
      }),
    })
    let cumulativeUsage = decompositionBudget.cumulativeUsage
    let cumulativeCost = decompositionBudget.cumulativeCost

    if (decompositionBudget.exceeded) {
      emitBudgetExceeded(this.config, decompositionBudget.exceeded, 'coordinator')
      const classified = classifyRunFailure(decompositionBudget.exceeded)
      return finish(this.buildTeamRunResult(
        agentResults, identity, goal, [], classified.status, classified.errorInfo,
      ))
    }

    // ------------------------------------------------------------------
    // Step 2: Parse tasks from coordinator output
    // ------------------------------------------------------------------
    if (!decompositionResult.success && decompositionResult.errorInfo?.kind !== 'validation') {
      this.config.onProgress?.({
        type: 'agent_complete',
        agent: 'coordinator',
        data: decompositionResult,
      })
      this.config.onProgress?.({
        type: 'error',
        data: {
          code: 'COORDINATOR_DECOMPOSITION_FAILED',
          error: decompositionResult.errorInfo,
        },
      })
      return finish(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        [],
        decompositionResult.status ?? statusOnly('error'),
        decompositionResult.errorInfo,
      ))
    }

    const taskSpecs = decompositionResult.success && Array.isArray(decompositionResult.structured)
      ? decompositionResult.structured as ParsedTaskSpec[]
      : null

    const queue = new TaskQueue()
    const scheduler = this.createScheduler(options?.modelRouting, () => queue.list())
    const taskMetrics = new Map<string, TaskExecutionMetrics>()

    if (taskSpecs && taskSpecs.length > 0) {
      const invalidAssignees = findInvalidAssignees(taskSpecs, agentConfigs)
      if (invalidAssignees.length > 0 && this.config.strictAssignees) {
        const error = Object.assign(
          new Error(
            `Coordinator plan contains invalid assignees: ${invalidAssignees
              .map((issue) => `"${issue.assignee}" for "${issue.taskTitle}"`)
              .join(', ')}.`,
          ),
          { code: 'INVALID_ASSIGNEE' },
        )
        const classified = classifyRunFailure(error, { kind: 'validation' })
        this.config.onProgress?.({
          type: 'agent_complete',
          agent: 'coordinator',
          data: decompositionResult,
        })
        this.config.onProgress?.({
          type: 'error',
          data: {
            code: 'INVALID_ASSIGNEE',
            issues: invalidAssignees,
            error: classified.errorInfo,
          },
        })
        return finish(this.buildTeamRunResult(
          agentResults,
          identity,
          goal,
          [],
          classified.status,
          classified.errorInfo,
        ))
      }
      for (const issue of invalidAssignees) {
        this.config.onProgress?.({
          type: 'warning',
          task: issue.taskTitle,
          data: {
            code: 'INVALID_ASSIGNEE',
            assignee: issue.assignee,
            taskTitle: issue.taskTitle,
            fallback: 'clear-and-schedule',
          },
        })
      }
      // Map title-based dependsOn references to real task IDs and reject an
      // invalid coordinator DAG before any task can be dispatched or the
      // coordinator can synthesise an answer from incomplete work.
      try {
        loadSpecsIntoQueue(taskSpecs, agentConfigs, queue, options?.verifyJudges)
      } catch (error) {
        const classified = classifyRunFailure(error, { kind: 'validation' })
        this.config.onProgress?.({
          type: 'agent_complete',
          agent: 'coordinator',
          data: decompositionResult,
        })
        this.config.onProgress?.({
          type: 'error',
          data: {
            code: 'INVALID_TASK_DEPENDENCIES',
            error: classified.errorInfo,
          },
        })
        return finish(this.buildTeamRunResult(
          agentResults,
          identity,
          goal,
          [],
          classified.status,
          classified.errorInfo,
        ))
      }
    } else {
      // A coordinator plan is an execution boundary. Do not turn an invalid
      // plan into a different topology: that could duplicate side effects.
      const error = Object.assign(
        new Error('Coordinator plan failed structured validation after repair.'),
        { code: 'COORDINATOR_PLAN_INVALID' },
      )
      const classified = classifyRunFailure(error, { kind: 'validation' })
      this.config.onProgress?.({
        type: 'agent_complete',
        agent: 'coordinator',
        data: decompositionResult,
      })
      this.config.onProgress?.({
        type: 'error',
        data: {
          code: 'COORDINATOR_PLAN_INVALID',
          error: classified.errorInfo,
        },
      })
      return finish(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        [],
        classified.status,
        classified.errorInfo,
      ))
    }

    emitInitialPlanSet(journal, queue)

    const requirementIssues = validateTaskRequirements(
      queue.list(),
      agentConfigs,
      this.agentSelectorContext(options?.modelRouting, () => queue.list()),
    )
    if (requirementIssues.length > 0) {
      const error = new InvalidTaskRequirementsError(requirementIssues)
      const classified = classifyRunFailure(error, { kind: 'validation' })
      this.config.onProgress?.({
        type: 'error',
        data: {
          code: error.code,
          issues: requirementIssues,
          error: classified.errorInfo,
        },
      })
      return finish(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        [],
        classified.status,
        classified.errorInfo,
      ))
    }

    // ------------------------------------------------------------------
    // Step 3: Auto-assign any unassigned tasks
    // ------------------------------------------------------------------
    if (this.config.onApproval || this.config.onPlanReady || options?.planOnly) {
      scheduler.autoAssign(queue, agentConfigs)
    }

    // ------------------------------------------------------------------
    // Step 4: Build pool and execute
    // ------------------------------------------------------------------
    const pool = this.buildPool(
      agentConfigs,
      undeclared && this.config.requireConsequentialConfirmation
        ? confirmationState
        : undefined,
      runConfig,
    )
    const activeCheckpoint = this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint,
      'runTeam',
      goal,
    )
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: runConfig,
      ...(activeCheckpoint ? { checkpoint: activeCheckpoint } : {}),
      ...(journal ? { journal } : {}),
      runId,
      identity,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(traceRuntime ? { traceRuntime } : {}),
      taskSpans: new Map(),
      abortSignal: options?.abortSignal,
      cumulativeUsage,
      cumulativeCost,
      maxTokenBudget,
      maxCostBudget,
      estimateCost: this.config.estimateCost,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics,
      ...(options?.revealCoordinator
        ? {
            revealCoordinatorContext: {
              goal,
              rosterNames: agentConfigs.map((a) => a.name),
            },
          }
        : {}),
      modelRouting: options?.modelRouting,
      taskById: new Map(queue.list().map((task) => [task.id, task])),
      taskLeafById: new Map(queue.list().map((task) => [task.id, isLeafTask(task, queue.list())])),
      recovery: resolveRecoveryOptions(this.config.recovery, options?.recovery),
      recoveryPatchSignatures: new Set(),
    }

    const planTasks = queue.list()
    const planSpan = traceRuntime?.startSpan({
      kind: 'plan',
      name: 'prepare_plan',
      parent: traceRuntime.root,
      attributes: { 'oma.plan.task_count': planTasks.length },
    })
    const planReadyStartMs = planSpan?.startUnixMs ?? Date.now()
    let planDecision: { readonly action: 'allow' | 'deny' | 'suspend'; readonly reason?: string } = {
      action: 'allow',
    }
    let planApprovalError: unknown
    if (this.config.onPlanReady) {
      try {
        planDecision = normalizeApprovalDecision(
          await this.config.onPlanReady(planTasks),
          'onPlanReady',
        )
        if (planDecision.action === 'suspend') {
          assertDurableTaskApprovalSupport(planTasks)
          const request = createApprovalRequest({
            runId: identity.runId,
            scope: 'plan',
            boundary: 'coordinator-plan',
            content: {
              kind: 'plan',
              continuation: options?.planOnly ? 'plan_only' : 'execute',
              tasks: queue.snapshot().tasks,
            },
            ...(planDecision.reason !== undefined ? { reason: planDecision.reason } : {}),
          })
          await persistPendingApproval(queue, ctx, request)
          ctx.outcomeStatus = statusOnly('suspended', 'Plan approval pending.')
        }
      } catch (error) {
        planDecision = { action: 'deny' }
        planApprovalError = error
      }
    }
    if (
      planDecision.action === 'allow'
      && this.config.onPlanReady
      && consequentialUndeclared
      && this.config.requireConsequentialConfirmation
    ) {
      confirmationState.planApproved = true
    }
    const planReadyEndMs = Date.now()
    const planLegacyEvent = this.config.onTrace ? {
        type: 'plan_ready',
        runId: runId ?? '',
        spanId: generateSpanId(),
        ...(coordinatorDecomposeSpanId ? { parentId: coordinatorDecomposeSpanId } : {}),
        agent: 'coordinator',
        taskCount: planTasks.length,
        approved: planDecision.action === 'allow',
        startMs: planReadyStartMs,
        endMs: planReadyEndMs,
        durationMs: planReadyEndMs - planReadyStartMs,
      } as const : undefined
    if (planSpan) {
      const planStatus = planApprovalError !== undefined
        ? classifyRunFailure(planApprovalError, { kind: 'callback' })
        : undefined
      planSpan.end({
        status: planStatus?.status ?? statusOnly(
          planDecision.action === 'allow'
            ? 'ok'
            : planDecision.action === 'suspend'
              ? 'suspended'
              : 'rejected',
        ),
        ...(planStatus ? { error: planStatus.errorInfo } : {}),
        attributes: {
          'oma.plan.approved': planDecision.action === 'allow',
          'oma.approval.decision': planDecision.action,
        },
        ...(planLegacyEvent ? { legacyEvent: planLegacyEvent } : {}),
      })
    } else if (planLegacyEvent) {
      emitTrace(this.config.onTrace, planLegacyEvent)
    }
    if (planDecision.action === 'suspend') {
      const suspended = this.buildPlanOnlyTeamRunResult(agentResults, identity, goal, queue)
      return finish(this.withCheckpointApprovals({
        ...suspended,
        success: false,
        status: statusOnly('suspended', 'Plan approval pending.'),
        planOnly: undefined,
      }, activeCheckpoint))
    }
    if (planDecision.action === 'deny') {
      if (planApprovalError !== undefined) {
        const classified = classifyRunFailure(planApprovalError, { kind: 'callback' })
        return finish(this.buildTeamRunResult(
          agentResults, identity, goal, [], classified.status, classified.errorInfo,
        ))
      }
      return finish(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        [],
        statusOnly('rejected', 'Plan approval rejected.'),
      ))
    }

    if (options?.planOnly) {
      this.config.onProgress?.({
        type: 'agent_complete',
        agent: 'coordinator',
        data: decompositionResult,
      })
      return finish(this.buildPlanOnlyTeamRunResult(agentResults, identity, goal, queue))
    }

    await executeQueue(queue, ctx)
    if (queue.list().every((task) => task.status === 'completed')) {
      await saveRunCheckpoint(queue, ctx)
    }
    cumulativeUsage = ctx.cumulativeUsage
    cumulativeCost = ctx.cumulativeCost
    const taskRecords: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      description: task.description,
      memoryScope: task.memoryScope,
      dependencyPayload: task.dependencyPayload,
      role: task.role,
      priority: task.priority,
      metadata: task.metadata,
      requires: task.requires,
      maxRetries: task.maxRetries,
      retryDelayMs: task.retryDelayMs,
      retryBackoff: task.retryBackoff,
      verify: task.verify,
      supersededByRevision: task.supersededByRevision,
      recoveredByRevision: task.recoveredByRevision,
      metrics: taskMetrics.get(task.id),
    }))

    if (ctx.outcomeStatus?.code === 'suspended') {
      return finish(this.withCheckpointApprovals(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        taskRecords,
        ctx.outcomeStatus,
        ctx.outcomeErrorInfo,
      ), activeCheckpoint))
    }

    // ------------------------------------------------------------------
    // Step 5: Coordinator synthesises final result
    // ------------------------------------------------------------------
    const synthesis = await runCoordinatorSynthesis(runConfig, team, queue, goal, coordinatorBaseConfig, {
      identity,
      modelRouting: options?.modelRouting,
      runId,
      abortSignal: options?.abortSignal,
      cumulativeUsage,
      cumulativeCost,
      maxTokenBudget,
      maxCostBudget,
      estimateCost: this.config.estimateCost,
      ...(traceRuntime ? { traceRuntime, consumedTaskSpans: [...ctx.taskSpans.values()] } : {}),
      ...(journal ? { journal } : {}),
    })
    if (synthesis === null) {
      // Aborted or already over budget — return raw task outputs, no synthesis.
      if (options?.abortSignal?.aborted && ctx.outcomeStatus === undefined) {
        const abortError = new Error('Run cancelled by caller.')
        abortError.name = 'AbortError'
        const classified = classifyRunFailure(abortError)
        ctx.outcomeStatus = classified.status
        ctx.outcomeErrorInfo = classified.errorInfo
      }
      return finish(this.withCheckpointApprovals(this.buildTeamRunResult(
        agentResults,
        identity,
        goal,
        taskRecords,
        ctx.outcomeStatus,
        ctx.outcomeErrorInfo,
        false,
        queue.getPlanRevisions(),
      ), activeCheckpoint))
    }
    agentResults.set('coordinator', synthesis.result)
    cumulativeUsage = synthesis.cumulativeUsage
    cumulativeCost = synthesis.cumulativeCost

    // Note: coordinator decompose and synthesis are internal meta-steps.
    // Only actual user tasks (non-coordinator keys) are counted in
    // buildTeamRunResult, so we do not increment completedTaskCount here.

    return finish(this.withCheckpointApprovals(this.buildTeamRunResult(
      agentResults,
      identity,
      goal,
      taskRecords,
      ctx.outcomeStatus,
      ctx.outcomeErrorInfo,
      false,
      queue.getPlanRevisions(),
    ), activeCheckpoint))
  }

  // -------------------------------------------------------------------------
  // Explicit-task and plan replay team runs
  // -------------------------------------------------------------------------

  /**
   * Convert a plan-only {@link TeamRunResult} into a serializable plan artifact.
   *
   * The input must come from `runTeam(team, goal, { planOnly: true })` on a
   * version that records task descriptions. Executed run results are rejected
   * because their task records are not a replay contract.
   */
  createPlanArtifact(result: TeamRunResult): PlanArtifact {
    if (result.planOnly !== true || !result.tasks) {
      throw new Error('createPlanArtifact requires a plan-only TeamRunResult.')
    }

    return {
      version: 1,
      ...(result.goal !== undefined ? { goal: result.goal } : {}),
      tasks: result.tasks.map((task): PlanTaskArtifact => {
        if (!task.description) {
          throw new Error(`Plan task "${task.id}" is missing a description and cannot be replayed.`)
        }
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
          ...(task.dependsOn.length > 0 ? { dependsOn: task.dependsOn } : {}),
          ...(task.memoryScope !== undefined ? { memoryScope: task.memoryScope } : {}),
          ...(task.dependencyPayload !== undefined
            ? { dependencyPayload: task.dependencyPayload }
            : {}),
          ...(task.role !== undefined ? { role: task.role } : {}),
          ...(task.priority !== undefined ? { priority: task.priority } : {}),
          ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
          ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
          ...(task.retryDelayMs !== undefined ? { retryDelayMs: task.retryDelayMs } : {}),
          ...(task.retryBackoff !== undefined ? { retryBackoff: task.retryBackoff } : {}),
          ...(task.requires !== undefined ? { requires: task.requires } : {}),
        }
      }),
    }
  }

  /**
   * Replay a persisted plan artifact without invoking the coordinator.
   *
   * Task IDs, dependencies, assignees, titles, and descriptions are used exactly
   * as stored in the artifact. This is intentionally execution-only; it does not
   * synthesize a coordinator final answer. Durable checkpoints are available
   * through the same opt-in `checkpoint` option used by `runTasks`.
   */
  async runFromPlan(
    team: Team,
    plan: PlanArtifact,
    options?: RunTasksOptions,
  ): Promise<TeamRunResult> {
    const pendingEvaluation = this.beginOnlineEvaluation(plan)
    if (resolveRecoveryOptions(this.config.recovery, options?.recovery).mode !== 'fixed') {
      throw new Error('runFromPlan requires fixed recovery so the frozen plan remains exact.')
    }
    if (plan.version !== 1) {
      throw new Error(`Unsupported plan artifact version: ${String(plan.version)}`)
    }

    const queue = new TaskQueue()
    const tasks = this.tasksFromPlan(plan)
    const validation = validateTaskDependencies(tasks)
    if (!validation.valid) {
      throw new Error(`Invalid plan artifact: ${validation.errors.join(' ')}`)
    }
    queue.addBatch(tasks)
    const activeCheckpoint = this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint,
      'runFromPlan',
      plan.goal,
    )

    return this.executeExplicitTaskQueue(
      team,
      queue,
      options,
      plan.goal,
      undefined,
      activeCheckpoint,
      undefined,
      undefined,
      undefined,
      pendingEvaluation,
      undefined,
      undefined,
      'runFromPlan',
    )
  }

  /**
   * Resume a checkpointed run, or start a fresh one when no checkpoint exists.
   *
   * Loads the latest checkpoint from the configured {@link MemoryStore}, rebuilds
   * the task queue and shared memory, skips already-completed tasks, and runs the
   * remainder. When no checkpoint is found the call falls back to a normal run of
   * the provided tasks/plan (or a no-op when neither is given).
   *
   * A resumed `runTeam` run re-runs the coordinator synthesis so the result
   * matches a fresh `runTeam` (a synthesized final answer under the
   * `'coordinator'` key in `agentResults`, not just raw per-task outputs).
   * Re-supply the coordinator via `options.coordinator` — the checkpoint cannot
   * persist a live adapter. If no usable coordinator config is available or the
   * synthesis call fails, restore falls back to raw outputs and emits an
   * `onProgress` `synthesis_failed` event. A restored `runTasks`/`runFromPlan`
   * run never synthesizes; pass the original tasks/plan to resume it unchanged.
   */
  async restore(
    team: Team,
    tasks: ReadonlyArray<RunTaskSpec>,
    options?: RestoreOptions,
  ): Promise<TeamRunResult>
  async restore(
    team: Team,
    plan: PlanArtifact,
    options?: RestoreOptions,
  ): Promise<TeamRunResult>
  async restore(
    team: Team,
    options?: RestoreOptions,
  ): Promise<TeamRunResult>
  async restore(
    team: Team,
    tasksOrOptions?: ReadonlyArray<RunTaskSpec> | PlanArtifact | RestoreOptions,
    maybeOptions?: RestoreOptions,
  ): Promise<TeamRunResult> {
    const evaluationStartedAtMs = this.onlineEvaluator === undefined ? undefined : Date.now()
    const hasTaskSource = Array.isArray(tasksOrOptions) || this.isPlanArtifact(tasksOrOptions)
    const options = hasTaskSource ? maybeOptions : tasksOrOptions as RestoreOptions | undefined
    validateRunMetadata(options?.metadata)
    const activeCheckpoint = this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint ?? true,
      'runTasks',
      options?.goal,
    )

    const snapshot = activeCheckpoint ? await activeCheckpoint.manager.loadLatest() : null
    if (!snapshot) {
      if (Array.isArray(tasksOrOptions)) {
        const queue = new TaskQueue()
        loadSpecsIntoQueue(
          tasksOrOptions.map((t) => ({
            title: t.title,
            description: t.description,
            assignee: t.assignee,
            dependsOn: t.dependsOn,
            memoryScope: t.memoryScope,
            dependencyPayload: t.dependencyPayload,
            maxRetries: t.maxRetries,
            retryDelayMs: t.retryDelayMs,
            retryBackoff: t.retryBackoff,
            role: t.role,
            priority: t.priority,
            metadata: t.metadata,
            requires: t.requires,
            verify: t.verify,
          })),
          team.getAgents(),
          queue,
        )
        return this.executeExplicitTaskQueue(
          team,
          queue,
          options,
          options?.goal,
          undefined,
          activeCheckpoint,
          undefined,
          undefined,
          undefined,
          evaluationStartedAtMs === undefined ? undefined : {
            input: tasksOrOptions,
            startedAtMs: evaluationStartedAtMs,
          },
          undefined,
          undefined,
          'restore',
        )
      }
      if (this.isPlanArtifact(tasksOrOptions)) {
        if (resolveRecoveryOptions(this.config.recovery, options?.recovery).mode !== 'fixed') {
          throw new Error('restore from a plan artifact requires fixed recovery so the plan remains exact.')
        }
        const queue = new TaskQueue()
        const tasks = this.tasksFromPlan(tasksOrOptions)
        const validation = validateTaskDependencies(tasks)
        if (!validation.valid) {
          throw new Error(`Invalid plan artifact: ${validation.errors.join(' ')}`)
        }
        queue.addBatch(tasks)
        return this.executeExplicitTaskQueue(
          team,
          queue,
          options,
          tasksOrOptions.goal ?? options?.goal,
          undefined,
          activeCheckpoint,
          undefined,
          undefined,
          undefined,
          evaluationStartedAtMs === undefined ? undefined : {
            input: tasksOrOptions,
            startedAtMs: evaluationStartedAtMs,
          },
          undefined,
          undefined,
          'restore',
        )
      }

      const queue = new TaskQueue()
      return this.executeExplicitTaskQueue(
        team,
        queue,
        options,
        options?.goal,
        undefined,
        activeCheckpoint,
        undefined,
        undefined,
        undefined,
        evaluationStartedAtMs === undefined ? undefined : {
          input: { kind: 'restore', goal: options?.goal },
          startedAtMs: evaluationStartedAtMs,
        },
        undefined,
        undefined,
        'restore',
      )
    }

    if (
      snapshot.mode === 'runFromPlan'
      && resolveRecoveryOptions(this.config.recovery, options?.recovery).mode !== 'fixed'
    ) {
      throw new Error('restore of a runFromPlan checkpoint requires fixed recovery so the plan remains exact.')
    }

    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem && snapshot.sharedMemory) {
      await sharedMem.restore(snapshot.sharedMemory)
    } else if (sharedMem && snapshot.turnCount !== undefined) {
      // Reused-store checkpoint: entries are already in the store; only the
      // turn counter needs restoring so TTL expiry resumes correctly.
      sharedMem.setTurnCount(snapshot.turnCount)
    }
    if (snapshot.messageBus) {
      team.restoreMessageBus(snapshot.messageBus)
    }

    const restoreIdentityOptions = identityOptionsForRun(options)
    const restoreMetadata = resolveRestoreMetadata(snapshot, restoreIdentityOptions)
    const identity = createRestoreIdentity(snapshot, restoreIdentityOptions)

    const queue = TaskQueue.fromSnapshot(snapshot.queue, { resetInProgress: true })
    const validation = validateTaskDependencies(queue.list())
    if (!validation.valid) {
      throw new Error(`Invalid checkpoint task dependencies: ${validation.errors.join(' ')}`)
    }
    let restoredInFlightTasks: InFlightTaskCheckpoint[] =
      snapshot.version === 3 || snapshot.version === 4 || snapshot.version === 5
        ? snapshot.inFlightTasks.map((state) => ({
            ...state,
            ...(state.pendingToolCalls
              ? { pendingToolCalls: state.pendingToolCalls.map((pending) => ({ ...pending })) }
              : {}),
          }))
        : []
    for (const state of restoredInFlightTasks) {
      const task = queue.get(state.taskId)
      if (!task || !snapshot.queue.inProgress.includes(state.taskId)) {
        throw new Error(
          `Invalid checkpoint in-flight state: task "${state.taskId}" is not in the queue's in-progress partition.`,
        )
      }
      if (task.assignee !== state.assignee) {
        throw new Error(
          `Invalid checkpoint in-flight state: task "${state.taskId}" belongs to ` +
            `"${task.assignee ?? 'unassigned'}", not "${state.assignee}".`,
        )
      }
    }
    const agentResults = this.agentResultsFromCheckpoint(snapshot, queue)
    const checkpointForResume: ActiveCheckpoint | undefined = activeCheckpoint
      ? {
          ...activeCheckpoint,
          mode: snapshot.mode,
          ...(snapshot.goal !== undefined ? { goal: snapshot.goal } : {}),
          runId: identity.runId,
          inFlightTasks: new Map(restoredInFlightTasks.map((state) => [state.taskId, state])),
          ...(snapshot.version === 5
            ? { journalWatermarkSeq: snapshot.journalWatermarkSeq }
            : {}),
        }
      : undefined

    if ((snapshot.version === 4 || snapshot.version === 5) && checkpointForResume) {
      const hasTerminalRejection = snapshot.approvalDecisions.some(
        (decision) => decision.scope !== 'tool_call' && decision.decision === 'rejected',
      )
      for (const decision of snapshot.approvalDecisions) {
        const primary = await checkpointForResume.approvalLedger.get(decision.requestId)
        if (!primary?.decision || !this.approvalDecisionsEqual(primary.decision, decision)) {
          throw new DurableApprovalError(
            'APPROVAL_INTEGRITY_ERROR',
            `Checkpoint approval decision "${decision.requestId}" does not match the primary ledger.`,
          )
        }
        checkpointForResume.approvalDecisions.set(decision.requestId, decision)
      }

      const unresolved: ApprovalRequest[] = []
      let rejectedBoundary: ApprovalRequest | undefined
      let approvedPlanOnly: ApprovalRequest | undefined

      for (const request of snapshot.pendingApprovals) {
        if (request.runId !== identity.runId) {
          throw new DurableApprovalError(
            'APPROVAL_INTEGRITY_ERROR',
            `Approval request "${request.id}" belongs to another logical run.`,
          )
        }
        this.assertApprovalMatchesCheckpoint(request, snapshot)
        checkpointForResume.pendingApprovals.set(request.id, request)
        const primary = await checkpointForResume.approvalLedger.ensureRequest(request)
        if (!primary.decision) {
          unresolved.push(request)
          continue
        }

        checkpointForResume.approvalDecisions.set(request.id, primary.decision)
        if (request.scope === 'tool_call') {
          restoredInFlightTasks = restoredInFlightTasks.map((state) => ({
            ...state,
            ...(state.pendingToolCalls
              ? {
                  pendingToolCalls: state.pendingToolCalls.map((pending) =>
                    pending.approvalRequest?.id === request.id
                      ? { ...pending, approvalDecision: primary.decision }
                      : pending),
                }
              : {}),
          }))
          continue
        }

        if (primary.decision.decision === 'approved') {
          if (
            request.content.kind === 'plan'
            && request.content.continuation === 'plan_only'
          ) {
            approvedPlanOnly = request
          } else if (request.scope === 'plan' || request.scope === 'task_round') {
            checkpointForResume.pendingApprovals.delete(request.id)
          } else {
            checkpointForResume.approvedBoundaries.set(request.id, primary.decision)
          }
        } else {
          rejectedBoundary = request
        }
      }
      checkpointForResume.inFlightTasks.clear()
      for (const state of restoredInFlightTasks) {
        checkpointForResume.inFlightTasks.set(state.taskId, state)
      }

      const taskRecords = (): readonly TaskExecutionRecord[] => queue.list().map((task) => ({
        id: task.id,
        title: task.title,
        assignee: task.assignee,
        status: task.status,
        dependsOn: task.dependsOn ?? [],
        description: task.description,
        memoryScope: task.memoryScope,
        dependencyPayload: task.dependencyPayload,
        role: task.role,
        priority: task.priority,
        metadata: task.metadata,
        requires: task.requires,
        maxRetries: task.maxRetries,
        retryDelayMs: task.retryDelayMs,
        retryBackoff: task.retryBackoff,
        supersededByRevision: task.supersededByRevision,
        recoveredByRevision: task.recoveredByRevision,
      }))
      const finishRestoreBoundary = (result: TeamRunResult): TeamRunResult => {
        const completed = {
          ...this.withCheckpointApprovals(result, checkpointForResume),
          ...(restoreMetadata.metadata !== undefined ? { metadata: restoreMetadata.metadata } : {}),
        }
        this.completeOnlineEvaluation(
          evaluationStartedAtMs === undefined ? undefined : {
            input: { kind: 'restore', goal: snapshot.goal ?? options?.goal },
            startedAtMs: evaluationStartedAtMs,
          },
          completed,
        )
        return completed
      }

      if (unresolved.length > 0) {
        return finishRestoreBoundary(this.buildTeamRunResult(
          agentResults,
          identity,
          snapshot.goal ?? options?.goal,
          taskRecords(),
          statusOnly('suspended', 'Durable approval decision pending.'),
        ))
      }

      if (rejectedBoundary) {
        checkpointForResume.pendingApprovals.delete(rejectedBoundary.id)
        queue.skipRemaining('Skipped: durable approval rejected.')
        await saveRunCheckpoint(queue, {
          team,
          pool: this.buildPool(team.getAgents()),
          scheduler: this.createScheduler(options?.modelRouting, () => queue.list()),
          agentResults,
          config: this.config,
          checkpoint: checkpointForResume,
          identity,
          ...(restoreMetadata.metadata !== undefined ? { metadata: restoreMetadata.metadata } : {}),
          runId: identity.runId,
          taskSpans: new Map(),
          cumulativeUsage: ZERO_USAGE,
          cumulativeCost: 0,
          budgetExceededTriggered: false,
          taskMetrics: new Map(),
          taskById: new Map(queue.list().map((task) => [task.id, task])),
          taskLeafById: new Map(queue.list().map((task) => [task.id, isLeafTask(task, queue.list())])),
          recovery: resolveRecoveryOptions(this.config.recovery, options?.recovery),
          recoveryPatchSignatures: new Set(),
        })
        return finishRestoreBoundary(this.buildTeamRunResult(
          agentResults,
          identity,
          snapshot.goal ?? options?.goal,
          taskRecords(),
          statusOnly('rejected', 'Durable approval rejected.'),
        ))
      }

      if (hasTerminalRejection) {
        return finishRestoreBoundary(this.buildTeamRunResult(
          agentResults,
          identity,
          snapshot.goal ?? options?.goal,
          taskRecords(),
          statusOnly('rejected', 'Durable approval rejected.'),
        ))
      }

      if (approvedPlanOnly) {
        checkpointForResume.pendingApprovals.delete(approvedPlanOnly.id)
        const goal = snapshot.goal ?? options?.goal
        if (goal === undefined) {
          throw new DurableApprovalError(
            'APPROVAL_INTEGRITY_ERROR',
            'A plan-only approval checkpoint has no goal.',
          )
        }
        return finishRestoreBoundary(this.buildPlanOnlyTeamRunResult(
          agentResults,
          identity,
          goal,
          queue,
        ))
      }
    }

    return this.executeExplicitTaskQueue(
      team,
      queue,
      options,
      snapshot.goal ?? options?.goal,
      agentResults,
      checkpointForResume,
      options?.coordinator,
      identity,
      restoreMetadata,
      evaluationStartedAtMs === undefined ? undefined : {
        input: { kind: 'restore', goal: snapshot.goal ?? options?.goal },
        startedAtMs: evaluationStartedAtMs,
      },
      undefined,
      undefined,
      'restore',
    )
  }

  /**
   * Run a team with an explicitly provided task list.
   *
   * Simpler than {@link runTeam}: no coordinator agent is involved. Tasks are
   * loaded directly into the queue, unassigned tasks are auto-assigned via the
   * {@link Scheduler}, and execution proceeds in dependency order.
   *
   * @param team  - A team created via {@link createTeam}.
   * @param tasks - Array of task descriptors.
   */
  async runTasks(
    team: Team,
    tasks: ReadonlyArray<RunTaskSpec>,
    options?: RunTasksOptions,
  ): Promise<TeamRunResult> {
    const pendingEvaluation = this.beginOnlineEvaluation(tasks)
    const agentConfigs = team.getAgents()
    const queue = new TaskQueue()

    loadSpecsIntoQueue(
      tasks.map((t) => ({
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        dependsOn: t.dependsOn,
        memoryScope: t.memoryScope,
        dependencyPayload: t.dependencyPayload,
        maxRetries: t.maxRetries,
        retryDelayMs: t.retryDelayMs,
        retryBackoff: t.retryBackoff,
        role: t.role,
        priority: t.priority,
        metadata: t.metadata,
        requires: t.requires,
        verify: t.verify,
      })),
      agentConfigs,
      queue,
    )

    return this.executeExplicitTaskQueue(
      team,
      queue,
      options,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pendingEvaluation,
    )
  }

  // -------------------------------------------------------------------------
  // Consensus
  // -------------------------------------------------------------------------

  /**
   * Run a proposer→judge consensus over a single prompt.
   *
   * The proposer emits an answer; judges try to refute it over up to
   * `maxRounds`, exiting early once `quorum` accept. Proposer and judge token
   * usage all count against the orchestrator's `maxTokenBudget` — crossing it
   * stops issuing further judge calls, exactly like delegation and `runTasks`.
   */
  async runConsensus(
    team: Team,
    prompt: string,
    options: ConsensusOptions,
  ): Promise<ConsensusResult> {
    const runConfig = this.configForRun(options.egressPolicy)
    const pendingEvaluation = this.beginOnlineEvaluation(prompt)
    const { identity, metadata } = createRunFacts(options)
    const proposers = Array.isArray(options.proposer) ? options.proposer : [options.proposer]
    if (proposers.length === 0) {
      throw new Error('runConsensus: at least one proposer is required.')
    }
    if (options.judges.length === 0) {
      throw new Error('runConsensus: at least one judge is required.')
    }

    const traceRuntime = this.startTrace(identity, metadata)
    const consensusSpan = traceRuntime?.startSpan({
      kind: 'consensus',
      name: 'verify_consensus',
      parent: traceRuntime.root,
      attributes: { 'oma.consensus.scope': 'top_level' },
    })
    const finish = (result: ConsensusResult): ConsensusResult => {
      const completedResult: ConsensusResult = {
        ...result,
        ...(metadata !== undefined ? { metadata } : {}),
      }
      const status = completedResult.status ?? statusOnly('ok')
      consensusSpan?.end({
        status,
        ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
        attributes: {
          'oma.consensus.verdict': completedResult.verdict,
          'oma.consensus.rounds': completedResult.rounds,
        },
      })
      traceRuntime?.close({
        status,
        ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
      })
      this.completeOnlineEvaluation(pendingEvaluation, completedResult)
      return completedResult
    }

    const mode = options.mode ?? 'refute'
    const maxRounds = Math.max(1, options.maxRounds ?? 2)
    const quorum = Math.min(
      options.judges.length,
      Math.max(1, options.quorum ?? Math.ceil(options.judges.length / 2)),
    )
    const onDissent = options.onDissent ?? 'revise'
    const budget = this.config.maxTokenBudget
    const defaults: ConsensusAgentDefaults = {
      defaultModel: this.config.defaultModel,
      defaultProvider: this.config.defaultProvider,
      defaultBaseURL: this.config.defaultBaseURL,
      defaultApiKey: this.config.defaultApiKey,
      egressPolicy: runConfig.egressPolicy,
      defaultCwd: this.config.defaultCwd,
      defaultShellExecutor: this.config.defaultShellExecutor,
      onToolCall: this.config.onToolCall,
      maxConcurrency: this.config.maxConcurrency,
    }

    const pool = new AgentPool(Math.max(1, this.config.maxConcurrency))
    let usage: TokenUsage = ZERO_USAGE

    // Step 2: run proposer(s); accumulate usage and honour the budget before judging.
    const candidates: string[] = []
    let firstFailure: AgentRunResult | undefined
    for (const proposerConfig of proposers) {
      const r = await pool.runEphemeral(
        buildAgent(applyConsensusDefaults(proposerConfig, defaults)),
        prompt,
        {
          identity,
          runId: identity.runId,
          ...(traceRuntime && consensusSpan ? {
            traceRuntime,
            traceSpan: consensusSpan,
            tracePhase: 'proposer',
          } : {}),
          ...(this.config.onTrace ? { onTrace: this.config.onTrace, traceAgent: proposerConfig.name } : {}),
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        },
      )
      usage = addUsage(usage, r.tokenUsage)
      if (r.success && r.output) candidates.push(r.output)
      if (!r.success && firstFailure === undefined) firstFailure = r
      if (options.abortSignal?.aborted) {
        const abortError = new Error('Run cancelled by caller.')
        abortError.name = 'AbortError'
        const classified = classifyRunFailure(abortError)
        return finish({
          identity,
          status: classified.status,
          errorInfo: classified.errorInfo,
          answer: candidates.join('\n\n---\n\n'),
          verdict: 'rejected',
          dissent: [],
          rounds: 0,
          tokenUsage: usage,
        })
      }
      if (budget !== undefined && usage.input_tokens + usage.output_tokens > budget) {
        const budgetError = new TokenBudgetExceededError(
          proposerConfig.name,
          usage.input_tokens + usage.output_tokens,
          budget,
        )
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: proposerConfig.name,
          data: budgetError,
        })
        const classified = classifyRunFailure(budgetError)
        consensusSpan?.event('budget_exhausted', {})
        return finish({
          identity,
          status: classified.status,
          errorInfo: classified.errorInfo,
          answer: candidates.join('\n\n---\n\n'),
          verdict: 'rejected',
          dissent: [],
          rounds: 0,
          tokenUsage: usage,
        })
      }
    }

    // Every proposer failed or returned empty output: there is nothing to judge.
    // Bail with a rejected verdict so an empty answer can never come back accepted.
    if (candidates.length === 0) {
      const status = firstFailure?.status ?? statusOnly('error', 'All consensus proposers failed.')
      return finish({
        identity,
        status,
        ...(firstFailure?.errorInfo ? { errorInfo: firstFailure.errorInfo } : {}),
        answer: '', verdict: 'rejected', dissent: [], rounds: 0, tokenUsage: usage,
      })
    }

    // `structured` belongs to the per-task verify hook, where one task result
    // carries one parsed value. Here several proposer answers may be joined into
    // a single string, so no parsed value corresponds to it; drop it rather than
    // leak an undeclared field onto the public ConsensusResult.
    const { structured: _structured, ...result } = await runConsensusCore({
      team,
      prompt,
      initialAnswer: candidates.join('\n\n---\n\n'),
      initialUsage: usage,
      budgetBaseTokens: 0,
      judges: options.judges,
      mode,
      quorum,
      maxRounds,
      verdictSchema: options.verdictSchema,
      onDissent,
      judgePrompt: options.judgePrompt,
      budget,
      reviseProposer: proposers[0],
      defaults,
      onTrace: this.config.onTrace,
      runId: identity.runId,
      identity,
      abortSignal: options.abortSignal,
      pool,
      ...(traceRuntime && consensusSpan ? { traceRuntime, consensusSpan } : {}),
    })
    if (options.abortSignal?.aborted) {
      const abortError = new Error('Run cancelled by caller.')
      abortError.name = 'AbortError'
      const classified = classifyRunFailure(abortError)
      return finish({ ...result, identity, status: classified.status, errorInfo: classified.errorInfo })
    }
    if (budget !== undefined && result.tokenUsage.input_tokens + result.tokenUsage.output_tokens > budget) {
      const budgetError = new TokenBudgetExceededError(
        proposers[0]!.name,
        result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
        budget,
      )
      const classified = classifyRunFailure(budgetError)
      consensusSpan?.event('budget_exhausted', {})
      return finish({ ...result, identity, status: classified.status, errorInfo: classified.errorInfo })
    }
    return finish({ ...result, identity, status: result.status ?? statusOnly('ok') })
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /**
   * Returns a lightweight status snapshot.
   *
   * - `teams`          — Number of teams registered with this orchestrator.
   * - `activeAgents`   — Total agents currently in `running` state.
   * - `completedTasks` — Cumulative count of successfully completed tasks
   *                      (coordinator meta-steps excluded).
   */
  getStatus(): { teams: number; activeAgents: number; completedTasks: number } {
    return {
      teams: this.teams.size,
      activeAgents: 0, // Pools are ephemeral per-run; no cross-run state to inspect.
      completedTasks: this.completedTaskCount,
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deregister all teams and reset internal counters.
   *
   * Does not cancel in-flight runs. Call this when you want to reuse the
   * orchestrator instance for a fresh set of teams.
   *
   * Async for forward compatibility — shutdown may need to perform async
   * cleanup (e.g. graceful agent drain) in future versions.
   */
  async shutdown(): Promise<void> {
    this.teams.clear()
    this.completedTaskCount = 0
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private tasksFromPlan(plan: PlanArtifact): Task[] {
    const now = new Date()
    return plan.tasks.map((task): Task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: 'pending' as TaskStatus,
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      ...(task.dependsOn && task.dependsOn.length > 0 ? { dependsOn: [...task.dependsOn] } : {}),
      ...(task.memoryScope !== undefined ? { memoryScope: task.memoryScope } : {}),
      ...(task.dependencyPayload !== undefined
        ? { dependencyPayload: task.dependencyPayload }
        : {}),
      ...(task.role !== undefined ? { role: task.role } : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.metadata !== undefined
        ? { metadata: validateTaskMetadata(task.metadata) }
        : {}),
      ...(task.requires !== undefined ? { requires: task.requires } : {}),
      result: undefined,
      createdAt: now,
      updatedAt: now,
      ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
      ...(task.retryDelayMs !== undefined ? { retryDelayMs: task.retryDelayMs } : {}),
      ...(task.retryBackoff !== undefined ? { retryBackoff: task.retryBackoff } : {}),
    }))
  }

  private async executeExplicitTaskQueue(
    team: Team,
    queue: TaskQueue,
    options?: RunTasksOptions,
    goal?: string,
    initialAgentResults?: Map<string, AgentRunResult>,
    activeCheckpoint?: ActiveCheckpoint,
    coordinatorForSynthesis?: CoordinatorConfig,
    identity?: RunIdentity,
    restoreMetadata?: RestoreMetadataResolution,
    pendingEvaluation?: PendingOnlineEvaluation,
    governanceDeclaration?: GovernanceDeclaration,
    routingDecisionInput?: RoutingDecisionRecordInput,
    journalMode: RunJournalMode = 'runTasks',
  ): Promise<TeamRunResult> {
    const runConfig = this.configForRun(options?.egressPolicy)
    const agentConfigs = team.getAgents()
    const requirementIssues = validateTaskRequirements(
      queue.list(),
      agentConfigs,
      this.agentSelectorContext(options?.modelRouting, () => queue.list()),
    )
    if (requirementIssues.length > 0) {
      const error = new InvalidTaskRequirementsError(requirementIssues)
      this.config.onProgress?.({
        type: 'error',
        data: {
          code: error.code,
          issues: requirementIssues,
          error: classifyRunFailure(error, { kind: 'validation' }).errorInfo,
        },
      })
      throw error
    }

    const newRunFacts = identity === undefined
      ? createRunFacts(identityOptionsForRun(options))
      : undefined
    const runIdentity = identity ?? newRunFacts!.identity
    const metadata = restoreMetadata?.metadata ?? newRunFacts?.metadata
    const traceRuntime = this.startTrace(runIdentity, metadata, restoreMetadata?.overridden)
    const journal = await this.startRunJournal(
      options?.journal, runIdentity, journalMode, goal, metadata,
      activeCheckpoint?.journalWatermarkSeq,
    )
    emitInitialPlanSet(journal, queue)
    const routingDecision = routingDecisionInput
      ? recordRoutingDecision(runIdentity, traceRuntime, routingDecisionInput)
      : undefined
    const scheduler = this.createScheduler(options?.modelRouting, () => queue.list())
    if (this.config.onApproval) {
      scheduler.autoAssign(queue, agentConfigs)
    }
    const budgets = resolveRunBudgets(runConfig, options)

    const agentResults = initialAgentResults ?? new Map<string, AgentRunResult>()
    const checkpoint = activeCheckpoint ?? this.createActiveCheckpoint(
      team,
      options?.checkpoint ?? this.config.checkpoint,
      'runTasks',
      goal,
    )
    // Restore reconciles approval decisions against the primary ledger before
    // this point, when no recorder exists yet. Recording them here is what
    // makes an attempt's journal say which boundaries it resumed under.
    if (journal && checkpoint) {
      for (const decision of checkpoint.approvalDecisions.values()) {
        journal.emit({ type: 'approval/decision', decision })
      }
      await this.resumeFromJournal(journal, checkpoint)
    }
    const restoredConfirmationState = checkpoint?.mode === 'runTeam'
      && this.config.requireConsequentialConfirmation
      && [...checkpoint.approvalDecisions.values()].some(
        (decision) => decision.scope === 'plan' && decision.decision === 'approved',
      )
      ? createConsequentialConfirmationState()
      : undefined
    if (restoredConfirmationState) restoredConfirmationState.planApproved = true
    const pool = this.buildPool(agentConfigs, restoredConfirmationState, runConfig)
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: runConfig,
      ...(checkpoint ? { checkpoint } : {}),
      ...(journal ? { journal } : {}),
      identity: runIdentity,
      ...(metadata !== undefined ? { metadata } : {}),
      runId: runIdentity.runId,
      ...(traceRuntime ? { traceRuntime } : {}),
      taskSpans: new Map(),
      abortSignal: options?.abortSignal,
      cumulativeUsage: ZERO_USAGE,
      cumulativeCost: 0,
      maxTokenBudget: budgets.maxTokenBudget,
      maxCostBudget: budgets.maxCostBudget,
      estimateCost: this.config.estimateCost,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics: new Map<string, TaskExecutionMetrics>(),
      modelRouting: options?.modelRouting,
      taskById: new Map(queue.list().map((task) => [task.id, task])),
      taskLeafById: new Map(queue.list().map((task) => [task.id, isLeafTask(task, queue.list())])),
      recovery: resolveRecoveryOptions(this.config.recovery, options?.recovery),
      recoveryPatchSignatures: new Set(),
    }

    await executeQueue(queue, ctx)
    if (queue.list().every((task) => task.status === 'completed')) {
      await saveRunCheckpoint(queue, ctx)
    }

    // A resumed `runTeam` re-runs the coordinator synthesis so the restored
    // result matches a fresh `runTeam` (a synthesized final answer, not raw
    // per-task outputs). Best-effort: a missing/unusable coordinator config or
    // a failing synthesis call must not discard the recovered work — on failure
    // we surface `synthesis_failed` and fall back to raw outputs.
    if (
      ctx.outcomeStatus?.code !== 'suspended'
      && checkpoint?.mode === 'runTeam'
      && goal !== undefined
    ) {
      try {
        const coordinatorBaseConfig = buildCoordinatorBaseConfig(runConfig, coordinatorForSynthesis, agentConfigs, false)
        const synthesis = await runCoordinatorSynthesis(runConfig, team, queue, goal, coordinatorBaseConfig, {
          identity: runIdentity,
          modelRouting: options?.modelRouting,
          runId: ctx.runId,
          abortSignal: options?.abortSignal,
          cumulativeUsage: ctx.cumulativeUsage,
          cumulativeCost: ctx.cumulativeCost,
          maxTokenBudget: ctx.maxTokenBudget,
          maxCostBudget: ctx.maxCostBudget,
          estimateCost: ctx.estimateCost,
          ...(traceRuntime ? { traceRuntime, consumedTaskSpans: [...ctx.taskSpans.values()] } : {}),
          ...(journal ? { journal } : {}),
        })
        if (synthesis !== null && synthesis.result.success) {
          agentResults.set('coordinator', synthesis.result)
          ctx.cumulativeUsage = synthesis.cumulativeUsage
          ctx.cumulativeCost = synthesis.cumulativeCost
        } else if (synthesis !== null) {
          // Synthesis ran but the coordinator agent failed (e.g. the LLM call
          // errored). Keep the recovered task outputs and surface the failure
          // rather than attaching a failed answer under `'coordinator'`.
          this.config.onProgress?.({
            type: 'error',
            data: {
              kind: 'synthesis_failed',
              error: new Error(synthesis.result.output || 'coordinator synthesis failed'),
            },
          })
          ctx.outcomeStatus = synthesis.result.status ?? statusOnly('error', synthesis.result.output)
          ctx.outcomeErrorInfo = synthesis.result.errorInfo
        } else if (options?.abortSignal?.aborted && ctx.outcomeStatus === undefined) {
          const abortError = new Error('Run cancelled by caller.')
          abortError.name = 'AbortError'
          const classified = classifyRunFailure(abortError)
          ctx.outcomeStatus = classified.status
          ctx.outcomeErrorInfo = classified.errorInfo
        }
      } catch (error) {
        this.config.onProgress?.({
          type: 'error',
          data: { kind: 'synthesis_failed', error },
        })
        const classified = classifyRunFailure(error)
        ctx.outcomeStatus = classified.status
        ctx.outcomeErrorInfo = classified.errorInfo
      }
    }

    const taskRecords: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      description: task.description,
      memoryScope: task.memoryScope,
      dependencyPayload: task.dependencyPayload,
      role: task.role,
      priority: task.priority,
      metadata: task.metadata,
      requires: task.requires,
      maxRetries: task.maxRetries,
      retryDelayMs: task.retryDelayMs,
      retryBackoff: task.retryBackoff,
      verify: task.verify,
      supersededByRevision: task.supersededByRevision,
      recoveredByRevision: task.recoveredByRevision,
      metrics: ctx.taskMetrics.get(task.id),
    }))

    const result = this.withCheckpointApprovals(this.buildTeamRunResult(
      agentResults,
      runIdentity,
      goal,
      taskRecords,
      ctx.outcomeStatus,
      ctx.outcomeErrorInfo,
      false,
      queue.getPlanRevisions(),
    ), checkpoint)
    const resultWithRouting = {
      ...result,
      ...(routingDecision !== undefined ? { routingDecision } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    }
    const completedResult = finalizeGovernanceRun(
      resultWithRouting,
      governanceDeclaration,
      buildExecutionReceipt(resultWithRouting),
    )
    const queueStatus = completedResult.status
      ?? statusOnly(completedResult.success ? 'ok' : 'error')
    await endRunJournal(journal, queueStatus, completedResult.errorInfo)
    traceRuntime?.close({
      status: queueStatus,
      ...(completedResult.errorInfo ? { error: completedResult.errorInfo } : {}),
    })
    this.completeOnlineEvaluation(pendingEvaluation, completedResult)
    return completedResult
  }

  private createActiveCheckpoint(
    team: Team,
    config: boolean | CheckpointOptions | undefined,
    mode: CheckpointSnapshot['mode'],
    goal?: string,
  ): ActiveCheckpoint | undefined {
    if (config === undefined || config === false) return undefined
    const options = config === true ? {} : config
    if (options.enabled === false) return undefined

    // The instance-level fallback store is shared across every run on this
    // orchestrator, so concurrent runs would overwrite each other at the
    // default checkpoint key. Require a `runId` (or an explicit `key`/`store`)
    // before falling back, so each run resolves to a distinct, resumable key.
    const sharedStore = team.getSharedMemory()
    const explicitStore = options.store ?? sharedStore
    if (!explicitStore && options.runId === undefined && options.key === undefined) {
      throw new Error(
        'Checkpoint requires a `runId` (or an explicit `store`/`key`) when the team has no ' +
          'shared-memory store. Without one, concurrent runs would share the fallback store and ' +
          "overwrite each other's checkpoint at the default key.",
      )
    }
    const store = explicitStore ?? this.fallbackCheckpointStore
    return {
      manager: new Checkpoint(store, options),
      approvalLedger: new DurableApprovalLedger(store),
      mode,
      ...(goal !== undefined ? { goal } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      reusesSharedMemoryStore: sharedStore !== undefined && store === sharedStore,
      inFlightTasks: new Map(),
      pendingApprovals: new Map(),
      approvalDecisions: new Map(),
      approvedBoundaries: new Map(),
      saveChain: Promise.resolve(),
    }
  }

  private withCheckpointApprovals(
    result: TeamRunResult,
    checkpoint: ActiveCheckpoint | undefined,
  ): TeamRunResult {
    if (!checkpoint) return result
    const decisions = [...checkpoint.approvalDecisions.values()]
    const pending = [...checkpoint.pendingApprovals.values()].filter(
      (request) => !checkpoint.approvalDecisions.has(request.id),
    )
    return {
      ...result,
      ...(pending.length > 0 ? { pendingApprovals: pending } : {}),
      ...(decisions.length > 0 ? { approvalDecisions: decisions } : {}),
    }
  }

  private approvalContentAtCheckpoint(
    request: ApprovalRequest,
    snapshot: CheckpointSnapshot,
  ): ApprovalRequestContent {
    const tasks = new Map(snapshot.queue.tasks.map((task) => [task.id, task]))
    switch (request.content.kind) {
      case 'plan':
        if (request.boundary !== 'coordinator-plan') {
          throw new DurableApprovalError(
            'APPROVAL_INTEGRITY_ERROR',
            `Plan approval "${request.id}" has an invalid boundary.`,
          )
        }
        return {
          kind: 'plan',
          continuation: request.content.continuation,
          tasks: snapshot.queue.tasks,
        }
      case 'task_dispatch': {
        const task = tasks.get(request.content.task.id)
        if (!task || request.boundary !== task.id) {
          throw new DurableApprovalError(
            'APPROVAL_STALE_DECISION',
            `Task-dispatch approval "${request.id}" no longer identifies a pending task.`,
          )
        }
        return { kind: 'task_dispatch', task }
      }
      case 'task_round': {
        const completedTasks = request.content.completedTasks.map((task) => tasks.get(task.id))
        const nextTasks = request.content.nextTasks.map((task) => tasks.get(task.id))
        if (completedTasks.some((task) => !task) || nextTasks.some((task) => !task)) {
          throw new DurableApprovalError(
            'APPROVAL_STALE_DECISION',
            `Round approval "${request.id}" references a task that no longer exists.`,
          )
        }
        const boundary = [
          request.content.completedTasks.map((task) => task.id).join(','),
          request.content.nextTasks.map((task) => task.id).join(','),
        ].join('->')
        if (request.boundary !== boundary) {
          throw new DurableApprovalError(
            'APPROVAL_INTEGRITY_ERROR',
            `Round approval "${request.id}" has an invalid boundary.`,
          )
        }
        return {
          kind: 'task_round',
          completedTasks: completedTasks as NonNullable<(typeof completedTasks)[number]>[],
          nextTasks: nextTasks as NonNullable<(typeof nextTasks)[number]>[],
        }
      }
      case 'tool_call': {
        const content = request.content
        const state = (
          snapshot.version === 3 || snapshot.version === 4 || snapshot.version === 5
        )
          ? snapshot.inFlightTasks.find((item) => item.taskId === content.taskId)
          : undefined
        const pending = state?.pendingToolCalls?.find(
          (item) => item.call.id === content.toolCallId,
        )
        if (
          !state
          || !pending
          || pending.commit
          || pending.approvalRequest?.id !== request.id
          || state.assignee !== content.agentName
          || pending.call.name !== content.toolName
          || request.boundary !== `${state.taskId}:${pending.call.id}`
        ) {
          throw new DurableApprovalError(
            'APPROVAL_STALE_DECISION',
            `Tool approval "${request.id}" no longer identifies the pending invocation.`,
          )
        }
        return {
          ...content,
          rawInput: pending.call.input,
        }
      }
    }
  }

  private assertApprovalMatchesCheckpoint(
    request: ApprovalRequest,
    snapshot: CheckpointSnapshot,
  ): void {
    const content = this.approvalContentAtCheckpoint(request, snapshot)
    const currentHash = hashApprovalRequest(
      request.scope,
      request.boundary,
      content,
    )
    if (currentHash !== request.requestHash) {
      throw new DurableApprovalError(
        'APPROVAL_STALE_DECISION',
        `Approval request "${request.id}" does not match the checkpointed execution boundary.`,
      )
    }
  }

  private approvalDecisionsEqual(
    left: ApprovalDecisionRecord,
    right: ApprovalDecisionRecord,
  ): boolean {
    return left.requestId === right.requestId
      && left.runId === right.runId
      && left.scope === right.scope
      && left.requestHash === right.requestHash
      && left.decision === right.decision
      && left.reviewer.id === right.reviewer.id
      && left.reviewer.displayName === right.reviewer.displayName
      && left.decidedAt === right.decidedAt
  }

  private agentResultsFromCheckpoint(
    snapshot: CheckpointSnapshot,
    queue: TaskQueue,
  ): Map<string, AgentRunResult> {
    const taskById = new Map(queue.list().map((task) => [task.id, task]))
    const agentResults = new Map<string, AgentRunResult>()

    for (const completed of snapshot.completedTaskResults) {
      const task = taskById.get(completed.taskId)
      const assignee = completed.assignee ?? task?.assignee ?? 'unknown'
      const output = completed.result ?? task?.result ?? ''
      agentResults.set(
        `${assignee}:${completed.taskId}`,
        completed.agentResult ?? {
          success: true,
          output,
          messages: [],
          tokenUsage: ZERO_USAGE,
          toolCalls: [],
        },
      )
    }

    return agentResults
  }

  private isPlanArtifact(value: unknown): value is PlanArtifact {
    if (value === null || typeof value !== 'object') return false
    const artifact = value as Record<string, unknown>
    return artifact['version'] === 1 && Array.isArray(artifact['tasks'])
  }

  private buildPool(
    agentConfigs: AgentConfig[],
    confirmationState?: ConsequentialConfirmationState,
    config: EffectiveOrchestratorConfig = this.config,
  ): AgentPool {
    const pool = new AgentPool(config.maxConcurrency)
    for (const agentConfig of agentConfigs) {
      const effective: AgentConfig = applyDefaultToolPreset(
        applyAgentDefaults(agentConfig, config),
        config.defaultToolPreset,
      )
      const guardedEffective = confirmationState
        && hasGrantedConsequentialTool(effective, { includeDelegateTool: true })
        ? withConsequentialConfirmation(effective, confirmationState)
        : effective
      pool.add(buildAgent(guardedEffective, { includeDelegateTool: true }))
    }
    return pool
  }

  /**
   * Aggregate the per-run `agentResults` map into a {@link TeamRunResult}.
   *
   * Merges results keyed as `agentName:taskId` back into a per-agent map
   * by agent name for the public result surface.
   *
   * Only non-coordinator entries are counted toward `completedTaskCount` to
   * avoid double-counting the coordinator's internal decompose/synthesis steps.
   */
  private buildTeamRunResult(
    agentResults: Map<string, AgentRunResult>,
    identity: RunIdentity,
    goal?: string,
    tasks?: readonly TaskExecutionRecord[],
    forcedStatus?: RunStatus,
    forcedErrorInfo?: StructuredTraceError,
    allowIncompleteTasks = false,
    planRevisions?: readonly PlanRevision[],
  ): TeamRunResult {
    let totalUsage: TokenUsage = ZERO_USAGE
    let overallSuccess = true
    const collapsed = new Map<string, AgentRunResult>()
    const taskResults = new Map<string, AgentRunResult>()
    const taskRecordsById = new Map((tasks ?? []).map((task) => [task.id, task]))

    for (const task of tasks ?? []) {
      if (!task.assignee) continue
      const exact = agentResults.get(`${task.assignee}:${task.id}`)
        ?? (task.id === 'short-circuit' ? agentResults.get(task.assignee) : undefined)
      if (exact !== undefined) taskResults.set(task.id, exact)
    }

    for (const [key, result] of agentResults) {
      // Strip the `:taskId` suffix to get the agent name
      const agentName = key.includes(':') ? key.split(':')[0]! : key

      totalUsage = addUsage(totalUsage, result.tokenUsage)
      const taskId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : undefined
      const recovered = taskId !== undefined
        && taskRecordsById.get(taskId)?.recoveredByRevision !== undefined
      if (!result.success && !recovered) overallSuccess = false

      const existing = collapsed.get(agentName)
      if (!existing) {
        collapsed.set(agentName, result)
      } else {
        // Merge multiple results for the same agent (multi-task case).
        // Keep the latest `structured` value (last completed task wins).
        collapsed.set(agentName, {
          success: existing.success && result.success,
          identity,
          status: existing.success && result.success
            ? statusOnly('ok')
            : result.status ?? existing.status ?? statusOnly('error'),
          ...(result.errorInfo ?? existing.errorInfo
            ? { errorInfo: result.errorInfo ?? existing.errorInfo }
            : {}),
          output: [existing.output, result.output].filter(Boolean).join('\n\n---\n\n'),
          messages: [...existing.messages, ...result.messages],
          tokenUsage: addUsage(existing.tokenUsage, result.tokenUsage),
          toolCalls: [...existing.toolCalls, ...result.toolCalls],
          structured: result.structured !== undefined ? result.structured : existing.structured,
        })
      }

      // Only count actual user tasks — skip coordinator meta-entries
      // (keys that start with 'coordinator') to avoid double-counting.
      if (result.success && !key.startsWith('coordinator')) {
        this.completedTaskCount++
      }
    }

    const metrics = computeRunMetrics(tasks)

    const statuses = [...agentResults.entries()]
      .filter(([key]) => {
        const taskId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : undefined
        return taskId === undefined
          || taskRecordsById.get(taskId)?.recoveredByRevision === undefined
      })
      .map(([, result]) => result.status)
      .filter((status): status is RunStatus => status !== undefined)
    const firstStatus = (code: RunStatus['code']) => statuses.find((status) => status.code === code)
    const taskFailed = tasks?.some((task) =>
      task.status === 'failed' && task.recoveredByRevision === undefined) ?? false
    const taskIncomplete = tasks?.some((task) =>
      task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked'
    ) ?? false
    const status = forcedStatus
      ?? firstStatus('budget_exhausted')
      ?? firstStatus('timeout')
      ?? firstStatus('cancelled')
      ?? (overallSuccess && !taskFailed && (!taskIncomplete || allowIncompleteTasks)
        ? statusOnly('ok')
        : statusOnly('error'))
    const errorInfo = forcedErrorInfo ?? [...agentResults.values()]
      .find((result) => result.status?.code === status.code && result.errorInfo !== undefined)
      ?.errorInfo

    return {
      success: status.code === 'ok',
      governanceConclusion: 'not-applicable',
      identity,
      status,
      ...(errorInfo !== undefined ? { errorInfo } : {}),
      goal,
      tasks,
      ...(planRevisions && planRevisions.length > 0 ? { planRevisions } : {}),
      agentResults: collapsed,
      taskResults,
      totalTokenUsage: totalUsage,
      metrics,
    }
  }

  private buildPlanOnlyTeamRunResult(
    agentResults: Map<string, AgentRunResult>,
    identity: RunIdentity,
    goal: string,
    queue: TaskQueue,
  ): TeamRunResult {
    const tasks: readonly TaskExecutionRecord[] = queue.list().map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: 'pending',
      dependsOn: task.dependsOn ?? [],
      description: task.description,
      memoryScope: task.memoryScope,
      dependencyPayload: task.dependencyPayload,
      role: task.role,
      priority: task.priority,
      metadata: task.metadata,
      requires: task.requires,
      maxRetries: task.maxRetries,
      retryDelayMs: task.retryDelayMs,
      retryBackoff: task.retryBackoff,
      verify: task.verify,
      metrics: undefined,
    }))
    return {
      ...this.buildTeamRunResult(agentResults, identity, goal, tasks, undefined, undefined, true),
      planOnly: true,
    }
  }
}
