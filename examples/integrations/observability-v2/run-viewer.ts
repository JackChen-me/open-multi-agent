/**
 * Deterministic Run Viewer demo
 *
 * Run after building the core workspace:
 *   npx tsx examples/integrations/observability-v2/run-viewer.ts
 *
 * The trace is fictional deterministic demo data. It performs no model call,
 * tool execution, network request, or OpenTelemetry registration.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TraceAttributeValue, TraceLink } from '@open-multi-agent/core'
import type { SpanKind, TraceRecord } from '@open-multi-agent/core/observability'
import { FileTraceStore } from '@open-multi-agent/core/observability/file'
import { exportStoredRunDashboard } from '../../../packages/core/src/cli/oma.js'

const runId = 'deterministic-run-viewer-demo'
const traceId = '11111111111111111111111111111111'
const startedAt = Date.UTC(2026, 0, 1, 0, 0, 0)
let sequence = 0

const ids = {
  run: '1000000000000001',
  researchTask: '2000000000000001',
  researcher: '3000000000000001',
  researchLlm: '4000000000000001',
  catalogTool: '5000000000000001',
  writingTask: '2000000000000002',
  writer: '3000000000000002',
  writingLlm: '4000000000000002',
} as const

function recordBase(spanId: string, offsetMs: number, parentSpanId?: string) {
  return {
    schemaVersion: 2 as const,
    recordId: `demo-${++sequence}`,
    sequence,
    timestampUnixMs: startedAt + offsetMs,
    runId,
    attempt: 1,
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
  }
}

function span(
  kind: SpanKind,
  name: string,
  spanId: string,
  startOffsetMs: number,
  endOffsetMs: number,
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  parentSpanId?: string,
  links?: readonly TraceLink[],
): TraceRecord[] {
  return [
    {
      ...recordBase(spanId, startOffsetMs, parentSpanId),
      recordType: 'span_start',
      kind,
      name,
      startUnixMs: startedAt + startOffsetMs,
      attributes,
      ...(links ? { links } : {}),
    },
    {
      ...recordBase(spanId, endOffsetMs, parentSpanId),
      recordType: 'span_end',
      kind,
      name,
      startUnixMs: startedAt + startOffsetMs,
      endUnixMs: startedAt + endOffsetMs,
      durationMs: endOffsetMs - startOffsetMs,
      status: { code: 'ok' },
      attributes,
      ...(links ? { links } : {}),
    },
  ]
}

const records: TraceRecord[] = [
  ...span('run', 'oma.run', ids.run, 0, 1_200, { 'oma.phase': 'deterministic_demo' }),
  ...span('task', 'execute_task', ids.researchTask, 80, 520, {
    'oma.task.id': 'research',
    'oma.task.title': 'Collect catalog evidence',
    'oma.agent.name': 'researcher',
  }, ids.run),
  ...span('agent', 'agent.run', ids.researcher, 100, 500, {
    'oma.task.id': 'research',
    'oma.agent.name': 'researcher',
    'oma.agent.turns': 2,
  }, ids.researchTask),
  ...span('llm', 'llm.chat', ids.researchLlm, 140, 330, {
    'oma.task.id': 'research',
    'oma.agent.name': 'researcher',
    'oma.llm.model': 'deterministic-local-model',
    'oma.llm.provider': 'local-demo',
    'oma.usage.input_tokens': 30,
    'oma.usage.output_tokens': 12,
    'oma.cost.amount': 0.001,
    'oma.cost.currency': 'USD',
  }, ids.researcher),
  ...span('tool', 'catalog_lookup', ids.catalogTool, 340, 470, {
    'oma.task.id': 'research',
    'oma.agent.name': 'researcher',
    'oma.tool.name': 'catalog_lookup',
    'oma.tool.is_error': false,
  }, ids.researcher),
  {
    ...recordBase(ids.catalogTool, 390, ids.researcher),
    recordType: 'span_event',
    name: 'retry_scheduled',
    attributes: {
      'oma.retry.attempt': 2,
      'oma.retry.delay_ms': 40,
      'oma.retry.max_attempts': 2,
    },
  },
  ...span('task', 'execute_task', ids.writingTask, 560, 1_080, {
    'oma.task.id': 'write',
    'oma.task.title': 'Write customer brief',
    'oma.agent.name': 'writer',
  }, ids.run, [{ traceId, spanId: ids.researchTask, relation: 'depends_on' }]),
  ...span('agent', 'agent.run', ids.writer, 590, 1_050, {
    'oma.task.id': 'write',
    'oma.agent.name': 'writer',
    'oma.agent.turns': 1,
  }, ids.writingTask),
  ...span('llm', 'llm.chat', ids.writingLlm, 630, 930, {
    'oma.task.id': 'write',
    'oma.agent.name': 'writer',
    'oma.llm.model': 'deterministic-local-model',
    'oma.llm.provider': 'local-demo',
    'oma.usage.input_tokens': 26,
    'oma.usage.output_tokens': 18,
    'oma.cost.amount': 0.0015,
    'oma.cost.currency': 'USD',
  }, ids.writer),
]

export async function createRunViewerDemo(outputRoot = process.cwd()): Promise<{
  readonly demo: string
  readonly runId: string
  readonly dashboard: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'oma-run-viewer-demo-'))
  const traceStore = join(directory, 'traces.ndjson')
  const dashboard = resolve(outputRoot, 'oma-dashboards/run-viewer-demo.html')
  const store = await FileTraceStore.open(traceStore)
  try {
    await store.append(records)
    await store.flush()
    await store.close()
    const exported = await exportStoredRunDashboard({ traceStore, runId, output: dashboard })
    return {
      demo: 'fictional deterministic Run Viewer data',
      runId: exported.runId,
      dashboard: exported.dashboard,
    }
  } finally {
    try { await store.close() } catch { /* already closed or reported by the export path */ }
    await rm(directory, { recursive: true, force: true })
  }
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false

if (isMain) {
  console.log(await createRunViewerDemo())
}
