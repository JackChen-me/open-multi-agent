import type {
  ExecutionRoutingDecisionRecord,
  ExecutionRoutingDecisionSource,
  RoutingDecision,
  RunIdentity,
  RoutingDecisionTrace,
  SemanticRoutingAssessment,
} from '../types.js'
import type { TraceRuntime } from './runtime.js'

export interface RoutingDecisionRecordInput {
  readonly source: ExecutionRoutingDecisionSource
  readonly mode: RoutingDecision['mode']
  readonly confidence?: number
  readonly reasons: readonly string[]
  readonly routerVersion?: string
  readonly status?: RoutingDecision['status']
  readonly requestedRouterVersion?: string
  readonly fallbackCode?: RoutingDecision['fallbackCode']
  readonly semanticRoutingAssessment?: SemanticRoutingAssessment
}

/**
 * Records one execution-routing decision through the existing trace runtime.
 * The returned result field and its future ExecutionReceipt share stable IDs.
 */
export function recordRoutingDecision(
  identity: RunIdentity,
  traceRuntime: TraceRuntime | undefined,
  input: RoutingDecisionRecordInput,
): ExecutionRoutingDecisionRecord {
  const decisionId = `${identity.traceId}:routing-decision`
  const receiptId = `${identity.traceId}:execution-receipt`
  const span = traceRuntime?.startSpan({
    kind: 'routing',
    name: 'decide_execution_route',
    parent: traceRuntime.root,
    attributes: {
      'oma.routing.decision_id': decisionId,
      'oma.routing.receipt_id': receiptId,
      'oma.routing.source': input.source,
      'oma.routing.mode': input.mode,
      'oma.routing.reasons': input.reasons,
      ...(input.routerVersion !== undefined
        ? { 'oma.routing.router_version': input.routerVersion }
        : {}),
      ...(input.confidence !== undefined
        ? { 'oma.routing.confidence': input.confidence }
        : {}),
      ...(input.status !== undefined ? { 'oma.routing.status': input.status } : {}),
      ...(input.requestedRouterVersion !== undefined
        ? { 'oma.routing.requested_router_version': input.requestedRouterVersion }
        : {}),
      ...(input.fallbackCode !== undefined
        ? { 'oma.routing.fallback_code': input.fallbackCode }
        : {}),
      ...(input.semanticRoutingAssessment !== undefined
        ? {
            'oma.routing.semantic.profiler_version':
              input.semanticRoutingAssessment.profilerVersion,
            ...(input.semanticRoutingAssessment.requestedProfilerVersion !== undefined
              ? {
                  'oma.routing.semantic.requested_profiler_version':
                    input.semanticRoutingAssessment.requestedProfilerVersion,
                }
              : {}),
            'oma.routing.semantic.recommendation':
              input.semanticRoutingAssessment.recommendation,
            'oma.routing.semantic.outcome': input.semanticRoutingAssessment.outcome,
            ...(input.semanticRoutingAssessment.model !== undefined
              ? {
                  'oma.routing.semantic.model':
                    input.semanticRoutingAssessment.model,
                }
              : {}),
            ...(input.semanticRoutingAssessment.provider !== undefined
              ? {
                  'oma.routing.semantic.provider':
                    input.semanticRoutingAssessment.provider,
                }
              : {}),
            ...(input.semanticRoutingAssessment.estimatedCost !== undefined
              ? {
                  'oma.routing.semantic.estimated_cost':
                    input.semanticRoutingAssessment.estimatedCost,
                }
              : {}),
            ...(input.semanticRoutingAssessment.profile !== undefined
              ? {
                  'oma.routing.semantic.confidence':
                    input.semanticRoutingAssessment.profile.confidence,
                }
              : {}),
          }
        : {}),
    },
  })
  const record: ExecutionRoutingDecisionRecord = {
    decisionId,
    receiptId,
    ...(span ? { traceSpanId: span.spanId } : {}),
    source: input.source,
    mode: input.mode,
    reasons: input.reasons,
    ...(input.routerVersion !== undefined ? { routerVersion: input.routerVersion } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.requestedRouterVersion !== undefined
      ? { requestedRouterVersion: input.requestedRouterVersion }
      : {}),
    ...(input.fallbackCode !== undefined ? { fallbackCode: input.fallbackCode } : {}),
    ...(input.semanticRoutingAssessment !== undefined
      ? { semanticRoutingAssessment: input.semanticRoutingAssessment }
      : {}),
  }
  if (span) {
    const endMs = Date.now()
    const legacyEvent: RoutingDecisionTrace = {
      type: 'routing_decision',
      runId: identity.runId,
      spanId: span.spanId,
      parentId: identity.rootSpanId,
      agent: 'orchestrator',
      decisionId,
      receiptId,
      source: input.source,
      mode: input.mode,
      reasons: input.reasons,
      ...(input.routerVersion !== undefined ? { routerVersion: input.routerVersion } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.requestedRouterVersion !== undefined
        ? { requestedRouterVersion: input.requestedRouterVersion }
        : {}),
      ...(input.fallbackCode !== undefined ? { fallbackCode: input.fallbackCode } : {}),
      ...(input.semanticRoutingAssessment !== undefined
        ? { semanticRoutingAssessment: input.semanticRoutingAssessment }
        : {}),
      startMs: span.startUnixMs,
      endMs,
      durationMs: Math.max(0, endMs - span.startUnixMs),
    }
    span.end({ status: { code: 'ok' }, legacyEvent })
  }
  return record
}
