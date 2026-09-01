import { randomBytes, randomUUID } from 'node:crypto'
import type {
  RunIdentity,
  RunStatus,
  StructuredTraceError,
  TraceAttributeValue,
  TraceEvent,
  TraceLink,
} from '../types.js'
import type {
  SpanEndRecord,
  SpanEventName,
  SpanEventRecord,
  SpanKind,
  SpanStartRecord,
  TraceRecord,
} from './records.js'
import type { TraceSink } from './sink.js'
import { attachLegacyTraceEvent, LegacyCallbackTraceSink } from './legacy-callback.js'
import { CompositeSink } from './composite.js'

export type TraceRecordObserver = (record: TraceRecord) => void

/**
 * Internal marker used when a public LegacyCallbackTraceSink is configured as
 * a v2 sink. Call sites still build the unchanged legacy event metadata, while
 * TraceRuntime avoids installing a second callback sink.
 */
export const LEGACY_TRACE_METADATA_ONLY = (): void => {}

/** Internal-only hook used by contract tests until OBS-2 introduces TraceSink. */
export const TRACE_RECORD_OBSERVER = Symbol('oma.traceRecordObserver')

export interface InternalTraceRecordConfig {
  readonly [TRACE_RECORD_OBSERVER]?: TraceRecordObserver
}

export interface StartSpanOptions {
  readonly kind: SpanKind
  readonly name: string
  readonly parent?: TraceSpan | string
  readonly spanId?: string
  readonly links?: readonly TraceLink[]
  readonly attributes?: Readonly<Record<string, TraceAttributeValue>>
}

export interface EndSpanOptions {
  readonly status: RunStatus
  readonly error?: StructuredTraceError
  readonly links?: readonly TraceLink[]
  readonly attributes?: Readonly<Record<string, TraceAttributeValue>>
  /** Exact legacy completion event emitted after the v2 end record. */
  readonly legacyEvent?: TraceEvent
}

function w3cSpanId(): string {
  let id = randomBytes(8).toString('hex')
  while (/^0+$/.test(id)) id = randomBytes(8).toString('hex')
  return id
}

function safeObserve(observer: TraceRecordObserver | undefined, record: TraceRecord): void {
  if (!observer) return
  try {
    observer(record)
  } catch {
    // Telemetry must never change execution semantics.
  }
}

function safeEmit(sink: TraceSink | undefined, record: TraceRecord): void {
  if (!sink) return
  try {
    sink.emit(record)
  } catch {
    // A user-supplied sink must never change execution semantics.
  }
}

/** One top-level attempt's synchronous record runtime. */
export class TraceRuntime {
  readonly identity: RunIdentity
  readonly root: TraceSpan
  /**
   * True when the configured capture policy opts into tool input/output.
   * Instrumentation sites read this before serializing content they would
   * otherwise build and immediately discard; `SensitiveDataProcessor` still
   * performs the authoritative filtering and redaction.
   */
  readonly capturesToolIO: boolean
  private sequence = 0
  private readonly sink?: TraceSink

  constructor(
    identity: RunIdentity,
    private readonly observer?: TraceRecordObserver,
    legacyCallback?: (event: TraceEvent) => void | Promise<void>,
    sink?: TraceSink,
    rootAttributes: Readonly<Record<string, TraceAttributeValue>> = {},
    capturesToolIO = false,
  ) {
    this.identity = identity
    this.capturesToolIO = capturesToolIO
    const legacySink = legacyCallback && legacyCallback !== LEGACY_TRACE_METADATA_ONLY
      ? new LegacyCallbackTraceSink(legacyCallback)
      : undefined
    this.sink = sink && legacySink
      ? new CompositeSink([sink, legacySink], { diagnostics: 'silent' })
      : sink ?? legacySink
    this.root = this.startSpan({
      kind: 'run',
      name: 'oma.run',
      spanId: identity.rootSpanId,
      links: identity.links,
      attributes: {
        'oma.run.id': identity.runId,
        'oma.run.attempt': identity.attempt,
        ...rootAttributes,
      },
    })
  }

  startSpan(options: StartSpanOptions): TraceSpan {
    return new TraceSpan(this, {
      ...options,
      spanId: options.spanId ?? w3cSpanId(),
      parentSpanId: typeof options.parent === 'string'
        ? options.parent
        : options.parent?.spanId,
      startUnixMs: Date.now(),
    })
  }

  close(options: EndSpanOptions): boolean {
    return this.root.end(options)
  }

  emitStart(span: TraceSpan): void {
    const record: SpanStartRecord = {
      ...this.base(span),
      recordType: 'span_start',
      kind: span.kind,
      name: span.name,
      startUnixMs: span.startUnixMs,
      ...(span.links.length > 0 ? { links: span.links } : {}),
      attributes: span.attributes,
    }
    safeObserve(this.observer, record)
    safeEmit(this.sink, record)
  }

  emitEvent(
    span: TraceSpan,
    name: SpanEventName,
    attributes: Readonly<Record<string, TraceAttributeValue>>,
    legacyEvent?: TraceEvent,
  ): void {
    if (span.ended) return
    const record: SpanEventRecord = {
      ...this.base(span),
      recordType: 'span_event',
      name,
      attributes,
    }
    if (legacyEvent) attachLegacyTraceEvent(record, legacyEvent)
    safeObserve(this.observer, record)
    safeEmit(this.sink, record)
  }

  emitEnd(span: TraceSpan, options: EndSpanOptions, endUnixMs: number): void {
    const links = [...span.links, ...(options.links ?? [])]
    const attributes = { ...span.attributes, ...options.attributes, 'oma.status': options.status.code }
    const record: SpanEndRecord = {
      ...this.base(span),
      recordType: 'span_end',
      kind: span.kind,
      name: span.name,
      startUnixMs: span.startUnixMs,
      endUnixMs,
      durationMs: Math.max(0, endUnixMs - span.startUnixMs),
      status: options.status,
      ...(options.error ? { error: options.error } : {}),
      ...(links.length > 0 ? { links } : {}),
      attributes,
    }
    if (options.legacyEvent) attachLegacyTraceEvent(record, options.legacyEvent)
    safeObserve(this.observer, record)
    safeEmit(this.sink, record)
  }

  private base(span: TraceSpan) {
    return {
      schemaVersion: 2 as const,
      recordId: randomUUID(),
      sequence: ++this.sequence,
      timestampUnixMs: Date.now(),
      runId: this.identity.runId,
      attempt: this.identity.attempt,
      traceId: this.identity.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    }
  }
}

/** Idempotently closable span handle. */
export class TraceSpan {
  readonly spanId: string
  readonly parentSpanId?: string
  readonly kind: SpanKind
  readonly name: string
  readonly startUnixMs: number
  readonly links: readonly TraceLink[]
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>
  private closed = false

  constructor(
    private readonly runtime: TraceRuntime,
    options: StartSpanOptions & {
      readonly spanId: string
      readonly parentSpanId?: string
      readonly startUnixMs: number
    },
  ) {
    this.spanId = options.spanId
    this.parentSpanId = options.parentSpanId
    this.kind = options.kind
    this.name = options.name
    this.startUnixMs = options.startUnixMs
    this.links = options.links ?? []
    this.attributes = options.attributes ?? {}
    runtime.emitStart(this)
  }

  get ended(): boolean { return this.closed }

  event(
    name: SpanEventName,
    attributes: Readonly<Record<string, TraceAttributeValue>> = {},
    legacyEvent?: TraceEvent,
  ): void {
    this.runtime.emitEvent(this, name, attributes, legacyEvent)
  }

  end(options: EndSpanOptions): boolean {
    if (this.closed) return false
    this.closed = true
    this.runtime.emitEnd(this, options, Date.now())
    return true
  }

  ensureEnded(options?: EndSpanOptions): boolean {
    return this.end(options ?? {
      status: { code: 'error', message: 'Span exited without an explicit outcome.' },
      error: { kind: 'framework', code: 'SPAN_NOT_CLOSED', message: 'Span exited without an explicit outcome.' },
    })
  }
}

export function traceRecordObserverFrom(config: unknown): TraceRecordObserver | undefined {
  return (config as InternalTraceRecordConfig | undefined)?.[TRACE_RECORD_OBSERVER]
}

export function createTraceRuntime(
  identity: RunIdentity,
  legacyCallback?: (event: TraceEvent) => void | Promise<void>,
  observer?: TraceRecordObserver,
  sink?: TraceSink,
  rootAttributes?: Readonly<Record<string, TraceAttributeValue>>,
  capturesToolIO?: boolean,
): TraceRuntime | undefined {
  return legacyCallback || observer || sink
    ? new TraceRuntime(identity, observer, legacyCallback, sink, rootAttributes, capturesToolIO)
    : undefined
}
