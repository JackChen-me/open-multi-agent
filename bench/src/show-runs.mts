/**
 * Per-run audit view built from the results CSV plus each run's artefact mtime.
 *
 *   npx tsx bench/src/show-runs.mts --date 2026-08-18
 *
 * Complements `show-calls.mts`, which needs `calls.json` and is only written
 * when a whole invocation finishes. This view works from artefacts that exist
 * as soon as the runs themselves are done: token counts come from the CSV,
 * timestamps are the filesystem mtime of each run's saved output.
 */

import { readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from './config.mts'
import { fromCSV } from './results.mts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const date = flag('date') ?? new Date().toISOString().slice(0, 10)
const csvPath = path.join(BENCH_ROOT, `results-${date}.csv`)
const runsDir = path.join(BENCH_ROOT, 'runs', date)
if (!existsSync(csvPath)) {
  console.error(`No results CSV at ${csvPath}.`)
  process.exit(1)
}

const rows = fromCSV(readFileSync(csvPath, 'utf-8'))

const utc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
const pad = (text: string | number, width: number, right = false): string => {
  const value = String(text)
  return right ? value.padStart(width) : value.padEnd(width)
}

const bar = '─'.repeat(126)
console.log(bar)
console.log('OMA A/B benchmark — completed runs')
console.log(`  csv         ${csvPath}`)
console.log(`  outputs     ${runsDir}/<run_id>.md`)
console.log(`  timestamps  filesystem mtime of each run's saved output`)
console.log(`  tokens      provider-reported usage, recorded at the HTTP boundary`)
console.log(bar)
console.log(
  `${pad('#', 4)} ${pad('finished (UTC)', 24)} ${pad('run', 22)} ${pad('grp', 4)} `
  + `${pad('in', 7, true)} ${pad('cached', 7, true)} ${pad('out', 7, true)} ${pad('total', 7, true)} `
  + `${pad('wall s', 7, true)} ${pad('calls', 6, true)} ${pad('cost $', 9, true)} ${pad('ok', 3, true)}`,
)
console.log(bar)

let totalIn = 0
let totalOut = 0
let totalCost = 0
// An unpriced run has an empty est_cost_usd cell, not a zero one. Rendering it
// as $0.00000 and adding it into the total reports "not priced" as "free",
// which is the one thing the rest of the harness refuses to do.
let unpricedRuns = 0
rows.forEach((row, index) => {
  const outputFile = path.join(runsDir, `${row['run_id']}.md`)
  const finished = existsSync(outputFile) ? utc(statSync(outputFile).mtimeMs) : 'n/a'
  totalIn += Number(row['input_tokens'])
  totalOut += Number(row['output_tokens'])
  const cost = row['est_cost_usd'] === '' ? null : Number(row['est_cost_usd'])
  if (cost === null || !Number.isFinite(cost)) unpricedRuns += 1
  else totalCost += cost
  console.log(
    `${pad(index + 1, 4)} ${pad(finished, 24)} ${pad(row['run_id']!, 22)} ${pad(row['group']!, 4)} `
    + `${pad(row['input_tokens']!, 7, true)} ${pad(row['cached_tokens']!, 7, true)} ${pad(row['output_tokens']!, 7, true)} `
    + `${pad(row['total_tokens']!, 7, true)} ${pad(row['wall_seconds']!, 7, true)} ${pad(row['llm_calls']!, 6, true)} `
    + `${pad(cost === null || !Number.isFinite(cost) ? 'not priced' : cost.toFixed(5), 9, true)} `
    + `${pad(row['success'] === 'true' ? 'y' : 'N', 3, true)}`,
  )
})

console.log(bar)
console.log(
  `${pad('', 4)} ${pad('TOTAL', 24)} ${pad(`${rows.length} runs`, 22)} ${pad('', 4)} `
  + `${pad(totalIn, 7, true)} ${pad('', 7)} ${pad(totalOut, 7, true)} ${pad(totalIn + totalOut, 7, true)} `
  + `${pad('', 7)} ${pad('', 6)} ${pad(unpricedRuns === rows.length ? 'not priced' : totalCost.toFixed(5), 9, true)}`,
)
console.log(bar)
if (unpricedRuns > 0 && unpricedRuns < rows.length) {
  console.log(
    `${unpricedRuns} of ${rows.length} runs have no price, so the total above covers only the other `
    + `${rows.length - unpricedRuns}. Add the missing model to "pricing" in bench/config.json.`,
  )
}
