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

export function loadConfig(configPath = path.join(BENCH_ROOT, 'config.json')): BenchConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  const config = raw as unknown as BenchConfig

  if (!config.models?.strong || !config.models?.cheap) {
    throw new Error('bench/config.json: models.strong and models.cheap are required.')
  }
  if (typeof config.temperature !== 'number') {
    throw new Error('bench/config.json: temperature must be a number.')
  }
  if (!Number.isInteger(config.repetitions) || config.repetitions < 1) {
    throw new Error('bench/config.json: repetitions must be a positive integer.')
  }
  for (const group of config.groups) {
    if (!['A', 'B', 'C'].includes(group)) {
      throw new Error(`bench/config.json: unknown group "${group}" (expected A, B, or C).`)
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
