import {
  SpanKind as OTelSpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api'
import type {
  AttributeValue,
  Attributes,
  Link,
  SpanContext,
  SpanStatus,
} from '@opentelemetry/api'
import type {
  RunStatus,
  SpanEndRecord,
  SpanKind,
  SpanStartRecord,
  TraceAttributeValue,
  TraceLink,
  TraceRecordBase,
} from '@open-multi-agent/core'

/** Version of OMA's stable TraceRecord-to-OTel mapping. */
export const OMA_OTEL_MAPPING_VERSION = '1.0.0'

/**
 * The GenAI conventions are development-status and deliberately remain a
 * compatibility mapping rather than part of OMA's stable public schema.
 */
export const OTEL_GENAI_SEMCONV_VERSION = '1.43.0-development'

export const OMA_SCHEMA_VERSION = 2

const CONTENT_ATTRIBUTE = /(^|[._-])(prompt|completion|content|message|messages|argument|arguments|result|results|reasoning|thinking|payload)($|[._-])/i
const SECRET_ATTRIBUTE = /(^|[._-])(authorization|cookie|set_cookie|api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key)($|[._-])/i
const SAFE_OMA_ATTRIBUTES = new Set([
  'oma.agent.attempt',
  'oma.agent.name',
  'oma.agent.tool_calls',
  'oma.agent.turns',
  'oma.approval.approved',
  'oma.callback.name',
  'oma.checkpoint.mode',
  'oma.consensus.accepted',
  'oma.consensus.round',
  'oma.consensus.rounds',
  'oma.consensus.scope',
  'oma.consensus.verdict',
  'oma.cost.amount',
  'oma.cost.currency',
  'oma.cost.price_version',
  'oma.cost.source',
  'oma.environment',
  'oma.llm.model',
  'oma.llm.provider',
  'oma.llm.response_model',
  'oma.llm.turn',
  'oma.model',
  'oma.phase',
  'oma.plan.approved',
  'oma.plan.task_count',
  'oma.provider',
  'oma.release',
  'oma.request.id',
  'oma.retry.attempt',
  'oma.retry.delay_ms',
  'oma.retry.max_attempts',
  'oma.status',
  'oma.stream.type',
  'oma.task.id',
  'oma.task.retries',
  'oma.tenant.id',
  'oma.tool.is_error',
  'oma.tool.name',
  'oma.ttft.ms',
])

function toAttributeValue(value: TraceAttributeValue): AttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return [...value] as AttributeValue
}

function isTokenUsageAttribute(key: string): boolean {
  return key.startsWith('oma.usage.') && (key.endsWith('_tokens') || key.endsWith('.tokens'))
}

/**
 * Content attributes that core only produces under an explicit
 * `observability.capture` policy, and that this package forwards only when the
 * application also opts in with `contentCapture: { mode: 'upstream-policy' }`.
 * Both opt-ins are required; neither alone exports content.
 */
const UPSTREAM_POLICY_CONTENT_ATTRIBUTES = new Set([
  'oma.tool.input',
  'oma.tool.output',
])

/**
 * OMA content crosses this boundary only through the safe metadata allowlist,
 * or through `UPSTREAM_POLICY_CONTENT_ATTRIBUTES` when the caller has opted
 * into the upstream capture policy.
 */
export function isSafeOmaAttribute(key: string, allowUpstreamContent = false): boolean {
  if (!key.startsWith('oma.')) return false
  if (isTokenUsageAttribute(key)) return true
  if (allowUpstreamContent && UPSTREAM_POLICY_CONTENT_ATTRIBUTES.has(key)) return true
  if (CONTENT_ATTRIBUTE.test(key) || SECRET_ATTRIBUTE.test(key)) return false
  return SAFE_OMA_ATTRIBUTES.has(key)
}

export function mapOmaAttributes(
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  allowUpstreamContent = false,
): Attributes {
  const mapped: Attributes = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (isSafeOmaAttribute(key, allowUpstreamContent)) mapped[key] = toAttributeValue(value)
  }
  return mapped
}

function readNumber(attributes: Attributes, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function readString(attributes: Attributes, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Add a bounded compatibility subset of the current GenAI semantic conventions. */
export function addGenAiAttributes(kind: SpanKind, attributes: Attributes): void {
  if (kind === 'llm') attributes['gen_ai.operation.name'] = 'chat'
  if (kind === 'agent') attributes['gen_ai.operation.name'] = 'invoke_agent'
  if (kind === 'tool') attributes['gen_ai.operation.name'] = 'execute_tool'

  const provider = readString(attributes, 'oma.llm.provider', 'oma.provider', 'oma.error.provider')
  if (provider !== undefined) attributes['gen_ai.provider.name'] = provider

  const model = readString(attributes, 'oma.llm.model', 'oma.model')
  if (model !== undefined) attributes['gen_ai.request.model'] = model

  const responseModel = readString(attributes, 'oma.llm.response_model', 'oma.response.model')
  if (responseModel !== undefined) attributes['gen_ai.response.model'] = responseModel

  const inputTokens = readNumber(attributes, 'oma.usage.input_tokens')
  if (inputTokens !== undefined) attributes['gen_ai.usage.input_tokens'] = inputTokens
  const outputTokens = readNumber(attributes, 'oma.usage.output_tokens')
  if (outputTokens !== undefined) attributes['gen_ai.usage.output_tokens'] = outputTokens
  const cacheRead = readNumber(attributes, 'oma.usage.cache_read_input_tokens', 'oma.usage.cache_read.input_tokens')
  if (cacheRead !== undefined) attributes['gen_ai.usage.cache_read.input_tokens'] = cacheRead
  const cacheCreation = readNumber(attributes, 'oma.usage.cache_creation_input_tokens', 'oma.usage.cache_creation.input_tokens')
  if (cacheCreation !== undefined) attributes['gen_ai.usage.cache_creation.input_tokens'] = cacheCreation
  const reasoningTokens = readNumber(attributes, 'oma.usage.reasoning_output_tokens', 'oma.usage.reasoning.output_tokens')
  if (reasoningTokens !== undefined) attributes['gen_ai.usage.reasoning.output_tokens'] = reasoningTokens

  const toolName = readString(attributes, 'oma.tool.name')
  if (toolName !== undefined && kind === 'tool') attributes['gen_ai.tool.name'] = toolName

  const ttftMs = readNumber(attributes, 'oma.ttft.ms')
  if (ttftMs !== undefined) attributes['gen_ai.response.time_to_first_chunk'] = ttftMs / 1_000
}

export function mapSpanKind(kind: SpanKind): OTelSpanKind {
  return kind === 'llm' ? OTelSpanKind.CLIENT : OTelSpanKind.INTERNAL
}

/** Keep successful OMA instrumentation spans Unset, per the OTel Trace API guidance. */
export function mapStatus(status: RunStatus): SpanStatus {
  switch (status.code) {
    case 'error':
    case 'timeout':
    case 'budget_exhausted':
      return {
        code: SpanStatusCode.ERROR,
        ...(status.message ? { message: 'oma.' + status.code } : {}),
      }
    case 'ok':
    case 'cancelled':
    case 'rejected':
    case 'skipped':
      return { code: SpanStatusCode.UNSET }
  }
  return { code: SpanStatusCode.UNSET }
}

export function mapLink(link: TraceLink, resolvedContext?: SpanContext): Link {
  const resolved = resolvedContext !== undefined
  const context: SpanContext = resolvedContext ?? {
    traceId: link.traceId,
    spanId: link.spanId,
    traceFlags: TraceFlags.NONE,
    isRemote: true,
  }
  return {
    context,
    attributes: {
      'oma.link.relation': link.relation,
      'oma.link.resolved': resolved,
      'oma.link.target.trace_id': link.traceId,
      'oma.link.target.span_id': link.spanId,
      ...mapOmaAttributes(link.attributes ?? {}),
    },
  }
}

export function baseAttributes(record: TraceRecordBase & { readonly recordType: string }): Attributes {
  return {
    'oma.schema.version': OMA_SCHEMA_VERSION,
    'oma.otel.mapping.version': OMA_OTEL_MAPPING_VERSION,
    'oma.otel.gen_ai_semconv.version': OTEL_GENAI_SEMCONV_VERSION,
    'oma.record.id': record.recordId,
    'oma.record.sequence': record.sequence,
    'oma.record.type': record.recordType,
    'oma.run.id': record.runId,
    'oma.run.attempt': record.attempt,
    'oma.trace.id': record.traceId,
    'oma.span.id': record.spanId,
    ...(record.parentSpanId ? { 'oma.parent_span.id': record.parentSpanId } : {}),
  }
}

export function spanAttributes(
  record: SpanStartRecord | SpanEndRecord,
  allowUpstreamContent = false,
): Attributes {
  const attributes: Attributes = {
    ...baseAttributes(record),
    'oma.span.kind': record.kind,
    ...mapOmaAttributes(record.attributes, allowUpstreamContent),
  }
  addGenAiAttributes(record.kind, attributes)
  return attributes
}
