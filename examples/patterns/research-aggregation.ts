/**
 * Multi-Source Research Aggregation
 *
 * Demonstrates runTasks() with explicit dependency chains:
 * - Parallel execution: three analyst agents research the same topic independently
 * - Dependency chain via dependsOn: synthesizer waits for all analysts to finish
 * - Automatic shared memory: agent output flows to downstream agents via the framework
 *
 * Compare with example 07 (fan-out-aggregate) which uses AgentPool.runParallel()
 * for the same 3-analysts + synthesizer pattern. This example shows the runTasks()
 * API with explicit dependsOn declarations instead.
 *
 * Flow:
 *   [technical-analyst, market-analyst, community-analyst] (parallel) → synthesizer
 *
 * Run:
 *   npx tsx examples/patterns/research-aggregation.ts "<topic>"
 *
 * Provider selection (env):
 *   - LLM_PROVIDER=anthropic   (default)  → requires ANTHROPIC_API_KEY
 *   - LLM_PROVIDER=gemini                 → requires GEMINI_API_KEY (+ optional peer dep @google/genai)
 *   - LLM_PROVIDER=groq                   → requires GROQ_API_KEY
 *   - LLM_PROVIDER=openrouter             → requires OPENROUTER_API_KEY
 *
 * Optional:
 *   - LLM_MODEL=... overrides the default model for the selected provider.
 */

import { z } from 'zod'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Topic + provider selection
// ---------------------------------------------------------------------------

const TOPIC = process.argv[2] ?? 'WebAssembly adoption in 2026'

type ProviderChoice = 'anthropic' | 'gemini' | 'groq' | 'openrouter'

function resolveProvider(): {
  label: ProviderChoice
  model: string
  provider: NonNullable<AgentConfig['provider']>
  baseURL?: string
  apiKey?: string
} {
  const raw = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() as ProviderChoice
  const modelOverride = process.env.LLM_MODEL

  switch (raw) {
    case 'gemini':
      return { label: 'gemini', provider: 'gemini', model: modelOverride ?? 'gemini-2.5-flash' }
    case 'groq':
      return {
        label: 'groq',
        provider: 'openai',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        model: modelOverride ?? 'llama-3.3-70b-versatile',
      }
    case 'openrouter':
      return {
        label: 'openrouter',
        provider: 'openai',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        model: modelOverride ?? 'openai/gpt-4o-mini',
      }
    case 'anthropic':
    default:
      return { label: 'anthropic', provider: 'anthropic', model: modelOverride ?? 'claude-sonnet-4-6' }
  }
}

const PROVIDER = resolveProvider()
if (PROVIDER.label === 'groq' && !PROVIDER.apiKey) {
  throw new Error('LLM_PROVIDER=groq requires GROQ_API_KEY')
}
if (PROVIDER.label === 'openrouter' && !PROVIDER.apiKey) {
  throw new Error('LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY')
}

// ---------------------------------------------------------------------------
// Output schema (synthesizer)
// ---------------------------------------------------------------------------

const FindingSchema = z.object({
  title: z.string().describe('One-sentence finding'),
  detail: z.string().describe('2-4 sentence explanation'),
  analysts: z.array(z.enum(['technical-analyst', 'market-analyst', 'community-analyst']))
    .min(1)
    .describe('Analyst agent names that support this finding'),
  confidence: z.number().min(0).max(1).describe('0..1 confidence score'),
})

const ContradictionSchema = z.object({
  claim_a: z.string().describe('Claim from analyst A (quote or tight paraphrase)'),
  claim_b: z.string().describe('Contradicting claim from analyst B (quote or tight paraphrase)'),
  analysts: z.tuple([
    z.enum(['technical-analyst', 'market-analyst', 'community-analyst']),
    z.enum(['technical-analyst', 'market-analyst', 'community-analyst']),
  ])
    .describe('Exactly two analyst agent names (must be different)'),
}).refine((x) => x.analysts[0] !== x.analysts[1], {
  message: 'contradictions.analysts must reference two different analysts',
  path: ['analysts'],
})

const ResearchAggregationSchema = z.object({
  summary: z.string().describe('High-level executive summary'),
  findings: z.array(FindingSchema).describe('Key findings extracted from the analyst reports'),
  contradictions: z.array(ContradictionSchema).describe('Explicit contradictions (may be empty)'),
})

// ---------------------------------------------------------------------------
// Agents — three analysts + one synthesizer
// ---------------------------------------------------------------------------

const technicalAnalyst: AgentConfig = {
  name: 'technical-analyst',
  model: PROVIDER.model,
  systemPrompt: `You are a technical analyst.

Task: Given a topic, produce a compact report that is easy to cross-reference.
Output markdown with EXACT sections:

## Claims (max 6 bullets)
Each bullet is one falsifiable technical claim.

## Evidence (max 4 bullets)
Concrete examples, benchmarks, or implementation details.

Constraints: <= 160 words total. No filler.`,
  maxTurns: 1,
}

const marketAnalyst: AgentConfig = {
  name: 'market-analyst',
  model: PROVIDER.model,
  systemPrompt: `You are a market analyst.

Output markdown with EXACT sections:

## Claims (max 6 bullets)
Adoption, players, market dynamics.

## Evidence (max 4 bullets)
Metrics, segments, named companies, or directional estimates.

Constraints: <= 160 words total. No filler.`,
  maxTurns: 1,
}

const communityAnalyst: AgentConfig = {
  name: 'community-analyst',
  model: PROVIDER.model,
  systemPrompt: `You are a developer community analyst.

Output markdown with EXACT sections:

## Claims (max 6 bullets)
Sentiment, ecosystem maturity, learning curve, community signals.

## Evidence (max 4 bullets)
Tooling, docs, conferences, repos, surveys.

Constraints: <= 160 words total. No filler.`,
  maxTurns: 1,
}

const synthesizer: AgentConfig = {
  name: 'synthesizer',
  model: PROVIDER.model,
  outputSchema: ResearchAggregationSchema,
  systemPrompt: `You are a research director. You will receive three analyst reports.

Your job: produce ONLY a JSON object matching the required schema.

Rules:
1. Extract 3-6 findings. Each finding MUST list the analyst names that support it.
2. Extract contradictions as explicit pairs of claims. Each contradiction MUST:
   - include claim_a and claim_b copied VERBATIM from the analysts' "## Claims" bullets
   - include analysts as a 2-item array with the two analyst names
3. contradictions MUST be an array (may be empty).
4. No markdown, no code fences, no extra text. JSON only.`,
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'task_start') {
    console.log(`  [START] ${event.task ?? ''} → ${event.agent ?? ''}`)
  }
  if (event.type === 'task_complete') {
    console.log(`  [DONE]  ${event.task ?? ''}`)
  }
}

const orchestrator = new OpenMultiAgent({
  defaultModel: PROVIDER.model,
  defaultProvider: PROVIDER.provider,
  ...(PROVIDER.baseURL ? { defaultBaseURL: PROVIDER.baseURL } : {}),
  ...(PROVIDER.apiKey ? { defaultApiKey: PROVIDER.apiKey } : {}),
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents: [technicalAnalyst, marketAnalyst, communityAnalyst, synthesizer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Tasks — three analysts run in parallel, synthesizer depends on all three
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Technical analysis',
    description: `Research the technical aspects of ${TOPIC}. Focus on capabilities, limitations, performance, and architecture.`,
    assignee: 'technical-analyst',
  },
  {
    title: 'Market analysis',
    description: `Research the market landscape for ${TOPIC}. Focus on adoption rates, key players, market size, and competition.`,
    assignee: 'market-analyst',
  },
  {
    title: 'Community analysis',
    description: `Research the developer community around ${TOPIC}. Focus on sentiment, ecosystem maturity, learning resources, and community activity.`,
    assignee: 'community-analyst',
  },
  {
    title: 'Synthesize report',
    description: `Cross-reference all analyst findings, identify key insights, flag contradictions, and produce a unified research report.`,
    assignee: 'synthesizer',
    dependsOn: ['Technical analysis', 'Market analysis', 'Community analysis'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Multi-Source Research Aggregation')
console.log('='.repeat(60))
console.log(`Topic: ${TOPIC}`)
console.log(`Provider: ${PROVIDER.label} (model=${PROVIDER.model})`)
console.log('Pipeline: 3 analysts (parallel) → synthesizer')
console.log('='.repeat(60))
console.log()

const result = await orchestrator.runTasks(team, tasks)

// ---------------------------------------------------------------------------
// Parallelism assertion (analysts should benefit from concurrency)
// ---------------------------------------------------------------------------

const analystTitles = new Set(['Technical analysis', 'Market analysis', 'Community analysis'])
const analystTasks = (result.tasks ?? []).filter((t) => analystTitles.has(t.title))

if (
  analystTasks.length === 3
  && analystTasks.every((t) => t.metrics?.startMs !== undefined && t.metrics?.endMs !== undefined)
) {
  const durations = analystTasks.map((t) => Math.max(0, (t.metrics!.endMs - t.metrics!.startMs)))
  const serialSum = durations.reduce((a, b) => a + b, 0)
  const minStart = Math.min(...analystTasks.map((t) => t.metrics!.startMs))
  const maxEnd = Math.max(...analystTasks.map((t) => t.metrics!.endMs))
  const parallelWall = Math.max(0, maxEnd - minStart)

  // Require parallel wall time < 70% of the serial sum.
  if (serialSum > 0 && parallelWall >= 0.7 * serialSum) {
    throw new Error(
      `Parallelism assertion failed: parallelWall=${parallelWall}ms, serialSum=${serialSum}ms (need < 0.7x). ` +
      `Tighten analyst prompts or increase concurrency.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log(`Overall success: ${result.success}`)
console.log(`Tokens — input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)
console.log()

for (const [name, r] of result.agentResults) {
  const icon = r.success ? 'OK  ' : 'FAIL'
  const tokens = `in:${r.tokenUsage.input_tokens} out:${r.tokenUsage.output_tokens}`
  console.log(`  [${icon}] ${name.padEnd(20)} ${tokens}`)
}

const synthResult = result.agentResults.get('synthesizer')
if (synthResult?.success) {
  console.log('\n' + '='.repeat(60))
  console.log('SYNTHESIZED OUTPUT (JSON)')
  console.log('='.repeat(60))
  console.log()

  if (synthResult.structured) {
    console.log(JSON.stringify(synthResult.structured, null, 2))
  } else {
    // Should not happen when outputSchema succeeds, but keep a fallback.
    console.log(synthResult.output)
  }
}

console.log('\nDone.')
