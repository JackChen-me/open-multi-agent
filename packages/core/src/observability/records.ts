import type {
  RunStatus,
  StructuredTraceError,
  TraceAttributeValue,
  TraceLink,
} from '../types.js'

/** Stable operation categories used by TraceRecord schema v2. */
export type SpanKind =
  | 'run'
  | 'routing'
  | 'agent'
  | 'task'
  | 'llm'
  | 'tool'
  | 'plan'
  | 'consensus'
  | 'checkpoint'
  | 'callback'

/** Event names emitted by the OBS-1B runtime. */
export type SpanEventName =
  | 'retry_scheduled'
  | 'budget_exhausted'
  | 'first_chunk'
  | 'approval_decision'
  | 'checkpoint_failed'
  | 'telemetry_diagnostic'
  | 'loop_detected'
  | 'stream_chunk'
  | 'consensus_verdict'
  | 'recovery_decision'
  | 'plan_revision_applied'

export interface TraceRecordBase {
  readonly schemaVersion: 2
  readonly recordId: string
  /** Strictly increasing and unique within one traceId. */
  readonly sequence: number
  readonly timestampUnixMs: number
  readonly runId: string
  readonly attempt: number
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
}

export interface SpanStartRecord extends TraceRecordBase {
  readonly recordType: 'span_start'
  readonly kind: SpanKind
  readonly name: string
  readonly startUnixMs: number
  readonly links?: readonly TraceLink[]
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>
}

export interface SpanEventRecord extends TraceRecordBase {
  readonly recordType: 'span_event'
  readonly name: SpanEventName
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>
}

export interface SpanEndRecord extends TraceRecordBase {
  readonly recordType: 'span_end'
  readonly kind: SpanKind
  readonly name: string
  readonly startUnixMs: number
  readonly endUnixMs: number
  readonly durationMs: number
  readonly status: RunStatus
  readonly error?: StructuredTraceError
  readonly links?: readonly TraceLink[]
  /** Complete final snapshot; usable even if the matching start was dropped. */
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>
}

export type TraceRecord = SpanStartRecord | SpanEventRecord | SpanEndRecord
