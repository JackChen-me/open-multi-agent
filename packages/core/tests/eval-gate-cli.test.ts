import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { tsxCli } from './helpers/tsx-cli.js'

const cliSource = fileURLToPath(new URL('../src/cli/oma.ts', import.meta.url))
const fixtures = fileURLToPath(new URL('./fixtures/eval/', import.meta.url))
const setPath = join(fixtures, 'set.json')
const targetPath = join(fixtures, 'target.mjs')
const failingTargetPath = join(fixtures, 'target-gate-fail.mjs')
const gatePath = join(fixtures, 'gate.json')
const baselinePath = join(fixtures, 'baseline.json')

interface CliRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'oma-eval-gate-cli-'))
}

function runCli(args: readonly string[], cwd = temporaryDirectory()): CliRun {
  const result = spawnSync(process.execPath, [tsxCli, cliSource, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function output(run: CliRun): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>
}

function failingReportPath(): string {
  const report = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    records: Array<Record<string, unknown>>
    aggregates: Array<Record<string, unknown>>
  }
  report.records = report.records.map((record) => ({
    ...record,
    score: 0,
    pass: false,
    reason: 'mismatch',
  }))
  report.aggregates = report.aggregates.map((aggregate) => ({
    ...aggregate,
    avg: 0,
    p50: 0,
    p95: 0,
    min: 0,
    max: 0,
    passRate: 0,
  }))
  const path = join(temporaryDirectory(), 'failing-report.json')
  writeFileSync(path, JSON.stringify(report), 'utf8')
  return path
}

describe('oma eval run quality gate', () => {
  it('runs a no-network gate+baseline flow with pass and fail exit paths', () => {
    const passingOut = temporaryDirectory()
    const passing = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', targetPath,
      '--gate', gatePath,
      '--baseline', baselinePath,
      '--report', 'junit',
      '--out', passingOut,
    ])

    expect(passing.status, passing.stderr).toBe(0)
    const passingSummary = output(passing)
    expect(passingSummary['verdict']).toEqual({ pass: true, failures: [], warnings: [] })
    const passingVerdictPath = passingSummary['verdictPath'] as string
    expect(passingVerdictPath).toBe(join(
      passingOut,
      String(passingSummary['evalRunId']),
      'verdict.json',
    ))
    expect(JSON.parse(readFileSync(passingVerdictPath, 'utf8'))).toEqual(
      passingSummary['verdict'],
    )

    const failingOut = temporaryDirectory()
    const failing = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', failingTargetPath,
      '--gate', gatePath,
      '--baseline', baselinePath,
      '--out', failingOut,
    ])

    expect(failing.status, failing.stderr).toBe(1)
    const failingSummary = output(failing)
    const verdict = failingSummary['verdict'] as {
      pass: boolean
      failures: Array<{ kind: string }>
    }
    expect(verdict.pass).toBe(false)
    expect(verdict.failures.map((failure) => failure.kind)).toEqual([
      'threshold',
      'regression',
    ])
    expect(JSON.parse(readFileSync(failingSummary['verdictPath'] as string, 'utf8'))).toEqual(
      verdict,
    )
  })

  it('supports --gate without a baseline and rejects --baseline without --gate', () => {
    const gated = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', targetPath,
      '--gate', gatePath,
      '--out', temporaryDirectory(),
    ])

    expect(gated.status, gated.stderr).toBe(0)
    expect(output(gated)['verdict']).toMatchObject({
      pass: true,
      warnings: [expect.stringContaining('no baseline report was provided')],
    })

    const baselineOnly = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', targetPath,
      '--baseline', baselinePath,
    ])
    expect(baselineOnly.status).toBe(2)
    expect(output(baselineOnly)).toEqual({
      error: { kind: 'validation', message: '--baseline requires --gate' },
    })
  })
})

describe('oma eval gate', () => {
  it('evaluates existing reports with pass and fail exit paths', () => {
    const passing = runCli([
      'eval', 'gate',
      '--report', baselinePath,
      '--gate', gatePath,
      '--baseline', baselinePath,
    ])
    expect(passing.status, passing.stderr).toBe(0)
    expect(output(passing)).toEqual({ pass: true, failures: [], warnings: [] })

    const failing = runCli([
      'eval', 'gate',
      '--report', failingReportPath(),
      '--gate', gatePath,
      '--baseline', baselinePath,
    ])
    expect(failing.status, failing.stderr).toBe(1)
    expect(output(failing)).toMatchObject({
      pass: false,
      failures: [
        { kind: 'threshold' },
        { kind: 'regression' },
      ],
    })
  })

  it('maps invalid gate and report files to usage exit code 2', () => {
    const directory = temporaryDirectory()
    const invalidGate = join(directory, 'invalid-gate.json')
    const invalidReport = join(directory, 'invalid-report.json')
    writeFileSync(invalidGate, JSON.stringify({ schemaVersion: 2, thresholds: [] }), 'utf8')
    writeFileSync(invalidReport, JSON.stringify({ schemaVersion: 2 }), 'utf8')

    const gateFailure = runCli([
      'eval', 'gate',
      '--report', baselinePath,
      '--gate', invalidGate,
    ])
    expect(gateFailure.status).toBe(2)
    expect(output(gateFailure)).toMatchObject({ error: { kind: 'validation' } })

    const reportFailure = runCli([
      'eval', 'gate',
      '--report', invalidReport,
      '--gate', gatePath,
    ])
    expect(reportFailure.status).toBe(2)
    expect(output(reportFailure)).toMatchObject({ error: { kind: 'validation' } })
  })

  it('is documented in CLI help', () => {
    const run = runCli(['help'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(
      'oma eval gate --report <report.json> --gate <gate.json> [--baseline <report.json>]',
    )
  })
})
