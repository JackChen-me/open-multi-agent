/**
 * Translation + Backtranslation Quality Check (Cross-Model)
 *
 * Demonstrates:
 * - Agent A: translate EN -> target language with Claude
 * - Agent B: back-translate -> EN with a different provider family
 * - Agent C: compare original vs. backtranslation and flag semantic drift
 * - Structured output with Zod schemas
 *
 * Run:
 *   npx tsx examples/cookbook/translation-backtranslation.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY must be set
 *   and at least one of OPENAI_API_KEY / GEMINI_API_KEY must be set
 */

import { z } from 'zod'
import {
  Agent,
  AgentPool,
  ToolRegistry,
  ToolExecutor,
  registerBuiltInTools,
} from '../../packages/core/src/index.js'
import type { AgentConfig } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Inline sample text (3-5 technical paragraphs, per issue requirement)
// ---------------------------------------------------------------------------

const SAMPLE_TEXT = `
Modern CI/CD pipelines rely on deterministic builds and reproducible environments.
A deployment may fail even when the application code is correct if the runtime,
dependency graph, or container image differs from what engineers tested locally.

Observability should combine logs, metrics, and traces rather than treating them
as separate debugging tools. Metrics show that something is wrong, logs provide
local detail, and traces explain how a request moved across services.

Schema validation is especially important in LLM systems. A response may sound
reasonable to a human reader but still break automation if the JSON structure,
field names, or enum values do not match the downstream contract.

Cross-model verification can reduce self-confirmation bias. When one model
produces a translation and a different provider family performs the
backtranslation, semantic drift becomes easier to detect.
`.trim()

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ParagraphInput = z.object({
  index: z.number().int().positive(),
  original: z.string(),
})
type ParagraphInput = z.infer<typeof ParagraphInput>

const TranslationBatch = z.object({
  target_language: z.string(),
  items: z.array(
    z.object({
      index: z.number().int().positive(),
      translation: z.string(),
    }),
  ),
})
type TranslationBatch = z.infer<typeof TranslationBatch>

const BacktranslationBatch = z.object({
  items: z.array(
    z.object({
      index: z.number().int().positive(),
      backtranslation: z.string(),
    }),
  ),
})
type BacktranslationBatch = z.infer<typeof BacktranslationBatch>

const DriftRow = z.object({
  original: z.string(),
  translation: z.string(),
  backtranslation: z.string(),
  drift_severity: z.enum(['none', 'minor', 'major']),
  notes: z.string(),
})
type DriftRow = z.infer<typeof DriftRow>

const DriftTable = z.array(DriftRow)
type DriftTable = z.infer<typeof DriftTable>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

function splitParagraphs(text: string): ParagraphInput[] {
  return text
    .split(/\n\s*\n/)
    .map((p, i) => ({
      index: i + 1,
      original: p.trim(),
    }))
    .filter((p) => p.original.length > 0)
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY)
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)
const hasGemini = Boolean(process.env.GEMINI_API_KEY)

if (!hasAnthropic || (!hasGemini && !hasOpenAI)) {
  console.log(
    '[skip] This example needs ANTHROPIC_API_KEY plus GEMINI_API_KEY or OPENAI_API_KEY.',
  )
  process.exit(0)
}

// Prefer native Gemini when GEMINI_API_KEY is available.
// Fall back to OpenAI otherwise.
const backProvider: 'gemini' | 'openai' = hasGemini ? 'gemini' : 'openai'

const backModel =
  backProvider === 'gemini'
    ? 'gemini-2.5-pro'
    : (process.env.OPENAI_MODEL || 'gpt-5.4')
    
// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

// Agent A ---------------------------------------------------------------
// 用 Claude 做 “英文 -> 目标语言” 翻译
const translatorConfig: AgentConfig = {
  name: 'translator',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are Agent A, a technical translator.

Translate English paragraphs into Simplified Chinese.
Preserve meaning, terminology, paragraph boundaries, and index numbers.
Do not merge paragraphs.
Return JSON only, matching the schema exactly.`,
  maxTurns: 1,
  temperature: 0,
  outputSchema: TranslationBatch,
}

// Agent B ---------------------------------------------------------------
// 用不同 provider 家族做 “目标语言 -> 英文” 回译
const backtranslatorConfig: AgentConfig = {
  name: 'backtranslator',
  provider: backProvider,
  model: backModel,
  baseURL: backProvider === 'openai' ? process.env.OPENAI_BASE_URL : undefined,
  systemPrompt: `You are Agent B, a back-translation specialist.

Back-translate the provided Simplified Chinese paragraphs into English.
Preserve meaning as literally as possible.
Do not merge paragraphs.
Keep the same index numbers.
Return JSON only, matching the schema exactly.`,
  maxTurns: 1,
  temperature: 0,
  outputSchema: BacktranslationBatch,
}
// Agent C ---------------------------------------------------------------
// 比较原文和回译文，判断语义漂移
const reviewerConfig: AgentConfig = {
  name: 'reviewer',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are Agent C, a semantic drift reviewer.

You will receive:
- the original English paragraph
- the translated paragraph
- the backtranslated English paragraph

For each paragraph, judge drift_severity using only:
- none: meaning preserved
- minor: slight wording drift, but no important meaning change
- major: material semantic change, omission, contradiction, or mistranslation

Return JSON only.
The final output must be an array where each item contains:
original, translation, backtranslation, drift_severity, notes.`,
  maxTurns: 1,
  temperature: 0,
  outputSchema: DriftTable,
}

// ---------------------------------------------------------------------------
// Build agents
// ---------------------------------------------------------------------------

const translator = buildAgent(translatorConfig)
const backtranslator = buildAgent(backtranslatorConfig)
const reviewer = buildAgent(reviewerConfig)

const pool = new AgentPool(1)
pool.add(translator)
pool.add(backtranslator)
pool.add(reviewer)

// ---------------------------------------------------------------------------
// Run pipeline
// ---------------------------------------------------------------------------

const paragraphs = splitParagraphs(SAMPLE_TEXT)

console.log('Translation + Backtranslation Quality Check')
console.log('='.repeat(60))
console.log(`Paragraphs: ${paragraphs.length}`)
console.log(`Translator provider: anthropic (claude-sonnet-4-6)`)
console.log(`Backtranslator provider: ${backProvider} (${backModel})`)
console.log()

// Step 1: Agent A translates
console.log('[1/3] Agent A translating EN -> zh-CN...\n')

const translationPrompt = `Target language: Simplified Chinese

Translate the following paragraphs.
Return exactly one translated item per paragraph.

Input:
${JSON.stringify(paragraphs, null, 2)}`
const translationResult = await pool.run('translator', translationPrompt)

if (!translationResult.success || !translationResult.structured) {
  console.error('Agent A failed:', translationResult.output)
  process.exit(1)
}

const translated = translationResult.structured as TranslationBatch

// Step 2: Agent B back-translates
console.log('[2/3] Agent B back-translating zh-CN -> EN...\n')

const backtranslationPrompt = `Back-translate the following paragraphs into English.
Keep the same indexes.

Input:
${JSON.stringify(translated.items, null, 2)}`
const backtranslationResult = await pool.run('backtranslator', backtranslationPrompt)

if (!backtranslationResult.success || !backtranslationResult.structured) {
  console.error('Agent B failed:', backtranslationResult.output)
  process.exit(1)
}

const backtranslated = backtranslationResult.structured as BacktranslationBatch

// Step 3: Agent C reviews semantic drift
console.log('[3/3] Agent C reviewing semantic drift...\n')

const mergedInput = paragraphs.map((p) => ({
  index: p.index,
  original: p.original,
  translation: translated.items.find((x) => x.index === p.index)?.translation ?? '',
  backtranslation:
    backtranslated.items.find((x) => x.index === p.index)?.backtranslation ?? '',
}))

const reviewPrompt = `Compare the original English against the backtranslated English.

Important:
- Evaluate semantic drift paragraph by paragraph
- Do not judge style differences as major unless meaning changed
- Return only the final JSON array

Input:
${JSON.stringify(mergedInput, null, 2)}`
const reviewResult = await pool.run('reviewer', reviewPrompt)

if (!reviewResult.success || !reviewResult.structured) {
  console.error('Agent C failed:', reviewResult.output)
  process.exit(1)
}

const driftTable = reviewResult.structured as DriftTable

// ---------------------------------------------------------------------------
// Final output
// ---------------------------------------------------------------------------

console.log('='.repeat(60))
console.log('FINAL DRIFT TABLE')
console.log('='.repeat(60))
console.log(JSON.stringify(driftTable, null, 2))
console.log()

console.log('Token Usage Summary')
console.log('-'.repeat(60))
console.log(
  `Agent A (translator)    — input: ${translationResult.tokenUsage.input_tokens}, output: ${translationResult.tokenUsage.output_tokens}`,
)
console.log(
  `Agent B (backtranslator) — input: ${backtranslationResult.tokenUsage.input_tokens}, output: ${backtranslationResult.tokenUsage.output_tokens}`,
)
console.log(
  `Agent C (reviewer)      — input: ${reviewResult.tokenUsage.input_tokens}, output: ${reviewResult.tokenUsage.output_tokens}`,
)

const totalInput =
  translationResult.tokenUsage.input_tokens +
  backtranslationResult.tokenUsage.input_tokens +
  reviewResult.tokenUsage.input_tokens

const totalOutput =
  translationResult.tokenUsage.output_tokens +
  backtranslationResult.tokenUsage.output_tokens +
  reviewResult.tokenUsage.output_tokens

console.log('-'.repeat(60))
console.log(`TOTAL                   — input: ${totalInput}, output: ${totalOutput}`)
console.log('\nDone.')