import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DashboardCliError,
  DashboardTraceCaptureSink,
  EXIT,
  PROVIDER_REFERENCE,
  exportCurrentRunDashboard,
  exportStoredRunDashboard,
  parseArgs,
  renderCapturedRunDashboard,
  serializeAgentResult,
  serializeTeamRunResult,
  writeDashboardFile,
} from '../src/cli/oma.js'
import type { AgentRunResult, TeamRunResult } from '../src/types.js'
import type { TraceRecord } from '../src/observability/records.js'
import type { StoredRun } from '../src/observability/store.js'
import { FileTraceStore } from '../src/observability/file-store.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oma-cli-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

function records(runId: string): TraceRecord[] {
  const base = {
    schemaVersion: 2 as const,
    recordId: `${runId}-start`,
    sequence: 1,
    timestampUnixMs: 1_000,
    runId,
    attempt: 1,
    traceId: '1'.repeat(32),
    spanId: '1'.repeat(16),
  }
  return [
    {
      ...base,
      recordType: 'span_start',
      kind: 'run',
      name: 'oma.run',
      startUnixMs: 1_000,
      attributes: {},
    },
    {
      ...base,
      recordId: `${runId}-end`,
      sequence: 2,
      timestampUnixMs: 1_100,
      recordType: 'span_end',
      kind: 'run',
      name: 'oma.run',
      startUnixMs: 1_000,
      endUnixMs: 1_100,
      durationMs: 100,
      status: { code: 'ok' },
      attributes: {},
    },
  ]
}

function storedRun(runId: string): StoredRun {
  return {
    schemaVersion: 2,
    runId,
    attempts: [{
      attempt: 1,
      traceId: '1'.repeat(32),
      rootSpanId: '1'.repeat(16),
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(1_100).toISOString(),
      durationMs: 100,
      status: 'ok',
      incomplete: false,
    }],
    startedAt: new Date(1_000).toISOString(),
    endedAt: new Date(1_100).toISOString(),
    durationMs: 100,
    status: 'ok',
    agents: [],
    taskIds: [],
    models: [],
    providers: [],
    tokens: { input_tokens: 0, output_tokens: 0 },
    costs: [],
    incomplete: false,
    spans: [],
  }
}

describe('parseArgs', () => {
  it('parses flags, key=value, and key value', () => {
    const a = parseArgs(['node', 'oma', 'run', '--goal', 'hello', '--team=x.json', '--pretty'])
    expect(a._[0]).toBe('run')
    expect(a.kv.get('goal')).toBe('hello')
    expect(a.kv.get('team')).toBe('x.json')
    expect(a.flags.has('pretty')).toBe(true)
  })
})

describe('serializeTeamRunResult', () => {
  it('maps agentResults to a plain object', () => {
    const ar: AgentRunResult = {
      success: true,
      output: 'ok',
      messages: [],
      tokenUsage: { input_tokens: 1, output_tokens: 2 },
      toolCalls: [],
    }
    const tr: TeamRunResult = {
      success: true,
      routingDecision: {
        mode: 'single',
        reasons: ['simple goal'],
        routerVersion: 'deterministic-v1',
      },
      agentResults: new Map([['alice', ar]]),
      taskResults: new Map([['task-1', ar]]),
      totalTokenUsage: { input_tokens: 1, output_tokens: 2 },
    }
    const json = serializeTeamRunResult(tr, { pretty: false, includeMessages: false })
    expect(json.success).toBe(true)
    expect(json.routingDecision).toEqual(tr.routingDecision)
    expect((json.agentResults as Record<string, unknown>)['alice']).toMatchObject({
      success: true,
      output: 'ok',
    })
    expect((json.agentResults as Record<string, unknown>)['alice']).not.toHaveProperty('messages')
    expect((json.taskResults as Record<string, unknown>)['task-1']).toMatchObject({
      success: true,
      output: 'ok',
    })
    expect((json.taskResults as Record<string, unknown>)['task-1']).not.toHaveProperty('messages')
  })

  it('includes messages when requested', () => {
    const ar: AgentRunResult = {
      success: true,
      output: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      toolCalls: [],
    }
    const tr: TeamRunResult = {
      success: true,
      agentResults: new Map([['bob', ar]]),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    }
    const json = serializeTeamRunResult(tr, { pretty: false, includeMessages: true })
    expect(serializeAgentResult(ar, true).messages).toHaveLength(1)
    expect((json.agentResults as Record<string, unknown>)['bob']).toHaveProperty('messages')
  })
})

describe('EXIT', () => {
  it('uses stable numeric codes', () => {
    expect(EXIT.SUCCESS).toBe(0)
    expect(EXIT.RUN_FAILED).toBe(1)
    expect(EXIT.USAGE).toBe(2)
    expect(EXIT.INTERNAL).toBe(3)
  })
})

describe('DashboardTraceCaptureSink', () => {
  it('captures records synchronously and rejects later emits after shutdown', async () => {
    const sink = new DashboardTraceCaptureSink()
    const batch = records('capture')
    batch.forEach((record) => sink.emit(record))
    expect(sink.records()).toEqual(batch)
    expect(await sink.forceFlush()).toMatchObject({ status: 'ok', accepted: 2, exported: 2 })
    await sink.shutdown()
    sink.emit({ ...batch[0]!, recordId: 'late' })
    expect(sink.records()).toHaveLength(2)
  })

  it('falls back to result-only HTML with an explicit capture warning', () => {
    const result: TeamRunResult = {
      success: true,
      identity: { runId: 'missing-trace', attempt: 1 },
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    }
    const rendered = renderCapturedRunDashboard(result, [])
    expect(rendered.captureWarning).toContain('DASHBOARD_TRACE_CAPTURE_FAILED')
    expect(rendered.html).toContain('Structured trace data was not provided')
  })

  it('keeps current-run render and write failures in fixed dashboard-only categories', async () => {
    const result: TeamRunResult = {
      success: true,
      identity: { runId: 'current-run', attempt: 1 },
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    }
    await expect(exportCurrentRunDashboard(result, [], {
      render: () => { throw new Error('bad renderer') },
    })).resolves.toEqual({ warnings: ['DASHBOARD_RENDER_FAILED: bad renderer'] })
    await expect(exportCurrentRunDashboard(result, [], {
      render: () => ({ html: '<html></html>', captureWarning: 'DASHBOARD_TRACE_CAPTURE_FAILED: fallback' }),
      write: async () => { throw new Error('read-only filesystem') },
    })).resolves.toEqual({
      warnings: [
        'DASHBOARD_TRACE_CAPTURE_FAILED: fallback',
        'DASHBOARD_WRITE_FAILED: read-only filesystem',
      ],
    })
  })

  it('returns the current dashboard path without changing the serialized run result', async () => {
    const result: TeamRunResult = {
      success: true,
      identity: { runId: 'current-run', attempt: 1 },
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    }
    const exported = await exportCurrentRunDashboard(result, records('current-run'), {
      write: async () => '/tmp/current-run.html',
    })
    expect(exported).toEqual({ dashboard: '/tmp/current-run.html', warnings: [] })
    expect(serializeTeamRunResult(result, { pretty: false, includeMessages: false }))
      .not.toHaveProperty('dashboard')
  })
})

describe('dashboard file export', () => {
  it('allocates distinct non-overwriting default paths on timestamp collisions', async () => {
    const directory = await temporaryDirectory()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
    try {
      const paths = await Promise.all([
        writeDashboardFile('one', { prefix: 'run', directory }),
        writeDashboardFile('two', { prefix: 'run', directory }),
      ])
      expect(new Set(paths).size).toBe(2)
      expect(await Promise.all(paths.map((path) => readFile(path, 'utf8'))))
        .toEqual(expect.arrayContaining(['one', 'two']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports one historical FileTraceStore run to a non-overwriting HTML destination', async () => {
    const directory = await temporaryDirectory()
    const storePath = join(directory, 'traces.ndjson')
    const output = join(directory, 'run.html')
    const store = await FileTraceStore.open(storePath)
    await store.append(records('historical'))
    await store.close()

    await expect(exportStoredRunDashboard({ traceStore: storePath, runId: 'historical', output }))
      .resolves.toEqual({ runId: 'historical', dashboard: output })
    expect(await readFile(output, 'utf8')).toContain('OMA Run Viewer')
    await expect(exportStoredRunDashboard({ traceStore: storePath, runId: 'historical', output }))
      .rejects.toMatchObject({ code: 'dashboard_output_exists', exit: EXIT.USAGE })
  })

  it('does not create a missing source and reports a missing run precisely', async () => {
    const directory = await temporaryDirectory()
    const missing = join(directory, 'missing.ndjson')
    await expect(exportStoredRunDashboard({ traceStore: missing, runId: 'x' }))
      .rejects.toMatchObject({ code: 'trace_store_not_found' })

    const storePath = join(directory, 'traces.ndjson')
    const store = await FileTraceStore.open(storePath)
    await store.close()
    await expect(exportStoredRunDashboard({ traceStore: storePath, runId: 'absent' }))
      .rejects.toMatchObject({ code: 'run_not_found' })
  })

  it('surfaces corrupt stores without creating HTML', async () => {
    const directory = await temporaryDirectory()
    const storePath = join(directory, 'corrupt.ndjson')
    await writeFile(storePath, '{"not":"a file header"}\n', 'utf8')
    await expect(exportStoredRunDashboard({ traceStore: storePath, runId: 'x' }))
      .rejects.toMatchObject({ code: 'CORRUPT_FILE' })
  })

  it('reports close failure after a successful render instead of claiming success', async () => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'source.ndjson')
    await writeFile(source, '', 'utf8')
    await expect(exportStoredRunDashboard(
      { traceStore: source, runId: 'close-fail' },
      {
        openStore: async () => ({
          getRun: async () => storedRun('close-fail'),
          close: async () => { throw new Error('close exploded') },
        }),
        render: () => '<html></html>',
        write: async () => join(directory, 'rendered.html'),
      },
    )).rejects.toMatchObject({ code: 'trace_store_close_failed', exit: EXIT.INTERNAL })
  })

  it.each(['render', 'write'] as const)('closes the historical store when %s fails', async (phase) => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'source.ndjson')
    await writeFile(source, '', 'utf8')
    const close = vi.fn(async () => {})
    await expect(exportStoredRunDashboard(
      { traceStore: source, runId: `${phase}-fail` },
      {
        openStore: async () => ({
          getRun: async () => storedRun(`${phase}-fail`),
          close,
        }),
        render: () => {
          if (phase === 'render') throw new Error('render failed')
          return '<html></html>'
        },
        write: async () => {
          throw new Error('write failed')
        },
      },
    )).rejects.toThrow(`${phase} failed`)
    expect(close).toHaveBeenCalledOnce()
  })

  it('refuses to overwrite an explicit destination', async () => {
    const directory = await temporaryDirectory()
    const output = join(directory, 'existing.html')
    await writeFile(output, 'original', 'utf8')
    await expect(writeDashboardFile('replacement', { output }))
      .rejects.toBeInstanceOf(DashboardCliError)
    expect(await readFile(output, 'utf8')).toBe('original')
  })
})

describe('PROVIDER_REFERENCE', () => {
  it('includes the Doubao shortcut for provider list/template commands', () => {
    expect(PROVIDER_REFERENCE).toContainEqual(
      expect.objectContaining({
        id: 'doubao',
        apiKeyEnv: ['ARK_API_KEY'],
        baseUrlSupported: true,
      }),
    )
  })

  it('includes the MiMo shortcut for provider list/template commands', () => {
    expect(PROVIDER_REFERENCE).toContainEqual(
      expect.objectContaining({
        id: 'mimo',
        apiKeyEnv: ['MIMO_API_KEY', 'MIMO_BASE_URL'],
        baseUrlSupported: true,
      }),
    )
  })
})
