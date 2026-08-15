import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { defineScorer, evaluateGate, runEvalSet } from '../src/eval/index.js'
import type {
  EvalRunReport,
  EvalSet,
  EvalTarget,
  GatePolicy,
  Scorer,
} from '../src/eval/index.js'
import { loadEvalSet, loadGatePolicy } from '../src/eval/file.js'
import { buildExecutionReceipt } from '../src/observability/execution-receipt.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import type { GovernanceDeclaration } from '../src/orchestrator/governance.js'
import type {
  AgentConfig,
  GovernanceConclusion,
  LLMAdapter,
  LLMResponse,
  RunTeamOptions,
  TaskProfiler,
  TeamRunResult,
} from '../src/types.js'

const FIXTURE_DIRECTORY = new URL('./fixtures/eval/', import.meta.url)
const EVAL_SET_PATH = fileURLToPath(new URL('routing-stability-set.json', FIXTURE_DIRECTORY))
const GATE_PATH = fileURLToPath(new URL('routing-stability-gate.json', FIXTURE_DIRECTORY))

// Every model phase receives this exact content. The coordinator parses it as
// a fixed two-role plan; workers and synthesis return the same inert text.
const FIXED_MODEL_OUTPUT = `\`\`\`json
[
  {"title":"Collect facts","description":"Collect the relevant facts.","assignee":"researcher"},
  {"title":"Analyze facts","description":"Analyze the collected facts.","assignee":"analyst","dependsOn":["Collect facts"]}
]
\`\`\``

type FamilyKind = 'benign' | 'governance'
type Language = 'en' | 'zh' | 'ja' | 'ko'
type VariantType = 'short' | 'detailed' | 'translation'

interface RoutingVariant {
  readonly id: string
  readonly language: Language
  readonly variantType: VariantType
  readonly text: string
}

interface RoutingFamily {
  readonly id: string
  readonly kind: FamilyKind
  readonly declaration?: GovernanceDeclaration
  readonly variants: readonly RoutingVariant[]
  readonly comparisonPairs: {
    readonly length: readonly [string, string]
    readonly language: readonly [string, string]
  }
}

interface RoutingTopology {
  readonly route: 'single-short-circuit' | 'task-graph'
  readonly mode: 'single' | 'multi-agent'
  readonly roles: readonly string[]
  readonly dependencyEdges: readonly string[]
}

interface RouteObservation {
  readonly variant: RoutingVariant
  readonly topology: RoutingTopology
  readonly governanceConclusion: GovernanceConclusion | 'missing'
}

interface RoutingMetrics {
  readonly flipRate: number
  readonly flippedPairs: readonly string[]
  readonly totalPairs: number
  readonly lengthInvariant: boolean
  readonly languageInvariant: boolean
}

interface RoutingFamilyResult {
  readonly familyId: string
  readonly kind: FamilyKind
  readonly observations: readonly RouteObservation[]
  readonly metrics: RoutingMetrics
}

type VariantRouter = (
  family: RoutingFamily,
  variant: RoutingVariant,
  signal: AbortSignal,
) => Promise<Omit<RouteObservation, 'variant'>>

interface FamilyMetricSnapshot {
  readonly familyId: string
  readonly flipRate: number
  readonly flippedPairs: number
  readonly totalPairs: number
  readonly lengthInvariant: boolean
  readonly languageInvariant: boolean
  readonly governanceConclusions: readonly string[]
  readonly variantTopologies: readonly string[]
}

interface MetricGroupSnapshot {
  readonly families: readonly FamilyMetricSnapshot[]
  readonly flipRate: number
  readonly lengthInvariance: number
  readonly languageInvariance: number
}

interface RoutingStabilitySnapshot {
  readonly evalSet: EvalRunReport['evalSet']
  readonly target: {
    readonly maxFlipRate: number
    readonly minLengthInvariance: number
  }
  readonly governance: MetricGroupSnapshot
  readonly benign: MetricGroupSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${context}.${key} must be a non-empty string.`)
  }
  return value
}

function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${context}.${key} must be an array of strings.`)
  }
  return value
}

function parsePair(
  record: Record<string, unknown>,
  key: string,
  variants: ReadonlySet<string>,
  context: string,
): readonly [string, string] {
  const pair = requiredStringArray(record, key, context)
  if (pair.length !== 2 || pair[0] === pair[1] || pair.some((id) => !variants.has(id))) {
    throw new TypeError(`${context}.${key} must reference two distinct variants.`)
  }
  return [pair[0]!, pair[1]!]
}

function parseRoutingFamily(input: unknown, caseId: string): RoutingFamily {
  if (!isRecord(input)) throw new TypeError(`Eval case ${caseId} input must be an object.`)
  const kind = requiredString(input, 'kind', caseId)
  if (kind !== 'benign' && kind !== 'governance') {
    throw new TypeError(`Eval case ${caseId} has unsupported kind ${kind}.`)
  }

  const rawVariants = input['variants']
  if (!Array.isArray(rawVariants) || rawVariants.length < 3) {
    throw new TypeError(`Eval case ${caseId} must contain at least three variants.`)
  }
  const variants = rawVariants.map((value, index): RoutingVariant => {
    const context = `${caseId}.variants.${index}`
    if (!isRecord(value)) throw new TypeError(`${context} must be an object.`)
    const language = requiredString(value, 'language', context)
    const variantType = requiredString(value, 'variantType', context)
    if (language !== 'en' && language !== 'zh' && language !== 'ja' && language !== 'ko') {
      throw new TypeError(`${context}.language must be en, zh, ja, or ko.`)
    }
    if (variantType !== 'short' && variantType !== 'detailed' && variantType !== 'translation') {
      throw new TypeError(`${context}.variantType is invalid.`)
    }
    return {
      id: requiredString(value, 'id', context),
      language,
      variantType,
      text: requiredString(value, 'text', context),
    }
  })
  const variantIds = new Set(variants.map((variant) => variant.id))
  if (variantIds.size !== variants.length) {
    throw new TypeError(`Eval case ${caseId} variant ids must be unique.`)
  }

  const rawPairs = input['comparisonPairs']
  if (!isRecord(rawPairs)) {
    throw new TypeError(`Eval case ${caseId}.comparisonPairs must be an object.`)
  }
  const comparisonPairs = {
    length: parsePair(rawPairs, 'length', variantIds, `${caseId}.comparisonPairs`),
    language: parsePair(rawPairs, 'language', variantIds, `${caseId}.comparisonPairs`),
  }

  if (kind === 'benign') {
    if (input['declaration'] !== undefined) {
      throw new TypeError(`Benign eval case ${caseId} must not declare governance.`)
    }
    return { id: caseId, kind, variants, comparisonPairs }
  }

  const rawDeclaration = input['declaration']
  if (!isRecord(rawDeclaration)) {
    throw new TypeError(`Governance eval case ${caseId} must include a declaration.`)
  }
  const governanceIntent = requiredString(rawDeclaration, 'governanceIntent', caseId)
  if (governanceIntent !== 'required') {
    throw new TypeError(`Governance eval case ${caseId} must use governanceIntent=required.`)
  }
  const declaration: GovernanceDeclaration = {
    governanceIntent,
    requiredRoles: requiredStringArray(rawDeclaration, 'requiredRoles', caseId),
    requiredOrder: requiredStringArray(rawDeclaration, 'requiredOrder', caseId),
  }
  return { id: caseId, kind, declaration, variants, comparisonPairs }
}

function fixedAdapter(): LLMAdapter {
  return {
    name: 'routing-stability-fixed-output',
    async chat(): Promise<LLMResponse> {
      return {
        id: 'routing-stability-fixed-response',
        content: [{ type: 'text', text: FIXED_MODEL_OUTPUT }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream() { /* unused */ },
  }
}

function fixedProfiler(): TaskProfiler {
  return {
    version: 'routing-stability-profiler-v1',
    async profile() {
      return {
        profile: {
          evidenceSources: 'single',
          independentReview: 'none',
          conflictingObjectives: false,
          sideEffectIntent: 'none',
          permissionIsolation: 'none',
          decomposable: false,
          parallelizable: false,
          complexity: 'low',
          confidence: 0.95,
          reasons: ['Frozen benign routing profile.'],
          source: 'inferred',
        },
      }
    },
  }
}

function agent(
  name: string,
  systemPrompt: string,
  adapter: LLMAdapter,
): AgentConfig {
  return { name, model: 'mock-model', systemPrompt, adapter }
}

function topologyFromResult(result: TeamRunResult): RoutingTopology {
  const receipt = buildExecutionReceipt(result)
  const dependencyEdges = receipt.dependencyEdges
    .map((edge) => `${edge.from}->${edge.to}`)
    .sort()
  return {
    route: result.tasks?.length === 1 && result.tasks[0]?.id === 'short-circuit'
      ? 'single-short-circuit'
      : 'task-graph',
    mode: receipt.mode,
    roles: [...receipt.rolesExecuted].sort(),
    dependencyEdges,
  }
}

function canonicalTopology(topology: RoutingTopology, kind?: FamilyKind): string {
  // Undeclared families gate Execution Routing only: which topology family was
  // selected. Agent assignment is a separate subsystem. Declared governance
  // keeps the full role/dependency topology in its 0%-flip gate.
  return kind === 'benign'
    ? JSON.stringify({ route: topology.route, mode: topology.mode })
    : JSON.stringify(topology)
}

async function runActualRoute(
  family: RoutingFamily,
  variant: RoutingVariant,
  signal: AbortSignal,
): Promise<Omit<RouteObservation, 'variant'>> {
  const adapter = fixedAdapter()
  const orchestrator = new OpenMultiAgent({
    defaultModel: 'mock-model',
    executionRouting: { strategy: 'hybrid', profiler: fixedProfiler() },
  })
  const team = orchestrator.createTeam(`routing-stability-${family.id}-${variant.id}`, {
    name: `routing-stability-${family.id}`,
    agents: [
      agent('researcher', 'Explain beginner concepts, DNS, domains, IP addresses, and resolvers.', adapter),
      agent('analyst', 'Compare PostgreSQL, MySQL, and SQLite latency, throughput, and licenses in tables.', adapter),
      agent('reviewer', 'Review governed requests independently.', adapter),
      agent('security', 'Assess security controls independently.', adapter),
      agent('operator', 'Record operational outcomes without changing policy.', adapter),
    ],
    sharedMemory: true,
  })
  const options: RunTeamOptions = {
    abortSignal: signal,
    coordinator: { model: 'mock-model', adapter },
    ...family.declaration,
  }
  const result = await orchestrator.runTeam(team, variant.text, options)
  if (
    family.kind === 'benign'
    && (
      result.semanticRoutingAssessment?.outcome !== 'applied'
      || result.semanticRoutingAssessment.recommendation !== 'single'
    )
  ) {
    throw new Error(
      `Benign routing fixture ${family.id}/${variant.id} did not exercise applied Hybrid profiling.`,
    )
  }
  return {
    topology: topologyFromResult(result),
    governanceConclusion: result.governanceConclusion ?? 'missing',
  }
}

function variantById(
  variants: readonly RoutingVariant[],
  variantId: string,
): RoutingVariant {
  const variant = variants.find((candidate) => candidate.id === variantId)
  if (variant === undefined) throw new Error(`Missing routing variant ${variantId}.`)
  return variant
}

function calculateMetrics(
  observations: readonly RouteObservation[],
  pairs: RoutingFamily['comparisonPairs'],
  kind: FamilyKind,
): RoutingMetrics {
  const canonical = new Map(observations.map((observation) => [
    observation.variant.id,
    canonicalTopology(observation.topology, kind),
  ]))
  const flippedPairs: string[] = []
  let totalPairs = 0
  for (let left = 0; left < observations.length; left++) {
    for (let right = left + 1; right < observations.length; right++) {
      totalPairs++
      const leftId = observations[left]!.variant.id
      const rightId = observations[right]!.variant.id
      if (canonical.get(leftId) !== canonical.get(rightId)) {
        flippedPairs.push(`${leftId}<->${rightId}`)
      }
    }
  }

  const invariant = (pair: readonly [string, string]): boolean =>
    canonical.get(pair[0]) === canonical.get(pair[1])
  return {
    flipRate: totalPairs === 0 ? 0 : flippedPairs.length / totalPairs,
    flippedPairs,
    totalPairs,
    lengthInvariant: invariant(pairs.length),
    languageInvariant: invariant(pairs.language),
  }
}

function routingTarget(router: VariantRouter): EvalTarget {
  return async (input, context) => {
    const family = parseRoutingFamily(input, context.caseId)
    const observations: RouteObservation[] = []
    for (const variant of family.variants) {
      const routed = await router(family, variant, context.signal)
      observations.push({ variant, ...routed })
    }
    const output: RoutingFamilyResult = {
      familyId: family.id,
      kind: family.kind,
      observations,
      metrics: calculateMetrics(observations, family.comparisonPairs, family.kind),
    }
    return { output }
  }
}

function familyResult(output: unknown): RoutingFamilyResult {
  if (!isRecord(output) || !isRecord(output['metrics']) || !Array.isArray(output['observations'])) {
    throw new TypeError('Routing stability target returned an invalid result.')
  }
  return output as unknown as RoutingFamilyResult
}

const routingStabilityScorer = defineScorer({
  name: 'routing-stability',
  version: '1.0.0',
  score({ output }) {
    const result = familyResult(output)
    const { flipRate, flippedPairs, totalPairs } = result.metrics
    return {
      score: 1 - flipRate,
      pass: flipRate === 0,
      reason: `${flippedPairs.length}/${totalPairs} equivalent variant pairs changed topology.`,
      details: {
        family: result.familyId,
        family_kind: result.kind,
        flip_rate: flipRate,
        flipped_pair_count: flippedPairs.length,
        total_pair_count: totalPairs,
        flipped_pairs: flippedPairs,
        governance_conclusions: result.observations.map((item) => item.governanceConclusion),
        variant_topologies: result.observations.map((item) =>
          `${item.variant.id}=${canonicalTopology(item.topology)}`),
      },
    }
  },
})

function invarianceScorer(
  name: 'length-invariance' | 'language-invariance',
  metric: 'lengthInvariant' | 'languageInvariant',
): Scorer {
  return defineScorer({
    name,
    version: '1.0.0',
    score({ output }) {
      const result = familyResult(output)
      const invariant = result.metrics[metric]
      return {
        score: invariant ? 1 : 0,
        pass: invariant,
        reason: invariant
          ? `${name} comparison kept the same topology.`
          : `${name} comparison changed topology.`,
        details: {
          family: result.familyId,
          family_kind: result.kind,
          invariant,
        },
      }
    },
  })
}

const routingScorers = [
  routingStabilityScorer,
  invarianceScorer('length-invariance', 'lengthInvariant'),
  invarianceScorer('language-invariance', 'languageInvariant'),
] as const

function detailNumber(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number {
  const value = details?.[key]
  if (typeof value !== 'number') throw new TypeError(`Missing numeric report detail ${key}.`)
  return value
}

function detailBoolean(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): boolean {
  const value = details?.[key]
  if (typeof value !== 'boolean') throw new TypeError(`Missing boolean report detail ${key}.`)
  return value
}

function detailStrings(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly string[] {
  const value = details?.[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`Missing string-array report detail ${key}.`)
  }
  return value
}

function familySnapshots(report: EvalRunReport, kind: FamilyKind): FamilyMetricSnapshot[] {
  const stabilityRecords = report.records.filter((record) =>
    record.status === 'scored'
    && record.scorer.name === 'routing-stability'
    && record.details?.['family_kind'] === kind)
  return stabilityRecords.map((record) => {
    const familyId = record.caseId!
    const length = report.records.find((candidate) =>
      candidate.caseId === familyId && candidate.scorer.name === 'length-invariance')
    const language = report.records.find((candidate) =>
      candidate.caseId === familyId && candidate.scorer.name === 'language-invariance')
    return {
      familyId,
      flipRate: detailNumber(record.details, 'flip_rate'),
      flippedPairs: detailNumber(record.details, 'flipped_pair_count'),
      totalPairs: detailNumber(record.details, 'total_pair_count'),
      lengthInvariant: detailBoolean(length?.details, 'invariant'),
      languageInvariant: detailBoolean(language?.details, 'invariant'),
      governanceConclusions: detailStrings(record.details, 'governance_conclusions'),
      variantTopologies: detailStrings(record.details, 'variant_topologies'),
    }
  })
}

function groupSnapshot(families: readonly FamilyMetricSnapshot[]): MetricGroupSnapshot {
  const flippedPairs = families.reduce((sum, family) => sum + family.flippedPairs, 0)
  const totalPairs = families.reduce((sum, family) => sum + family.totalPairs, 0)
  return {
    families,
    flipRate: totalPairs === 0 ? 0 : flippedPairs / totalPairs,
    lengthInvariance: families.length === 0
      ? 1
      : families.filter((family) => family.lengthInvariant).length / families.length,
    languageInvariance: families.length === 0
      ? 1
      : families.filter((family) => family.languageInvariant).length / families.length,
  }
}

function routingSnapshot(report: EvalRunReport): RoutingStabilitySnapshot {
  return {
    evalSet: report.evalSet,
    target: {
      maxFlipRate: 0.05,
      minLengthInvariance: 0.95,
    },
    governance: groupSnapshot(familySnapshots(report, 'governance')),
    benign: groupSnapshot(familySnapshots(report, 'benign')),
  }
}

describe('runTeam routing stability EvalSet', () => {
  let evalSet: EvalSet
  let gatePolicy: GatePolicy

  beforeAll(async () => {
    const loaded = await Promise.all([
      loadEvalSet(EVAL_SET_PATH),
      loadGatePolicy(GATE_PATH),
    ])
    evalSet = loaded[0]
    gatePolicy = loaded[1]
  })

  it('loads frozen short, detailed, and translated variants with governance declared only where required', () => {
    expect(evalSet.cases).toHaveLength(4)
    for (const evalCase of evalSet.cases) {
      const family = parseRoutingFamily(evalCase.input, evalCase.id)
      // Each family carries one short + one detailed English anchor plus three
      // equivalent translations (Chinese, Japanese, Korean). The Japanese and
      // Korean translations join the existing en/zh goals in the all-pairs flip
      // gate so equivalent CJK goals cannot change execution topology.
      expect(family.variants.map((variant) => variant.variantType)).toEqual([
        'short',
        'detailed',
        'translation',
        'translation',
        'translation',
      ])
      expect(variantById(family.variants, 'short-en')).toMatchObject({
        language: 'en',
        variantType: 'short',
      })
      expect(variantById(family.variants, 'short-en').text.length).toBeLessThanOrEqual(200)
      expect(variantById(family.variants, 'detailed-en')).toMatchObject({
        language: 'en',
        variantType: 'detailed',
      })
      expect(variantById(family.variants, 'detailed-en').text.length).toBeGreaterThan(200)
      expect(variantById(family.variants, 'translated-cn')).toMatchObject({
        language: 'zh',
        variantType: 'translation',
      })
      expect(variantById(family.variants, 'translated-ja')).toMatchObject({
        language: 'ja',
        variantType: 'translation',
      })
      expect(variantById(family.variants, 'translated-ko')).toMatchObject({
        language: 'ko',
        variantType: 'translation',
      })

      const [shortId, detailedId] = family.comparisonPairs.length
      expect(variantById(family.variants, shortId).variantType).toBe('short')
      expect(variantById(family.variants, detailedId).variantType).toBe('detailed')
      const [englishId, chineseId] = family.comparisonPairs.language
      expect(variantById(family.variants, englishId).language).toBe('en')
      expect(variantById(family.variants, chineseId).language).toBe('zh')
      if (family.kind === 'governance') {
        expect(family.declaration?.governanceIntent).toBe('required')
        expect(family.declaration?.requiredOrder).toEqual(family.declaration?.requiredRoles)
      } else {
        expect(family.declaration).toBeUndefined()
      }
    }
  })

  it('hard-gates declared governance at 0% flip and undeclared routing at no more than 5%', async () => {
    const report = await runEvalSet(evalSet, routingTarget(runActualRoute), {
      scorers: routingScorers,
      concurrency: 1,
      evalRunId: 'routing-stability-current',
    })
    const snapshot = routingSnapshot(report)
    console.info(`[routing-stability] ${JSON.stringify(snapshot)}`)

    expect(snapshot.governance.families).toHaveLength(2)
    expect(snapshot.governance.flipRate).toBe(0)
    expect(snapshot.governance.lengthInvariance).toBe(1)
    expect(snapshot.governance.languageInvariance).toBe(1)
    expect(snapshot.governance.families.every((family) =>
      family.governanceConclusions.every((conclusion) => conclusion === 'satisfied'))).toBe(true)

    expect(snapshot.benign.families).toHaveLength(2)
    expect(snapshot.benign.flipRate).toBeLessThanOrEqual(snapshot.target.maxFlipRate)
    expect(gatePolicy.thresholds.some((threshold) =>
      threshold.tag === 'benign'
      && threshold.scorer === 'routing-stability'
      && threshold.min === 0.95)).toBe(true)

    expect(evaluateGate(report, gatePolicy)).toEqual({
      pass: true,
      failures: [],
      warnings: [],
    })
  })

  it('turns the hard gate red when an injected declared route flips on Chinese', async () => {
    const languageSensitiveFakeRoute: VariantRouter = async (family, variant, signal) => {
      if (family.kind !== 'governance' || variant.language !== 'zh') {
        return runActualRoute(family, variant, signal)
      }
      return {
        topology: {
          route: 'single-short-circuit',
          mode: 'single',
          roles: [family.declaration!.requiredRoles![0]!],
          dependencyEdges: [],
        },
        // Keep I3 green so this negative control isolates the stability gate.
        governanceConclusion: 'satisfied',
      }
    }
    const report = await runEvalSet(evalSet, routingTarget(languageSensitiveFakeRoute), {
      scorers: routingScorers,
      concurrency: 1,
      evalRunId: 'routing-stability-negative-control',
    })

    const verdict = evaluateGate(report, gatePolicy)
    expect(verdict.pass).toBe(false)
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'threshold',
        scorer: 'routing-stability',
        tag: 'governance',
      }),
      expect.objectContaining({
        kind: 'threshold',
        scorer: 'language-invariance',
        tag: 'governance',
      }),
    ]))
  })

  it('turns the hard gate red when an injected undeclared route flips mode', async () => {
    const languageSensitiveFakeRoute: VariantRouter = async (family, variant, signal) => {
      if (family.kind !== 'benign' || variant.language !== 'zh') {
        return runActualRoute(family, variant, signal)
      }
      return {
        topology: {
          route: 'task-graph',
          mode: 'multi-agent',
          roles: ['analyst', 'researcher'],
          dependencyEdges: ['researcher->analyst'],
        },
        governanceConclusion: 'not-applicable',
      }
    }
    const report = await runEvalSet(evalSet, routingTarget(languageSensitiveFakeRoute), {
      scorers: routingScorers,
      concurrency: 1,
      evalRunId: 'routing-stability-benign-negative-control',
    })

    const verdict = evaluateGate(report, gatePolicy)
    expect(verdict.pass).toBe(false)
    expect(verdict.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'threshold',
        scorer: 'routing-stability',
        tag: 'benign',
      }),
    ]))
  })
})
