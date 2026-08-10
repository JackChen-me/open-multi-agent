/**
 * Structured Output
 *
 * Demonstrates `outputSchema` on AgentConfig. The agent's response is
 * automatically parsed as JSON and validated against a Zod schema.
 * On validation failure, the framework retries once with error feedback.
 *
 * The validated result is available via `result.structured`.
 *
 * Run:
 *   npx tsx examples/patterns/structured-output.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 */

import { z } from 'zod'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Define a Zod schema for the expected output
// ---------------------------------------------------------------------------

const ReviewAnalysis = z.object({
  summary: z.string().describe('One-sentence summary of the review'),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1).describe('How confident the analysis is'),
  keyTopics: z.array(z.string()).describe('Main topics mentioned in the review'),
})

type ReviewAnalysis = z.infer<typeof ReviewAnalysis>

// ---------------------------------------------------------------------------
// Agent with outputSchema
// ---------------------------------------------------------------------------

const analyst: AgentConfig = {
  name: 'analyst',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a product review analyst. Analyze the given review and extract structured insights.',
  outputSchema: ReviewAnalysis,
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-sonnet-4-6' })

const reviews = [
  'This keyboard is amazing! The mechanical switches feel incredible and the RGB lighting is stunning. Build quality is top-notch. Only downside is the price.',
  'Terrible experience. The product arrived broken, customer support was unhelpful, and the return process took 3 weeks.',
  'It works fine. Nothing special, nothing bad. Does what it says on the box.',
]

console.log('Analyzing product reviews with structured output...\n')

for (const review of reviews) {
  const result = await orchestrator.runAgent(analyst, `Analyze this review: "${review}"`)

  if (result.structured) {
    const data = result.structured as ReviewAnalysis
    console.log(`Sentiment: ${data.sentiment} (confidence: ${data.confidence})`)
    console.log(`Summary:   ${data.summary}`)
    console.log(`Topics:    ${data.keyTopics.join(', ')}`)
  } else {
    console.log(`Validation failed. Raw output: ${result.output.slice(0, 100)}`)
  }

  console.log(`Tokens:    ${result.tokenUsage.input_tokens} in / ${result.tokenUsage.output_tokens} out`)
  console.log('---')
}
