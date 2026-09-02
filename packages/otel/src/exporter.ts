import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import type {
  Attributes,
  Span,
  SpanContext,
  Tracer,
  TracerProvider,
} from '@opentelemetry/api'
import {
  BatchingTraceSink,
  type BatchingTraceSinkOptions,
  type ExportResult,
  type SpanEndRecord,
  type SpanEventRecord,
  type SpanStartRecord,
  type TraceLink,
  type TraceExporter,
  type TraceRecord,
  type TraceSink,
} from '@open-multi-agent/core'
import {
  baseAttributes,
  mapLink,
  mapOmaAttributes,
  mapSpanKind,
  mapStatus,
  spanAttributes,
} from './mapping.js'
import { PACKAGE_VERSION } from './version.js'

export type OTelDiagnosticCode =
  | 'span_start_failed'
  | 'duplicate_span_start'
  | 'orphan_event'
  | 'span_event_failed'
  | 'duplicate_span_end'
  | 'incomplete_span'
  | 'span_end_failed'
  | 'force_flush_failed'
  | 'force_flush_timeout'
  | 'shutdown_skipped'
  | 'shutdown_failed'
  | 'shutdown_timeout'

export interface OTelDiagnostic {
  readonly code: OTelDiagnosticCode
  readonly message: string
}

export interface OTelTracerProvider extends TracerProvider {
  forceFlush?(): Promise<void>
  shutdown?(): Promise<void>
}

export interface OTelTraceExporterOptions {
  /** Use an application-owned tracer directly. It is never globally registered or shut down. */
  readonly tracer?: Tracer
  /**
   * Use an application-owned provider to create the adapter tracer. Its
   * forceFlush is delegated when available; shutdown remains opt-in.
   */
  readonly tracerProvider?: OTelTracerProvider
  readonly instrumentationName?: string
  readonly instrumentationVersion?: string
  /** Optional low-sensitivity metadata, added only when callers provide it. */
  readonly metadata?: OTelMetadata
  /**
   * Reserved for a separately reviewed future capture policy. This release only
   * accepts the disabled value and never exports content-bearing fields.
   */
  readonly contentCapture?: OTelContentCaptureExtension
  /** Opt in to calling shutdown on the supplied provider. Defaults to false. */
  readonly shutdownOnShutdown?: boolean
  /** Receives payload-free adapter diagnostics. */
  readonly onDiagnostic?: (diagnostic: OTelDiagnostic) => void
}

export interface OTelMetadata {
  readonly environment?: string
  readonly release?: string
  readonly tenantId?: string
  readonly requestId?: string
}

export interface OTelContentCaptureExtension {
  /**
   * `disabled` (default) exports no content-bearing attribute. Under
   * `upstream-policy` the adapter forwards the bounded set of content
   * attributes that core produces only when `observability.capture` opts in,
   * already redacted and truncated by `SensitiveDataProcessor`. Both opt-ins
   * are required, so this alone never widens what a run records.
   */
  readonly mode?: 'disabled' | 'upstream-policy'
}

export interface OTelTraceSinkOptions extends OTelTraceExporterOptions {
  readonly batching?: BatchingTraceSinkOptions
}

interface SpanEntry {
  readonly span: Span
  readonly startUnixMs: number
  readonly linkKeys: Set<string>
}

const MAX_RECENT_ROOT_CONTEXTS = 256

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}/${spanId}`
}

function linkKey(link: TraceLink): string {
  return `${link.traceId}/${link.spanId}/${link.relation}`
}

function lifecycleResult(status: 'success' | 'failure', code?: string): ExportResult {
  return { status, exported: 0, ...(code ? { code } : {}) }
}

const ACCEPT_FAILURES: Record<TraceRecord['recordType'], {
  readonly diagnostic: OTelDiagnosticCode
  readonly message: string
  readonly code: string
}> = {
  span_start: {
    diagnostic: 'span_start_failed',
    message: 'The OpenTelemetry tracer rejected an OMA span_start record.',
    code: 'OTEL_SPAN_START_FAILED',
  },
  span_event: {
    diagnostic: 'span_event_failed',
    message: 'The OpenTelemetry tracer rejected an OMA span_event record.',
    code: 'OTEL_SPAN_EVENT_FAILED',
  },
  span_end: {
    diagnostic: 'span_end_failed',
    message: 'The OpenTelemetry tracer rejected an OMA span_end record.',
    code: 'OTEL_SPAN_END_FAILED',
  },
}

/**
 * Adapts OMA TraceRecord v2 to an application-owned OpenTelemetry tracer.
 * It deliberately does not configure or replace OpenTelemetry's global provider.
 */
export class OTelTraceExporter implements TraceExporter {
  private readonly tracer: Tracer
  private readonly provider?: OTelTracerProvider
  private readonly openSpans = new Map<string, SpanEntry>()
  private readonly spanContexts = new Map<string, SpanContext>()
  private readonly traceSpanKeys = new Map<string, Set<string>>()
  private readonly recentRootContexts = new Map<string, SpanContext>()
  private readonly shutdownOnShutdown: boolean
  private readonly metadata: Attributes
  private readonly allowUpstreamContent: boolean

  constructor(private readonly options: OTelTraceExporterOptions) {
    if ((options.tracer === undefined) === (options.tracerProvider === undefined)) {
      throw new TypeError('Provide exactly one of tracer or tracerProvider; global OpenTelemetry state is never used.')
    }
    if (options.contentCapture?.mode !== undefined
      && options.contentCapture.mode !== 'disabled'
      && options.contentCapture.mode !== 'upstream-policy') {
      throw new TypeError(
        'Unsupported contentCapture mode for @open-multi-agent/otel. '
        + "Use 'disabled' (default) or 'upstream-policy'.",
      )
    }
    this.allowUpstreamContent = options.contentCapture?.mode === 'upstream-policy'
    this.provider = options.tracerProvider
    this.tracer = options.tracer ?? options.tracerProvider!.getTracer(
      options.instrumentationName ?? '@open-multi-agent/otel',
      options.instrumentationVersion ?? PACKAGE_VERSION,
    )
    this.shutdownOnShutdown = options.shutdownOnShutdown ?? false
    this.metadata = {
      ...(options.metadata?.environment ? {
        'oma.environment': options.metadata.environment,
        'deployment.environment.name': options.metadata.environment,
      } : {}),
      ...(options.metadata?.release ? {
        'oma.release': options.metadata.release,
        'service.version': options.metadata.release,
      } : {}),
      ...(options.metadata?.tenantId ? { 'oma.tenant.id': options.metadata.tenantId } : {}),
      ...(options.metadata?.requestId ? { 'oma.request.id': options.metadata.requestId } : {}),
    }
  }

  export(records: readonly TraceRecord[], _signal: AbortSignal): Promise<ExportResult> {
    let exported = 0
    for (const record of records) {
      try {
        this.accept(record)
        exported++
      } catch {
        const failure = ACCEPT_FAILURES[record.recordType]
        this.diagnostic(failure.diagnostic, failure.message)
        return Promise.resolve({ status: 'failure', exported, code: failure.code })
      }
    }
    return Promise.resolve({ status: 'success', exported })
  }

  async forceFlush(signal: AbortSignal): Promise<ExportResult> {
    if (!this.provider?.forceFlush) return lifecycleResult('success')
    return this.delegateLifecycle(this.provider.forceFlush.bind(this.provider), signal, 'force_flush')
  }

  async shutdown(signal: AbortSignal): Promise<ExportResult> {
    this.finalizeAllOpenSpans(Date.now())
    this.spanContexts.clear()
    this.traceSpanKeys.clear()
    this.recentRootContexts.clear()
    if (!this.shutdownOnShutdown || !this.provider?.shutdown) {
      this.diagnostic('shutdown_skipped', 'Provider shutdown was skipped because the adapter does not own the provider.')
      return lifecycleResult('success')
    }
    return this.delegateLifecycle(this.provider.shutdown.bind(this.provider), signal, 'shutdown')
  }

  private accept(record: TraceRecord): void {
    if (record.recordType === 'span_start') {
      this.start(record)
      return
    }
    if (record.recordType === 'span_event') {
      this.event(record)
      return
    }
    this.end(record)
  }

  private start(record: SpanStartRecord): void {
    const key = spanKey(record.traceId, record.spanId)
    if (this.openSpans.has(key) || this.spanContexts.has(key) || this.recentRootContexts.has(key)) {
      this.diagnostic('duplicate_span_start', 'Duplicate OMA span_start record ignored.')
      return
    }
    const span = this.createSpan(record)
    this.registerSpanContext(record.traceId, key, span.spanContext())
    this.openSpans.set(key, {
      span,
      startUnixMs: record.startUnixMs,
      linkKeys: new Set(record.links?.map(linkKey)),
    })
  }

  private event(record: SpanEventRecord): void {
    const entry = this.openSpans.get(spanKey(record.traceId, record.spanId))
    if (!entry) {
      this.diagnostic('orphan_event', 'OMA span_event arrived without an open OTel span and was ignored.')
      return
    }
    const attributes: Attributes = {
      ...baseAttributes(record),
      ...this.metadata,
      ...this.safeEventAttributes(record),
      'oma.event.name': record.name,
    }
    entry.span.addEvent(`oma.${record.name}`, attributes, record.timestampUnixMs)
    if (record.name === 'first_chunk') {
      const ttftSeconds = Math.max(0, record.timestampUnixMs - entry.startUnixMs) / 1_000
      entry.span.setAttribute('gen_ai.response.time_to_first_chunk', ttftSeconds)
      entry.span.setAttribute('oma.ttft.ms', ttftSeconds * 1_000)
    }
  }

  private end(record: SpanEndRecord): void {
    const key = spanKey(record.traceId, record.spanId)
    let entry = this.openSpans.get(key)
    if (!entry && (this.spanContexts.has(key) || this.recentRootContexts.has(key))) {
      this.diagnostic('duplicate_span_end', 'Duplicate OMA span_end record ignored.')
      return
    }
    if (!entry) {
      this.diagnostic('incomplete_span', 'OMA span_end arrived without span_start; a synthetic OTel span was created.')
      const span = this.createSpan(record, true)
      this.registerSpanContext(record.traceId, key, span.spanContext())
      entry = {
        span,
        startUnixMs: record.startUnixMs,
        linkKeys: new Set(record.links?.map(linkKey)),
      }
      this.openSpans.set(key, entry)
    }
    entry.span.setAttributes({
      ...spanAttributes(record, this.allowUpstreamContent),
      ...this.metadata,
      'oma.status': record.status.code,
    })
    this.addEndLinks(entry, record.links)
    entry.span.setStatus(mapStatus(record.status))
    if (record.error) {
      const errorAttributes: Attributes = {
        'error.type': record.error.code ?? record.error.kind,
        'oma.error.kind': record.error.kind,
        ...(record.error.code ? { 'oma.error.code': record.error.code } : {}),
        ...(record.error.name ? { 'oma.error.name': record.error.name } : {}),
        ...(record.error.retryable !== undefined ? { 'oma.error.retryable': record.error.retryable } : {}),
        ...(record.error.httpStatus !== undefined ? { 'oma.error.http_status': record.error.httpStatus } : {}),
        ...(record.error.provider ? { 'oma.error.provider': record.error.provider } : {}),
        ...(record.error.attempt !== undefined ? { 'oma.error.attempt': record.error.attempt } : {}),
      }
      entry.span.setAttributes(errorAttributes)
      entry.span.addEvent('exception', errorAttributes, record.endUnixMs)
    }
    entry.span.end(record.endUnixMs)
    this.openSpans.delete(key)
    if (record.kind === 'run') {
      const rootContext = this.spanContexts.get(key)
      if (rootContext) this.rememberRootContext(key, rootContext)
      this.finalizeTrace(record.traceId, record.endUnixMs)
    }
  }

  private createSpan(record: SpanStartRecord | SpanEndRecord, incomplete = false): Span {
    const parent = record.parentSpanId
      ? this.spanContexts.get(spanKey(record.traceId, record.parentSpanId))
      : undefined
    // Root spans must not parent under whatever application span happens to be
    // active at export time; batching makes that ambient context arbitrary.
    const parentContext = parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT
    const attributes: Attributes = {
      ...spanAttributes(record, this.allowUpstreamContent),
      ...this.metadata,
      ...(incomplete ? { 'oma.record.incomplete': true } : {}),
    }
    const span = this.tracer.startSpan(record.name, {
      kind: mapSpanKind(record.kind),
      attributes,
      links: record.links?.map((link) => this.mapLink(link)),
      startTime: record.startUnixMs,
    }, parentContext)
    return span
  }

  private safeEventAttributes(record: SpanEventRecord): Attributes {
    return mapOmaAttributes(record.attributes, this.allowUpstreamContent)
  }

  private addEndLinks(entry: SpanEntry, links: readonly TraceLink[] | undefined): void {
    for (const link of links ?? []) {
      const key = linkKey(link)
      if (entry.linkKeys.has(key)) continue
      entry.span.addLink(this.mapLink(link))
      entry.linkKeys.add(key)
    }
  }

  private mapLink(link: TraceLink) {
    const key = spanKey(link.traceId, link.spanId)
    return mapLink(link, this.spanContexts.get(key) ?? this.recentRootContexts.get(key))
  }

  private registerSpanContext(traceId: string, key: string, spanContext: SpanContext): void {
    this.spanContexts.set(key, spanContext)
    let keys = this.traceSpanKeys.get(traceId)
    if (!keys) {
      keys = new Set()
      this.traceSpanKeys.set(traceId, keys)
    }
    keys.add(key)
  }

  private rememberRootContext(key: string, spanContext: SpanContext): void {
    this.recentRootContexts.delete(key)
    this.recentRootContexts.set(key, spanContext)
    while (this.recentRootContexts.size > MAX_RECENT_ROOT_CONTEXTS) {
      const oldest = this.recentRootContexts.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.recentRootContexts.delete(oldest)
    }
  }

  private finalizeTrace(traceId: string, endUnixMs: number): void {
    const keys = this.traceSpanKeys.get(traceId)
    if (!keys) return
    for (const key of keys) {
      const entry = this.openSpans.get(key)
      if (entry) this.finalizeIncompleteSpan(key, entry, endUnixMs)
      this.spanContexts.delete(key)
    }
    this.traceSpanKeys.delete(traceId)
  }

  private finalizeAllOpenSpans(endUnixMs: number): void {
    for (const [key, entry] of this.openSpans) {
      this.finalizeIncompleteSpan(key, entry, endUnixMs)
    }
    this.openSpans.clear()
  }

  private finalizeIncompleteSpan(key: string, entry: SpanEntry, endUnixMs: number): void {
    this.diagnostic('incomplete_span', 'OMA trace closed without span_end; the open OTel span was ended as incomplete.')
    try {
      entry.span.setAttribute('oma.record.incomplete', true)
      entry.span.setStatus({ code: SpanStatusCode.UNSET })
      entry.span.end(endUnixMs)
    } catch {
      this.diagnostic('span_end_failed', 'The OpenTelemetry tracer rejected cleanup of an incomplete OMA span.')
    } finally {
      this.openSpans.delete(key)
    }
  }

  private async delegateLifecycle(
    action: () => Promise<void>,
    signal: AbortSignal,
    operation: 'force_flush' | 'shutdown',
  ): Promise<ExportResult> {
    if (signal.aborted) {
      this.diagnostic(`${operation}_timeout` as OTelDiagnosticCode, `OpenTelemetry ${operation} timed out.`)
      return lifecycleResult('failure', `OTEL_${operation.toUpperCase()}_TIMEOUT`)
    }
    const actionResult = Promise.resolve().then(action).then(
      () => ({ kind: 'success' as const }),
      () => ({ kind: 'failure' as const }),
    )
    let removeAbortListener: (() => void) | undefined
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      const onAbort = () => resolve({ kind: 'timeout' })
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    })
    const outcome = await Promise.race([actionResult, timeout])
    removeAbortListener?.()
    if (outcome.kind === 'success') return lifecycleResult('success')
    if (outcome.kind === 'timeout') {
      this.diagnostic(`${operation}_timeout` as OTelDiagnosticCode, `OpenTelemetry ${operation} timed out.`)
      return lifecycleResult('failure', `OTEL_${operation.toUpperCase()}_TIMEOUT`)
    }
    this.diagnostic(`${operation}_failed` as OTelDiagnosticCode, `OpenTelemetry ${operation} failed.`)
    return lifecycleResult('failure', `OTEL_${operation.toUpperCase()}_FAILED`)
  }

  private diagnostic(code: OTelDiagnosticCode, message: string): void {
    try {
      this.options.onDiagnostic?.({ code, message })
    } catch {
      // Diagnostics are best effort and must never alter OMA execution.
    }
  }
}

/** Build an OBS-2 TraceSink around the OTel adapter without adding OTel to core. */
export function createOtelTraceSink(options: OTelTraceSinkOptions): TraceSink {
  const { batching, ...exporterOptions } = options
  return new BatchingTraceSink(new OTelTraceExporter(exporterOptions), batching)
}

/** Convenience factory for callers that want to provide the adapter to their own BatchingTraceSink. */
export function createOtelTraceExporter(options: OTelTraceExporterOptions): OTelTraceExporter {
  return new OTelTraceExporter(options)
}
