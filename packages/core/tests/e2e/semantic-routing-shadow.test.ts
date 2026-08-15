/**
 * Release-canary evaluation for the real LLMTaskProfiler.
 *
 * This suite is deliberately skipped unless the caller explicitly enables it.
 * It sends only the reviewed synthetic goals in semantic-routing-set.json to
 * the selected provider; it never executes workers, tools, or user data.
 *
 * Run with the `test:semantic-routing-shadow` workspace script after setting:
 *   SEMANTIC_ROUTING_SHADOW=1
 *   SEMANTIC_ROUTING_SHADOW_PROVIDER=<supported provider>
 *   SEMANTIC_ROUTING_SHADOW_MODEL=<model id>
 *   SEMANTIC_ROUTING_SHADOW_API_KEY=<local secret> (not needed for Bedrock)
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { loadEvalSet } from '../../src/eval/file.js'
import { createAdapter, type SupportedProvider } from '../../src/llm/adapter.js'
import {
  evaluateSemanticRoutingPolicy,
  LLMTaskProfiler,
  taskProfileSchema,
} from '../../src/orchestrator/task-profiler.js'
import type { TaskProfile } from '../../src/types.js'

const SEMANTIC_EVAL_SET_PATH = fileURLToPath(
  new URL('../fixtures/eval/semantic-routing-set.json', import.meta.url),
)
const SUPPORTED_PROVIDERS = new Set<SupportedProvider>([
  'anthropic',
  'azure-openai',
  'bedrock',
  'copilot',
  'deepseek',
  'doubao',
  'gemini',
  'grok',
  'hunyuan',
  'minimax',
  'mimo',
  'openai',
  'qiniu',
])
const SHADOW_ENABLED = process.env['SEMANTIC_ROUTING_SHADOW'] === '1'
const describeShadow = SHADOW_ENABLED ? describe : describe.skip

interface ShadowFixture {
  readonly goal: string
  readonly facts: {
    readonly confidenceThreshold: number
    readonly hasConsequentialTools: boolean
    readonly permissionBoundaryCount: number
  }
  readonly expected: 'single' | 'team' | 'needs-declaration'
}

interface ShadowObservation {
  readonly caseId: string
  readonly tags: readonly string[]
  readonly expected: ShadowFixture['expected']
  readonly actual?: ShadowFixture['expected']
  readonly durationMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly failure?: string
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!
}

function requireShadowConfig(): {
  readonly provider: SupportedProvider
  readonly model: string
  readonly apiKey?: string
  readonly baseURL?: string
  readonly region?: string
} {
  const providerValue = process.env['SEMANTIC_ROUTING_SHADOW_PROVIDER']
  const model = process.env['SEMANTIC_ROUTING_SHADOW_MODEL']
  const apiKey = process.env['SEMANTIC_ROUTING_SHADOW_API_KEY']
  const baseURL = process.env['SEMANTIC_ROUTING_SHADOW_BASE_URL']
  const region = process.env['SEMANTIC_ROUTING_SHADOW_REGION']
  if (providerValue === undefined || !SUPPORTED_PROVIDERS.has(providerValue as SupportedProvider)) {
    throw new Error('SEMANTIC_ROUTING_SHADOW_PROVIDER must name a supported provider.')
  }
  if (model === undefined || model.length === 0) {
    throw new Error('SEMANTIC_ROUTING_SHADOW_MODEL must be a non-empty model id.')
  }
  if ((apiKey === undefined || apiKey.length === 0) && providerValue !== 'bedrock') {
    throw new Error('SEMANTIC_ROUTING_SHADOW_API_KEY must be set locally when Shadow testing is enabled.')
  }
  return {
    provider: providerValue as SupportedProvider,
    model,
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    ...(baseURL !== undefined && baseURL.length > 0 ? { baseURL } : {}),
    ...(region !== undefined && region.length > 0 ? { region } : {}),
  }
}

describeShadow('semantic routing Shadow evaluation', () => {
  it('meets the reviewed semantic-routing release gates with a real profiler', async () => {
    const config = requireShadowConfig()
    const evalSet = await loadEvalSet(SEMANTIC_EVAL_SET_PATH)
    const adapter = await createAdapter(
      config.provider,
      config.apiKey,
      config.baseURL,
      config.region,
    )
    const profiler = new LLMTaskProfiler({
      adapter,
      model: config.model,
      // Match the shipping LLMTaskProfiler default. A lower canary-only cap
      // would validate truncation behavior rather than the release contract.
      maxTokens: 800,
    })
    const observations: ShadowObservation[] = []

    for (const evalCase of evalSet.cases) {
      const fixture = evalCase.input as ShadowFixture
      const startedAt = Date.now()
      try {
        const profiled = await profiler.profile({
          goal: fixture.goal,
          roster: [
            { name: 'researcher', model: config.model, capabilities: ['research'] },
            { name: 'reviewer', model: config.model, capabilities: ['review'] },
          ],
        })
        const profile: TaskProfile = taskProfileSchema.parse(profiled.profile)
        const actual = evaluateSemanticRoutingPolicy(profile, fixture.facts).recommendation
        observations.push({
          caseId: evalCase.id,
          tags: evalCase.tags ?? [],
          expected: fixture.expected,
          actual,
          durationMs: Date.now() - startedAt,
          inputTokens: profiled.usage?.input_tokens,
          outputTokens: profiled.usage?.output_tokens,
        })
      } catch (error) {
        observations.push({
          caseId: evalCase.id,
          tags: evalCase.tags ?? [],
          expected: fixture.expected,
          durationMs: Date.now() - startedAt,
          failure: error instanceof Error ? error.name : 'unknown',
        })
      }
    }

    const failures = observations.filter((observation) => observation.failure !== undefined)
    const mismatches = observations.filter((observation) =>
      observation.failure === undefined && observation.actual !== observation.expected)
    const criticalFalseSingles = observations.filter((observation) =>
      observation.tags.includes('critical')
      && observation.expected !== 'single'
      && observation.actual === 'single')
    const successful = observations.length - failures.length
    const accuracy = observations.length === 0
      ? 0
      : (successful - mismatches.length) / observations.length
    const inputTokens = observations.reduce(
      (total, observation) => total + (observation.inputTokens ?? 0),
      0,
    )
    const outputTokens = observations.reduce(
      (total, observation) => total + (observation.outputTokens ?? 0),
      0,
    )

    // Deliberately excludes goal text, profile reasons, raw responses, and API
    // configuration so the canary report stays safe to retain in CI output.
    console.info('[semantic-routing-shadow] %s', JSON.stringify({
      provider: config.provider,
      model: config.model,
      caseCount: observations.length,
      successful,
      accuracy,
      invalidOrFailedProfiles: failures.length,
      criticalFalseSingles: criticalFalseSingles.map((observation) => observation.caseId),
      mismatches: mismatches.map((observation) => ({
        caseId: observation.caseId,
        expected: observation.expected,
        actual: observation.actual,
      })),
      failureCases: failures.map((observation) => ({
        caseId: observation.caseId,
        failure: observation.failure,
      })),
      p95ProfilerLatencyMs: percentile95(observations.map((observation) => observation.durationMs)),
      totalTokens: { input_tokens: inputTokens, output_tokens: outputTokens },
    }))

    expect(failures, 'Profiler must return a valid profile for every reviewed fixture.').toHaveLength(0)
    expect(criticalFalseSingles, 'Critical tasks must never remain on the Single path.').toHaveLength(0)
    expect(accuracy, 'Reviewed end-to-end routing accuracy must be at least 95%.').toBeGreaterThanOrEqual(0.95)
  }, 120_000)
})
