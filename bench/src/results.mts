/** Run records, CSV serialization, and the dispersion stats the report needs. */

export interface RunRecord {
  run_id: string
  date: string
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
  quality_score: number | null
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
