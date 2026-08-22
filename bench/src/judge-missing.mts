/**
 * Scores every A-vs-challenger pair that does not yet have a verdict on disk.
 *
 *   npx tsx bench/src/judge-missing.mts --date 2026-08-18
 *
 * Judging is the slow half of a benchmark invocation and the half most likely
 * to be interrupted. The runs themselves are already saved as Markdown, so
 * scoring can be finished later without re-running a single agent. Pairs that
 * already have a verdict file are skipped, which makes this safe to re-run.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT, loadConfig } from './config.mts'
import { Judge } from './judge.mts'
import { readFixture } from './prompts.mts'
import { fromCSV } from './results.mts'
import { taskById } from './tasks.mts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const date = flag('date') ?? new Date().toISOString().slice(0, 10)
const runsDir = path.join(BENCH_ROOT, 'runs', date)
const csvPath = path.join(BENCH_ROOT, `results-${date}.csv`)
if (!existsSync(csvPath)) throw new Error(`bench: no CSV at ${csvPath}.`)

const config = loadConfig()

// Take the run inventory from the CSV rather than from config: config may have
// been edited since, but the CSV is what actually ran.
const runs = fromCSV(readFileSync(csvPath, 'utf-8'))

const tasks = [...new Set(runs.map((run) => run['task']!))]
const repetitions = [...new Set(runs.map((run) => Number(run['repetition'])))].sort((a, b) => a - b)
const challengers = [...new Set(runs.map((run) => run['group']!))].filter((group) => group !== 'A')

interface Pending {
  readonly taskId: string
  readonly challenger: string
  readonly repetition: number
  readonly verdictPath: string
  readonly aOutput: string
  readonly bOutput: string
}

const pending: Pending[] = []
const skipped: string[] = []

for (const taskId of tasks) {
  for (const repetition of repetitions) {
    for (const challenger of challengers) {
      const verdictPath = path.join(runsDir, `judge-${taskId}-A-vs-${challenger}-r${repetition}.json`)
      if (existsSync(verdictPath)) continue
      const aPath = path.join(runsDir, `${taskId}-A-r${repetition}.md`)
      const bPath = path.join(runsDir, `${taskId}-${challenger}-r${repetition}.md`)
      if (!existsSync(aPath) || !existsSync(bPath)) {
        skipped.push(`${taskId} A-vs-${challenger} r${repetition}: a run output is missing`)
        continue
      }
      const aOutput = readFileSync(aPath, 'utf-8')
      const bOutput = readFileSync(bPath, 'utf-8')
      if (!aOutput.trim() || !bOutput.trim()) {
        skipped.push(`${taskId} A-vs-${challenger} r${repetition}: a run output is empty`)
        continue
      }
      pending.push({ taskId, challenger, repetition, verdictPath, aOutput, bOutput })
    }
  }
}

console.log(`${pending.length} pair(s) to score, ${skipped.length} skipped.`)
for (const reason of skipped) console.log(`  skip: ${reason}`)
if (pending.length === 0) process.exit(0)

const judge = new Judge(config)
let failures = 0

for (const [index, pair] of pending.entries()) {
  const label = `${pair.taskId} A-vs-${pair.challenger} r${pair.repetition}`
  process.stdout.write(`[${index + 1}/${pending.length}] ${label} ... `)
  try {
    const scores = await judge.scorePair(
      taskById(pair.taskId),
      readFixture(taskById(pair.taskId).fixture),
      [{ group: 'A', output: pair.aOutput }, { group: pair.challenger, output: pair.bOutput }],
    )
    // Written per pair, not at the end: an interruption keeps everything scored
    // so far, which is the failure this whole script exists to recover from.
    writeFileSync(pair.verdictPath, JSON.stringify(scores, null, 2))
    console.log(
      Object.entries(scores.scores).map(([group, score]) => `${group}=${score.toFixed(2)}`).join(' '),
    )
  } catch (error) {
    failures += 1
    console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\nScored ${pending.length - failures} of ${pending.length} pair(s).`)
console.log(`Next: npx tsx bench/src/merge-judge.mts --date ${date} && npx tsx bench/src/report.mts --csv ${csvPath}`)
if (failures > 0) process.exitCode = 1
