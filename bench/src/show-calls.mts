/**
 * Prints the raw provider-call log for one benchmark run: UTC timestamp, model,
 * exact token counts, latency, HTTP status — straight out of
 * `bench/runs/<date>/calls.json`, with no aggregation in between.
 *
 *   npx tsx bench/src/show-calls.mts --date 2026-08-18
 *
 * This is the audit view. The CSV and REPORT.md are derived from these rows, so
 * anything in them can be checked against this.
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from './config.mts'
import type { CallRecord } from './proxy.mts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const date = flag('date') ?? new Date().toISOString().slice(0, 10)
const runsDir = path.join(BENCH_ROOT, 'runs', date)
const callsPath = path.join(runsDir, 'calls.json')
const manifestPath = path.join(runsDir, 'manifest.json')

if (!existsSync(callsPath)) {
  console.error(`No call log at ${callsPath}. Run the benchmark first.`)
  process.exit(1)
}

const all = JSON.parse(readFileSync(callsPath, 'utf-8')) as CallRecord[]
const limitArg = flag('limit')
const limit = limitArg === undefined ? all.length : Number(limitArg)
const calls = all.slice(0, limit)
const manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, any>)
  : {}

const utc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
const pad = (text: string | number, width: number, right = false): string => {
  const value = String(text)
  return right ? value.padStart(width) : value.padEnd(width)
}

const bar = '─'.repeat(118)
console.log(bar)
console.log(`OMA A/B benchmark — provider call log`)
console.log(`  file        ${callsPath}`)
if (manifest['startedAtUtc']) {
  console.log(`  window UTC  ${manifest['startedAtUtc']} → ${manifest['finishedAtUtc']}`)
}
if (manifest['gitSha']) console.log(`  git sha     ${manifest['gitSha']}`)
if (manifest['node']) console.log(`  node        ${manifest['node']}`)
if (manifest['config']) {
  const config = manifest['config'] as Record<string, any>
  console.log(`  models      ${config['models']?.strong} / ${config['models']?.cheap}   temperature ${config['temperature']}   thinking ${config['thinking']?.enabled ? 'enabled' : 'disabled'}`)
}
console.log(`  calls       ${all.length}${calls.length === all.length ? '' : ` (showing first ${calls.length})`}`)
console.log(bar)
console.log(
  `${pad('#', 4)} ${pad('started (UTC)', 24)} ${pad('run', 22)} ${pad('model', 18)} `
  + `${pad('in', 7, true)} ${pad('cached', 7, true)} ${pad('out', 7, true)} ${pad('ms', 7, true)} ${pad('http', 5, true)}`,
)
console.log(bar)

let totalIn = 0
let totalOut = 0
let totalCached = 0
calls.forEach((call, index) => {
  totalIn += call.inputTokens
  totalOut += call.outputTokens
  totalCached += call.cachedInputTokens
  console.log(
    `${pad(index + 1, 4)} ${pad(utc(call.startedAt), 24)} ${pad(call.label, 22)} ${pad(call.model, 18)} `
    + `${pad(call.inputTokens, 7, true)} ${pad(call.cachedInputTokens, 7, true)} ${pad(call.outputTokens, 7, true)} `
    + `${pad(call.latencyMs, 7, true)} ${pad(call.status, 5, true)}`,
  )
})

console.log(bar)
console.log(
  `${pad('', 4)} ${pad('TOTAL', 24)} ${pad('', 22)} ${pad('', 18)} `
  + `${pad(totalIn, 7, true)} ${pad(totalCached, 7, true)} ${pad(totalOut, 7, true)}`,
)
console.log(bar)
console.log(
  `cache-hit prompt tokens: ${totalCached} of ${totalIn} — cache busting ${totalCached === 0 ? 'confirmed effective' : 'DID NOT fully suppress the cache'}`,
)
const failed = all.filter((call) => call.status !== 200).length
console.log(`non-200 responses across all ${all.length} calls: ${failed}`)
