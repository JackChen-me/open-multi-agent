/**
 * @fileoverview The orchestration loop: dispatch dependency-ready tasks in
 * parallel, run each assignee (with retry, model routing, streaming, tracing),
 * fold usage into the budget, run the optional per-task verify, persist results
 * to shared memory, and save checkpoints.
 *
 * Also owns delegation team-info assembly ({@link buildTaskAgentTeamInfo}) and
 * per-task prompt construction ({@link buildTaskPrompt}).
 */

import type { RunOptions } from '../agent/runner.js'
import type {
  AgentConfig,
  AgentRunResult,
  ApprovalDecisionRecord,
  ApprovalGateDecision,
  ApprovalRequest,
  ApprovalRequestContent,
  CheckpointSnapshot,
  OrchestratorEvent,
  StreamEvent,
  Task,
  TaskExecutionMetrics,
  TaskStatus,
  TaskVerificationOutcome,
  TeamInfo,
  TokenUsage,
} from '../types.js'
import type { AgentPool } from '../agent/pool.js'
import type { Team } from '../team/team.js'
import type { TaskQueue } from '../task/queue.js'
import { taskMetadataTraceAttributes } from '../task/metadata.js'
import type { Checkpoint } from '../memory/checkpoint.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { classifyRunFailure, statusOnly } from '../observability/status.js'
import type { TraceRuntime, TraceSpan } from '../observability/runtime.js'
import {
  ZERO_USAGE,
  DEFAULT_MODEL,
  errorMessage,
  prependRevealCoordinatorContext,
  buildRevealCoordinatorLines,
  type RunContext,
  type RevealCoordinatorContext,
} from './run-context.js'
import { InvalidTaskRequirementsError } from '../errors.js'
import { validateTaskRequirements } from './agent-selector.js'
import { recordRunUsage, buildCostEstimateContext } from './budget.js'
import {
  routeMatches,
  withModelRoute,
  routeChain,
  applyAgentDefaults,
  applyDefaultToolPreset,
  buildAgent,
  isLeafTask,
} from './agent-config.js'
import { executeWithRetry } from './retry.js'
import { runTaskVerify } from './consensus.js'
import {
  buildTaskOutcome,
  countAddedTasks,
  planPatchSignature,
  validatePlanPatchEligibility,
} from './recovery.js'
import {
  assertDurableTaskApprovalSupport,
  createApprovalRequest,
  DurableApprovalError,
} from '../approval/durable.js'

/**
 * Build {@link TeamInfo} for tool context, including nested `runDelegatedAgent`
 * that respects pool capacity to avoid semaphore deadlocks.
 *
 * Delegation always builds a **fresh** Agent instance for the target and runs
 * it via `pool.runEphemeral` — the pool semaphore still gates total concurrency,
 * but the per-agent lock is bypassed. This matches `delegate_to_agent`'s "runs
 * in a fresh conversation for this prompt only" contract and prevents mutual
 * delegation (A→B while B→A) from deadlocking on each other's agent locks.
 */
export function buildTaskAgentTeamInfo(
  ctx: RunContext,
  taskId: string,
  traceBase: Partial<RunOptions>,
  delegationDepth: number,
  delegationChain: readonly string[],
): TeamInfo {
  const sharedMem = ctx.team.getSharedMemoryInstance()
  const maxDepth = ctx.config.maxDelegationDepth
  const agentConfigs = ctx.team.getAgents()
  const agentNames = agentConfigs.map((a) => a.name)

  const runDelegatedAgent = async (
    targetAgent: string,
    prompt: string,
    delegatedParent?: unknown,
  ): Promise<AgentRunResult> => {
    const pool = ctx.pool
    if (pool.availableRunSlots < 1) {
      return {
        success: false,
        output:
          'Agent pool has no free concurrency slot for a delegated run (would deadlock). ' +
          'Increase maxConcurrency or reduce parallel delegation.',
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      }
    }

    const targetConfig = agentConfigs.find((a) => a.name === targetAgent)
    if (!targetConfig) {
      return {
        success: false,
        output: `Unknown agent "${targetAgent}" — not in team roster [${agentNames.join(', ')}].`,
        messages: [],
        tokenUsage: ZERO_USAGE,
        toolCalls: [],
      }
    }

    // Apply orchestrator-level defaults just like buildPool, then construct a
    // one-shot Agent for this delegation only.
    const route = routeMatches(ctx.modelRouting, {
      phase: 'delegated',
      agent: targetAgent,
      task: ctx.taskById.get(taskId),
      leaf: ctx.taskLeafById.get(taskId),
    })
    const effective: AgentConfig = withModelRoute(applyDefaultToolPreset(
      applyAgentDefaults(targetConfig, ctx.config),
      ctx.config.defaultToolPreset,
    ), route)
    const tempAgent = buildAgent(effective, { includeDelegateTool: true })

    const delegatedParentId = traceBase.traceSpanId ?? traceBase.traceParentId
    const delegatedSpanId = traceBase.onTrace ? generateSpanId() : undefined
    const childTraceBase: Partial<RunOptions> = {
      ...traceBase,
      traceAgent: targetAgent,
      taskId,
      ...(ctx.traceRuntime && delegatedParent ? {
        traceRuntime: ctx.traceRuntime,
        traceSpan: delegatedParent as TraceSpan,
        tracePhase: 'delegated',
        traceLinks: ctx.taskSpans.get(taskId) ? [{
          traceId: ctx.identity.traceId,
          spanId: ctx.taskSpans.get(taskId)!.spanId,
          relation: 'delegated_from' as const,
        }] : [],
      } : {}),
      ...(delegatedParentId ? { traceParentId: delegatedParentId } : {}),
      ...(delegatedSpanId ? { traceSpanId: delegatedSpanId } : {}),
    }
    const nestedTeam = buildTaskAgentTeamInfo(
      ctx,
      taskId,
      childTraceBase,
      delegationDepth + 1,
      [...delegationChain, targetAgent],
    )
    const childOpts: Partial<RunOptions> = {
      ...childTraceBase,
      team: nestedTeam,
    }
    return pool.runEphemeral(
      tempAgent,
      prependRevealCoordinatorContext(prompt, ctx.revealCoordinatorContext, targetAgent),
      childOpts,
    )
  }

  return {
    name: ctx.team.name,
    agents: agentNames,
    ...(sharedMem ? { sharedMemory: sharedMem.getStore() } : {}),
    delegationDepth,
    maxDelegationDepth: maxDepth,
    delegationPool: ctx.pool,
    delegationChain,
    runDelegatedAgent,
  }
}

export async function saveRunCheckpoint(queue: TaskQueue, ctx: RunContext): Promise<boolean> {
  const active = ctx.checkpoint
  if (!active) return true
  const checkpointSpan = ctx.traceRuntime?.startSpan({
    kind: 'checkpoint',
    name: 'save_checkpoint',
    parent: ctx.traceRuntime.root,
    attributes: { 'oma.checkpoint.mode': active.mode },
  })

  // Best-effort: a checkpoint write must never take down the run it protects.
  // Both snapshot construction and the store write are guarded, so a failing
  // store (e.g. a transient Redis/SQLite error) is surfaced via `onProgress`
  // and the run continues — the next safe runner or task boundary retries it.
  const save = async (): Promise<void> => {
    const sharedMem = ctx.team.getSharedMemoryInstance()
    const completedTaskResults = queue.getByStatus('completed').map((task) => {
      const agentResult = task.assignee === undefined
        ? undefined
        : ctx.agentResults.get(`${task.assignee}:${task.id}`)
      const checkpointAgentResult = agentResult === undefined
        ? undefined
        : toCheckpointAgentResult(agentResult)
      return {
        taskId: task.id,
        ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
        ...(task.result !== undefined ? { result: task.result } : {}),
        ...(checkpointAgentResult !== undefined
          ? { agentResult: checkpointAgentResult }
          : {}),
      }
    })

    const pendingApprovals = new Map(active.pendingApprovals)
    for (const state of active.inFlightTasks.values()) {
      for (const pending of state.pendingToolCalls ?? []) {
        if (pending.approvalRequest && !pending.commit) {
          pendingApprovals.set(pending.approvalRequest.id, pending.approvalRequest)
        }
      }
    }

    const snapshot: CheckpointSnapshot = {
      version: 4,
      mode: active.mode,
      createdAt: new Date().toISOString(),
      ...(ctx.metadata !== undefined ? { metadata: ctx.metadata } : {}),
      identity: {
        runId: ctx.identity.runId,
        attempt: ctx.identity.attempt,
        lastTraceId: ctx.identity.traceId,
        lastRootSpanId: ctx.identity.rootSpanId,
      },
      ...(active.goal !== undefined ? { goal: active.goal } : {}),
      queue: queue.snapshot(),
      // When the checkpoint store IS the shared-memory store, the entries are
      // already durable there — embedding a full snapshot at every boundary would
      // be ~O(N^2) write volume. Persist only the turn counter (cheap) so TTL
      // expiry stays correct; restore reads the entries straight from the store.
      ...(sharedMem && !active.reusesSharedMemoryStore
        ? { sharedMemory: await sharedMem.snapshot() }
        : {}),
      messageBus: ctx.team.snapshotMessageBus(),
      ...(sharedMem ? { turnCount: sharedMem.getTurnCount() } : {}),
      completedTaskResults,
      inFlightTasks: [...active.inFlightTasks.values()],
      pendingApprovals: [...pendingApprovals.values()],
      approvalDecisions: [...active.approvalDecisions.values()],
    }

    await active.manager.save(snapshot)
  }

  const nextSave = active.saveChain.catch(() => undefined).then(save)
  // Keep the stored chain non-rejecting so a failed save never leaves an
  // unhandled rejection or blocks the next checkpoint in the chain.
  active.saveChain = nextSave.catch(() => undefined)
  try {
    await nextSave
    checkpointSpan?.end({ status: statusOnly('ok') })
    // The watermark is the recorder's high-water mark at save time: which
    // journal events this snapshot already folds in.
    ctx.journal?.emit({
      type: 'checkpoint/saved',
      mode: active.mode,
      version: 4,
      watermarkSeq: ctx.journal.lastSeq,
    })
    return true
  } catch (error) {
    const classified = classifyRunFailure(error, { kind: 'store' })
    checkpointSpan?.event('checkpoint_failed', {})
    checkpointSpan?.end({ status: classified.status, error: classified.errorInfo })
    ctx.config.onProgress?.({
      type: 'error',
      data: { kind: 'checkpoint_save_failed', error },
    } satisfies OrchestratorEvent)
    return false
  }
}

interface NormalizedApprovalDecision {
  readonly action: 'allow' | 'deny' | 'suspend'
  readonly reason?: string
}

function normalizeApprovalDecision(
  value: ApprovalGateDecision,
  callbackName: string,
): NormalizedApprovalDecision {
  if (value === true) return { action: 'allow' }
  if (value === false) return { action: 'deny' }
  if (value === null || typeof value !== 'object') {
    throw new Error(`${callbackName} returned an invalid approval decision.`)
  }
  if (value.action !== 'allow' && value.action !== 'deny' && value.action !== 'suspend') {
    throw new Error(`${callbackName} returned an invalid approval decision.`)
  }
  if ('reason' in value && value.reason !== undefined && typeof value.reason !== 'string') {
    throw new Error(`${callbackName} returned an invalid approval reason.`)
  }
  const reason = 'reason' in value ? value.reason : undefined
  return reason === undefined
    ? { action: value.action }
    : { action: value.action, reason }
}

function approvalCandidate(
  ctx: RunContext,
  scope: ApprovalRequest['scope'],
  boundary: string,
  content: ApprovalRequestContent,
): ApprovalRequest {
  return createApprovalRequest({
    runId: ctx.identity.runId,
    scope,
    boundary,
    content,
  })
}

function consumeApprovedBoundary(
  ctx: RunContext,
  candidate: ApprovalRequest,
): ApprovalDecisionRecord | undefined {
  const active = ctx.checkpoint
  const decision = active?.approvedBoundaries.get(candidate.id)
  if (!decision || decision.requestHash !== candidate.requestHash) return undefined
  active!.approvedBoundaries.delete(candidate.id)
  active!.pendingApprovals.delete(candidate.id)
  return decision
}

function approvedDispatchTaskId(ctx: RunContext): string | undefined {
  const active = ctx.checkpoint
  if (!active) return undefined
  for (const request of active.pendingApprovals.values()) {
    if (
      request.content.kind === 'task_dispatch'
      && active.approvedBoundaries.has(request.id)
    ) {
      return request.content.task.id
    }
  }
  return undefined
}

/** Persist a boundary before exposing it to an out-of-process reviewer. */
export async function persistPendingApproval(
  queue: TaskQueue,
  ctx: RunContext,
  request: ApprovalRequest,
): Promise<void> {
  const active = ctx.checkpoint
  if (!active) {
    throw new DurableApprovalError(
      'APPROVAL_ATOMIC_STORE_REQUIRED',
      'A suspend decision requires durable checkpoint configuration.',
    )
  }
  active.approvalLedger.assertAtomicSupport()
  active.pendingApprovals.set(request.id, request)
  const saved = await saveRunCheckpoint(queue, ctx)
  if (!saved) {
    active.pendingApprovals.delete(request.id)
    throw new DurableApprovalError(
      'APPROVAL_INTEGRITY_ERROR',
      'The approval boundary could not be checkpointed; suspension was not reported.',
    )
  }
  await active.approvalLedger.ensureRequest(request)
  // Journaled after the ledger accepted it. Durability here is the ledger's
  // job; the journal only records that the boundary existed.
  ctx.journal?.emit({ type: 'approval/request', request })
  ctx.config.onProgress?.({
    type: 'approval_pending',
    data: request,
  } satisfies OrchestratorEvent)
}

function toCheckpointAgentResult(
  result: AgentRunResult,
): Omit<AgentRunResult, 'error'> | undefined {
  const { error: _error, ...candidate } = result
  try {
    return JSON.parse(JSON.stringify(candidate)) as Omit<AgentRunResult, 'error'>
  } catch {
    // A custom structured value or tool input can be non-JSON-safe. Preserve
    // checkpoint durability and let restore use the legacy minimal task result.
    return undefined
  }
}

type DispatchGateResult = 'allow' | 'abort' | 'budget' | 'capacity'

/**
 * Synchronous dispatch-admission seam. AgentPool's semaphore remains the
 * concurrency authority; future task-specific resource policies can compose
 * here without changing queue or execution-loop topology.
 */
function evaluateDispatchGate(
  ctx: RunContext,
  inFlightCount: number,
): DispatchGateResult {
  if (ctx.abortSignal?.aborted) return 'abort'
  if (ctx.budgetExceededTriggered) return 'budget'
  if (inFlightCount >= ctx.pool.runConcurrencyLimit) return 'capacity'
  return 'allow'
}

async function applyRecoveryAtOutcome(
  queue: TaskQueue,
  task: Task,
  result: AgentRunResult,
  verification: TaskVerificationOutcome | undefined,
  ctx: RunContext,
): Promise<boolean> {
  const recovery = ctx.recovery
  if (recovery.mode === 'fixed' || !recovery.onTaskOutcome) return false

  const trigger = verification?.verdict === 'rejected'
    ? 'verification_rejected' as const
    : result.success
      ? 'success' as const
      : 'failure' as const

  // A patch may have been durably committed immediately before a crash while
  // this trigger task was still in_progress. Restore resets the task, so do not
  // append the same repair a second time when it settles again.
  if (queue.getPlanRevisions().some((revision) =>
    revision.triggerTaskId === task.id && revision.trigger === trigger)) {
    ctx.config.onProgress?.({
      type: 'recovery_decision',
      task: task.id,
      data: { decision: 'already_applied', trigger, planRevision: queue.getPlanRevision() },
    })
    return false
  }

  const tokenUsed = ctx.cumulativeUsage.input_tokens + ctx.cumulativeUsage.output_tokens
  const outcome = buildTaskOutcome({
    queue,
    task: queue.get(task.id) ?? task,
    result,
    verification,
    ...(ctx.maxTokenBudget !== undefined
      ? { tokenBudgetRemaining: Math.max(0, ctx.maxTokenBudget - tokenUsed) }
      : {}),
    ...(ctx.maxCostBudget !== undefined
      ? { costBudgetRemaining: Math.max(0, ctx.maxCostBudget - ctx.cumulativeCost) }
      : {}),
  })

  const policySpan = ctx.traceRuntime?.startSpan({
    kind: 'callback',
    name: 'recovery_policy_callback',
    parent: ctx.taskSpans.get(task.id) ?? ctx.traceRuntime?.root,
    attributes: {
      'oma.callback.name': 'onTaskOutcome',
      'oma.task.id': task.id,
      'oma.plan.trigger': trigger,
    },
  })
  let patch
  try {
    patch = await recovery.onTaskOutcome(outcome)
  } catch (error) {
    const classified = classifyRunFailure(error, { kind: 'callback' })
    policySpan?.end({ status: classified.status, error: classified.errorInfo })
    ctx.config.onProgress?.({
      type: 'error',
      task: task.id,
      data: { kind: 'recovery_policy_failed', error },
    })
    return false
  }
  policySpan?.event('recovery_decision', { 'oma.recovery.proposed': patch !== undefined })
  policySpan?.end({ status: statusOnly('ok') })
  if (!patch) {
    ctx.config.onProgress?.({
      type: 'recovery_decision',
      task: task.id,
      data: { decision: 'no_patch', trigger, planRevision: queue.getPlanRevision() },
    })
    return false
  }

  if (queue.getPlanRevision() >= recovery.maxPlanRevisions) {
    ctx.config.onProgress?.({
      type: 'warning',
      task: task.id,
      data: {
        code: 'RECOVERY_REVISION_LIMIT',
        maxPlanRevisions: recovery.maxPlanRevisions,
      },
    })
    return false
  }
  const addedSoFar = countAddedTasks(queue.getPlanRevisions())
  const requestedAdded = patch.addTasks?.length ?? 0
  if (addedSoFar + requestedAdded > recovery.maxAddedTasks) {
    ctx.config.onProgress?.({
      type: 'warning',
      task: task.id,
      data: {
        code: 'RECOVERY_ADDED_TASK_LIMIT',
        maxAddedTasks: recovery.maxAddedTasks,
        requestedAdded,
        addedSoFar,
      },
    })
    return false
  }
  const signature = planPatchSignature(patch)
  if (ctx.recoveryPatchSignatures.has(signature)) {
    ctx.config.onProgress?.({
      type: 'warning',
      task: task.id,
      data: { code: 'RECOVERY_PATCH_REPEATED' },
    })
    return false
  }

  try {
    validatePlanPatchEligibility(patch, queue, ctx.team.getAgents(), {
      defaultProvider: ctx.config.defaultProvider,
      defaultToolPreset: ctx.config.defaultToolPreset,
    })
  } catch (error) {
    ctx.config.onProgress?.({
      type: 'warning',
      task: task.id,
      data: { code: 'RECOVERY_PATCH_INELIGIBLE', error },
    })
    return false
  }

  if (recovery.onPlanPatch) {
    const approvalSpan = ctx.traceRuntime?.startSpan({
      kind: 'callback',
      name: 'plan_patch_approval_callback',
      parent: ctx.taskSpans.get(task.id) ?? ctx.traceRuntime?.root,
      attributes: {
        'oma.callback.name': 'onPlanPatch',
        'oma.task.id': task.id,
        'oma.plan.trigger': trigger,
      },
    })
    let approved = false
    try {
      approved = await recovery.onPlanPatch(patch, outcome)
    } catch (error) {
      const classified = classifyRunFailure(error, { kind: 'callback' })
      approvalSpan?.end({ status: classified.status, error: classified.errorInfo })
      ctx.config.onProgress?.({
        type: 'error',
        task: task.id,
        data: { kind: 'recovery_approval_failed', error },
      })
      return false
    }
    approvalSpan?.event('approval_decision', { 'oma.approval.approved': approved })
    approvalSpan?.end({ status: statusOnly(approved ? 'ok' : 'rejected') })
    if (!approved) {
      ctx.config.onProgress?.({
        type: 'recovery_decision',
        task: task.id,
        data: { decision: 'rejected', trigger, planRevision: queue.getPlanRevision() },
      })
      return false
    }
  }

  const revisionSpan = ctx.traceRuntime?.startSpan({
    kind: 'plan',
    name: 'apply_plan_revision',
    parent: ctx.taskSpans.get(task.id) ?? ctx.traceRuntime.root,
    attributes: {
      'oma.plan.revision.previous': queue.getPlanRevision(),
      'oma.plan.trigger': trigger,
      'oma.task.id': task.id,
    },
  })

  let applied
  try {
    applied = queue.applyPlanPatch(patch, task.id, trigger)
  } catch (error) {
    const classified = classifyRunFailure(error, { kind: 'validation' })
    revisionSpan?.end({ status: classified.status, error: classified.errorInfo })
    ctx.config.onProgress?.({
      type: 'warning',
      task: task.id,
      data: { code: 'RECOVERY_PATCH_INVALID', error },
    })
    return false
  }

  const durable = await saveRunCheckpoint(queue, ctx)
  if (!durable && ctx.checkpoint) {
    queue.restorePlanSnapshot(applied.before)
    revisionSpan?.end({
      status: statusOnly('error', 'Plan revision checkpoint failed.'),
      error: {
        kind: 'store',
        code: 'PLAN_REVISION_NOT_DURABLE',
        message: 'Plan revision was rolled back because its checkpoint failed.',
      },
    })
    ctx.config.onProgress?.({
      type: 'warning',
      task: task.id,
      data: {
        code: 'PLAN_REVISION_NOT_DURABLE',
        revision: applied.revision.version,
      },
    })
    return false
  }

  ctx.recoveryPatchSignatures.add(signature)
  queue.publishPlanRevision(applied.revision)
  const tasks = queue.list()
  ctx.taskById.clear()
  ctx.taskLeafById.clear()
  for (const candidate of tasks) {
    ctx.taskById.set(candidate.id, candidate)
    ctx.taskLeafById.set(candidate.id, isLeafTask(candidate, tasks))
  }
  revisionSpan?.event('plan_revision_applied', {
    'oma.plan.revision': applied.revision.version,
    'oma.plan.added_tasks': Object.keys(applied.revision.addedTasks).length,
    'oma.plan.superseded_tasks': applied.revision.supersededTaskIds.length,
    'oma.plan.retargeted_tasks': applied.revision.retargetedTasks.length,
  })
  revisionSpan?.end({
    status: statusOnly('ok'),
    attributes: { 'oma.plan.revision': applied.revision.version },
  })
  // Journaled only after the patch committed and its checkpoint survived the
  // rollback check above, so the journal never names a revision the run
  // discarded.
  ctx.journal?.emit({
    type: 'plan/set',
    taskId: task.id,
    revision: applied.revision.version,
    source: 'recovery',
    tasks: tasks.map((candidate) => ({
      taskId: candidate.id,
      ...(candidate.description !== undefined ? { description: candidate.description } : {}),
      ...(candidate.assignee !== undefined ? { assignee: candidate.assignee } : {}),
      ...(candidate.dependsOn !== undefined ? { dependsOn: candidate.dependsOn } : {}),
    })),
    detail: applied.revision,
  })
  ctx.config.onProgress?.({
    type: 'plan_revision',
    task: task.id,
    data: applied.revision,
  })
  ctx.config.onProgress?.({
    type: 'recovery_decision',
    task: task.id,
    data: {
      decision: 'applied',
      trigger,
      planRevision: applied.revision.version,
    },
  })
  return true
}

/**
 * Execute all tasks in `queue` using agents in `pool`, respecting dependencies
 * and running independent tasks in parallel.
 *
 * By default the loop subscribes to `'task:ready'`, assigns each newly-ready
 * task against the current queue snapshot, and dispatches it as soon as the
 * AgentPool concurrency gate admits another task. Configuring the legacy
 * `onApproval` callback selects the round-based compatibility loop because
 * that callback's arguments and timing are defined in terms of batches.
 */
export async function executeQueue(
  queue: TaskQueue,
  ctx: RunContext,
): Promise<void> {
  const { team, pool, scheduler, config } = ctx
  const legacyRoundMode = config.onApproval !== undefined
  if (legacyRoundMode && ctx.recovery.mode !== 'fixed') {
    throw new Error('Runtime recovery is incompatible with legacy onApproval round scheduling.')
  }
  const readyTaskIds = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const dispatchErrors: unknown[] = []
  let stopDispatch: { readonly reason: string } | undefined
  let suspendDispatch = false
  let fatalError: unknown
  let wakeCount = 0
  let wakeResolver: (() => void) | undefined

  const signalLoop = (): void => {
    wakeCount++
    wakeResolver?.()
    wakeResolver = undefined
  }

  const waitForSignal = async (): Promise<void> => {
    if (wakeCount === 0) {
      await new Promise<void>((resolve) => {
        wakeResolver = resolve
      })
    }
    wakeCount = 0
  }

  const requestStop = (reason: string): void => {
    stopDispatch ??= { reason }
    signalLoop()
  }

  const requestSuspend = (): void => {
    suspendDispatch = true
    signalLoop()
  }

  const requestAbortStop = (): void => {
    if (stopDispatch) return
    const abortError = new Error('Run cancelled by caller.')
    abortError.name = 'AbortError'
    const classified = classifyRunFailure(abortError)
    ctx.outcomeStatus = classified.status
    ctx.outcomeErrorInfo = classified.errorInfo
    requestStop('Skipped: run aborted.')
  }

  const requestTerminalGateStop = (): boolean => {
    const dispatchGate = evaluateDispatchGate(ctx, inFlight.size)
    if (dispatchGate === 'abort') {
      requestAbortStop()
      return true
    }
    if (dispatchGate === 'budget') {
      requestStop(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
      return true
    }
    return false
  }

  // Relay queue-level skip events to the orchestrator's onProgress callback.
  const unsubSkipped = config.onProgress
    ? queue.on('task:skipped', (task) => {
        config.onProgress!({
          type: 'task_skipped',
          task: task.id,
          data: task,
        } satisfies OrchestratorEvent)
      })
    : undefined

  // Terminal task transitions are journaled from the queue rather than the
  // dispatch loop, so cascaded failures and skips — which no dispatch site
  // ever sees — are recorded too.
  const unsubJournal = ctx.journal
    ? (['task:complete', 'task:failed', 'task:skipped'] as const).map((event) =>
        queue.on(event, (task) => {
          ctx.journal!.emit({
            type: 'task/status',
            taskId: task.id,
            ...(task.assignee !== undefined ? { agentName: task.assignee } : {}),
            status: task.status,
            // `result` is the failure or skip explanation on those paths; on
            // completion it is the task output, which `memory/set` and the
            // run result already carry.
            ...(task.status !== 'completed' && task.result !== undefined
              ? { reason: task.result }
              : {}),
          })
        }))
    : undefined

  const unsubReady = !legacyRoundMode
    ? queue.on('task:ready', (task) => {
        readyTaskIds.add(task.id)
        signalLoop()
      })
    : undefined
  const unsubAllComplete = !legacyRoundMode
    ? queue.on('all:complete', signalLoop)
    : undefined
  const abortListener = !legacyRoundMode && ctx.abortSignal
    ? () => requestAbortStop()
    : undefined

  if (abortListener) {
    ctx.abortSignal!.addEventListener('abort', abortListener, { once: true })
  }
  if (!legacyRoundMode) {
    // Initial and restored ready events happened before executeQueue subscribed.
    for (const task of queue.getByStatus('pending')) {
      readyTaskIds.add(task.id)
    }
  }

  try {
    while (true) {
      // Legacy approval is checked only between complete rounds.
      if (legacyRoundMode && ctx.abortSignal?.aborted) {
        queue.skipRemaining('Skipped: run aborted.')
        const abortError = new Error('Run cancelled by caller.')
        abortError.name = 'AbortError'
        const classified = classifyRunFailure(abortError)
        ctx.outcomeStatus = classified.status
        ctx.outcomeErrorInfo = classified.errorInfo
        break
      }

      if (!legacyRoundMode) {
        const dispatchGate = evaluateDispatchGate(ctx, inFlight.size)
        if (dispatchGate === 'abort') requestAbortStop()
        if (dispatchGate === 'budget') {
          requestStop(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
        }
        if (
          dispatchErrors.length > 0
          && fatalError === undefined
          && stopDispatch === undefined
        ) {
          fatalError = dispatchErrors.shift()
          requestStop(
            `Skipped: task dispatch failed — ${
              fatalError instanceof Error ? fatalError.message : String(fatalError)
            }`,
          )
        }
        if (stopDispatch !== undefined && fatalError === undefined) {
          dispatchErrors.length = 0
        }

        if (ctx.outcomeStatus?.code === 'suspended') requestSuspend()

        // A durable suspension drains work that was already admitted but
        // preserves every not-yet-started task for restore.
        if (suspendDispatch) {
          if (inFlight.size > 0) {
            await waitForSignal()
            continue
          }
          await saveRunCheckpoint(queue, ctx)
          break
        }

        // drain-then-skip: once any terminal gate closes, no new task is
        // admitted. Existing task promises settle before the queue is skipped.
        if (stopDispatch) {
          if (inFlight.size > 0) {
            await waitForSignal()
            continue
          }
          queue.skipRemaining(stopDispatch.reason)
          if (fatalError !== undefined) throw fatalError
          break
        }

        // Reconcile the event-fed set with queue state. This also covers
        // restored queues and initial tasks whose ready event predated the
        // subscription above.
        for (const task of queue.getByStatus('pending')) {
          readyTaskIds.add(task.id)
        }
        for (const taskId of readyTaskIds) {
          if (queue.get(taskId)?.status !== 'pending') readyTaskIds.delete(taskId)
        }

        if (readyTaskIds.size === 0) {
          if (inFlight.size === 0) break
          await waitForSignal()
          continue
        }

        // The limit comes from AgentPool's semaphore. The queue does not own a
        // second concurrency setting; delegated runs remain accounted for and
        // enforced inside AgentPool.
        if (dispatchGate === 'capacity') {
          await waitForSignal()
          continue
        }
      }

      let pending: Task[]
      if (legacyRoundMode) {
        scheduler.autoAssign(queue, team.getAgents())
        pending = queue.getByStatus('pending')
      } else {
        // Queue completion makes dependents pending before completion
        // checkpoint/progress/span work settles. Do not start a dependent until
        // its predecessor's dispatch promise has finished, preserving paired
        // terminal/start event ordering.
        const readyTasks = [...readyTaskIds]
          .map((taskId) => queue.get(taskId))
          .filter((task): task is Task =>
            task?.status === 'pending'
            && !(task.dependsOn ?? []).some((dependencyId) => inFlight.has(dependencyId)),
          )
        const approvedTaskId = approvedDispatchTaskId(ctx)
        const nextReady = approvedTaskId === undefined
          ? scheduler.orderReadyTasks(readyTasks, queue.list())[0]
          : readyTasks.find((task) => task.id === approvedTaskId)

        if (approvedTaskId !== undefined && !nextReady) {
          throw new DurableApprovalError(
            'APPROVAL_STALE_DECISION',
            `Approved task-dispatch boundary "${approvedTaskId}" is no longer ready.`,
          )
        }

        if (!nextReady) {
          if (inFlight.size === 0) break
          await waitForSignal()
          continue
        }
        readyTaskIds.delete(nextReady.id)

        let assigned = nextReady
        if (!assigned.assignee) {
          try {
            const assignee = scheduler.scheduleTask(
              assigned,
              team.getAgents(),
              queue.list(),
            )
            if (assignee) assigned = queue.update(assigned.id, { assignee })
          } catch (error) {
            fatalError = error
            requestStop(
              `Skipped: task scheduling failed — ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
            continue
          }
        }

        if (config.onTaskDispatch && assigned.assignee) {
          const taskSnapshot = queue.snapshot().tasks.find((task) => task.id === assigned.id)
          if (!taskSnapshot) throw new Error(`Task "${assigned.id}" has no approval snapshot.`)
          const content = {
            kind: 'task_dispatch',
            task: taskSnapshot,
          } as const
          const candidate = approvalCandidate(
            ctx,
            'task_dispatch',
            assigned.id,
            content,
          )
          const priorApproval = consumeApprovedBoundary(ctx, candidate)
          const approvalSpan = ctx.traceRuntime?.startSpan({
            kind: 'callback',
            name: 'task_dispatch_callback',
            parent: ctx.traceRuntime.root,
            attributes: {
              'oma.callback.name': 'onTaskDispatch',
              'oma.task.id': assigned.id,
              'oma.task.title': assigned.title,
            },
          })
          let decision: NormalizedApprovalDecision = { action: 'allow' }
          if (!priorApproval) {
            try {
              decision = normalizeApprovalDecision(
                await config.onTaskDispatch(assigned),
                'onTaskDispatch',
              )
              if (decision.action === 'suspend') {
                assertDurableTaskApprovalSupport([assigned])
                const request = createApprovalRequest({
                  runId: ctx.identity.runId,
                  scope: 'task_dispatch',
                  boundary: assigned.id,
                  content,
                  ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
                })
                await persistPendingApproval(queue, ctx, request)
                ctx.outcomeStatus = statusOnly('suspended', 'Task dispatch approval pending.')
                requestSuspend()
              }
            } catch (error) {
              const classified = classifyRunFailure(error, { kind: 'callback' })
              approvalSpan?.end({ status: classified.status, error: classified.errorInfo })
              if (requestTerminalGateStop()) continue
              ctx.outcomeStatus = classified.status
              ctx.outcomeErrorInfo = classified.errorInfo
              requestStop(
                `Skipped: task dispatch callback error — ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
              continue
            }
          }

          approvalSpan?.event('approval_decision', {
            'oma.approval.decision': priorApproval ? 'approved' : decision.action,
          })
          approvalSpan?.end({
            status: statusOnly(
              priorApproval || decision.action === 'allow'
                ? 'ok'
                : decision.action === 'suspend'
                  ? 'suspended'
                  : 'rejected',
            ),
          })
          if (requestTerminalGateStop()) continue
          if (decision.action === 'suspend') continue
          if (decision.action === 'deny') {
            ctx.outcomeStatus = statusOnly('rejected', 'Task dispatch approval rejected.')
            requestStop('Skipped: task dispatch approval rejected.')
            continue
          }
        }

        pending = [assigned]
      }

      if (pending.length === 0) {
        // Either all done, or everything remaining is blocked/failed.
        break
      }

      // Used only by the legacy round approval callback. Pipeline mode admits
      // one ready task per loop iteration.
      const completedThisRound: Task[] = []

      const dispatchPromises = pending.map(async (task): Promise<void> => {
      const requirementIssues = validateTaskRequirements(
        [task],
        team.getAgents(),
        {
          defaultProvider: config.defaultProvider,
          defaultToolPreset: config.defaultToolPreset,
          includeDelegateTool: true,
          resolveCandidate: (candidateTask, candidate) => {
            const base = applyDefaultToolPreset(
              applyAgentDefaults(candidate, config),
              config.defaultToolPreset,
            )
            return withModelRoute(base, routeMatches(ctx.modelRouting, {
              phase: 'worker',
              agent: candidate.name,
              task: candidateTask,
              leaf: ctx.taskLeafById.get(candidateTask.id),
            }))
          },
        },
      )
      if (requirementIssues.length > 0) {
        throw new InvalidTaskRequirementsError(requirementIssues)
      }

      // Mark in-progress. The queue has no event for this transition, so it is
      // the one status the journal records from the dispatch site.
      queue.update(task.id, { status: 'in_progress' as TaskStatus })
      ctx.journal?.emit({
        type: 'task/status',
        taskId: task.id,
        ...(task.assignee !== undefined ? { agentName: task.assignee } : {}),
        status: 'in_progress',
      })

      const dependencyLinks = (task.dependsOn ?? []).flatMap((dependencyId) => {
        const dependencySpan = ctx.taskSpans.get(dependencyId)
        return dependencySpan ? [{
          traceId: ctx.identity.traceId,
          spanId: dependencySpan.spanId,
          relation: 'depends_on' as const,
        }] : []
      })
      const taskSpan = ctx.traceRuntime?.startSpan({
        kind: 'task',
        name: 'execute_task',
        parent: ctx.traceRuntime.root,
        links: dependencyLinks,
        attributes: {
          'oma.task.id': task.id,
          'oma.task.title': task.title,
          ...(task.assignee ? { 'oma.agent.name': task.assignee } : {}),
          ...(task.role ? { 'oma.task.role': task.role } : {}),
          ...taskMetadataTraceAttributes(task.metadata),
        },
      })
      if (taskSpan) ctx.taskSpans.set(task.id, taskSpan)

      try {
        const assignee = task.assignee
        if (!assignee) {
          // No assignee — mark failed and continue
          const msg = `Task "${task.title}" has no assignee.`
          queue.fail(task.id, msg)
          const classified = classifyRunFailure(new Error(msg), { kind: 'framework' })
          taskSpan?.end({ status: classified.status, error: classified.errorInfo })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            data: msg,
          } satisfies OrchestratorEvent)
          return
        }

        const agentConfig = team.getAgent(assignee)
        if (!agentConfig) {
          const msg = `Agent "${assignee}" not found in team for task "${task.title}".`
          queue.fail(task.id, msg)
          const classified = classifyRunFailure(new Error(msg), { kind: 'framework' })
          taskSpan?.end({ status: classified.status, error: classified.errorInfo })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: msg,
          } satisfies OrchestratorEvent)
          return
        }

        const agent = pool.get(assignee)
        if (!agent) {
          const msg = `Agent "${assignee}" not found in pool for task "${task.title}".`
          queue.fail(task.id, msg)
          const classified = classifyRunFailure(new Error(msg), { kind: 'framework' })
          taskSpan?.end({ status: classified.status, error: classified.errorInfo })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: msg,
          } satisfies OrchestratorEvent)
          return
        }

        config.onProgress?.({
          type: 'task_start',
          task: task.id,
          agent: assignee,
          data: task,
        } satisfies OrchestratorEvent)

        config.onProgress?.({
          type: 'agent_start',
          agent: assignee,
          task: task.id,
          data: task,
        } satisfies OrchestratorEvent)

        const taskStartMs = taskSpan?.startUnixMs ?? Date.now()
        const taskSpanId = config.onTrace ? generateSpanId() : undefined
        const agentSpanId = config.onTrace ? generateSpanId() : undefined
        const legacyTaskEvent = (
          success: boolean,
          endMs: number,
          retries: number,
        ) => config.onTrace ? {
            type: 'task',
            runId: ctx.runId ?? '',
            spanId: taskSpanId ?? generateSpanId(),
            taskId: task.id,
            taskTitle: task.title,
            ...(task.role !== undefined ? { taskRole: task.role } : {}),
            ...(task.metadata !== undefined ? { taskMetadata: task.metadata } : {}),
            agent: assignee,
            success,
            retries,
            startMs: taskStartMs,
            endMs,
            durationMs: endMs - taskStartMs,
          } as const : undefined

        // Build the prompt: task description + dependency-only context by default.
        let prompt: string
        try {
          prompt = await buildTaskPrompt(
            task,
            team,
            queue,
            ctx.revealCoordinatorContext,
            ctx.agentResults,
          )
        } catch (error) {
          if (!(error instanceof DependencyPayloadError)) throw error
          const taskEndMs = Date.now()
          const message = errorMessage(error)
          const classified = classifyRunFailure(error, { kind: 'validation' })
          const failure: AgentRunResult = {
            success: false,
            output: message,
            messages: [],
            tokenUsage: ZERO_USAGE,
            toolCalls: [],
            status: classified.status,
            errorInfo: classified.errorInfo,
            error,
          }
          ctx.agentResults.set(`${assignee}:${task.id}`, failure)
          ctx.taskMetrics.set(task.id, {
            startMs: taskStartMs,
            endMs: taskEndMs,
            durationMs: Math.max(0, taskEndMs - taskStartMs),
            tokenUsage: ZERO_USAGE,
            toolCalls: [],
            retries: 0,
          })
          queue.fail(task.id, message)
          const taskLegacyEvent = legacyTaskEvent(false, taskEndMs, 0)
          taskSpan?.end({
            status: classified.status,
            error: classified.errorInfo,
            ...(taskLegacyEvent ? { legacyEvent: taskLegacyEvent } : {}),
          })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: failure,
          } satisfies OrchestratorEvent)
          return
        }

        const restoredRunnerState = ctx.checkpoint?.inFlightTasks.get(task.id)
        const onRunnerCheckpoint = ctx.checkpoint
          ? async (state: Parameters<NonNullable<RunOptions['onCheckpoint']>>[0]) => {
              ctx.checkpoint!.inFlightTasks.set(task.id, state)
              const saved = await saveRunCheckpoint(queue, ctx)
              if (!saved) throw new Error('Runner checkpoint persistence failed.')
            }
          : undefined
        const onApprovalRequest = ctx.checkpoint
          ? async (request: ApprovalRequest) => {
              ctx.checkpoint!.pendingApprovals.set(request.id, request)
              await ctx.checkpoint!.approvalLedger.ensureRequest(request)
              ctx.journal?.emit({
                type: 'approval/request',
                taskId: task.id,
                agentName: assignee,
                request,
              })
              config.onProgress?.({
                type: 'approval_pending',
                task: task.id,
                agent: assignee,
                data: request,
              } satisfies OrchestratorEvent)
            }
          : undefined
        const onApprovalPrepare = ctx.checkpoint
          ? () => ctx.checkpoint!.approvalLedger.assertAtomicSupport()
          : undefined
        const onApprovalConsumed = ctx.checkpoint
          ? (requestId: string) => {
              ctx.checkpoint!.pendingApprovals.delete(requestId)
            }
          : undefined

        // Trace + abort + team tool context (delegate_to_agent)
        const traceBase: Partial<RunOptions> = {
          identity: ctx.identity,
          runId: ctx.runId,
          taskId: task.id,
          traceAgent: assignee,
          ...(ctx.traceRuntime ? {
            traceRuntime: ctx.traceRuntime,
            traceSpan: taskSpan ?? ctx.traceRuntime.root,
          } : {}),
          ...(config.onTrace
            ? {
                onTrace: config.onTrace,
                ...(taskSpanId ? { traceParentId: taskSpanId } : {}),
                ...(agentSpanId ? { traceSpanId: agentSpanId } : {}),
              }
            : {}),
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          ...(ctx.journal ? { journal: ctx.journal } : {}),
        }
        // On `traceBase` rather than `runOptions`, so delegated child runs
        // inherit the same recorder through `buildTaskAgentTeamInfo` and
        // journal under their own agent name in the one ordered stream.
        const runOptions: Partial<RunOptions> = {
          ...traceBase,
          team: buildTaskAgentTeamInfo(ctx, task.id, traceBase, 0, [assignee]),
          ...(restoredRunnerState ? { resumeState: restoredRunnerState } : {}),
          ...(onRunnerCheckpoint ? { onCheckpoint: onRunnerCheckpoint } : {}),
          ...(onApprovalPrepare ? { onApprovalPrepare } : {}),
          ...(onApprovalRequest ? { onApprovalRequest } : {}),
          ...(onApprovalConsumed ? { onApprovalConsumed } : {}),
        }
        const workerRoute = routeMatches(ctx.modelRouting, {
          phase: 'worker',
          agent: assignee,
          task,
          leaf: ctx.taskLeafById.get(task.id),
        })
        const workerBaseConfig = applyDefaultToolPreset(
          applyAgentDefaults(agentConfig, config),
          config.defaultToolPreset,
        )
        const routedConfigs = routeChain(workerRoute)
          .map(route => withModelRoute(workerBaseConfig, route))
          .filter(candidate =>
            validateTaskRequirements([task], [candidate], {
              defaultProvider: config.defaultProvider,
              defaultToolPreset: config.defaultToolPreset,
              includeDelegateTool: true,
            }).length === 0)
        const workerEffectiveConfig = routedConfigs[0] ?? workerBaseConfig
        const routedAgents = routedConfigs.map(route =>
          buildAgent(route, { includeDelegateTool: true }),
        )
        let routeIndex = 0
        let lastFailureWasRetryableProviderError = false
        let streamedErrorInfo: AgentRunResult['errorInfo']
        const attemptUsages: Array<{ readonly usage: TokenUsage; readonly config: AgentConfig }> = []
        const streamCallback = config.onAgentStream
          ? (event: StreamEvent) => {
              if (event.type === 'error') streamedErrorInfo = event.errorInfo
              const streamMs = Date.now()
              const legacyEvent = config.onTrace ? {
                  type: 'agent_stream',
                  runId: ctx.runId ?? '',
                  spanId: generateSpanId(),
                  ...(agentSpanId ? { parentId: agentSpanId } : {}),
                  taskId: task.id,
                  agent: assignee,
                  streamType: event.type,
                  startMs: streamMs,
                  endMs: streamMs,
                  durationMs: 0,
                } as const : undefined
              if (taskSpan) {
                taskSpan.event('stream_chunk', { 'oma.stream.type': event.type }, legacyEvent)
              } else if (legacyEvent) {
                emitTrace(config.onTrace, legacyEvent)
              }
              config.onAgentStream!(assignee, event)
            }
          : undefined

        let retryCount = 0

        const result = await executeWithRetry(
          async (attempt) => {
            if (attempt > 1 && ctx.checkpoint) {
              ctx.checkpoint.inFlightTasks.delete(task.id)
              await saveRunCheckpoint(queue, ctx)
            }
            const { resumeState: _resumeState, ...freshRunOptions } = runOptions
            const attemptRunOptions = attempt === 1 ? runOptions : freshRunOptions
            const activeRouteIndex = Math.min(routeIndex, routedAgents.length - 1)
            const routedAgent = routedAgents.length > 0
              ? routedAgents[activeRouteIndex]
              : undefined
            const activeConfig = routedConfigs.length > 0
              ? routedConfigs[activeRouteIndex]!
              : workerBaseConfig
            try {
              streamedErrorInfo = undefined
              const attemptResult = routedAgent
                ? await pool.runEphemeral(
                    routedAgent,
                    prompt,
                    { ...attemptRunOptions, traceAgentAttempt: attempt },
                    streamCallback,
                  )
                : await pool.run(
                    assignee,
                    prompt,
                    { ...attemptRunOptions, traceAgentAttempt: attempt },
                    streamCallback,
                  )
              attemptUsages.push({ usage: attemptResult.tokenUsage, config: activeConfig })
              lastFailureWasRetryableProviderError =
                !attemptResult.success
                && attemptResult.errorInfo?.kind === 'provider'
                && attemptResult.errorInfo.retryable === true
              return attemptResult
            } catch (error) {
              // Streaming errors are thrown by AgentPool after they have been
              // forwarded through onAgentStream. Use the source classification
              // attached by Agent rather than inferring it from the raw Error.
              lastFailureWasRetryableProviderError =
                streamedErrorInfo?.kind === 'provider'
                && streamedErrorInfo.retryable === true
              throw error
            }
          },
          task,
          (retryData) => {
            if (
              lastFailureWasRetryableProviderError
              && routeIndex < routedAgents.length - 1
            ) {
              routeIndex++
            }
            retryCount++
            taskSpan?.event('retry_scheduled', {
              'oma.retry.attempt': retryData.attempt,
              'oma.retry.max_attempts': retryData.maxAttempts,
              'oma.retry.delay_ms': retryData.nextDelayMs,
            })
            config.onProgress?.({
              type: 'task_retry',
              task: task.id,
              agent: assignee,
              data: retryData,
            } satisfies OrchestratorEvent)
          },
          undefined,
          { abortSignal: ctx.abortSignal },
        )

        if (result.error instanceof DurableApprovalError) throw result.error

        const taskEndMs = Date.now()

        const taskLegacyEvent = legacyTaskEvent(result.success, taskEndMs, retryCount)

        ctx.agentResults.set(`${assignee}:${task.id}`, result)

        ctx.taskMetrics.set(task.id, {
          startMs: taskStartMs,
          endMs: taskEndMs,
          durationMs: Math.max(0, taskEndMs - taskStartMs),
          tokenUsage: result.tokenUsage,
          toolCalls: result.toolCalls,
          retries: retryCount,
        })
        try {
          // Keep the existing aggregate estimate for a single route. A fallback
          // chain needs per-attempt contexts so each provider is priced correctly.
          const costAttempts = routedConfigs.length > 1
            ? attemptUsages
            : [{ usage: result.tokenUsage, config: workerEffectiveConfig }]
          for (const attemptUsage of costAttempts) {
            const budgetError = recordRunUsage(ctx, attemptUsage.usage, buildCostEstimateContext({
              agentName: assignee,
              model: attemptUsage.config.model ?? config.defaultModel ?? DEFAULT_MODEL,
              provider: attemptUsage.config.provider,
              phase: 'worker',
              taskId: task.id,
            }), assignee, task.id)
            if (budgetError) {
              taskSpan?.event('budget_exhausted', {})
            }
          }
        } catch (error) {
          const message = errorMessage(error)
          ctx.agentResults.set(`${assignee}:${task.id}`, {
            ...result,
            success: false,
            output: message,
            error,
          })
          ctx.checkpoint?.inFlightTasks.delete(task.id)
          queue.fail(task.id, message)
          const classified = classifyRunFailure(error, { kind: 'budget' })
          taskSpan?.event('budget_exhausted', {})
          taskSpan?.end({
            status: classified.status,
            error: classified.errorInfo,
            ...(taskLegacyEvent ? { legacyEvent: taskLegacyEvent } : {}),
          })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: message,
          } satisfies OrchestratorEvent)
          return
        }

        if (result.status?.code === 'suspended') {
          ctx.outcomeStatus = statusOnly(
            'suspended',
            'Durable approval required before task execution can continue.',
          )
          taskSpan?.end({
            status: ctx.outcomeStatus,
            attributes: { 'oma.task.retries': retryCount },
            ...(taskLegacyEvent ? { legacyEvent: taskLegacyEvent } : {}),
          })
          config.onProgress?.({
            type: 'agent_complete',
            agent: assignee,
            task: task.id,
            data: result,
          } satisfies OrchestratorEvent)
          return
        }

        if (result.success) {
          const sharedMem = team.getSharedMemoryInstance()

          // Opt-in consensus verification runs *before* the task is finalised so the
          // verified outcome (accepted → revised, rejected → original) flows into the
          // queue, shared memory, progress events, and agentResults as one consistent
          // result. Judge usage is charged to the same parent budget as the rest of the run.
          let effective = result
          let verification: TaskVerificationOutcome | undefined
          if (task.verify && !ctx.budgetExceededTriggered) {
            const verified = await runTaskVerify(task, assignee, result, sharedMem, ctx)
            effective = verified.result
            verification = verified.verification
          }

          // Reflect the verified result in the per-task record the caller receives.
          ctx.agentResults.set(`${assignee}:${task.id}`, effective)

          await applyRecoveryAtOutcome(queue, task, effective, verification, ctx)

          // Persist result into shared memory so other agents can read it
          if (sharedMem) {
            await sharedMem.write(assignee, `task:${task.id}:result`, effective.output)
            // The store stays authoritative for the value; the journal records
            // only that the write happened and how large it was.
            ctx.journal?.emit({
              type: 'memory/set',
              taskId: task.id,
              agentName: assignee,
              agent: assignee,
              key: `task:${task.id}:result`,
              valueBytes: Buffer.byteLength(effective.output, 'utf8'),
            })
            // Advance the turn counter so any TTL-tagged entries written during
            // this task can be expired by subsequent reads.
            sharedMem.advanceTurn()
          }

          ctx.checkpoint?.inFlightTasks.delete(task.id)
          const completedTask = queue.complete(task.id, effective.output)
          completedThisRound.push(completedTask)
          await saveRunCheckpoint(queue, ctx)

          config.onProgress?.({
            type: 'task_complete',
            task: task.id,
            agent: assignee,
            data: effective,
          } satisfies OrchestratorEvent)

          config.onProgress?.({
            type: 'agent_complete',
            agent: assignee,
            task: task.id,
            data: effective,
          } satisfies OrchestratorEvent)
          taskSpan?.end({
            status: effective.status ?? statusOnly(effective.success ? 'ok' : 'error'),
            ...(effective.errorInfo ? { error: effective.errorInfo } : {}),
            attributes: { 'oma.task.retries': retryCount },
            ...(taskLegacyEvent ? { legacyEvent: { ...taskLegacyEvent, success: effective.success } } : {}),
          })
        } else {
          await applyRecoveryAtOutcome(queue, task, result, undefined, ctx)
          ctx.checkpoint?.inFlightTasks.delete(task.id)
          queue.fail(task.id, result.output)
          taskSpan?.end({
            status: result.status ?? statusOnly('error', result.output),
            ...(result.errorInfo ? { error: result.errorInfo } : {}),
            attributes: { 'oma.task.retries': retryCount },
            ...(taskLegacyEvent ? { legacyEvent: taskLegacyEvent } : {}),
          })
          config.onProgress?.({
            type: 'error',
            task: task.id,
            agent: assignee,
            data: result,
          } satisfies OrchestratorEvent)
        }
      } finally {
        taskSpan?.ensureEnded()
      }
    })

      if (!legacyRoundMode) {
        const task = pending[0]!
        const taskPromise = dispatchPromises[0]!
        inFlight.set(task.id, taskPromise)
        void taskPromise.then(
          () => {
            inFlight.delete(task.id)
            if (ctx.outcomeStatus?.code === 'suspended') {
              requestSuspend()
            } else if (ctx.budgetExceededTriggered) {
              requestStop(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
            } else {
              signalLoop()
            }
          },
          (error) => {
            inFlight.delete(task.id)
            dispatchErrors.push(error)
            signalLoop()
          },
        )
        // Re-enter synchronously so another ready task can be assigned against
        // the now-in-progress queue snapshot without waiting for this task.
        continue
      }

      // Compatibility mode deliberately retains the complete batch barrier.
      await Promise.all(dispatchPromises)
      if (ctx.outcomeStatus?.code === 'suspended') {
        await saveRunCheckpoint(queue, ctx)
        break
      }
      if (ctx.budgetExceededTriggered) {
        queue.skipRemaining(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
        break
      }

      // --- Legacy round approval gate ---
      if (config.onApproval && completedThisRound.length > 0) {
        scheduler.autoAssign(queue, team.getAgents())
        const nextPending = queue.getByStatus('pending')

        if (nextPending.length > 0) {
          const taskSnapshots = new Map(
            queue.snapshot().tasks.map((task) => [task.id, task]),
          )
          const content = {
            kind: 'task_round',
            completedTasks: completedThisRound.map((task) => taskSnapshots.get(task.id)!),
            nextTasks: nextPending.map((task) => taskSnapshots.get(task.id)!),
          } as const
          const boundary = [
            completedThisRound.map((task) => task.id).join(','),
            nextPending.map((task) => task.id).join(','),
          ].join('->')
          const candidate = approvalCandidate(ctx, 'task_round', boundary, content)
          const priorApproval = consumeApprovedBoundary(ctx, candidate)
          const approvalSpan = ctx.traceRuntime?.startSpan({
            kind: 'callback',
            name: 'approval_callback',
            parent: ctx.traceRuntime.root,
            attributes: { 'oma.callback.name': 'onApproval' },
          })
          let decision: NormalizedApprovalDecision = { action: 'allow' }
          if (!priorApproval) {
            try {
              decision = normalizeApprovalDecision(
                await config.onApproval(completedThisRound, nextPending),
                'onApproval',
              )
              if (decision.action === 'suspend') {
                assertDurableTaskApprovalSupport(nextPending)
                const request = createApprovalRequest({
                  runId: ctx.identity.runId,
                  scope: 'task_round',
                  boundary,
                  content,
                  ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
                })
                await persistPendingApproval(queue, ctx, request)
                ctx.outcomeStatus = statusOnly('suspended', 'Round approval pending.')
              }
            } catch (err) {
              const reason = `Skipped: approval callback error — ${err instanceof Error ? err.message : String(err)}`
              queue.skipRemaining(reason)
              const classified = classifyRunFailure(err, { kind: 'callback' })
              approvalSpan?.end({ status: classified.status, error: classified.errorInfo })
              ctx.outcomeStatus = classified.status
              ctx.outcomeErrorInfo = classified.errorInfo
              break
            }
          }
          if (decision.action === 'suspend') {
            approvalSpan?.event('approval_decision', { 'oma.approval.decision': 'suspend' })
            approvalSpan?.end({ status: statusOnly('suspended') })
            break
          }
          if (decision.action === 'deny') {
            approvalSpan?.event('approval_decision', { 'oma.approval.approved': false })
            approvalSpan?.end({ status: statusOnly('rejected') })
            queue.skipRemaining('Skipped: approval rejected.')
            ctx.outcomeStatus = statusOnly('rejected', 'Approval rejected.')
            break
          }
          approvalSpan?.event('approval_decision', {
            'oma.approval.approved': true,
            ...(priorApproval ? { 'oma.approval.durable': true } : {}),
          })
          approvalSpan?.end({ status: statusOnly('ok') })
        }
      }
    }
  } finally {
    if (abortListener) ctx.abortSignal!.removeEventListener('abort', abortListener)
    unsubAllComplete?.()
    unsubReady?.()
    unsubSkipped?.()
    for (const unsubscribe of unsubJournal ?? []) unsubscribe()
  }
}

/**
 * Build the agent prompt for a specific task.
 *
 * Injects:
 *  - Optional team-context block at the top when `revealContext` is provided
 *    (set via `RunTeamOptions.revealCoordinator`)
 *  - Task title and description
 *  - Direct dependency task results by default (clean slate when none)
 *  - Optional full shared-memory context when `task.memoryScope === 'all'`
 *  - Any messages addressed to this agent from the team bus
 */
export async function buildTaskPrompt(
  task: Task,
  team: Team,
  queue: TaskQueue,
  revealContext?: RevealCoordinatorContext,
  agentResults?: ReadonlyMap<string, AgentRunResult>,
): Promise<string> {
  const lines: string[] = []

  // `task.assignee` is belt-and-suspenders: `executeQueue` already fails any
  // task without an assignee before reaching this function (see the assignee
  // check in the dispatch loop). The guard here documents the precondition and
  // protects against future refactors that move the call site.
  if (revealContext && task.assignee) {
    lines.push(...buildRevealCoordinatorLines(revealContext, task.assignee))
  }

  lines.push(
    `# Task: ${task.title}`,
    '',
    task.description,
  )

  if (task.memoryScope === 'all') {
    // Explicit opt-in for full visibility (legacy/shared-memory behavior).
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      const summary = await sharedMem.getSummary()
      if (summary) {
        lines.push('', summary)
      }
    }
  } else if (task.dependsOn && task.dependsOn.length > 0) {
    // Default-deny: inject only explicit prerequisite outputs.
    const depResults: string[] = []
    for (const depId of task.dependsOn) {
      const depTask = queue.get(depId)
      if (depTask?.status !== 'completed') continue

      const heading = `### ${depTask.title} (by ${depTask.assignee ?? 'unknown'})`
      const payloadMode = task.dependencyPayload ?? 'output'
      if (payloadMode === 'output') {
        if (depTask.result) depResults.push(`${heading}\n${depTask.result}`)
        continue
      }

      const dependencyResult = depTask.assignee === undefined
        ? undefined
        : agentResults?.get(`${depTask.assignee}:${depTask.id}`)
      if (!dependencyResult?.success || dependencyResult.structured === undefined) {
        throw new DependencyPayloadError(
          'DEPENDENCY_STRUCTURED_RESULT_MISSING',
          `Task "${task.title}" requires a structured result from dependency ` +
            `"${depTask.title}" (${depTask.id}), but none is available.`,
        )
      }

      let structured: string
      try {
        structured = stableJsonStringify(dependencyResult.structured)
      } catch {
        throw new DependencyPayloadError(
          'DEPENDENCY_STRUCTURED_SERIALIZATION_FAILED',
          `Task "${task.title}" could not serialize the structured result from ` +
            `dependency "${depTask.title}" (${depTask.id}).`,
        )
      }

      const payload = payloadMode === 'structured'
        ? `${heading}\n#### Validated structured result\n${structured}`
        : [
            heading,
            '#### Raw output',
            depTask.result ?? dependencyResult.output,
            '',
            '#### Validated structured result',
            structured,
          ].join('\n')
      assertDependencyPayloadSize(task, depTask, payload)
      depResults.push(payload)
    }
    if (depResults.length > 0) {
      lines.push('', '## Context from prerequisite tasks', '', ...depResults)
    }
  }

  // Inject messages from other agents addressed to this assignee
  if (task.assignee) {
    const messages = team.getMessages(task.assignee)
    if (messages.length > 0) {
      lines.push('', '## Messages from team members')
      for (const msg of messages) {
        lines.push(`- **${msg.from}**: ${msg.content}`)
      }
    }
  }

  return lines.join('\n')
}

const MAX_DEPENDENCY_PAYLOAD_BYTES = 64 * 1_024

class DependencyPayloadError extends Error {
  constructor(
    readonly code:
      | 'DEPENDENCY_STRUCTURED_RESULT_MISSING'
      | 'DEPENDENCY_STRUCTURED_SERIALIZATION_FAILED'
      | 'DEPENDENCY_PAYLOAD_TOO_LARGE',
    message: string,
  ) {
    super(message)
    this.name = 'DependencyPayloadError'
  }
}

function assertDependencyPayloadSize(task: Task, dependency: Task, payload: string): void {
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes <= MAX_DEPENDENCY_PAYLOAD_BYTES) return
  throw new DependencyPayloadError(
    'DEPENDENCY_PAYLOAD_TOO_LARGE',
    `Task "${task.title}" dependency payload from "${dependency.title}" ` +
      `is ${bytes} bytes; the limit is ${MAX_DEPENDENCY_PAYLOAD_BYTES} bytes.`,
  )
}

function stableJsonStringify(value: unknown): string {
  const normalized = normalizeJsonValue(value, new Set<object>())
  const serialized = JSON.stringify(normalized)
  if (serialized === undefined) {
    throw new TypeError('Structured dependency result is not JSON-serializable.')
  }
  return serialized
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') throw new TypeError('BigInt is not JSON-serializable.')
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }

  const object = value as object
  if (ancestors.has(object)) throw new TypeError('Circular structured dependency result.')
  ancestors.add(object)
  try {
    if (value instanceof Date) return value.toJSON()
    if (Array.isArray(value)) {
      return value.map(item => normalizeJsonValue(item, ancestors) ?? null)
    }

    const record = value as Record<string, unknown> & { toJSON?: () => unknown }
    if (typeof record.toJSON === 'function') {
      return normalizeJsonValue(record.toJSON(), ancestors)
    }

    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const child = normalizeJsonValue(record[key], ancestors)
      if (child !== undefined) normalized[key] = child
    }
    return normalized
  } finally {
    ancestors.delete(object)
  }
}
