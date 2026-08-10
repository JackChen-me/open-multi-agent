/**
 * Cost-Tiered Pipeline
 *
 * Demonstrates:
 * - Running the same four-stage `runTasks()` pipeline twice
 * - Assigning different models per agent within one pipeline
 * - Capturing token usage per model via `onTrace`
 * - Estimating USD cost from provider-specific model pricing
 *
 * Run:
 *   npx tsx examples/patterns/cost-tiered-pipeline.ts
 *
 * Prerequisites:
 *   Set one of:
 *   - ANTHROPIC_API_KEY
 *   - OPENAI_API_KEY
 *
 *   Optional:
 *   - LLM_PROVIDER=anthropic|openai
 *   - ANTHROPIC_BASE_URL for Anthropic-compatible relays
 *   - OPENAI_BASE_URL for OpenAI-compatible relays
 */

import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent, TokenUsage, TraceEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const PRICING_AS_OF = '2026-04-24'

const PRICING = {
  // Anthropic + OpenAI API pricing, as of 2026-04-24, USD per 1M tokens
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-5.5': { input: 5, output: 30 },
  'gpt-5.4': { input: 2.5, output: 15 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
} as const

type PricedModel = keyof typeof PRICING
type UsageByModel = Partial<Record<PricedModel, TokenUsage>>
type ProviderId = 'anthropic' | 'openai'
type ProviderConfig = Pick<AgentConfig, 'provider' | 'model' | 'apiKey' | 'baseURL'>
type AgentRunSummary = Map<string, { success: boolean, tokenUsage: TokenUsage }>
type PipelineAssignments = {
  researcher: ProviderConfig
  classifier: ProviderConfig
  drafter: ProviderConfig
  reviewer: ProviderConfig
}
type ScenarioResult = {
  label: string
  assignments: PipelineAssignments
  agentResults: AgentRunSummary
  usageByModel: UsageByModel
  totalTokenUsage: TokenUsage
  costUsd: number
  elapsedMs: number
  finalBrief: string
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

const TOPIC = 'Launch a developer-focused AI code review assistant for 200-800 engineer software teams'

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const RESEARCHER_PROMPT = `You are a product researcher preparing source material for a launch brief.
Focus on:
- target buyer and user personas
- pain points in code review workflows
- market landscape and competitive differentiators
- adoption risks and rollout constraints

Write structured markdown in 220-300 words. Be concrete and specific.`

const CLASSIFIER_PROMPT = `You are a product strategist turning raw research into decision-ready structure.
Organize the upstream research into four sections:
1. Audience
2. Risks
3. Differentiators
4. Open Questions

Write 180-250 words in markdown. Keep it crisp and managerial.`

const DRAFTER_PROMPT = `You are a senior product marketer writing a launch brief.
Use the prior task outputs from shared memory and produce a polished brief with:
- executive summary
- target audience
- product positioning
- go-to-market risks
- recommended launch angle

Write 380-500 words in markdown.`

const REVIEWER_PROMPT = `You are an executive reviewer. Rewrite the brief for clarity, internal consistency,
and sharper prioritization. Keep the strongest claims, remove repetition, and make the
recommendation decisive.

Return the final brief in 350-450 words using markdown headings.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0 }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

function isPricedModel(model: string): model is PricedModel {
  return model in PRICING
}

function createUsageCollector(): {
  usageByModel: UsageByModel
  handleTrace: (event: TraceEvent) => void
} {
  const usageByModel: UsageByModel = {}

  function handleTrace(event: TraceEvent): void {
    if (event.type !== 'llm_call' || !isPricedModel(event.model)) return
    usageByModel[event.model] = addUsage(usageByModel[event.model] ?? zeroUsage(), event.tokens)
  }

  return { usageByModel, handleTrace }
}

function estimateCostUsd(usageByModel: UsageByModel): number {
  return Object.entries(usageByModel).reduce((sum, [model, usage]) => {
    if (!usage || !isPricedModel(model)) return sum
    const pricing = PRICING[model]

    return sum + (
      (usage.input_tokens / 1_000_000) * pricing.input +
      (usage.output_tokens / 1_000_000) * pricing.output
    )
  }, 0)
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function inferProvider(): ProviderId {
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'

  throw new Error('Set OPENAI_API_KEY or ANTHROPIC_API_KEY to run this example.')
}

function getSelectedProvider(): ProviderId {
  const requested = process.env.LLM_PROVIDER?.trim().toLowerCase()
  if (!requested) return inferProvider()

  if (requested === 'anthropic' || requested === 'openai') {
    return requested
  }

  throw new Error(
    `Unsupported LLM_PROVIDER="${process.env.LLM_PROVIDER}". Use one of: anthropic, openai.`,
  )
}

function getProviderConfigs(provider: ProviderId): {
  baselineLabel: string
  tieredLabel: string
  endpointLabel: string
  flagship: ProviderConfig
  mid: ProviderConfig
  cheap: ProviderConfig
} {
  switch (provider) {
    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) {
        throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.')
      }

      const baseURL = process.env.OPENAI_BASE_URL

      return {
        baselineLabel: 'All GPT-5.5 baseline',
        tieredLabel: 'Tiered GPT mix',
        endpointLabel: baseURL ?? 'OpenAI official API',
        flagship: {
          provider: 'openai',
          model: 'gpt-5.5',
          apiKey,
          baseURL,
        },
        mid: {
          provider: 'openai',
          model: 'gpt-5.4',
          apiKey,
          baseURL,
        },
        cheap: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKey,
          baseURL,
        },
      }
    }

    case 'anthropic':
    default: {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY.')
      }

      const baseURL = process.env.ANTHROPIC_BASE_URL

      return {
        baselineLabel: 'All Opus baseline',
        tieredLabel: 'Tiered Claude mix',
        endpointLabel: baseURL ?? 'Anthropic official API',
        flagship: {
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          apiKey,
          baseURL,
        },
        mid: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey,
          baseURL,
        },
        cheap: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          apiKey,
          baseURL,
        },
      }
    }
  }
}

function createProgressHandler(label: string): (event: OrchestratorEvent) => void {
  return (event: OrchestratorEvent): void => {
    if (event.type === 'task_start') {
      console.log(`  [START] ${label} :: ${event.task ?? ''} → ${event.agent ?? ''}`)
    }
    if (event.type === 'task_complete') {
      console.log(`  [DONE]  ${label} :: ${event.task ?? ''}`)
    }
  }
}

function createAgents(assignments: PipelineAssignments): AgentConfig[] {
  return [
    {
      name: 'researcher',
      ...assignments.researcher,
      systemPrompt: RESEARCHER_PROMPT,
      maxTurns: 2,
      temperature: 0.2,
    },
    {
      name: 'classifier',
      ...assignments.classifier,
      systemPrompt: CLASSIFIER_PROMPT,
      maxTurns: 2,
      temperature: 0.2,
    },
    {
      name: 'drafter',
      ...assignments.drafter,
      systemPrompt: DRAFTER_PROMPT,
      maxTurns: 2,
      temperature: 0.3,
    },
    {
      name: 'reviewer',
      ...assignments.reviewer,
      systemPrompt: REVIEWER_PROMPT,
      maxTurns: 2,
      temperature: 0.2,
    },
  ]
}

function describeAssignments(assignments: PipelineAssignments): string {
  return [
    `researcher=${assignments.researcher.model}`,
    `classifier=${assignments.classifier.model}`,
    `drafter=${assignments.drafter.model}`,
    `reviewer=${assignments.reviewer.model}`,
  ].join(', ')
}

function printAgentTokenSummary(agentResults: AgentRunSummary): void {
  console.log('Agent Token Summary')
  console.log('-'.repeat(60))

  for (const [name, run] of agentResults) {
    const icon = run.success ? 'OK  ' : 'FAIL'
    const tokens = `in:${run.tokenUsage.input_tokens} out:${run.tokenUsage.output_tokens}`
    console.log(`  [${icon}] ${name.padEnd(12)} ${tokens}`)
  }

  console.log()
}

function printModelCostBreakdown(usageByModel: UsageByModel): void {
  console.log('Model Cost Breakdown')
  console.log('-'.repeat(60))
  console.log('| Model | Input | Output | USD cost |')
  console.log('|-------|------:|-------:|---------:|')

  for (const [model, usage] of Object.entries(usageByModel)) {
    if (!usage || !isPricedModel(model)) continue
    const costUsd =
      (usage.input_tokens / 1_000_000) * PRICING[model].input +
      (usage.output_tokens / 1_000_000) * PRICING[model].output

    console.log(
      `| ${model} | ${usage.input_tokens} | ${usage.output_tokens} | ${formatUsd(costUsd)} |`,
    )
  }

  console.log()
}

function printComparisonTable(runs: ScenarioResult[]): void {
  console.log('Comparison')
  console.log('-'.repeat(60))
  console.log('| Run | Input | Output | USD cost | Wall time |')
  console.log('|-----|------:|-------:|---------:|----------:|')

  for (const run of runs) {
    console.log(
      `| ${run.label} | ${run.totalTokenUsage.input_tokens} | ${run.totalTokenUsage.output_tokens} | ${formatUsd(run.costUsd)} | ${formatSeconds(run.elapsedMs)} |`,
    )
  }

  console.log()
}

function printFinalSummaryTable(runs: ScenarioResult[]): void {
  console.log('Final Summary')
  console.log('-'.repeat(60))
  console.log('| Run | Models | Input | Output | USD cost | Wall time |')
  console.log('|-----|--------|------:|-------:|---------:|----------:|')

  for (const run of runs) {
    console.log(
      `| ${run.label} | ${describeAssignments(run.assignments)} | ${run.totalTokenUsage.input_tokens} | ${run.totalTokenUsage.output_tokens} | ${formatUsd(run.costUsd)} | ${formatSeconds(run.elapsedMs)} |`,
    )
  }

  console.log()
}

function printScenarioDetails(run: ScenarioResult): void {
  console.log('='.repeat(60))
  console.log(run.label.toUpperCase())
  console.log('='.repeat(60))
  console.log(`Models: ${describeAssignments(run.assignments)}`)
  console.log(
    `Tokens — input: ${run.totalTokenUsage.input_tokens}, output: ${run.totalTokenUsage.output_tokens}`,
  )
  console.log(`Estimated USD cost — ${formatUsd(run.costUsd)}`)
  console.log(`Wall time — ${formatSeconds(run.elapsedMs)}`)
  console.log()

  printAgentTokenSummary(run.agentResults)
  printModelCostBreakdown(run.usageByModel)

  console.log('Final Brief')
  console.log('-'.repeat(60))
  console.log(run.finalBrief)
  console.log()
}

async function runScenario(
  label: string,
  assignments: PipelineAssignments,
  tasks: Array<{
    title: string
    description: string
    assignee: string
    dependsOn?: string[]
  }>,
): Promise<ScenarioResult> {
  const agents = createAgents(assignments)
  const usageCollector = createUsageCollector()
  const orchestrator = new OpenMultiAgent({
    defaultProvider: assignments.reviewer.provider,
    defaultModel: assignments.reviewer.model,
    defaultBaseURL: assignments.reviewer.baseURL,
    defaultApiKey: assignments.reviewer.apiKey,
    onProgress: createProgressHandler(label),
    onTrace: usageCollector.handleTrace,
  })

  const team = orchestrator.createTeam(`cost-tiered-pipeline-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`, {
    name: `cost-tiered-pipeline-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
    agents,
    sharedMemory: true,
  })

  console.log(`Run: ${label}`)
  console.log(`Models: ${describeAssignments(assignments)}`)
  console.log()

  const startedAt = performance.now()
  const result = await orchestrator.runTasks(team, tasks)
  const elapsedMs = performance.now() - startedAt

  if (!result.success) {
    console.error(`${label} failed.`)
    for (const [name, run] of result.agentResults) {
      if (!run.success) {
        console.error(`  ${name}: ${run.output}`)
      }
    }
    process.exit(1)
  }

  const finalResult = result.agentResults.get('reviewer')
  if (!finalResult?.success) {
    console.error(`${label} did not produce a final reviewer output.`)
    process.exit(1)
  }

  return {
    label,
    assignments,
    agentResults: result.agentResults,
    usageByModel: usageCollector.usageByModel,
    totalTokenUsage: result.totalTokenUsage,
    costUsd: estimateCostUsd(usageCollector.usageByModel),
    elapsedMs,
    finalBrief: finalResult.output,
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

const selectedProvider = getSelectedProvider()
const providerConfigs = getProviderConfigs(selectedProvider)

// ---------------------------------------------------------------------------
// Tasks — fixed four-stage pipeline
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Research launch context',
    description: `Research ${TOPIC}. Focus on buyer pain points, review bottlenecks, team adoption concerns, competitor positioning, and measurable product value.`,
    assignee: 'researcher',
  },
  {
    title: 'Classify findings',
    description: `Read the research from shared memory and classify it into audience, risks, differentiators, and open questions. Preserve concrete details and avoid generic filler.`,
    assignee: 'classifier',
    dependsOn: ['Research launch context'],
  },
  {
    title: 'Draft launch brief',
    description: `Using the structured findings, draft a substantial launch brief for leadership review. The brief should be decision-ready and exceed 300 words.`,
    assignee: 'drafter',
    dependsOn: ['Classify findings'],
  },
  {
    title: 'Review final brief',
    description: `Review the drafted brief, tighten the positioning, and return the final version leadership should read.`,
    assignee: 'reviewer',
    dependsOn: ['Draft launch brief'],
  },
]

// ---------------------------------------------------------------------------
// Scenario assignments
// ---------------------------------------------------------------------------

const baselineAssignments: PipelineAssignments = {
  researcher: providerConfigs.flagship,
  classifier: providerConfigs.flagship,
  drafter: providerConfigs.flagship,
  reviewer: providerConfigs.flagship,
}

const tieredAssignments: PipelineAssignments = {
  researcher: providerConfigs.cheap,
  classifier: providerConfigs.cheap,
  drafter: providerConfigs.mid,
  reviewer: providerConfigs.flagship,
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Cost-Tiered Pipeline')
console.log('='.repeat(60))
console.log(`Provider: ${selectedProvider}`)
console.log(`Endpoint: ${providerConfigs.endpointLabel}`)
console.log(`Pricing as of: ${PRICING_AS_OF}`)
console.log(`Topic: ${TOPIC}`)
console.log('Pipeline: researcher -> classifier -> drafter -> reviewer')
console.log()

const baselineRun = await runScenario(providerConfigs.baselineLabel, baselineAssignments, tasks)
console.log('-'.repeat(60))
const tieredRun = await runScenario(providerConfigs.tieredLabel, tieredAssignments, tasks)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
printComparisonTable([baselineRun, tieredRun])

const savings = 1 - (tieredRun.costUsd / baselineRun.costUsd)
console.log(`Tiered savings vs baseline — ${formatPercent(savings)}`)
console.log()

printScenarioDetails(baselineRun)
printScenarioDetails(tieredRun)

console.log('='.repeat(60))
printFinalSummaryTable([baselineRun, tieredRun])

if (savings < 0.4) {
  console.error(`ASSERTION FAILED: tiered savings ${Math.round(savings * 100)}% < 40%`)
  process.exit(1)
}

console.log(`Savings assertion — OK (${formatPercent(savings)} >= 40.0%)`)
console.log('\nDone.')
