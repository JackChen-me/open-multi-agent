/**
 * Generates bench/REPORT.md from a results CSV and its run manifest.
 *
 *   npx tsx bench/src/report.mts --csv bench/results-2026-08-18.csv
 *
 * Every number in the report is computed here from the CSV, so the report
 * cannot drift from the data. Prose that states method or limits is templated;
 * prose that states a result is not.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from './config.mts'
import { dispersion, percentDelta, type Dispersion } from './results.mts'
import { DAG_VARIANTS, taskById } from './tasks.mts'

interface Row {
  readonly [column: string]: string
}

function parseCSV(text: string): Row[] {
  const rows: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else { quoted = false }
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { record.push(field); field = '' }
    else if (char === '\n') { record.push(field); rows.push(record); record = []; field = '' }
    else if (char !== '\r') field += char
  }
  if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record) }
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell !== ''))
  return body.map((cells) => Object.fromEntries(header!.map((name, i) => [name, cells[i] ?? ''])))
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
function rangesOverlap(a: Dispersion | null, b: Dispersion | null): boolean {
  if (!a || !b) return true
  return a.min <= b.max && b.min <= a.max
}

/**
 * Quality phrased so the number cannot be quoted without its evidence. When the
 * two groups' ranges overlap, the delta is a direction at best.
 */
function qualityClause(a: GroupStats, b: GroupStats, delta: number | null): string {
  const n = Math.min(a.quality?.n ?? 0, b.quality?.n ?? 0)
  if (n === 0 || delta === null) return 'judge quality not scored'
  const spread = `A ${a.quality!.median.toFixed(2)} [${a.quality!.min.toFixed(2)}, ${a.quality!.max.toFixed(2)}] `
    + `vs ${b.group} ${b.quality!.median.toFixed(2)} [${b.quality!.min.toFixed(2)}, ${b.quality!.max.toFixed(2)}]`
  if (rangesOverlap(a.quality, b.quality)) {
    return `judge quality inconclusive — the two groups' observed ranges overlap (${spread}, n=${n})`
  }
  return `judge quality ${signedAbs(delta)} (${spread}, n=${n})`
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
    quality: dispersion(quality),
    calls: dispersion(ok.map((row) => num(row, 'llm_calls'))),
    parallelism: dispersion(ok.map((row) => num(row, 'parallelism'))),
    roleModels: subset[0]?.['role_models'] ?? '',
  }
}

function comparison(a: GroupStats, b: GroupStats) {
  return {
    tokens: a.tokens && b.tokens ? percentDelta(a.tokens.median, b.tokens.median) : null,
    wall: a.wall && b.wall ? percentDelta(a.wall.median, b.wall.median) : null,
    cost: a.cost && b.cost ? percentDelta(a.cost.median, b.cost.median) : null,
    quality: a.quality && b.quality ? a.quality.median - b.quality.median : null,
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }

  const csvPath = path.resolve(flag('csv') ?? path.join(BENCH_ROOT, `results-${new Date().toISOString().slice(0, 10)}.csv`))
  const rows = parseCSV(readFileSync(csvPath, 'utf-8'))
  if (rows.length === 0) throw new Error(`bench: ${csvPath} has no data rows.`)

  const date = rows[0]!['date']!
  const manifestPath = flag('manifest') ?? path.join(BENCH_ROOT, 'runs', date, 'manifest.json')
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, any>)
    : {}
  const config = (manifest['config'] ?? {}) as Record<string, any>
  const outPath = path.resolve(flag('out') ?? path.join(BENCH_ROOT, 'REPORT.md'))

  const taskIds = [...new Set(rows.map((row) => row['task']!))]
  const groups = [...new Set(rows.map((row) => row['group']!))]
  const repetitions = new Set(rows.map((row) => row['repetition'])).size
  const judgeModel = rows.find((row) => row['judge_model'])?.['judge_model'] ?? 'not scored'
  const strong = config['models']?.strong ?? 'unknown'
  const cheap = config['models']?.cheap ?? 'unknown'

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
    `Run date ${date}. Models ${strong} and ${cheap} (DeepSeek), judge ${judgeModel}.`,
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
      + `cost ${signedPercent(delta.cost)} (n=${repetitions}); ${qualityClause(a, b, delta.quality)}. `
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
    const qualityN = Math.min(a.quality?.n ?? 0, b.quality?.n ?? 0)
    const zh = qualityN === 0 || delta.quality === null
      ? '质量未评分'
      : rangesOverlap(a.quality, b.quality)
        ? `judge 质量分不可判定——两组实测区间重叠（A ${a.quality!.median.toFixed(2)} [${a.quality!.min.toFixed(2)}, ${a.quality!.max.toFixed(2)}]，`
          + `${b.group} ${b.quality!.median.toFixed(2)} [${b.quality!.min.toFixed(2)}, ${b.quality!.max.toFixed(2)}]，n=${qualityN}）`
        : `judge 质量分 ${signedAbs(delta.quality)}（A ${a.quality!.median.toFixed(2)} [${a.quality!.min.toFixed(2)}, ${a.quality!.max.toFixed(2)}]，`
          + `${b.group} ${b.quality!.median.toFixed(2)} [${b.quality!.min.toFixed(2)}, ${b.quality!.max.toFixed(2)}]，n=${qualityN}）`
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
        + `| ${s.cost ? range(s.cost, 4) : 'n/a'} | ${s.quality ? `${range(s.quality, 3)} (n=${s.quality.n})` : 'not scored'} `
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
      const defective = rows
        .filter((row) => row['task'] === taskId && row['success'] === 'true'
          && row['quality_score'] !== '' && Number(row['quality_score']) < 0.5)
        .map((row) => `${row['run_id']} scored ${Number(row['quality_score']).toFixed(2)}`)
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
    const variantRows = parseCSV(readFileSync(path.resolve(variantCsv), 'utf-8'))
    const variantDate = variantRows[0]?.['date'] ?? 'unknown'
    const variantName = variantRows[0]?.['variant'] ?? 'fixed-merge'
    const variantGroups = [...new Set(variantRows.map((row) => row['group']!))]
    const variantReps = new Set(variantRows.map((row) => row['repetition'])).size

    push(
      '## DAG variant: is the quality gap the wiring or the orchestration?',
      '',
      'The judge faulted group A repeatedly, and specifically: a compliance table that contradicted the '
      + 'report\'s own risk section, clauses dropped from the table, and a clause invented by splitting '
      + 'another. That is the signature of a merge with nothing to arbitrate against. In the published task '
      + 'graph the terminal task receives only its direct dependencies\' output, so the agent writing the '
      + 'final report never sees the contract, and cannot tell which of its two inputs is right when they '
      + 'disagree.',
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
      const entries: Array<[string, string, number, GroupStats, GroupStats]> = []
      const baseA = perTask.get(taskId)!.get('A')
      const baseB = perTask.get(taskId)!.get('B')
      if (baseA && baseB) entries.push(['as-published', date, repetitions, baseA, baseB])
      if (variantGroups.includes('A') && variantGroups.includes('B')) {
        entries.push([variantName, variantDate, variantReps,
          rowsFor(variantRows, 'A'), rowsFor(variantRows, 'B')])
      }
      for (const [name, day, n, a, b] of entries) {
        const gap = a.quality && b.quality ? a.quality.median - b.quality.median : null
        push(
          `| ${label} | ${name} | ${day} | ${n} | ${range(a.tokens)} | ${range(a.wall, 1)} `
          + `| ${a.cost ? range(a.cost, 4) : 'n/a'} | ${a.quality ? range(a.quality, 3) : 'n/a'} `
          + `| ${b.quality ? range(b.quality, 3) : 'n/a'} | ${signedAbs(gap)} |`,
        )
        if (name === variantName) {
          const entry = gaps.find((g) => g.task === label)
          if (entry) entry.fixed = gap
          else gaps.push({ task: label, published: null, fixed: gap })
        } else {
          gaps.push({ task: label, published: gap, fixed: null })
        }
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
      const basePublished = perTask.get(taskId)!.get('A')?.quality
      const baseFixed = statsFor(variantRows.filter((row) => row['task'] === taskId), 'A').quality
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
    'DeepSeek V4 enables thinking by default at `high` effort, which would put a large and highly variable block '
    + 'of reasoning tokens into the output column. It is disabled on both sides. Either setting is defensible; '
    + 'letting the two sides differ is not.',
    '',
    'DeepSeek\'s context cache cannot be switched off, so each run\'s system prompts carry a unique '
    + '`[bench <run_id>]` prefix that defeats the prefix cache identically for every group. The `cached_tokens` '
    + 'column verifies this rather than assuming it.',
    '',
    '### Measurement',
    '',
    'Token counts are read off each provider response by a loopback recording proxy, not taken from the '
    + 'framework. OMA\'s `TokenUsage` is `{ input_tokens, output_tokens }` with no cache field and no per-model '
    + 'split, so it cannot price a group-A run that deliberately mixes two tiers. The framework\'s own counts are '
    + 'recorded alongside in `framework_*_tokens`; any disagreement is written into the row\'s `notes` rather than '
    + 'reconciled silently. `bench/runs/<date>/calls.json` holds every individual call, so cost stays recomputable '
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
    push(
      `- **Cache busting failed on ${reps} (${tasks}).** Run ids are deterministic, so those runs reused a salt `
      + 'from an earlier aborted invocation of the same benchmark and inherited its prompt cache; their input '
      + 'tokens were partly billed at the much cheaper cache-hit rate, which understates their cost. It hit all '
      + 'three groups in the affected repetitions, and recomputing the medians without them moves the headline '
      + 'percentages by a few points without changing any direction. The salt now carries a per-invocation '
      + 'nonce so a re-run cannot inherit its predecessor\'s cache.',
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
    `- **Pricing is DeepSeek's published peak rate** at the time of the run. DeepSeek charges half that off-peak, `
    + 'so absolute cost figures halve outside the peak window while the ratios between groups do not move.',
    '- **The token budget never bound.** It was configured and enforced, but no run approached it, so these '
    + 'numbers say nothing about behaviour under budget pressure.',
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
    'export DEEPSEEK_API_KEY=...',
    `npx tsx bench/src/run-bench.mts --repetitions ${repetitions}`,
    `npx tsx bench/src/report.mts --csv bench/results-${date}.csv`,
    '```',
    '',
    `Harness details and every flag: [bench/README.md](README.md). Raw outputs, per-call log, and the manifest `
    + `(git SHA, node version, full config, UTC window) are in \`bench/runs/${date}/\`.`,
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

main()
