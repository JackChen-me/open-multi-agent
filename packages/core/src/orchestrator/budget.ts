/**
 * @fileoverview Token/cost budget accounting and run-level metrics rollup.
 *
 * Owns cumulative usage/cost tracking, budget-cap enforcement (emitting
 * {@link TokenBudgetExceededError} / {@link CostBudgetExceededError}), the
 * `budget_exceeded` progress event, and the post-run {@link RunMetrics} rollup.
 */

import type {
  AgentConfig,
  CostEstimateContext,
  OrchestratorConfig,
  OrchestratorEvent,
  RunMetrics,
  TaskExecutionRecord,
  TokenUsage,
} from '../types.js'
import { CostBudgetExceededError, TokenBudgetExceededError } from '../errors.js'
import { classifyRunFailure } from '../observability/status.js'
import { addUsage, totalTokens, type RunContext } from './run-context.js'

export function computeRunMetrics(
  tasks?: readonly TaskExecutionRecord[],
): RunMetrics | undefined {
  if (!tasks || tasks.length === 0) return undefined

  let inputTokens = 0
  let outputTokens = 0
  let totalRetries = 0
  let errorCount = 0
  let failureCount = 0
  let completedCount = 0
  let minTaskDurationMs: number | undefined
  let maxTaskDurationMs: number | undefined
  let totalDurationMs = 0

  for (const task of tasks) {
    if (task.status === 'failed') {
      failureCount++
    }
    if (task.status === 'failed' || task.status === 'skipped' || task.status === 'blocked') {
      errorCount++
    }
    if (task.status === 'completed') {
      completedCount++
    }

    const metrics = task.metrics
    if (metrics) {
      inputTokens += metrics.tokenUsage.input_tokens
      outputTokens += metrics.tokenUsage.output_tokens
      totalRetries += metrics.retries
    }

    if (task.status === 'completed' && metrics) {
      totalDurationMs += metrics.durationMs
      if (minTaskDurationMs === undefined || metrics.durationMs < minTaskDurationMs) {
        minTaskDurationMs = metrics.durationMs
      }
      if (maxTaskDurationMs === undefined || metrics.durationMs > maxTaskDurationMs) {
        maxTaskDurationMs = metrics.durationMs
      }
    }
  }

  return {
    totalTokens: { input_tokens: inputTokens, output_tokens: outputTokens },
    totalRetries,
    errorCount,
    failureCount,
    completedCount,
    minTaskDurationMs,
    maxTaskDurationMs,
    avgTaskDurationMs: completedCount > 0 ? Math.round(totalDurationMs / completedCount) : undefined,
    totalDurationMs,
  }
}

/** Resolve nested ceilings without allowing a per-run/agent override to widen its parent. */
export function resolveBudgetCeiling(primary?: number, fallback?: number): number | undefined {
  if (primary === undefined) return fallback
  if (fallback === undefined) return primary
  return Math.min(primary, fallback)
}

export type BudgetExceededError = TokenBudgetExceededError | CostBudgetExceededError

export function buildCostEstimateContext(params: {
  readonly agentName: string
  readonly model: string
  readonly provider?: AgentConfig['provider']
  readonly phase: CostEstimateContext['phase']
  readonly taskId?: string
}): CostEstimateContext {
  return {
    agentName: params.agentName,
    model: params.model,
    phase: params.phase,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
  }
}

export function estimateIncrementalCost(
  usage: TokenUsage,
  context: CostEstimateContext,
  estimateCost: NonNullable<OrchestratorConfig['estimateCost']>,
): number {
  const cost = estimateCost(usage, context)
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(
      `Cost estimator returned invalid cost for agent "${context.agentName}": ${String(cost)}`,
    )
  }
  return cost
}

export function applyBudgetAccounting(params: {
  readonly currentUsage: TokenUsage
  readonly currentCost: number
  readonly usage: TokenUsage
  readonly maxTokenBudget?: number
  readonly maxCostBudget?: number
  readonly estimateCost?: OrchestratorConfig['estimateCost']
  readonly costContext: CostEstimateContext
}): {
  readonly cumulativeUsage: TokenUsage
  readonly cumulativeCost: number
  readonly exceeded?: BudgetExceededError
} {
  const cumulativeUsage = addUsage(params.currentUsage, params.usage)
  const cumulativeCost = params.estimateCost
    ? params.currentCost + estimateIncrementalCost(params.usage, params.costContext, params.estimateCost)
    : params.currentCost

  if (
    params.maxTokenBudget !== undefined
    && totalTokens(cumulativeUsage) > params.maxTokenBudget
  ) {
    return {
      cumulativeUsage,
      cumulativeCost,
      exceeded: new TokenBudgetExceededError(
        params.costContext.agentName,
        totalTokens(cumulativeUsage),
        params.maxTokenBudget,
      ),
    }
  }

  if (
    params.maxCostBudget !== undefined
    && params.estimateCost !== undefined
    && cumulativeCost > params.maxCostBudget
  ) {
    return {
      cumulativeUsage,
      cumulativeCost,
      exceeded: new CostBudgetExceededError(
        params.costContext.agentName,
        cumulativeCost,
        params.maxCostBudget,
      ),
    }
  }

  return { cumulativeUsage, cumulativeCost }
}

export function emitBudgetExceeded(
  config: OrchestratorConfig,
  error: BudgetExceededError,
  agent: string,
  task?: string,
): void {
  config.onProgress?.({
    type: 'budget_exceeded',
    agent,
    ...(task !== undefined ? { task } : {}),
    data: error,
  } satisfies OrchestratorEvent)
}

export function recordRunUsage(
  ctx: RunContext,
  usage: TokenUsage,
  costContext: CostEstimateContext,
  agent: string = costContext.agentName,
  task?: string,
): BudgetExceededError | undefined {
  const accounting = applyBudgetAccounting({
    currentUsage: ctx.cumulativeUsage,
    currentCost: ctx.cumulativeCost,
    usage,
    maxTokenBudget: ctx.maxTokenBudget,
    maxCostBudget: ctx.maxCostBudget,
    estimateCost: ctx.estimateCost,
    costContext,
  })
  ctx.cumulativeUsage = accounting.cumulativeUsage
  ctx.cumulativeCost = accounting.cumulativeCost

  if (!ctx.budgetExceededTriggered && accounting.exceeded) {
    ctx.budgetExceededTriggered = true
    ctx.budgetExceededReason = accounting.exceeded.message
    const classified = classifyRunFailure(accounting.exceeded)
    ctx.outcomeStatus = classified.status
    ctx.outcomeErrorInfo = classified.errorInfo
    emitBudgetExceeded(ctx.config, accounting.exceeded, agent, task)
    return accounting.exceeded
  }

  return undefined
}
