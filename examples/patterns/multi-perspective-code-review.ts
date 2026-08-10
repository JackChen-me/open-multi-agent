/**
 * Multi-Perspective Code Review
 *
 * Demonstrates:
 * - Dependency chain: generator produces code, three reviewers depend on it
 * - Parallel execution: security, performance, and style reviewers run concurrently
 * - Structured output: synthesizer returns a Zod-validated list of findings
 * - Shared memory: each agent's output is automatically stored and injected
 *   into downstream agents' prompts by the framework
 *
 * Flow:
 *   generator → [security-reviewer, performance-reviewer, style-reviewer] (parallel) → synthesizer
 *
 * Run:
 *   npx tsx examples/patterns/multi-perspective-code-review.ts
 *
 * Prerequisites:
 *   If LLM_PROVIDER is unset, this example auto-selects the first available key
 *   in this fixed order: Gemini → Groq → OpenRouter → Anthropic.
 *   This precedence is this example's implementation choice for satisfying
 *   "default to whichever key is present".
 *   Override with LLM_PROVIDER=gemini|groq|openrouter|anthropic.
 *
 *   Supported env vars:
 *   - Gemini: GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_AI_STUDIO_API_KEY
 *   - Groq: GROQ_API_KEY
 *   - OpenRouter: OPENROUTER_API_KEY
 *   - Anthropic: ANTHROPIC_API_KEY
 *
 *   Anthropic support is kept for backward compatibility with the original
 *   example. It is not part of the free-provider path.
 */

import { z } from 'zod'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// API spec to implement
// ---------------------------------------------------------------------------

const API_SPEC = `POST /users endpoint that:
- Accepts JSON body with name (string, required), email (string, required), age (number, optional)
- Validates all fields
- Inserts into a PostgreSQL database
- Returns 201 with the created user or 400/500 on error`

// ---------------------------------------------------------------------------
// Structured output schema
// ---------------------------------------------------------------------------

const ReviewFinding = z.object({
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.enum(['security', 'performance', 'style']),
  issue: z.string().describe('A concise description of the code review finding'),
  fix_hint: z.string().describe('A short, actionable suggestion for fixing the issue'),
})

const ReviewFindings = z.array(ReviewFinding)

type ProviderId = 'anthropic' | 'gemini' | 'groq' | 'openrouter'
type ProviderConfig = Pick<AgentConfig, 'provider' | 'model' | 'apiKey' | 'baseURL'>

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

function getGeminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_AI_STUDIO_API_KEY
  )
}

function inferProvider(): ProviderId {
  if (getGeminiApiKey()) return 'gemini'
  if (process.env.GROQ_API_KEY) return 'groq'
  if (process.env.OPENROUTER_API_KEY) return 'openrouter'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'

  throw new Error(
    'No supported API key found. Set GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_AI_STUDIO_API_KEY, ' +
      'GROQ_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY.',
  )
}

function getSelectedProvider(): ProviderId {
  const requested = process.env.LLM_PROVIDER?.trim().toLowerCase()
  if (!requested) return inferProvider()

  if (
    requested === 'anthropic' ||
    requested === 'gemini' ||
    requested === 'groq' ||
    requested === 'openrouter'
  ) {
    return requested
  }

  throw new Error(
    `Unsupported LLM_PROVIDER="${process.env.LLM_PROVIDER}". ` +
      'Use one of: gemini, groq, openrouter, anthropic.',
  )
}

function getProviderConfigs(provider: ProviderId): {
  defaultModel: string
  defaultProvider: 'anthropic' | 'gemini' | 'openai'
  fast: ProviderConfig
  strong: ProviderConfig
} {
  switch (provider) {
    case 'gemini': {
      const apiKey = getGeminiApiKey()
      if (!apiKey) {
        throw new Error(
          'LLM_PROVIDER=gemini requires GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_AI_STUDIO_API_KEY.',
        )
      }

      return {
        defaultModel: 'gemini-2.5-flash',
        defaultProvider: 'gemini',
        fast: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          apiKey,
        },
        strong: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          apiKey,
        },
      }
    }

    case 'groq': {
      const apiKey = process.env.GROQ_API_KEY
      if (!apiKey) {
        throw new Error('LLM_PROVIDER=groq requires GROQ_API_KEY.')
      }

      return {
        defaultModel: 'llama-3.3-70b-versatile',
        defaultProvider: 'openai',
        fast: {
          provider: 'openai',
          model: 'llama-3.3-70b-versatile',
          apiKey,
          baseURL: 'https://api.groq.com/openai/v1',
        },
        strong: {
          provider: 'openai',
          model: 'llama-3.3-70b-versatile',
          apiKey,
          baseURL: 'https://api.groq.com/openai/v1',
        },
      }
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey) {
        throw new Error('LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY.')
      }

      return {
        defaultModel: 'google/gemini-2.5-flash',
        defaultProvider: 'openai',
        fast: {
          provider: 'openai',
          model: 'google/gemini-2.5-flash',
          apiKey,
          baseURL: 'https://openrouter.ai/api/v1',
        },
        strong: {
          provider: 'openai',
          model: 'google/gemini-2.5-flash',
          apiKey,
          baseURL: 'https://openrouter.ai/api/v1',
        },
      }
    }

    case 'anthropic':
    default:
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY.')
      }

      return {
        defaultModel: 'claude-sonnet-4-6',
        defaultProvider: 'anthropic',
        fast: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        strong: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      }
  }
}

const selectedProvider = getSelectedProvider()
const providerConfigs = getProviderConfigs(selectedProvider)

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const generator: AgentConfig = {
  name: 'generator',
  ...providerConfigs.fast,
  systemPrompt: `You are a Node.js backend developer. Given an API spec, write a complete
Express route handler. Include imports, validation, database query, and error handling.
Output only the code, no explanation. Keep it under 80 lines.`,
  maxTurns: 2,
}

const securityReviewer: AgentConfig = {
  name: 'security-reviewer',
  ...providerConfigs.fast,
  systemPrompt: `You are a security reviewer. Review the code provided in context and check
for OWASP top 10 vulnerabilities: SQL injection, XSS, broken authentication,
sensitive data exposure, etc. Write your findings as a markdown checklist.
Keep it to 150-200 words.`,
  maxTurns: 2,
}

const performanceReviewer: AgentConfig = {
  name: 'performance-reviewer',
  ...providerConfigs.fast,
  systemPrompt: `You are a performance reviewer. Review the code provided in context and check
for N+1 queries, memory leaks, blocking calls, missing connection pooling, and
inefficient patterns. Write your findings as a markdown checklist.
Keep it to 150-200 words.`,
  maxTurns: 2,
}

const styleReviewer: AgentConfig = {
  name: 'style-reviewer',
  ...providerConfigs.fast,
  systemPrompt: `You are a code style reviewer. Review the code provided in context and check
naming conventions, function structure, readability, error message clarity, and
consistency. Write your findings as a markdown checklist.
Keep it to 150-200 words.`,
  maxTurns: 2,
}

const synthesizer: AgentConfig = {
  name: 'synthesizer',
  ...providerConfigs.strong,
  systemPrompt: `You are a lead engineer synthesizing code review feedback. Review all
the feedback and original code provided in context. Produce a deduplicated list of
code review findings as JSON.

Rules:
- Output ONLY a JSON array matching the provided schema.
- Merge overlapping reviewer comments into a single finding when they describe the same issue.
- Use category "security", "performance", or "style" only.
- Use priority "critical", "high", "medium", or "low" only.
- issue should describe the problem, not the fix.
- fix_hint should be specific and actionable.
- If the code looks clean, return an empty JSON array.`,
  maxTurns: 2,
  outputSchema: ReviewFindings,
}

// ---------------------------------------------------------------------------
// Orchestrator + team
// ---------------------------------------------------------------------------

function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'task_start') {
    console.log(`  [START] ${event.task ?? '?'} → ${event.agent ?? '?'}`)
  }
  if (event.type === 'task_complete') {
    const success = (event.data as { success?: boolean })?.success ?? true
    console.log(`  [DONE]  ${event.task ?? '?'} (${success ? 'OK' : 'FAIL'})`)
  }
}

const orchestrator = new OpenMultiAgent({
  defaultModel: providerConfigs.defaultModel,
  defaultProvider: providerConfigs.defaultProvider,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('code-review-team', {
  name: 'code-review-team',
  agents: [generator, securityReviewer, performanceReviewer, styleReviewer, synthesizer],
  sharedMemory: true,
})

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const tasks = [
  {
    title: 'Generate code',
    description: `Write a Node.js Express route handler for this API spec:\n\n${API_SPEC}`,
    assignee: 'generator',
  },
  {
    title: 'Security review',
    description: 'Review the generated code for security vulnerabilities.',
    assignee: 'security-reviewer',
    dependsOn: ['Generate code'],
  },
  {
    title: 'Performance review',
    description: 'Review the generated code for performance issues.',
    assignee: 'performance-reviewer',
    dependsOn: ['Generate code'],
  },
  {
    title: 'Style review',
    description: 'Review the generated code for style and readability.',
    assignee: 'style-reviewer',
    dependsOn: ['Generate code'],
  },
  {
    title: 'Synthesize feedback',
    description: 'Synthesize all review feedback and the original code into a unified, prioritized structured findings array.',
    assignee: 'synthesizer',
    dependsOn: ['Security review', 'Performance review', 'Style review'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Multi-Perspective Code Review')
console.log('='.repeat(60))
console.log(`Provider: ${selectedProvider}`)
console.log(`Spec: ${API_SPEC.split('\n')[0]}`)
console.log('Pipeline: generator → 3 reviewers (parallel) → synthesizer')
console.log('='.repeat(60))
console.log()

const result = await orchestrator.runTasks(team, tasks)

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
  console.log(`  [${icon}] ${name.padEnd(22)} ${tokens}`)
}

const synthResult = result.agentResults.get('synthesizer')
if (synthResult?.structured) {
  console.log('\n' + '='.repeat(60))
  console.log('STRUCTURED REVIEW FINDINGS')
  console.log('='.repeat(60))
  console.log()
  console.log(JSON.stringify(synthResult.structured, null, 2))
} else if (synthResult) {
  console.log('\n' + '='.repeat(60))
  console.log('SYNTHESIZER OUTPUT FAILED SCHEMA VALIDATION OR DID NOT PRODUCE VALID JSON')
  console.log('='.repeat(60))
  console.log()
  console.log(synthResult.output.slice(0, 1200))
}

console.log('\nDone.')
