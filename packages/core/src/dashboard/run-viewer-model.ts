import type {
  ExecutionRoutingDecisionRecord,
  RunStatusCode,
  StructuredTraceError,
  TaskStatus,
  TeamRunResult,
  TokenUsage,
  TraceAttributeValue,
} from '../types.js'
import {
  buildExecutionReceipt,
  type ExecutionReceipt,
} from '../observability/execution-receipt.js'
import type { MaterializedSpan, StoredRun } from '../observability/store.js'
import type { SpanEndRecord } from '../observability/records.js'
import { TRACE_STORE_SCHEMA_MAJOR } from '../observability/store.js'
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, layoutTasks } from './layout-tasks.js'

export type RunViewerInputErrorCode =
  | 'MISSING_SOURCE'
  | 'RUN_ID_MISMATCH'
  | 'UNSUPPORTED_SCHEMA_VERSION'

export class RunViewerInputError extends Error {
  readonly name = 'RunViewerInputError'

  constructor(
    readonly code: RunViewerInputErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface RunViewerInput {
  readonly result?: TeamRunResult
  readonly run?: StoredRun
}

export interface RunViewerOptions {
  readonly title?: string
  readonly defaultView?: 'dag' | 'waterfall'
}

export type RunViewerSourceMode = 'result' | 'trace' | 'combined'
export type RunViewerStatus = RunStatusCode | TaskStatus | 'unknown'

export interface RunViewerWarning {
  readonly code:
    | 'RESULT_DETAILS_UNAVAILABLE'
    | 'TASK_GRAPH_UNAVAILABLE'
    | 'TRACE_DETAILS_UNAVAILABLE'
    | 'DAG_LAYOUT_FAILED'
    | 'UNKNOWN_FIELD_VALUE'
  readonly message: string
}

export interface RunViewerFact {
  readonly label: string
  readonly value: string | number | boolean
}

export interface RunViewerEvent {
  readonly name: string
  readonly timestampUnixMs: number
  readonly facts: readonly RunViewerFact[]
}

export interface RunViewerLink {
  readonly traceId: string
  readonly spanId: string
  readonly targetKey: string
  readonly relation: 'continued_from' | 'depends_on' | 'consumed' | 'delegated_from'
}

export interface RunViewerSpan {
  readonly key: string
  readonly traceId: string
  readonly spanId: string
  readonly parentKey?: string
  readonly attempt: number
  readonly kind: string
  readonly name: string
  readonly status: RunViewerStatus
  readonly incomplete: boolean
  readonly startUnixMs?: number
  readonly endUnixMs?: number
  readonly durationMs?: number
  readonly agent?: string
  readonly taskId?: string
  readonly taskTitle?: string
  readonly model?: string
  readonly provider?: string
  readonly tool?: string
  readonly tokens?: TokenUsage
  readonly costs?: readonly { readonly amount: number; readonly currency: string }[]
  readonly retries?: number
  readonly error?: StructuredTraceError
  readonly facts: readonly RunViewerFact[]
  readonly events: readonly RunViewerEvent[]
  readonly links: readonly RunViewerLink[]
}

export interface RunViewerTask {
  readonly id: string
  readonly title: string
  readonly assignee?: string
  readonly status: RunViewerStatus
  readonly dependsOn: readonly string[]
  readonly startUnixMs?: number
  readonly endUnixMs?: number
  readonly durationMs?: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly model?: string
  readonly provider?: string
  readonly costs?: readonly { readonly amount: number; readonly currency: string }[]
  readonly retries: number
  readonly toolCallCount: number
  readonly spanKey?: string
}

export interface RunViewerDagLayout {
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly width: number
  readonly height: number
  readonly nodeW: number
  readonly nodeH: number
  readonly degraded: boolean
}

export interface RunViewerSummary {
  readonly runId?: string
  readonly status: RunViewerStatus
  readonly incomplete: boolean
  readonly startedAt?: string
  readonly endedAt?: string
  readonly durationMs?: number
  readonly attempts: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costs: readonly { readonly amount: number; readonly currency: string }[]
  readonly agents: readonly string[]
  readonly models: readonly string[]
  readonly providers: readonly string[]
}

export interface RunViewerRoutingSummary {
  readonly decision: ExecutionRoutingDecisionRecord
  readonly receipt?: ExecutionReceipt
}

export interface RunViewerModel {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly title: string
  readonly defaultView: 'dag' | 'waterfall'
  readonly sourceMode: RunViewerSourceMode
  readonly summary: RunViewerSummary
  readonly routing?: RunViewerRoutingSummary
  readonly tasks: readonly RunViewerTask[]
  readonly spans: readonly RunViewerSpan[]
  readonly dag: RunViewerDagLayout
  readonly warnings: readonly RunViewerWarning[]
  readonly filters: {
    readonly kinds: readonly string[]
    readonly statuses: readonly string[]
    readonly agents: readonly string[]
    readonly tasks: readonly string[]
  }
}

const SAFE_FACT_KEYS: Readonly<Record<string, string>> = {
  'oma.agent.attempt': 'Agent attempt',
  'oma.agent.tool_calls': 'Tool calls',
  'oma.agent.turns': 'Agent turns',
  'oma.approval.approved': 'Approved',
  'oma.callback.name': 'Callback',
  'oma.checkpoint.mode': 'Checkpoint mode',
  'oma.consensus.accepted': 'Consensus accepted',
  'oma.consensus.round': 'Consensus round',
  'oma.consensus.rounds': 'Consensus rounds',
  'oma.consensus.scope': 'Consensus scope',
  'oma.consensus.verdict': 'Consensus verdict',
  'oma.llm.turn': 'LLM turn',
  'oma.phase': 'Phase',
  'oma.plan.approved': 'Plan approved',
  'oma.plan.task_count': 'Plan tasks',
  'oma.retry.attempt': 'Retry attempt',
  'oma.retry.delay_ms': 'Retry delay (ms)',
  'oma.retry.max_attempts': 'Retry max attempts',
  'oma.routing.confidence': 'Routing confidence',
  'oma.routing.decision_id': 'Routing decision ID',
  'oma.routing.mode': 'Routing mode',
  'oma.routing.receipt_id': 'Execution receipt ID',
  'oma.routing.reasons': 'Routing reasons',
  'oma.routing.router_version': 'Router version',
  'oma.routing.source': 'Routing source',
  'oma.stream.type': 'Stream type',
  'oma.task.retries': 'Task retries',
  'oma.tool.is_error': 'Tool error',
}

const SAFE_EVENT_FACT_KEYS = new Set([
  'oma.approval.approved',
  'oma.consensus.accepted',
  'oma.consensus.round',
  'oma.consensus.verdict',
  'oma.retry.attempt',
  'oma.retry.delay_ms',
  'oma.retry.max_attempts',
  'oma.stream.type',
])

function stringAttr(
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function numberAttr(
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function safeScalar(value: TraceAttributeValue | undefined): string | number | boolean | undefined {
  if (Array.isArray(value)) return value.join('; ')
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined
}

function traceRoutingDecision(run: StoredRun | undefined): ExecutionRoutingDecisionRecord | undefined {
  const span = run?.spans.find((candidate) =>
    candidate.kind === 'routing' && candidate.name === 'decide_execution_route')
  if (!span) return undefined
  const attributes = span.attributes
  const decisionId = stringAttr(attributes, 'oma.routing.decision_id')
  const receiptId = stringAttr(attributes, 'oma.routing.receipt_id')
  const source = stringAttr(attributes, 'oma.routing.source')
  const mode = stringAttr(attributes, 'oma.routing.mode')
  if (
    !decisionId
    || !receiptId
    || !['override', 'declared', 'policy', 'router', 'legacy-deterministic'].includes(source ?? '')
    || (mode !== 'single' && mode !== 'team')
  ) return undefined
  const rawReasons = attributes['oma.routing.reasons']
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((reason): reason is string => typeof reason === 'string')
    : []
  return {
    decisionId,
    receiptId,
    traceSpanId: span.spanId,
    source: source as ExecutionRoutingDecisionRecord['source'],
    mode,
    reasons,
    ...(stringAttr(attributes, 'oma.routing.router_version')
      ? { routerVersion: stringAttr(attributes, 'oma.routing.router_version') }
      : {}),
    ...(numberAttr(attributes, 'oma.routing.confidence') !== undefined
      ? { confidence: numberAttr(attributes, 'oma.routing.confidence') }
      : {}),
  }
}

function safeFacts(attributes: Readonly<Record<string, TraceAttributeValue>>): RunViewerFact[] {
  const facts: RunViewerFact[] = []
  for (const [key, label] of Object.entries(SAFE_FACT_KEYS)) {
    const value = safeScalar(attributes[key])
    if (value !== undefined) facts.push({ label, value })
  }
  return facts
}

function safeEventFacts(attributes: Readonly<Record<string, TraceAttributeValue>>): RunViewerFact[] {
  const facts: RunViewerFact[] = []
  for (const key of SAFE_EVENT_FACT_KEYS) {
    const label = SAFE_FACT_KEYS[key]
    const value = safeScalar(attributes[key])
    if (label && value !== undefined) facts.push({ label, value })
  }
  return facts
}

function uniqueSorted(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))]
    .sort((a, b) => a.localeCompare(b))
}

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`
}

function taskStatusFromSpan(status: RunStatusCode | undefined, incomplete: boolean): RunViewerStatus {
  if (incomplete) return 'in_progress'
  switch (status) {
    case 'ok': return 'completed'
    case 'skipped': return 'skipped'
    case 'cancelled': return 'blocked'
    case 'suspended': return 'in_progress'
    case 'error':
    case 'timeout':
    case 'budget_exhausted':
    case 'rejected': return 'failed'
    default: return 'unknown'
  }
}

function runStatus(result: TeamRunResult | undefined, run: StoredRun | undefined): RunViewerStatus {
  if (run?.status) return run.status
  if (result?.status?.code) return result.status.code
  if (result) return result.success ? 'ok' : 'error'
  return 'unknown'
}

function endRecords(run: StoredRun | undefined): Map<string, SpanEndRecord> {
  const ends = new Map<string, SpanEndRecord>()
  for (const record of run?.records ?? []) {
    if (record.recordType === 'span_end') {
      ends.set(spanKey(record.traceId, record.spanId), record)
    }
  }
  return ends
}

function viewerSpans(run: StoredRun | undefined): RunViewerSpan[] {
  if (!run) return []
  const attempts = new Map(run.attempts.map((attempt) => [attempt.traceId, attempt.attempt]))
  const ends = endRecords(run)
  return run.spans.map((span) => {
    const attributes = span.attributes
    const inputTokens = numberAttr(attributes, 'oma.usage.input_tokens', 'gen_ai.usage.input_tokens')
    const outputTokens = numberAttr(attributes, 'oma.usage.output_tokens', 'gen_ai.usage.output_tokens')
    const costAmount = numberAttr(attributes, 'oma.cost.amount')
    const costCurrency = stringAttr(attributes, 'oma.cost.currency')
    const key = spanKey(span.traceId, span.spanId)
    return {
      key,
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentKey: spanKey(span.traceId, span.parentSpanId) } : {}),
      attempt: attempts.get(span.traceId) ?? 1,
      kind: span.kind ?? 'unknown',
      name: span.name ?? 'Unnamed span',
      status: span.status ?? (span.incomplete ? 'in_progress' : 'unknown'),
      incomplete: span.incomplete,
      ...(span.startUnixMs !== undefined ? { startUnixMs: span.startUnixMs } : {}),
      ...(span.endUnixMs !== undefined ? { endUnixMs: span.endUnixMs } : {}),
      ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
      ...(stringAttr(attributes, 'oma.agent.name') ? { agent: stringAttr(attributes, 'oma.agent.name') } : {}),
      ...(stringAttr(attributes, 'oma.task.id') ? { taskId: stringAttr(attributes, 'oma.task.id') } : {}),
      ...(stringAttr(attributes, 'oma.task.title') ? { taskTitle: stringAttr(attributes, 'oma.task.title') } : {}),
      ...(stringAttr(attributes, 'oma.llm.model', 'oma.model', 'gen_ai.request.model', 'gen_ai.response.model')
        ? { model: stringAttr(attributes, 'oma.llm.model', 'oma.model', 'gen_ai.request.model', 'gen_ai.response.model') }
        : {}),
      ...(stringAttr(attributes, 'oma.llm.provider', 'oma.provider', 'gen_ai.provider.name', 'gen_ai.system')
        ? { provider: stringAttr(attributes, 'oma.llm.provider', 'oma.provider', 'gen_ai.provider.name', 'gen_ai.system') }
        : {}),
      ...(stringAttr(attributes, 'oma.tool.name') ? { tool: stringAttr(attributes, 'oma.tool.name') } : {}),
      ...(inputTokens !== undefined || outputTokens !== undefined
        ? { tokens: { input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0 } }
        : {}),
      ...(costAmount !== undefined && costCurrency
        ? { costs: [{ amount: costAmount, currency: costCurrency }] }
        : {}),
      ...(numberAttr(attributes, 'oma.task.retries') !== undefined
        ? { retries: numberAttr(attributes, 'oma.task.retries') }
        : {}),
      ...(ends.get(key)?.error ? { error: ends.get(key)!.error } : {}),
      facts: safeFacts(attributes),
      events: span.events.map((event) => ({
        name: event.name,
        timestampUnixMs: event.timestampUnixMs,
        facts: safeEventFacts(event.attributes),
      })),
      links: span.links.map((link) => ({
        traceId: link.traceId,
        spanId: link.spanId,
        targetKey: spanKey(link.traceId, link.spanId),
        relation: link.relation,
      })),
    } satisfies RunViewerSpan
  }).sort((a, b) =>
    a.attempt - b.attempt
    || (a.startUnixMs ?? Number.MAX_SAFE_INTEGER) - (b.startUnixMs ?? Number.MAX_SAFE_INTEGER)
    || a.key.localeCompare(b.key))
}

/**
 * Roll each task's descendant LLM spans up into task-level model, provider, and
 * cost. LLM spans carry these but no `taskId`, so they are reached by walking the
 * span tree down from the task span (task → agent → llm). Lets the viewer show a
 * task's actual model/provider/cost instead of "Not recorded".
 */
function llmRollupByTask(
  spans: readonly RunViewerSpan[],
): Map<string, { model?: string; provider?: string; costs?: { amount: number; currency: string }[] }> {
  const childrenByParent = new Map<string, RunViewerSpan[]>()
  for (const span of spans) {
    if (!span.parentKey) continue
    const bucket = childrenByParent.get(span.parentKey)
    if (bucket) bucket.push(span)
    else childrenByParent.set(span.parentKey, [span])
  }
  const rollup = new Map<string, { model?: string; provider?: string; costs?: { amount: number; currency: string }[] }>()
  for (const taskSpan of spans) {
    if (taskSpan.kind !== 'task' || !taskSpan.taskId) continue
    const models = new Set<string>()
    const providers = new Set<string>()
    const costByCurrency = new Map<string, number>()
    const seen = new Set<string>()
    const stack = [...(childrenByParent.get(taskSpan.key) ?? [])]
    while (stack.length > 0) {
      const span = stack.pop()
      if (!span || seen.has(span.key)) continue
      seen.add(span.key)
      if (span.kind === 'llm') {
        if (span.model) models.add(span.model)
        if (span.provider) providers.add(span.provider)
        for (const cost of span.costs ?? []) {
          costByCurrency.set(cost.currency, (costByCurrency.get(cost.currency) ?? 0) + cost.amount)
        }
      }
      for (const child of childrenByParent.get(span.key) ?? []) stack.push(child)
    }
    rollup.set(taskSpan.taskId, {
      ...(models.size > 0 ? { model: [...models].sort((a, b) => a.localeCompare(b)).join(', ') } : {}),
      ...(providers.size > 0 ? { provider: [...providers].sort((a, b) => a.localeCompare(b)).join(', ') } : {}),
      ...(costByCurrency.size > 0
        ? { costs: [...costByCurrency].map(([currency, amount]) => ({ amount, currency })) }
        : {}),
    })
  }
  return rollup
}

function traceTasks(spans: readonly RunViewerSpan[]): RunViewerTask[] {
  const taskSpans = spans.filter((span) => span.kind === 'task' && span.taskId)
  const taskIdBySpan = new Map(taskSpans.map((span) => [span.key, span.taskId!]))
  const rollup = llmRollupByTask(spans)
  return taskSpans.map((span) => ({
    id: span.taskId!,
    title: span.taskTitle ?? span.name,
    ...(span.agent ? { assignee: span.agent } : {}),
    status: taskStatusFromSpan(
      span.status === 'unknown' || span.status === 'pending' || span.status === 'in_progress'
        || span.status === 'completed' || span.status === 'failed' || span.status === 'blocked'
        ? undefined
        : span.status,
      span.incomplete,
    ),
    dependsOn: uniqueSorted(span.links
      .filter((link) => link.relation === 'depends_on')
      .map((link) => taskIdBySpan.get(link.targetKey))),
    ...(span.startUnixMs !== undefined ? { startUnixMs: span.startUnixMs } : {}),
    ...(span.endUnixMs !== undefined ? { endUnixMs: span.endUnixMs } : {}),
    ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
    inputTokens: span.tokens?.input_tokens ?? 0,
    outputTokens: span.tokens?.output_tokens ?? 0,
    retries: span.retries ?? 0,
    toolCallCount: 0,
    spanKey: span.key,
    ...(rollup.get(span.taskId!) ?? {}),
  }))
}

function resultTasks(result: TeamRunResult, spans: readonly RunViewerSpan[]): RunViewerTask[] {
  const spanByTask = new Map<string, RunViewerSpan>()
  for (const span of spans) {
    if (span.kind === 'task' && span.taskId && !spanByTask.has(span.taskId)) {
      spanByTask.set(span.taskId, span)
    }
  }
  const rollup = llmRollupByTask(spans)
  return (result.tasks ?? []).map((task) => {
    const span = spanByTask.get(task.id)
    return {
      id: task.id,
      title: task.title,
      ...(task.assignee ? { assignee: task.assignee } : {}),
      status: task.status,
      dependsOn: [...task.dependsOn],
      ...(task.metrics?.startMs !== undefined ? { startUnixMs: task.metrics.startMs } : {}),
      ...(task.metrics?.endMs !== undefined ? { endUnixMs: task.metrics.endMs } : {}),
      ...(task.metrics?.durationMs !== undefined ? { durationMs: task.metrics.durationMs } : {}),
      inputTokens: task.metrics?.tokenUsage.input_tokens ?? 0,
      outputTokens: task.metrics?.tokenUsage.output_tokens ?? 0,
      retries: task.metrics?.retries ?? 0,
      toolCallCount: task.metrics?.toolCalls.length ?? 0,
      ...(span ? { spanKey: span.key } : {}),
      ...(rollup.get(task.id) ?? {}),
    }
  })
}

function dagLayout(tasks: readonly RunViewerTask[], warnings: RunViewerWarning[]): RunViewerDagLayout {
  if (tasks.length === 0) {
    return {
      positions: {},
      width: 1200,
      height: 520,
      nodeW: DAG_NODE_WIDTH,
      nodeH: DAG_NODE_HEIGHT,
      degraded: false,
    }
  }
  try {
    const layout = layoutTasks(tasks)
    return {
      positions: Object.fromEntries(layout.positions),
      width: layout.width,
      height: layout.height,
      nodeW: layout.nodeW,
      nodeH: layout.nodeH,
      degraded: false,
    }
  } catch {
    warnings.push({
      code: 'DAG_LAYOUT_FAILED',
      message: 'Task dependencies could not be laid out as a DAG; a stable list is shown instead.',
    })
    const nodeW = DAG_NODE_WIDTH
    const nodeH = DAG_NODE_HEIGHT
    const rowStep = nodeH + 32
    return {
      positions: Object.fromEntries(tasks.map((task, index) => [task.id, { x: 80, y: 64 + index * rowStep }])),
      width: 1200,
      height: Math.max(520, 128 + tasks.length * rowStep),
      nodeW,
      nodeH,
      degraded: true,
    }
  }
}

function summary(
  result: TeamRunResult | undefined,
  run: StoredRun | undefined,
): RunViewerSummary {
  const durationMs = run?.durationMs ?? result?.metrics?.totalDurationMs
  const agents = uniqueSorted([
    ...(run?.agents ?? []),
    ...((result?.tasks ?? []).map((task) => task.assignee)),
  ])
  return {
    ...(run?.runId ?? result?.identity?.runId ? { runId: run?.runId ?? result?.identity?.runId } : {}),
    status: runStatus(result, run),
    incomplete: run?.incomplete ?? false,
    ...(run?.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run?.endedAt ? { endedAt: run.endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    attempts: run?.attempts.length ?? (result?.identity ? 1 : 0),
    inputTokens: run?.tokens.input_tokens ?? result?.totalTokenUsage.input_tokens ?? 0,
    outputTokens: run?.tokens.output_tokens ?? result?.totalTokenUsage.output_tokens ?? 0,
    costs: [...(run?.costs ?? [])],
    agents,
    models: [...(run?.models ?? [])],
    providers: [...(run?.providers ?? [])],
  }
}

export function buildRunViewerModel(
  input: RunViewerInput,
  options: RunViewerOptions = {},
): RunViewerModel {
  const { result, run } = input
  if (!result && !run) {
    throw new RunViewerInputError('MISSING_SOURCE', 'renderRunViewer requires result, run, or both.')
  }
  if (run && run.schemaVersion !== TRACE_STORE_SCHEMA_MAJOR) {
    throw new RunViewerInputError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `StoredRun schema ${String(run.schemaVersion)} is unsupported; expected ${TRACE_STORE_SCHEMA_MAJOR}.`,
    )
  }
  if (result?.identity?.runId && run?.runId && result.identity.runId !== run.runId) {
    throw new RunViewerInputError(
      'RUN_ID_MISMATCH',
      `TeamRunResult runId ${result.identity.runId} does not match StoredRun runId ${run.runId}.`,
    )
  }

  const warnings: RunViewerWarning[] = []
  if (!result) warnings.push({
    code: 'RESULT_DETAILS_UNAVAILABLE',
    message: 'The exact TeamRunResult task graph was not provided; trace links are used where available.',
  })
  if (!run) warnings.push({
    code: 'TRACE_DETAILS_UNAVAILABLE',
    message: 'Structured trace data was not provided; span waterfall details are unavailable.',
  })
  const spans = viewerSpans(run)
  const tasks = result ? resultTasks(result, spans) : traceTasks(spans)
  if (tasks.length === 0) warnings.push({
    code: 'TASK_GRAPH_UNAVAILABLE',
    message: 'No task graph was recorded for this run.',
  })
  const sourceMode: RunViewerSourceMode = result && run ? 'combined' : result ? 'result' : 'trace'
  const routingDecision = result?.routingDecision ?? traceRoutingDecision(run)
  const routing = routingDecision
    ? {
        decision: routingDecision,
        ...(result ? { receipt: buildExecutionReceipt(result) } : {}),
      }
    : undefined
  const availableKinds = uniqueSorted(spans.map((span) => span.kind))
  const availableStatuses = uniqueSorted([
    ...spans.map((span) => span.status),
    ...tasks.map((task) => task.status),
  ])
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    title: options.title ?? 'OMA Run Viewer',
    defaultView: options.defaultView ?? (tasks.length > 0 ? 'dag' : 'waterfall'),
    sourceMode,
    summary: summary(result, run),
    ...(routing ? { routing } : {}),
    tasks,
    spans,
    dag: dagLayout(tasks, warnings),
    warnings,
    filters: {
      kinds: availableKinds,
      statuses: availableStatuses,
      agents: uniqueSorted(spans.map((span) => span.agent).concat(tasks.map((task) => task.assignee))),
      tasks: uniqueSorted(tasks.map((task) => task.id)),
    },
  }
}
