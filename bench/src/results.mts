/** Run records, CSV serialization, and the dispersion stats the report needs. */

export interface RunRecord {
  run_id: string
  date: string
  /**
   * The invocation's `<date>` or `<date>-<label>` stamp.
   *
   * This is the only thing that ties a row back to its raw data: outputs, the
   * per-call log and the manifest live in `bench/runs/<run_stamp>/`, which is
   * not `bench/runs/<date>/` as soon as `--label` is used. Sibling tools take
   * the same string as their `--date` argument.
   */
  run_stamp: string
  task: string
  task_kind: string
  group: string
  variant: string
  repetition: number
  group_order: string
  role_models: string
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  total_tokens: number
  est_cost_usd: number | null
  wall_seconds: number
  agent_count: number
  parallelism: number
  max_concurrent_calls: number
  llm_calls: number
  success: boolean
  /**
   * Mean of this run's per-pairing judge scores, for eyeballing one row. Not a
   * comparison input: see {@link RunRecord.quality_by_opponent}.
   */
  quality_score: number | null
  /**
   * Every pairing this run was judged in, as `opponent=score` joined by `;`.
   *
   * Group A is judged once per challenger, so one A run carries one score per
   * challenger — two different measurements of the same output, taken under two
   * different contrasts. An A-minus-B comparison has to use A's score from the
   * A-vs-B pair, and this column is what makes that possible.
   */
  quality_by_opponent: string
  judge_model: string
  temperature: number
  thinking: string
  cache_busting: boolean
  framework_input_tokens: number
  framework_output_tokens: number
  budget_exceeded: boolean
  notes: string
}

export const CSV_COLUMNS: ReadonlyArray<keyof RunRecord> = [
  'run_id',
  'date',
  'run_stamp',
  'task',
  'task_kind',
  'group',
  'variant',
  'repetition',
  'group_order',
  'role_models',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'total_tokens',
  'est_cost_usd',
  'wall_seconds',
  'agent_count',
  'parallelism',
  'max_concurrent_calls',
  'llm_calls',
  'success',
  'quality_score',
  'quality_by_opponent',
  'judge_model',
  'temperature',
  'thinking',
  'cache_busting',
  'framework_input_tokens',
  'framework_output_tokens',
  'budget_exceeded',
  'notes',
]

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? String(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCSV(records: readonly RunRecord[]): string {
  const header = CSV_COLUMNS.join(',')
  const rows = records.map((record) => CSV_COLUMNS.map((column) => csvCell(record[column])).join(','))
  return [header, ...rows].join('\n') + '\n'
}

/** One CSV row, keyed by header name. Values are always strings. */
export interface CsvRow {
  readonly [column: string]: string
}

/**
 * Read a results CSV back into header-keyed rows.
 *
 * The single reader for every tool that consumes a CSV. There used to be four
 * of these: one complete, one that handled `""` escapes, one that dropped them,
 * and one that was a bare `line.split(',')`. All four happened to work only
 * because `notes` is the last column, so a comma inside it corrupted cells that
 * nothing read. That is a coincidence, not a design.
 */
export function fromCSV(text: string): CsvRow[] {
  const rows: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { record.push(field); field = '' }
    else if (char === '\n') { record.push(field); rows.push(record); record = []; field = '' }
    else if (char !== '\r') field += char
  }
  if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record) }
  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell !== ''))
  if (!header) return []
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])))
}

// ---------------------------------------------------------------------------
// Per-pairing judge scores
// ---------------------------------------------------------------------------

/** Read a `quality_by_opponent` cell back into `opponent -> score`. */
export function decodeOpponentScores(cell: string): Map<string, number> {
  const scores = new Map<string, number>()
  for (const entry of cell.split(';')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    // `Number('')` is 0, so an empty value would turn "not scored" into "scored
    // zero". Drop the entry instead; the report already renders a missing
    // pairing as unscored.
    const raw = entry.slice(separator + 1).trim()
    if (raw === '') continue
    const value = Number(raw)
    if (Number.isFinite(value)) scores.set(entry.slice(0, separator), value)
  }
  return scores
}

/** Serialize `opponent -> score` for the CSV, ordered so a re-run is diffable. */
export function encodeOpponentScores(scores: ReadonlyMap<string, number>): string {
  return [...scores.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([opponent, score]) => `${opponent}=${score.toFixed(3)}`)
    .join(';')
}

export interface FoldedScore {
  /** The updated `quality_by_opponent` cell. */
  readonly byOpponent: string
  /** Mean across every pairing recorded so far, for `quality_score`. */
  readonly mean: number
}

/**
 * Add one pairing's score to a run's existing per-pairing scores.
 *
 * Assigning to a single `quality_score` instead loses every pairing but the
 * last one, which makes group A's reported quality depend on which challenger
 * happened to be judged last and lets a later A-minus-B comparison subtract two
 * numbers that came from different pairs. Re-folding the same opponent replaces
 * that opponent's entry, so recovering verdicts from disk stays idempotent.
 */
export function foldPairScore(existing: string, opponent: string, score: number): FoldedScore {
  const scores = decodeOpponentScores(existing)
  scores.set(opponent, Number(score.toFixed(3)))
  const total = [...scores.values()].reduce((sum, value) => sum + value, 0)
  return { byOpponent: encodeOpponentScores(scores), mean: total / scores.size }
}

export interface Dispersion {
  readonly n: number
  readonly median: number
  readonly min: number
  readonly max: number
  readonly mean: number
}

export function dispersion(values: readonly number[]): Dispersion | null {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  const sorted = [...finite].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
  return {
    n: sorted.length,
    median,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}

/** Percent change from `baseline` to `value`; null when the baseline is zero. */
export function percentDelta(value: number, baseline: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return null
  return ((value - baseline) / baseline) * 100
}
