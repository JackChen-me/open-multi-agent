/**
 * Generates bench/REPORT.md from a results CSV and its run manifest.
 *
 *   npx tsx bench/src/report.mts --csv bench/results-2026-08-18.csv
 *
 * Every number in the report is computed here from the CSV, so the report
 * cannot drift from the data. Prose that states method or limits is templated;
 * prose that states a result is not.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BENCH_ROOT,
  classifyInvocationWindow,
  PROVIDER_KEY_ENV,
  TIME_OF_DAY_PRICING,
} from './config.mts'
import {
  decodeOpponentScores,
  dispersion,
  fromCSV,
  percentDelta,
  type CsvRow,
  type Dispersion,
} from './results.mts'
import { DAG_VARIANTS, taskById } from './tasks.mts'

export type Row = CsvRow

/**
 * Vendor-specific method notes.
 *
 * These state facts about one provider's product (its default reasoning effort,
 * whether its prompt cache can be turned off, how it prices by time of day).
 * Printing them for a run against a different provider would put a false vendor
 * claim in the report, so each is emitted only for the provider it is true of
 * and every other provider gets the vendor-neutral statement of what the
 * harness did.
 */
export function thinkingNote(provider: string, config: Record<string, any>): string {
  const enabled = config['thinking']?.enabled === true
  const vendor = provider === 'deepseek'
    ? 'DeepSeek V4 enables thinking by default at `high` effort, which would put a large and highly variable '
      + 'block of reasoning tokens into the output column. '
    : ''
  return vendor
    + `Thinking is ${enabled ? 'enabled' : 'disabled'} identically for every agent in every group. Either `
    + 'setting is defensible; letting the two sides differ is not.'
}

export function cacheNote(provider: string): string {
  const vendor = provider === 'deepseek'
    ? 'DeepSeek\'s context cache cannot be switched off, so '
    : `Prompt caching is a ${provider} server-side behaviour the harness does not control, so `
  return vendor
    + 'each run\'s system prompts carry a unique `[bench <nonce> <run_id>]` prefix that defeats the prefix '
    + 'cache identically for every group. The `cached_tokens` column verifies this rather than assuming it.'
}

export function pricingLimit(provider: string, manifest: Record<string, any> = {}): string {
  const opening = '- **Prices are operator-supplied**, taken from `bench/config.json` rather than fetched, so every '
    + 'cost figure is only as current as that file. '
  const schedule = TIME_OF_DAY_PRICING[provider]
  if (!schedule) {
    return opening + 'Rates that change over time are not tracked; the run date is on every row.'
  }

  // Checked against the manifest's own clock rather than assumed. The rates in
  // config.json are the peak rates, so an invocation that ran off-peak was
  // billed less than this report says, and one that straddled a boundary was
  // billed on two schedules at once.
  const window = classifyInvocationWindow(schedule, manifest['startedAtUtc'], manifest['finishedAtUtc'])
  const span = `${manifest['startedAtUtc']} to ${manifest['finishedAtUtc']} UTC`
  const multiple = schedule.offPeakMultiplier > 0
    ? `${(1 / schedule.offPeakMultiplier).toFixed(schedule.offPeakMultiplier === 0.5 ? 0 : 2)}x`
    : 'more than'
  switch (window) {
    case 'peak':
      return `${opening}${schedule.description} This invocation ran entirely inside the peak window (${span}), `
        + 'which is the schedule those rates are on, so the cost column needs no adjustment.'
    case 'off-peak':
      return `${opening}${schedule.description} The rates in \`bench/config.json\` are the peak ones and this `
        + `invocation ran entirely off-peak (${span}), so every cost figure here is about ${multiple} what was `
        + 'actually billed. The ratios between groups are unaffected.'
    case 'mixed':
      return `${opening}${schedule.description} This invocation crossed a peak boundary (${span}), so its runs `
        + 'were not all billed on the same schedule and the cost column mixes the two. Group order rotates per '
        + 'repetition but does not guarantee the groups were affected equally, so the cost comparison between '
        + 'groups is the weakest number in this report. Re-run inside one window for exact costs.'
    default:
      return `${opening}${schedule.description} The manifest carries no usable invocation window, so which `
        + 'schedule these runs were billed on was not checked.'
  }
}

/**
 * Recover the run stamp from a default-named CSV, for files written before the
 * `run_stamp` column existed. Returns '' for a `--out`-named CSV, which carries
 * no stamp and has to fall back to the `date` column.
 */
function stampFromCsvName(csvPath: string): string {
  return /^results-(.+)\.csv$/.exec(path.basename(csvPath))?.[1] ?? ''
}

/**
 * The CSV to report on when `--csv` is not given: the most recently written one.
 *
 * The default used to be `results-<today>.csv`, which no labelled run ever
 * writes, so `npm run bench:ab:mock && npm run bench:ab:report` died on ENOENT
 * even though the mock had just produced a perfectly good CSV.
 */
function newestCsv(): string {
  const candidates = readdirSync(BENCH_ROOT)
    .filter((name) => /^results-.+\.csv$/.test(name))
    .map((name) => path.join(BENCH_ROOT, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const newest = candidates[0]
  if (!newest) {
    throw new Error(
      `bench: no results CSV in ${BENCH_ROOT}. Run the benchmark first, or pass --csv <path>.`,
    )
  }
  if (candidates.length > 1) {
    console.log(`[report] --csv not given; using the most recent of ${candidates.length}: ${path.basename(newest)}`)
  }
  return newest
}

const num = (row: Row, column: string): number => Number(row[column])
const maybeNum = (row: Row, column: string): number | null =>
  row[column] === '' || row[column] === undefined ? null : Number(row[column])

function fmt(value: number, digits = 0): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function range(stat: Dispersion | null, digits = 0): string {
  if (!stat) return 'n/a'
  return `${fmt(stat.median, digits)} [${fmt(stat.min, digits)}, ${fmt(stat.max, digits)}]`
}

function signedPercent(value: number | null): string {
  if (value === null) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function signedAbs(value: number | null, digits = 2): string {
  if (value === null) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

/** True when the two observed ranges overlap, so their medians cannot be separated. */
export function rangesOverlap(a: Dispersion | null, b: Dispersion | null): boolean {
  if (!a || !b) return true
  return a.min <= b.max && b.min <= a.max
}

/**
 * Quality phrased so the number cannot be quoted without its evidence. When the
 * two groups' ranges overlap, the delta is a direction at best.
 *
 * Both spreads come from `pair`, so both were measured in the same pairing.
 */
function qualityClause(b: GroupStats, pair: Comparison): string {
  const { aQuality, bQuality, quality } = pair
  const n = Math.min(aQuality?.n ?? 0, bQuality?.n ?? 0)
  if (n === 0 || quality === null) return 'judge quality not scored'
  const spread = `A ${aQuality!.median.toFixed(2)} [${aQuality!.min.toFixed(2)}, ${aQuality!.max.toFixed(2)}] `
    + `vs ${b.group} ${bQuality!.median.toFixed(2)} [${bQuality!.min.toFixed(2)}, ${bQuality!.max.toFixed(2)}]`
  if (rangesOverlap(aQuality, bQuality)) {
    return `judge quality inconclusive — the two groups' observed ranges overlap (${spread}, n=${n})`
  }
  return `judge quality ${signedAbs(quality)} (${spread}, n=${n})`
}

interface GroupStats {
  readonly group: string
  readonly n: number
  readonly successes: number
  readonly tokens: Dispersion | null
  readonly inputTokens: Dispersion | null
  readonly outputTokens: Dispersion | null
  readonly cached: number
  readonly wall: Dispersion | null
  readonly cost: Dispersion | null
  /**
   * Judge score per opponent this group was paired against.
   *
   * Group A is judged once per challenger, so it has one entry per challenger
   * and those entries are not interchangeable: a score earned against the cheap
   * single-agent baseline is not a score earned against the strong one. Every
   * comparison reads the entry for its own opponent.
   */
  readonly qualityByOpponent: ReadonlyMap<string, Dispersion | null>
  /** Mean across this group's pairings. A summary only; never a comparison input. */
  readonly quality: Dispersion | null
  readonly calls: Dispersion | null
  readonly parallelism: Dispersion | null
  readonly roleModels: string
}

function statsFor(rows: readonly Row[], group: string): GroupStats {
  const subset = rows.filter((row) => row['group'] === group)
  const ok = subset.filter((row) => row['success'] === 'true')
  const costs = ok.map((row) => maybeNum(row, 'est_cost_usd')).filter((v): v is number => v !== null)
  const quality = ok.map((row) => maybeNum(row, 'quality_score')).filter((v): v is number => v !== null)
  const perOpponent = new Map<string, number[]>()
  for (const row of ok) {
    for (const [opponent, score] of decodeOpponentScores(row['quality_by_opponent'] ?? '')) {
      perOpponent.set(opponent, [...(perOpponent.get(opponent) ?? []), score])
    }
  }
  return {
    group,
    n: subset.length,
    successes: ok.length,
    tokens: dispersion(ok.map((row) => num(row, 'total_tokens'))),
    inputTokens: dispersion(ok.map((row) => num(row, 'input_tokens'))),
    outputTokens: dispersion(ok.map((row) => num(row, 'output_tokens'))),
    cached: ok.reduce((sum, row) => sum + num(row, 'cached_tokens'), 0),
    wall: dispersion(ok.map((row) => num(row, 'wall_seconds'))),
    cost: costs.length === ok.length ? dispersion(costs) : null,
    qualityByOpponent: new Map([...perOpponent].map(([opponent, values]) => [opponent, dispersion(values)])),
    quality: dispersion(quality),
    calls: dispersion(ok.map((row) => num(row, 'llm_calls'))),
    parallelism: dispersion(ok.map((row) => num(row, 'parallelism'))),
    roleModels: subset[0]?.['role_models'] ?? '',
  }
}

interface Comparison {
  readonly tokens: number | null
  readonly wall: number | null
  readonly cost: number | null
  readonly quality: number | null
  /** `a`'s score in the `a`-vs-`b` pairing, not its mean across all pairings. */
  readonly aQuality: Dispersion | null
  /** `b`'s score in the same pairing. */
  readonly bQuality: Dispersion | null
}

/**
 * How far each headline percentage moves when a subset of rows is dropped, and
 * whether it changes sign.
 *
 * The cache-contamination limit used to assert that recomputing without the
 * affected repetitions "moves the headline percentages by a few points without
 * changing any direction". That was one run's finding, hard-coded and reprinted
 * for any run that had cache hits at all. It is computed here instead.
 */
export interface DeltaShift {
  readonly metric: 'tokens' | 'wall' | 'cost'
  readonly full: number | null
  readonly clean: number | null
  /** Percentage points moved. Null when either side could not be computed. */
  readonly movedPoints: number | null
  readonly flipped: boolean
}

/**
 * The token-budget limit, stated from the data.
 *
 * This line used to read "The token budget never bound ... no run approached
 * it" unconditionally, while `budget_exceeded` sat unread in every row. A run
 * that actually hit the ceiling got a report denying it had happened.
 *
 * The headroom figure uses `framework_*_tokens`, not the proxy's counts: the
 * budget is enforced against OMA's own accounting, so that is the number it
 * was compared against.
 */
export function budgetLimit(rows: readonly Row[], config: Record<string, any>): string {
  const configured = Number(config['maxTokenBudget'])
  const bound = rows.filter((row) => row['budget_exceeded'] === 'true')
  if (bound.length > 0) {
    return `- **The token budget bound on ${bound.length} run(s):** `
      + `${bound.map((row) => row['run_id']).join(', ')}. A run stopped at the ceiling did not finish the work `
      + 'the others finished, so its tokens, cost, wall-clock and quality are not comparable with theirs. Read '
      + 'those rows as truncated, not as cheap.'
  }
  if (!Number.isFinite(configured) || configured <= 0) {
    return '- **No token budget was configured.** Nothing here says anything about behaviour under budget '
      + 'pressure, and nothing stopped a run from spending more than the others.'
  }
  const peak = Math.max(
    0,
    ...rows.map((row) => num(row, 'framework_input_tokens') + num(row, 'framework_output_tokens')),
  )
  const share = (peak / configured) * 100
  return '- **The token budget never bound.** The largest run used '
    + `${fmt(peak)} tokens of the ${fmt(configured)} configured (${share.toFixed(1)}%), on the framework's own `
    + 'accounting, which is what the budget is enforced against. These numbers therefore say nothing about '
    + 'behaviour under budget pressure.'
}

export function deltaShifts(full: Comparison, clean: Comparison): DeltaShift[] {
  return (['tokens', 'wall', 'cost'] as const).map((metric) => {
    const a = full[metric]
    const b = clean[metric]
    return {
      metric,
      full: a,
      clean: b,
      movedPoints: a === null || b === null ? null : b - a,
      // A sign flip needs two non-zero sides: a delta sitting exactly on zero
      // has no direction to reverse.
      flipped: a !== null && b !== null && a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b),
    }
  })
}

function comparison(a: GroupStats, b: GroupStats): Comparison {
  // Both sides of the quality delta must come from the same pair. A is judged
  // once per challenger, so A's score against B is a different measurement from
  // A's score against C, and subtracting across the two compares nothing.
  const aQuality = a.qualityByOpponent.get(b.group) ?? null
  const bQuality = b.qualityByOpponent.get(a.group) ?? null
  return {
    tokens: a.tokens && b.tokens ? percentDelta(a.tokens.median, b.tokens.median) : null,
    wall: a.wall && b.wall ? percentDelta(a.wall.median, b.wall.median) : null,
    cost: a.cost && b.cost ? percentDelta(a.cost.median, b.cost.median) : null,
    quality: aQuality && bQuality ? aQuality.median - bQuality.median : null,
    aQuality,
    bQuality,
  }
}

/** Judge scores for one group, split by the opponent each was measured against. */
function qualityCell(stats: GroupStats): string {
  if (stats.qualityByOpponent.size === 0) return 'not scored'
  return [...stats.qualityByOpponent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([opponent, stat]) => (stat ? `vs ${opponent} ${range(stat, 3)} (n=${stat.n})` : `vs ${opponent} n/a`))
    .join('<br>')
}

function main(): void {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }

  const csvFlag = flag('csv')
  const csvPath = csvFlag ? path.resolve(csvFlag) : newestCsv()
  const rows = fromCSV(readFileSync(csvPath, 'utf-8'))
  if (rows.length === 0) throw new Error(`bench: ${csvPath} has no data rows.`)

  const date = rows[0]!['date']!
  // Raw data lives under the invocation's stamp, which is `<date>-<label>` for
  // any run that passed --label. Deriving the directory from the `date` column
  // instead sends every labelled run to a path that does not exist.
  const stamp = rows[0]!['run_stamp'] || stampFromCsvName(csvPath) || date
  const manifestPath = flag('manifest') ?? path.join(BENCH_ROOT, 'runs', stamp, 'manifest.json')
  if (!existsSync(manifestPath)) {
    // Every controlled variable in the report comes out of the manifest. Without
    // it the models, temperature, thinking, budget, git SHA and invocation window
    // all render as "unknown", which reads as a finished report rather than as a
    // missing file. Stop instead, and say what to do about it.
    throw new Error(
      `bench: no manifest at ${manifestPath}.\n`
      + `  The report's controlled variables, model names and git SHA come from it.\n`
      + `  - Wrong stamp? Pass --manifest <path> explicitly.\n`
      + '  - Invocation stopped before it wrote one? Rebuild it with:\n'
      + `      npx tsx bench/src/merge-judge.mts --date ${stamp}`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, any>
  const config = (manifest['config'] ?? {}) as Record<string, any>
  const outPath = path.resolve(flag('out') ?? path.join(BENCH_ROOT, 'REPORT.md'))

  const taskIds = [...new Set(rows.map((row) => row['task']!))]
  const groups = [...new Set(rows.map((row) => row['group']!))]
  const repetitions = new Set(rows.map((row) => row['repetition'])).size
  const judgeModel = rows.find((row) => row['judge_model'])?.['judge_model'] ?? 'not scored'
  const strong = config['models']?.strong ?? 'unknown'
  const cheap = config['models']?.cheap ?? 'unknown'
  const provider = String(config['provider'] ?? 'unknown')

  const perTask = new Map<string, Map<string, GroupStats>>()
  for (const taskId of taskIds) {
    const taskRows = rows.filter((row) => row['task'] === taskId)
    perTask.set(taskId, new Map(groups.map((group) => [group, statsFor(taskRows, group)])))
  }

  const lines: string[] = []
  const push = (...text: string[]): void => { lines.push(...text) }

  push(
    '# OMA multi-agent vs single-agent: measured A/B',
    '',
    `Run date ${date}. Provider ${provider}, models ${strong} and ${cheap}, judge ${judgeModel}.`,
    `n = ${repetitions} repetitions per task per group.`,
    '',
    '## Headline',
    '',
  )

  // -- Headline sentences, one per task ---------------------------------------
  for (const taskId of taskIds) {
    const task = taskById(taskId)
    const stats = perTask.get(taskId)!
    const a = stats.get('A')
    const b = stats.get('B')
    if (!a || !b) continue
    const delta = comparison(a, b)
    const kind = task.hypothesis === 'favourable'
      ? 'On a task with real role separation and a parallelisable fan-out'
      : 'On a task one agent can finish in a single pass'
    push(
      `**${task.label} (${task.hypothesis} case).** ${kind}, against a single agent pursuing the same goal `
      + `on ${strong}: tokens ${signedPercent(delta.tokens)}, wall-clock ${signedPercent(delta.wall)}, `
      + `cost ${signedPercent(delta.cost)} (n=${repetitions}); ${qualityClause(b, delta)}. `
      + `${strong}/${cheap}, ${date}.`,
      '',
    )
  }

  push(
    '### Chinese, for a slide',
    '',
  )
  for (const taskId of taskIds) {
    const task = taskById(taskId)
    const stats = perTask.get(taskId)!
    const a = stats.get('A')
    const b = stats.get('B')
    if (!a || !b) continue
    const delta = comparison(a, b)
    const kind = task.hypothesis === 'favourable' ? '在需要分工与并行的任务上' : '在单 agent 一次就能做完的任务上'
    // Same pairing on both sides as the English headline above.
    const aQuality = delta.aQuality
    const bQuality = delta.bQuality
    const qualityN = Math.min(aQuality?.n ?? 0, bQuality?.n ?? 0)
    const zh = qualityN === 0 || delta.quality === null
      ? '质量未评分'
      : rangesOverlap(aQuality, bQuality)
        ? `judge 质量分不可判定——两组实测区间重叠（A ${aQuality!.median.toFixed(2)} [${aQuality!.min.toFixed(2)}, ${aQuality!.max.toFixed(2)}]，`
          + `${b.group} ${bQuality!.median.toFixed(2)} [${bQuality!.min.toFixed(2)}, ${bQuality!.max.toFixed(2)}]，n=${qualityN}）`
        : `judge 质量分 ${signedAbs(delta.quality)}（A ${aQuality!.median.toFixed(2)} [${aQuality!.min.toFixed(2)}, ${aQuality!.max.toFixed(2)}]，`
          + `${b.group} ${bQuality!.median.toFixed(2)} [${bQuality!.min.toFixed(2)}, ${bQuality!.max.toFixed(2)}]，n=${qualityN}）`
    push(
      `- ${kind}，同一目标：token ${signedPercent(delta.tokens)}、墙钟时间 ${signedPercent(delta.wall)}、`
      + `成本 ${signedPercent(delta.cost)}（n=${repetitions}）；${zh}。模型 ${strong}/${cheap}，${date}`,
    )
  }
  push('')

  // -- Results ---------------------------------------------------------------
  push('## Results', '', 'Median with [min, max] across repetitions. Successful runs only.', '')

  for (const taskId of taskIds) {
    const task = taskById(taskId)
    const stats = perTask.get(taskId)!
    push(
      `### ${task.label} — ${task.hypothesis} case`,
      '',
      `Source: [\`${path.basename(task.sourceExample)}\`](../${task.sourceExample})`,
      '',
      '| Group | Runs ok | LLM calls | Total tokens | Wall seconds | Cost USD | Judge score (n) | Parallelism |',
      '|---|---|---|---|---|---|---|---|',
    )
    for (const group of groups) {
      const s = stats.get(group)!
      push(
        `| ${group} | ${s.successes}/${s.n} | ${range(s.calls)} | ${range(s.tokens)} | ${range(s.wall, 1)} `
        + `| ${s.cost ? range(s.cost, 4) : 'n/a'} | ${qualityCell(s)} `
        + `| ${range(s.parallelism, 2)} |`,
      )
    }
    push('')

    const a = stats.get('A')
    if (a) {
      push('| A vs | Tokens | Wall-clock | Cost | Judge score |', '|---|---|---|---|---|')
      for (const group of groups.filter((g) => g !== 'A')) {
        const other = stats.get(group)!
        const delta = comparison(a, other)
        push(
          `| ${group} (${group === 'B' ? strong : cheap}, single agent) | ${signedPercent(delta.tokens)} `
          + `| ${signedPercent(delta.wall)} | ${signedPercent(delta.cost)} | ${signedAbs(delta.quality)} |`,
        )
      }
      push('')
      const totalCached = groups.reduce((sum, group) => sum + stats.get(group)!.cached, 0)
      const contaminated = [...new Set(
        rows.filter((row) => row['task'] === taskId && Number(row['cached_tokens']) > 0)
          .map((row) => `r${row['repetition']}`),
      )]
      // Read per pairing, not off the mean: an A run that the judge put below
      // 0.5 against B is a defective run even when its score against C pulls the
      // mean back over the line.
      const defective = rows
        .filter((row) => row['task'] === taskId && row['success'] === 'true')
        .flatMap((row) => [...decodeOpponentScores(row['quality_by_opponent'] ?? '')]
          .filter(([, score]) => score < 0.5)
          .map(([opponent, score]) => `${row['run_id']} scored ${score.toFixed(2)} against ${opponent}`))
      if (defective.length > 0) {
        push(
          `Runs the judge scored below 0.5 despite completing without error: ${defective.join(', ')}. `
          + 'A run like this widens its group\'s range and is usually why a comparison comes back '
          + 'inconclusive; it is one observation, not a measured failure rate.',
          '',
        )
      }
      push(
        `Input/output split (median): `
        + groups.map((group) => {
          const s = stats.get(group)!
          return `${group} ${fmt(s.inputTokens?.median ?? 0)} in / ${fmt(s.outputTokens?.median ?? 0)} out`
        }).join(', ')
        + `. Cache-hit prompt tokens across all ${task.label.toLowerCase()} runs: ${totalCached}`
        + (contaminated.length > 0
          ? `, all of it in ${contaminated.join(', ')} — see Limits.`
          : ' — cache busting fully effective.'),
        '',
      )
    }
  }

  // -- DAG variant comparison -------------------------------------------------
  const variantCsv = flag('variant-csv')
  if (variantCsv) {
    const variantRows = fromCSV(readFileSync(path.resolve(variantCsv), 'utf-8'))
    const variantDate = variantRows[0]?.['date'] ?? 'unknown'
    const variantName = variantRows[0]?.['variant'] ?? 'fixed-merge'
    if (variantName === 'as-published') {
      console.warn(
        `[report] WARNING: ${variantCsv} records its variant as "as-published", so this section compares the `
        + 'baseline against itself. Pass a CSV from a --variant run.',
      )
    }
    const variantGroups = [...new Set(variantRows.map((row) => row['group']!))]
    const variantReps = new Set(variantRows.map((row) => row['repetition'])).size

    push(
      '## DAG variant: is the quality gap the wiring or the orchestration?',
      '',
      // Mechanism and hypothesis only. An earlier draft narrated what one
      // specific judge said about one specific run, which would have been
      // reprinted verbatim above every future variant comparison regardless of
      // what that run's judge actually found.
      'In the published task graph the terminal task receives only its direct dependencies\' output, so the '
      + 'agent writing the final report never sees the source material and cannot tell which of its inputs '
      + 'is right when they disagree. Whether that costs group A quality is the hypothesis under test here.',
      '',
      `The judge's own reasons, per pair and per presentation order, are in \`bench/runs/${stamp}/judge-*.json\`. `
      + 'This section reports the scores and nothing about why they came out that way.',
      '',
      `**Change under test (\`${variantName}\`).** ${DAG_VARIANTS[variantName as keyof typeof DAG_VARIANTS] ?? 'see bench/src/tasks.mts'}`,
      '',
      '**This change was designed after seeing the first result.** It is reported as a separate experiment, '
      + 'never folded into the headline, because a fix chosen with the answer already in hand is exactly how '
      + 'a benchmark gets fitted to its conclusion. Group B is unchanged and was re-run inside each '
      + 'invocation, so the A-minus-B gap is measured fresh on each side and it is those two gaps that are '
      + 'compared here — not A against A.',
      '',
      `| Task | Variant | Date | n | A tokens | A wall s | A cost | A quality | B quality | A − B |`,
      '|---|---|---|---|---|---|---|---|---|---|',
    )

    const gaps: Array<{ task: string; published: number | null; fixed: number | null }> = []
    for (const taskId of taskIds) {
      const label = taskById(taskId).label
      const rowsFor = (source: Row[], group: string) => statsFor(source.filter((row) => row['task'] === taskId), group)
      // Keyed by an explicit `kind`, not by comparing the row's name against
      // `variantName`. When a variant CSV records its own variant as
      // `as-published`, that name test matched the baseline row too, both rows
      // landed in the `fixed` slot, `published` stayed null for every task and
      // the entire comparison paragraph below silently vanished.
      const entries: Array<{
        kind: 'baseline' | 'variant'
        name: string
        day: string
        n: number
        a: GroupStats
        b: GroupStats
      }> = []
      const baseA = perTask.get(taskId)!.get('A')
      const baseB = perTask.get(taskId)!.get('B')
      if (baseA && baseB) {
        entries.push({ kind: 'baseline', name: 'as-published', day: date, n: repetitions, a: baseA, b: baseB })
      }
      if (variantGroups.includes('A') && variantGroups.includes('B')) {
        entries.push({
          kind: 'variant',
          name: variantName,
          day: variantDate,
          n: variantReps,
          a: rowsFor(variantRows, 'A'),
          b: rowsFor(variantRows, 'B'),
        })
      }
      for (const { kind, name, day, n, a, b } of entries) {
        // The A-vs-B pairing on both sides. The baseline invocation also judged
        // A against C; that score belongs to a different contrast and would make
        // this gap incomparable with the variant's, which only ran A and B.
        const pair = comparison(a, b)
        const gap = pair.quality
        push(
          `| ${label} | ${name} | ${day} | ${n} | ${range(a.tokens)} | ${range(a.wall, 1)} `
          + `| ${a.cost ? range(a.cost, 4) : 'n/a'} | ${pair.aQuality ? range(pair.aQuality, 3) : 'n/a'} `
          + `| ${pair.bQuality ? range(pair.bQuality, 3) : 'n/a'} | ${signedAbs(gap)} |`,
        )
        const entry = gaps.find((g) => g.task === label)
        const slot = kind === 'variant' ? 'fixed' : 'published'
        if (entry) entry[slot] = gap
        else gaps.push({ task: label, published: null, fixed: null, [slot]: gap })
      }
    }
    push('')
    for (const { task, published, fixed } of gaps.filter((g) => g.published !== null)) {
      const other = gaps.find((g) => g.task === task && g.fixed !== null)?.fixed ?? fixed
      if (published === null || other === null || other === undefined) continue
      const moved = other - published
      const recovered = published !== 0 ? Math.round((moved / -published) * 100) : 0
      const verdict = Math.abs(moved) < 0.05
        ? 'That is inside the run-to-run spread; the wiring is not what was driving this gap.'
        : moved > 0
          ? `The wiring recovered about ${recovered}% of the original gap, and left ${signedAbs(other)} of it `
            + 'standing. Part of the quality deficit is how the graph was wired; the rest is not.'
          : 'The wiring change made it worse.'
      push(`**${task}:** the A-minus-B quality gap moved from ${signedAbs(published)} to ${signedAbs(other)}, a change of ${signedAbs(moved)}. ${verdict}`)
    }
    // The fix is not uniformly better if its worst run is worse than anything
    // the published wiring produced. That cuts against the fix and belongs here.
    for (const taskId of taskIds) {
      const label = taskById(taskId).label
      const basePublished = perTask.get(taskId)!.get('A')?.qualityByOpponent.get('B') ?? null
      const baseFixed = statsFor(variantRows.filter((row) => row['task'] === taskId), 'A')
        .qualityByOpponent.get('B') ?? null
      if (!basePublished || !baseFixed) continue
      if (baseFixed.min < basePublished.min) {
        push(
          '',
          `Note on ${label}: the variant's worst run (${baseFixed.min.toFixed(3)}) scored below anything the `
          + `published wiring produced (${basePublished.min.toFixed(3)}). The median improved but the spread `
          + 'widened, so the change is not uniformly better.',
        )
      }
    }
    push(
      '',
      'Token and timing costs are not held constant across variants: giving the terminal task more context '
      + 'makes group A\'s input larger, so any quality gained here is bought with tokens. Both columns are '
      + 'in the table.',
      '',
    )
  }

  // -- Method ----------------------------------------------------------------
  push(
    '## Method',
    '',
    '### Groups',
    '',
    '| Group | Execution | Models |',
    '|---|---|---|',
    `| A | OMA multi-agent orchestration through \`runTasks()\`, with deterministic model routing and a token budget | mixed per role |`,
    `| B | One agent, one call, same goal, same deliverable | ${strong} |`,
    `| C | One agent, one call, same goal, same deliverable | ${cheap} |`,
    '',
    'B and C bracket A. A-vs-B alone conflates orchestration with model tier, because A runs most of its work on '
    + 'the cheap tier; C removes the tier advantage from the other side. Any effect that holds against *both* '
    + 'single-agent baselines is attributable to the orchestration rather than the model mix.',
    '',
    '### Tasks',
    '',
    'Both are cookbook examples, and both are reported. The role prompts are read out of the example source at '
    + 'load time rather than restated in the harness, so what was measured cannot drift from what the examples say.',
    '',
  )
  for (const taskId of taskIds) {
    const task = taskById(taskId)
    push(`- **${task.label}** (${task.hypothesis}) — [\`${path.basename(task.sourceExample)}\`](../${task.sourceExample}), fixture \`${path.basename(task.fixture)}\`. Deliverable: ${task.deliverable}`)
  }
  push(
    '',
    'Group A runs those roles as a DAG. Groups B and C run one agent whose system prompt is the same roles '
    + 'concatenated in DAG order, closed by the terminal role\'s output spec, and asked for that deliverable only. '
    + 'Neither side receives task content the other lacks.',
    '',
    '### Controlled variables',
    '',
    '| Variable | Setting |',
    '|---|---|',
    `| Models | \`${strong}\`, \`${cheap}\` |`,
    `| Temperature | ${config['temperature'] ?? 'unknown'}, every agent, every group |`,
    `| Thinking | ${config['thinking']?.enabled ? 'enabled' : 'disabled'}, both groups |`,
    `| Max turns | ${config['maxTurns'] ?? 'unknown'} |`,
    `| Token budget | ${config['maxTokenBudget'] ?? 'unset'} per run |`,
    `| Prompt caching | ${config['cacheBusting'] ? 'defeated on both sides (see below)' : 'left on for both sides'} |`,
    `| Input | identical fixture per task |`,
    `| Run order | group order rotated each repetition, recorded per row |`,
    `| Repetitions | ${repetitions} per task per group |`,
    '',
    thinkingNote(provider, config),
    '',
    cacheNote(provider),
    '',
    '### Measurement',
    '',
    'Token counts are read off each provider response by a loopback recording proxy, not taken from the '
    + 'framework. OMA\'s `TokenUsage` is `{ input_tokens, output_tokens }` with no cache field and no per-model '
    + 'split, so it cannot price a group-A run that deliberately mixes two tiers. The framework\'s own counts are '
    + 'recorded alongside in `framework_*_tokens`; any disagreement is written into the row\'s `notes` rather than '
    + `reconciled silently. \`bench/runs/${stamp}/calls.json\` holds every individual call, so cost stays recomputable `
    + 'if a rate is later corrected.',
    '',
    '`parallelism` is the sum of per-call latency divided by the run\'s wall time: 1.0 is fully serial, 3.0 means '
    + 'three calls\' worth of work finished in one call\'s worth of wall time.',
    '',
    '### Quality scoring',
    '',
    `**Scores are judge-assigned, not human-assigned.** Judge: \`${judgeModel}\`.`,
    '',
    'Two outputs for the same task and repetition are shown to the judge without group labels, scored against a '
    + 'rubric fixed before any run, then scored again with the positions swapped; a candidate\'s reported score is '
    + 'the mean of its two positions, so a judge that merely prefers whatever it reads first cannot move the '
    + 'result. Each number is validated through the repo\'s `defineScorer()` contract from '
    + '`@open-multi-agent/core/eval`.',
    '',
    'Scores are per pairing, and every comparison above uses the pairing it names. Group A is judged once against '
    + 'each challenger, so an A run carries one score per challenger — two readings of the same output taken under '
    + 'two different contrasts, not one number measured twice. The A-minus-B row subtracts A\'s score against B; '
    + 'A\'s score against C appears only in the A-vs-C row. The CSV keeps both in `quality_by_opponent`, and '
    + '`quality_score` is their mean, carried for eyeballing a row rather than for any comparison.',
    '',
  )
  for (const taskId of taskIds) {
    const task = taskById(taskId)
    push(`Rubric — ${task.label}:`, '')
    for (const criterion of task.rubric) push(`- ${criterion}`)
    push('')
  }

  // -- Limits ----------------------------------------------------------------
  const judgeSameVendor = String(judgeModel).startsWith(String(config['provider'] ?? ''))
  const qualityCoverage = taskIds.map((taskId) => {
    const stats = perTask.get(taskId)!
    const scored = Math.min(...groups.map((group) => stats.get(group)!.quality?.n ?? 0))
    return { taskId, scored }
  })
  const partial = qualityCoverage.filter((entry) => entry.scored < repetitions)

  push(
    '## Limits',
    '',
    `- **n = ${repetitions} for tokens, wall-clock and cost.** Dispersion is reported as [min, max] beside `
    + 'every median. Where min and max straddle the difference between two groups, that difference is not '
    + 'established by this data.',
    '- **Judge, not human.** Every quality number is one model\'s opinion under a fixed rubric. It controls for '
    + 'position but not for a judge\'s taste in prose.',
  )
  if (judgeSameVendor) {
    push(
      `- **The judge is the same vendor as the models under test.** In this design that is largely symmetric — `
      + 'both candidates in every A-vs-B pair come from the same vendor and the same model — so vendor '
      + 'self-preference cannot favour one group. It is a weaker control for A-vs-C, where the two candidates '
      + 'come from different tiers.',
    )
  }
  if (partial.length > 0) {
    push(
      `- **Quality was not scored on every repetition.** Judging was stopped before it finished: `
      + partial.map((entry) => `${entry.taskId} scored ${entry.scored} of ${repetitions}`).join(', ')
      + '. The quality column therefore rests on a smaller sample than the token and timing columns, and the '
      + 'quality difference between groups should be read as a direction, not a measurement.',
    )
  }
  const cachedRows = rows.filter((row) => Number(row['cached_tokens']) > 0)
  if (cachedRows.length > 0) {
    const reps = [...new Set(cachedRows.map((row) => `r${row['repetition']}`))].join(', ')
    const tasks = [...new Set(cachedRows.map((row) => row['task']))].join(', ')
    // What dropping the affected repetitions actually does to the headline,
    // recomputed per task rather than asserted.
    const recomputed: string[] = []
    let anyFlipped = false
    let unrecomputable = false
    for (const taskId of taskIds) {
      const taskRows = rows.filter((row) => row['task'] === taskId)
      const dirtyReps = new Set(
        taskRows.filter((row) => Number(row['cached_tokens']) > 0).map((row) => row['repetition']),
      )
      if (dirtyReps.size === 0) continue
      const cleanRows = taskRows.filter((row) => !dirtyReps.has(row['repetition']))
      const cleanA = statsFor(cleanRows, 'A')
      const cleanB = statsFor(cleanRows, 'B')
      if (cleanA.successes === 0 || cleanB.successes === 0) {
        unrecomputable = true
        recomputed.push(`${taskId}: every repetition is affected, so there is nothing left to recompute from`)
        continue
      }
      const shifts = deltaShifts(
        comparison(statsFor(taskRows, 'A'), statsFor(taskRows, 'B')),
        comparison(cleanA, cleanB),
      )
      if (shifts.some((shift) => shift.flipped)) anyFlipped = true
      recomputed.push(
        `${taskId} (n=${cleanA.successes} clean): `
        + shifts
          .map((shift) => `${shift.metric} ${signedPercent(shift.full)} to ${signedPercent(shift.clean)}`
            + (shift.flipped ? ' **(direction reverses)**' : ''))
          .join(', '),
      )
    }
    push(
      `- **Cache busting failed on ${reps} (${tasks}).** Run ids are deterministic, so those runs reused a salt `
      + 'from an earlier aborted invocation of the same benchmark and inherited its prompt cache; their input '
      + 'tokens were partly billed at the much cheaper cache-hit rate, which understates their cost. The salt '
      + 'now carries a per-invocation nonce so a re-run cannot inherit its predecessor\'s cache.',
      '',
      `  Recomputing the A-vs-B headline without the affected repetitions: ${recomputed.join('; ')}.`
      + (unrecomputable
        ? ''
        : anyFlipped
          ? ' At least one comparison reverses direction, so the headline for this run rests on contaminated rows.'
          : ' No comparison reverses direction.'),
    )
  }
  if (variantCsv) {
    push(
      '- **The DAG variant ran on a different day from the baseline.** Its A and B groups were run in the same '
      + 'invocation, so each day\'s A-minus-B gap is internally clean, but the two A groups were never run '
      + 'side by side and must not be compared directly. B moved between the two days as well, which is the '
      + 'size of the day-to-day drift the variant\'s effect has to clear.',
    )
  }
  if (manifest['reconstructed']) {
    push(
      '- **The manifest is a reconstruction.** The invocation was stopped during judging, so the runner never '
      + 'wrote its own manifest and the per-HTTP-call log (`calls.json`) was lost with the process. Timestamps '
      + 'come from the mtimes of the saved run outputs. Per-run token totals in the CSV are unaffected: they '
      + 'were written as each run finished.',
    )
  }
  push(
    '- **Two tasks, one provider, one day.** Nothing here extrapolates to other task shapes, other providers, '
    + 'longer inputs, or tool-using agents. Model behaviour drifts; the date is on every row.',
    pricingLimit(provider, manifest),
    budgetLimit(rows, config),
    '- **Retries are off on both sides.** The contract-review example configures step-level retry; the benchmark '
    + 'disables it so both groups face identical failure handling. Group A issues more calls per run than B or C '
    + 'and therefore carries proportionally more exposure to a transient provider error, which shows up in the '
    + '"Runs ok" column if it happened.',
    '- **The single-agent baseline is one call.** It is not allowed to iterate, self-critique across turns, or '
    + 'use tools. A multi-turn single agent is a different baseline and was not measured.',
    '',
    '## Reproducing',
    '',
    '```bash',
    `export ${PROVIDER_KEY_ENV[provider] ?? 'PROVIDER_API_KEY'}=...`,
    `npx tsx bench/src/run-bench.mts --repetitions ${repetitions}`,
    `npx tsx bench/src/report.mts --csv bench/results-${stamp}.csv`,
    '```',
    '',
    `Harness details and every flag: [bench/README.md](README.md). Raw outputs, per-call log, and the manifest `
    + `(git SHA, node version, full config, UTC window) are in \`bench/runs/${stamp}/\`.`,
    '',
  )

  if (manifest['startedAtUtc']) {
    push(`Invocation window: ${manifest['startedAtUtc']} to ${manifest['finishedAtUtc']} UTC. Git SHA \`${manifest['gitSha']}\`.`, '')
  }
  if (manifest['judge']) {
    push(
      `Judge cost is separate from the group figures above: ${manifest['judge'].calls} calls, `
      + `${fmt(manifest['judge'].inputTokens)} input and ${fmt(manifest['judge'].outputTokens)} output tokens.`,
      '',
    )
  }

  writeFileSync(outPath, lines.join('\n'))
  console.log(`Wrote ${outPath}`)
}

// Only run as a script. The report's own arithmetic is unit-tested, and a test
// importing it must not trigger a CSV read and a report write at module load.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
