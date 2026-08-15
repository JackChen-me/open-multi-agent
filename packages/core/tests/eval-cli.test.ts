import { readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { tsxCli } from './helpers/tsx-cli.js'

const cliSource = fileURLToPath(new URL('../src/cli/oma.ts', import.meta.url))
const fixtures = fileURLToPath(new URL('./fixtures/eval/', import.meta.url))
const setPath = join(fixtures, 'set.json')

interface CliRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'oma-eval-cli-'))
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

describe('oma eval run', () => {
  it('loads an object target, merges metadata, and writes every requested report', async () => {
    const out = temporaryDirectory()
    const run = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'target.mjs'),
      '--repeats', '2',
      '--concurrency', '1',
      '--tags', 'upper',
      '--report', 'json',
      '--report=markdown',
      '--report', 'junit',
      '--out', out,
      '--meta', 'prompt_version=v2',
      '--meta=release=canary',
    ])

    expect(run.status, run.stderr).toBe(0)
    const summary = output(run)
    expect(summary).toMatchObject({
      command: 'eval',
      subcommand: 'run',
      caseCount: 2,
      repeats: 2,
      targetErrors: 0,
      scorers: [{ name: 'exact', version: '1', avg: 1, passRate: 1, errorCount: 0 }],
    })
    const reports = summary['reports'] as Record<string, string>
    expect(reports['json']).toBe(join(out, String(summary['evalRunId']), 'report.json'))
    expect(reports['markdown']).toBe(join(out, String(summary['evalRunId']), 'report.md'))
    expect(reports['junit']).toBe(join(out, String(summary['evalRunId']), 'report.junit.xml'))

    const report = JSON.parse(await readFile(reports['json']!, 'utf8')) as Record<string, unknown>
    expect(report['schemaVersion']).toBe(1)
    expect(report['metadata']).toEqual({ prompt_version: 'v2', release: 'canary' })
    expect((report['records'] as unknown[])).toHaveLength(4)
    expect(await readFile(reports['markdown']!, 'utf8')).toContain('# Evaluation Report: uppercase@1.0.0')
    expect(await readFile(reports['junit']!, 'utf8')).toContain('tests="4" failures="0" errors="0"')
  })

  it('accepts a function target plus a separate scorer module and uses the default output root', async () => {
    const cwd = temporaryDirectory()
    const run = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'target-function.mjs'),
      '--scorers', join(fixtures, 'scorers.mjs'),
    ], cwd)

    expect(run.status, run.stderr).toBe(0)
    const summary = output(run)
    const reports = summary['reports'] as Record<string, string>
    expect(Object.keys(reports)).toEqual(['json'])
    expect(reports['json']).toBe(join(
      await realpath(cwd),
      'eval-results',
      String(summary['evalRunId']),
      'report.json',
    ))
    expect(JSON.parse(await readFile(reports['json']!, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('returns usage for duplicate scorer names and for no scorers', () => {
    const duplicate = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'target.mjs'),
      '--scorers', join(fixtures, 'scorers.mjs'),
    ])
    expect(duplicate.status).toBe(2)
    expect(output(duplicate)).toMatchObject({
      error: { kind: 'validation', message: 'Duplicate scorer name: exact' },
    })

    const missing = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'target-function.mjs'),
    ])
    expect(missing.status).toBe(2)
    expect(output(missing)).toMatchObject({
      error: { kind: 'validation', message: 'At least one scorer is required' },
    })
  })

  it('maps missing set and target-module load failures to usage exit code 2', () => {
    const missingSet = runCli([
      'eval', 'run',
      '--set', join(fixtures, 'missing.json'),
      '--target', join(fixtures, 'target.mjs'),
    ])
    expect(missingSet.status).toBe(2)
    expect(output(missingSet)).toMatchObject({ error: { kind: 'io' } })

    const missingTarget = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'missing-target.mjs'),
    ])
    expect(missingTarget.status).toBe(2)
    expect(output(missingTarget)).toMatchObject({ error: { kind: 'validation' } })
  })

  it('returns 0 for partial target failure and 1 only when every target fails', () => {
    const partial = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'target-partial-failure.mjs'),
      '--out', temporaryDirectory(),
    ])
    expect(partial.status, partial.stderr).toBe(0)
    expect(output(partial)).toMatchObject({ targetErrors: 1 })

    const all = runCli([
      'eval', 'run',
      '--set', setPath,
      '--target', join(fixtures, 'target-all-failure.mjs'),
      '--out', temporaryDirectory(),
    ])
    expect(all.status, all.stderr).toBe(1)
    expect(output(all)).toMatchObject({ targetErrors: 2 })
  })
})

describe('oma eval help and routing', () => {
  it('documents eval run in help', () => {
    const run = runCli(['help'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('oma eval run --set <evalset.json> --target <target.mjs>')
  })

  it('returns usage for unknown eval subcommands', () => {
    const run = runCli(['eval', 'xyz'])
    expect(run.status).toBe(2)
    expect(output(run)).toEqual({
      error: { kind: 'usage', message: 'unknown eval subcommand: xyz' },
    })
  })
})
