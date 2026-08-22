/**
 * Merges judge verdicts that are already on disk into the results CSV.
 *
 *   npx tsx bench/src/merge-judge.mts --date 2026-08-18
 *
 * `run-bench.mts` writes each pair's verdict to `runs/<date>/judge-*.json` as
 * it goes, but only folds the scores into the CSV after every pair finishes. If
 * an invocation is stopped partway, the completed verdicts are still on disk and
 * this recovers them, marking clearly how many repetitions were actually scored.
 * It also writes a manifest when the interrupted run never got to write one.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { BENCH_ROOT, loadConfig } from './config.mts'
import { foldPairScore, fromCSV, toCSV, type RunRecord } from './results.mts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const date = flag('date') ?? new Date().toISOString().slice(0, 10)
const csvPath = path.join(BENCH_ROOT, `results-${date}.csv`)
const runsDir = path.join(BENCH_ROOT, 'runs', date)
if (!existsSync(csvPath)) throw new Error(`bench: no CSV at ${csvPath}.`)

const rows = fromCSV(readFileSync(csvPath, 'utf-8')).map((row) => ({ ...row }))

interface Verdict {
  readonly scores: Record<string, number>
  readonly preferred: Record<string, 'win' | 'loss' | 'tie'>
  readonly judgeTokens: { input: number; output: number }
  readonly calls: number
}

const config = loadConfig()
const judgeModel = `${config.judge.provider}/${config.judge.model}`
const files = readdirSync(runsDir).filter((name) => name.startsWith('judge-') && name.endsWith('.json'))

let merged = 0
let judgeCalls = 0
let judgeInput = 0
let judgeOutput = 0
const scoredPairs: string[] = []

for (const file of files) {
  // judge-<task>-A-vs-<group>-r<n>.json
  const match = /^judge-(.+)-A-vs-([A-Z])-r(\d+)\.json$/.exec(file)
  if (!match) { console.warn(`skipping unrecognised verdict file: ${file}`); continue }
  const [, task, challenger, repetition] = match as unknown as [string, string, string, string]
  const verdict = JSON.parse(readFileSync(path.join(runsDir, file), 'utf-8')) as Verdict
  judgeCalls += verdict.calls
  judgeInput += verdict.judgeTokens.input
  judgeOutput += verdict.judgeTokens.output
  scoredPairs.push(`${task} A-vs-${challenger} r${repetition}`)

  for (const [group, score] of Object.entries(verdict.scores)) {
    const runId = `${task}-${group}-r${repetition}`
    const row = rows.find((candidate) => candidate['run_id'] === runId)
    if (!row) { console.warn(`no CSV row for ${runId}`); continue }
    // `date` here is the invocation stamp. Backfill it on CSVs written before
    // the column existed, so report.mts can find this runs directory again.
    if (!row['run_stamp']) row['run_stamp'] = date
    const opponent = group === 'A' ? challenger : 'A'
    // Fold rather than assign, and for the same reason as in run-bench.mts: an
    // A run has one verdict file per challenger, and `readdirSync` order must
    // not decide which of them survives into the CSV.
    const folded = foldPairScore(row['quality_by_opponent'] ?? '', opponent, score)
    row['quality_by_opponent'] = folded.byOpponent
    row['quality_score'] = String(Number(folded.mean.toFixed(3)))
    row['judge_model'] = judgeModel
    const note = `judge ${verdict.preferred[group]} vs ${opponent}`
    if (!row['notes']!.includes(note)) {
      row['notes'] = [row['notes'], note].filter(Boolean).join(' | ')
    }
    merged += 1
  }
}

writeFileSync(csvPath, toCSV(rows as unknown as RunRecord[]))
console.log(`Merged ${merged} score(s) from ${files.length} verdict file(s) into ${csvPath}`)

// Coverage, stated explicitly: a partially judged run must not read as fully judged.
const byTask = new Map<string, Set<string>>()
for (const row of rows) {
  if (row['quality_score'] === '') continue
  const set = byTask.get(row['task']!) ?? new Set<string>()
  set.add(row['repetition']!)
  byTask.set(row['task']!, set)
}
const totalReps = new Set(rows.map((row) => row['repetition'])).size
for (const [task, reps] of byTask) {
  console.log(`  ${task}: quality scored for ${reps.size} of ${totalReps} repetitions`)
}

const manifestPath = path.join(runsDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  const mtimes = rows
    .map((row) => path.join(runsDir, `${row['run_id']}.md`))
    .filter((file) => existsSync(file))
    .map((file) => statSync(file).mtimeMs)
  let gitSha = 'unknown'
  try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim() } catch { /* not a repo */ }
  writeFileSync(manifestPath, JSON.stringify({
    date,
    reconstructed: true,
    reconstructedBecause:
      'The invocation was stopped during judging, so run-bench.mts never wrote its own manifest. '
      + 'Timestamps here are the mtimes of the saved run outputs, not the runner\'s own clock, and '
      + 'runs/<date>/calls.json (the per-HTTP-call log) was lost with the process.',
    startedAtUtc: mtimes.length ? new Date(Math.min(...mtimes)).toISOString() : null,
    finishedAtUtc: mtimes.length ? new Date(Math.max(...mtimes)).toISOString() : null,
    gitSha,
    node: process.version,
    mock: false,
    config,
    judge: { calls: judgeCalls, inputTokens: judgeInput, outputTokens: judgeOutput, pairs: scoredPairs },
    providerCalls: rows.reduce((sum, row) => sum + Number(row['llm_calls']), 0),
  }, null, 2))
  console.log(`Wrote reconstructed ${manifestPath}`)
}
