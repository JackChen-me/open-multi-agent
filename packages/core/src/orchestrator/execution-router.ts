/**
 * @fileoverview Pluggable execution-topology routing for automatic runTeam calls.
 *
 * The built-in policy is deliberately honest, cheap, and language-neutral. It
 * uses one shared goal heuristic plus an empty-roster qualification check; it
 * is not intended to infer deep task semantics or replace governance declarations.
 */

import type {
  AgentConfig,
  ExecutionRouter,
  RoutingFailurePolicy,
  RoutingContext,
  RoutingDecision,
  RoutingFallbackCode,
  RosterSummaryEntry,
} from '../types.js'
import { isSimpleGoal } from './short-circuit.js'
import { RoutingTimeoutError } from '../errors.js'
import { mergeAbortSignals } from '../utils/abort.js'

export type {
  ExecutionRouter,
  ExecutionRoutingDecisionRecord,
  ExecutionRoutingDecisionSource,
  RoutingBudget,
  RoutingContext,
  RoutingDecision,
  RoutingDecisionStatus,
  RoutingFallbackCode,
  RosterSummaryEntry,
} from '../types.js'

export const DETERMINISTIC_ROUTER_VERSION = 'deterministic-v1'

class RoutingValidationError extends Error {
  constructor(
    message: string,
    readonly fallbackCode: Extract<
      RoutingFallbackCode,
      'invalid-router-version' | 'invalid-decision'
    >,
  ) {
    super(message)
    this.name = 'RoutingValidationError'
  }
}

export class DeterministicRouter implements ExecutionRouter {
  readonly version = DETERMINISTIC_ROUTER_VERSION

  decide(context: RoutingContext): RoutingDecision {
    if (context.roster.length === 0) {
      return {
        mode: 'team',
        reasons: ['No roster member is available for the single-agent path.'],
        routerVersion: this.version,
      }
    }
    const simple = isSimpleGoal(context.goal)
    return {
      mode: simple ? 'single' : 'team',
      reasons: [
        simple
          ? 'The goal has one concise action and no multi-stage structure.'
          : 'The goal length or structure benefits from team decomposition.',
      ],
      routerVersion: this.version,
    }
  }
}

function directToolCount(agent: AgentConfig): number | undefined {
  if (agent.tools === undefined && agent.customTools === undefined) return undefined
  return (agent.tools?.length ?? 0) + (agent.customTools?.length ?? 0)
}

export function buildRoutingContext(
  goal: string,
  agents: readonly AgentConfig[],
  defaultModel: string,
  budget: {
    readonly maxTokenBudget?: number
    readonly maxCostBudget?: number
  },
  abortSignal?: AbortSignal,
): RoutingContext {
  const roster: RosterSummaryEntry[] = agents.map((agent) => {
    const toolCount = directToolCount(agent)
    return {
      name: agent.name,
      model: agent.model ?? defaultModel,
      ...(toolCount !== undefined ? { toolCount } : {}),
      ...(agent.capabilities !== undefined
        ? { capabilities: [...agent.capabilities] }
        : {}),
      ...(agent.costTier !== undefined ? { costTier: agent.costTier } : {}),
      ...(agent.latencyClass !== undefined ? { latencyClass: agent.latencyClass } : {}),
    }
  })
  const hasBudget = budget.maxTokenBudget !== undefined || budget.maxCostBudget !== undefined
  return {
    goal,
    roster,
    ...(hasBudget
      ? {
          budget: {
            ...(budget.maxTokenBudget !== undefined
              ? { tokenRemaining: budget.maxTokenBudget }
              : {}),
            ...(budget.maxCostBudget !== undefined
              ? { costRemaining: budget.maxCostBudget }
              : {}),
          },
        }
      : {}),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  }
}

function fallbackCode(error: unknown): RoutingFallbackCode {
  if (error instanceof RoutingValidationError) return error.fallbackCode
  if (error instanceof RoutingTimeoutError) return 'router-timeout'
  return 'router-error'
}

async function decideWithTimeout(
  router: ExecutionRouter,
  context: RoutingContext,
  timeoutMs: number | undefined,
): Promise<RoutingDecision> {
  if (timeoutMs === undefined || timeoutMs <= 0) return router.decide(context)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const abortSignal = context.abortSignal
    ? mergeAbortSignals(context.abortSignal, timeoutSignal)
    : timeoutSignal
  const timeout = new Promise<never>((_, reject) => {
    timeoutSignal.addEventListener(
      'abort',
      () => reject(new RoutingTimeoutError(timeoutMs, 'router')),
      { once: true },
    )
  })
  return Promise.race([
    Promise.resolve(router.decide({ ...context, abortSignal })),
    timeout,
  ])
}

function isValidDecision(
  value: unknown,
  routerVersion: string,
  context: RoutingContext,
): value is RoutingDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const decision = value as Partial<RoutingDecision>
  if (decision.mode !== 'single' && decision.mode !== 'team') return false
  if (decision.mode === 'single' && context.roster.length === 0) return false
  if (decision.routerVersion !== routerVersion) return false
  if (
    !Array.isArray(decision.reasons)
    || decision.reasons.some((reason) => typeof reason !== 'string')
  ) return false
  return decision.confidence === undefined
    || (
      typeof decision.confidence === 'number'
      && Number.isFinite(decision.confidence)
      && decision.confidence >= 0
      && decision.confidence <= 1
    )
}

function fallbackReason(error: unknown): string {
  if (error instanceof RoutingValidationError) {
    return `Execution router fallback: ${error.message}`
  }
  const kind = error instanceof Error && error.name ? error.name : 'unknown error'
  return `Execution router fallback: custom decision failed (${kind}).`
}

/**
 * Resolve a custom decision without allowing router failures to fail the run.
 * Invalid routers, thrown errors, and rejected promises all fall back to the
 * built-in deterministic policy with an explicit reason.
 */
export async function resolveExecutionRouting(
  router: ExecutionRouter,
  context: RoutingContext,
  fallback: DeterministicRouter,
  options: {
    readonly timeoutMs?: number
    readonly failurePolicy?: RoutingFailurePolicy
  } = {},
): Promise<RoutingDecision> {
  try {
    if (typeof router.version !== 'string' || router.version.length === 0) {
      throw new RoutingValidationError(
        'router version must be a non-empty string.',
        'invalid-router-version',
      )
    }
    const decision = await decideWithTimeout(router, context, options.timeoutMs)
    if (!isValidDecision(decision, router.version, context)) {
      throw new RoutingValidationError(
        'router returned an invalid decision.',
        'invalid-decision',
      )
    }
    return { ...decision, status: 'selected' }
  } catch (error) {
    if (context.abortSignal?.aborted) throw error
    if (options.failurePolicy === 'fail') throw error
    const decision = fallback.decide(context)
    return {
      ...decision,
      status: 'fallback',
      ...(typeof router.version === 'string' && router.version.length > 0
        ? { requestedRouterVersion: router.version }
        : {}),
      fallbackCode: fallbackCode(error),
      reasons: [...decision.reasons, fallbackReason(error)],
    }
  }
}
