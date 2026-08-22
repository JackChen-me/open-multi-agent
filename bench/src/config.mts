/** Loading and validation for bench/config.json. */

import { readFileSync } from 'node:fs'
import type { SupportedProvider } from '../../packages/core/src/index.js'
// `ThinkingConfig` types the public `AgentConfig.thinking` field but is not
// re-exported from the package index, so the bench reaches into types.js.
import type { ThinkingConfig } from '../../packages/core/src/types.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const BENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(BENCH_ROOT, '..')

export interface ModelPrice {
  /** USD per 1M uncached prompt tokens. */
  readonly input: number | null
  /** USD per 1M prompt tokens served from the provider cache. */
  readonly cachedInput: number | null
  /** USD per 1M completion tokens. */
  readonly output: number | null
}

export interface BenchConfig {
  readonly provider: SupportedProvider
  readonly models: { readonly strong: string; readonly cheap: string }
  readonly temperature: number
  readonly thinking: ThinkingConfig
  readonly maxTurns: number
  readonly cacheBusting: boolean
  readonly maxTokenBudget: number
  readonly repetitions: number
  readonly tasks: readonly string[]
  readonly groups: readonly string[]
  readonly judge: {
    readonly enabled: boolean
    readonly provider: SupportedProvider | null
    readonly model: string | null
    readonly temperature: number
    readonly rubricVersion: string
  }
  readonly pricing: Readonly<Record<string, ModelPrice>>
}

/** Upstream origin per provider, for the recording proxy to forward to. */
export const PROVIDER_ORIGINS: Readonly<Record<string, string>> = {
  deepseek: 'https://api.deepseek.com',
}

/**
 * Environment variable holding each provider's key.
 *
 * Lives here rather than in the runner because the report also needs it, to
 * print a reproduce command that names the key the run actually used instead of
 * assuming DeepSeek.
 */
export const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  mimo: 'MIMO_API_KEY',
  qiniu: 'QINIU_API_KEY',
  doubao: 'ARK_API_KEY',
  hunyuan: 'HUNYUAN_API_KEY',
}

/**
 * Vendors whose pricing has a time-of-day component.
 *
 * The report states the peak/off-peak caveat only for these. Asserting it for
 * every provider would put a DeepSeek billing fact into a report about someone
 * else's models.
 *
 * The windows are here rather than in the report so that all vendor knowledge
 * stays in one file, and so the report can check the invocation against them
 * instead of asserting which schedule applied.
 */
export interface TimeOfDayPricing {
  /** The schedule in words, quoted into the report. */
  readonly description: string
  /** Peak windows as `[fromHourUtc, toHourUtc)` pairs. Rates in `pricing` are the peak rates. */
  readonly peakWindowsUtc: ReadonlyArray<readonly [number, number]>
  /** Off-peak rate as a multiple of the peak rate. */
  readonly offPeakMultiplier: number
}

export const TIME_OF_DAY_PRICING: Readonly<Record<string, TimeOfDayPricing>> = {
  deepseek: {
    description: 'DeepSeek charges peak rates 01:00-04:00 and 06:00-10:00 UTC and half that off-peak.',
    peakWindowsUtc: [[1, 4], [6, 10]],
    offPeakMultiplier: 0.5,
  },
}

/** Which rate schedule an invocation was billed on. */
export type RateWindow = 'peak' | 'off-peak' | 'mixed' | 'unknown'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Merge overlapping/adjacent intervals so overlap can be summed without double counting. */
function merge(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}

/**
 * Classify the invocation's UTC window against a vendor's peak schedule.
 *
 * `bench/config.json` holds peak rates, so an invocation that ran entirely
 * off-peak was billed less than the report's cost column says, and one that
 * crossed a boundary was billed on two schedules at once. The report used to
 * assert the peak rate applied; this is what lets it check.
 */
export function classifyInvocationWindow(
  schedule: TimeOfDayPricing | undefined,
  startedAtUtc: unknown,
  finishedAtUtc: unknown,
): RateWindow {
  if (!schedule) return 'unknown'
  if (typeof startedAtUtc !== 'string' || typeof finishedAtUtc !== 'string') return 'unknown'
  const start = Date.parse(startedAtUtc)
  const finish = Date.parse(finishedAtUtc)
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return 'unknown'
  // The schedule repeats daily, so anything spanning a full day necessarily
  // covers both peak and off-peak hours.
  if (finish - start >= DAY_MS) return 'mixed'

  const windows: Array<[number, number]> = []
  const firstMidnight = Math.floor(start / DAY_MS) * DAY_MS
  for (let day = firstMidnight - DAY_MS; day <= finish + DAY_MS; day += DAY_MS) {
    for (const [from, to] of schedule.peakWindowsUtc) {
      windows.push([day + from * HOUR_MS, day + to * HOUR_MS])
    }
  }
  const peak = merge(windows)

  if (finish === start) {
    return peak.some(([from, to]) => start >= from && start < to) ? 'peak' : 'off-peak'
  }
  let inPeak = 0
  for (const [from, to] of peak) {
    inPeak += Math.max(0, Math.min(to, finish) - Math.max(from, start))
  }
  if (inPeak === 0) return 'off-peak'
  return inPeak >= finish - start ? 'peak' : 'mixed'
}

function fail(message: string): never {
  throw new Error(`bench/config.json: ${message}`)
}

export function loadConfig(configPath = path.join(BENCH_ROOT, 'config.json')): BenchConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  const config = raw as unknown as BenchConfig

  if (typeof config.provider !== 'string' || !config.provider) fail('provider is required.')
  if (!config.models?.strong || !config.models?.cheap) {
    fail('models.strong and models.cheap are required.')
  }
  if (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature)) {
    fail('temperature must be a finite number.')
  }
  if (!Number.isInteger(config.repetitions) || config.repetitions < 1) {
    fail('repetitions must be a positive integer.')
  }
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
    fail('maxTurns must be a positive integer.')
  }
  // These used to be read straight off the parsed JSON. A missing `groups`
  // surfaced as a bare TypeError from a for-of over undefined, several frames
  // away from the file that was actually wrong.
  if (!Array.isArray(config.groups) || config.groups.length === 0) {
    fail('groups must be a non-empty array.')
  }
  for (const group of config.groups) {
    if (!['A', 'B', 'C'].includes(group)) {
      fail(`unknown group "${group}" (expected A, B, or C).`)
    }
  }
  if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
    fail('tasks must be a non-empty array.')
  }
  for (const task of config.tasks) {
    if (typeof task !== 'string' || !task) fail('every entry in tasks must be a non-empty string.')
  }
  if (!config.judge || typeof config.judge !== 'object') fail('judge is required.')
  if (typeof config.judge.enabled !== 'boolean') fail('judge.enabled must be a boolean.')
  if (config.judge.enabled && (!config.judge.provider || !config.judge.model)) {
    fail('judge.provider and judge.model are required while judge.enabled is true.')
  }
  if (!config.pricing || typeof config.pricing !== 'object') {
    fail('pricing is required; use null rates rather than omitting it.')
  }
  for (const [model, price] of Object.entries(config.pricing)) {
    // `$`-prefixed keys are the file's own comment convention, used at every
    // level including inside `pricing`. They are documentation, not a model.
    if (model.startsWith('$')) continue
    if (!price || typeof price !== 'object') fail(`pricing["${model}"] must be an object.`)
    for (const rate of ['input', 'cachedInput', 'output'] as const) {
      const value = price[rate]
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        fail(`pricing["${model}"].${rate} must be a non-negative number or null.`)
      }
    }
  }
  return config
}

/**
 * Cost for one model's usage, or `null` when any needed price is missing.
 *
 * Returning `null` rather than a zero or a guessed rate is deliberate: an empty
 * cost column in the CSV is honest, a fabricated one is not.
 */
export function priceCall(
  pricing: Readonly<Record<string, ModelPrice>>,
  model: string,
  tokens: { input: number; cached: number; output: number },
): number | null {
  const price = pricing[model]
  if (!price) return null
  const uncachedInput = Math.max(0, tokens.input - tokens.cached)
  const needsCachedRate = tokens.cached > 0
  if (price.input === null || price.output === null) return null
  if (needsCachedRate && price.cachedInput === null) return null
  const cachedCost = needsCachedRate ? (tokens.cached / 1_000_000) * (price.cachedInput as number) : 0
  return (
    (uncachedInput / 1_000_000) * price.input
    + cachedCost
    + (tokens.output / 1_000_000) * price.output
  )
}

/** True when every model the run touched has a complete price entry. */
export function pricingIsComplete(
  pricing: Readonly<Record<string, ModelPrice>>,
  models: readonly string[],
): boolean {
  return models.every((model) => {
    const price = pricing[model]
    return Boolean(price) && price.input !== null && price.output !== null && price.cachedInput !== null
  })
}
