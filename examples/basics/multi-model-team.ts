/**
 * Multi-Model Team with Custom Tools
 *
 * Demonstrates:
 * - Mixing Anthropic and OpenAI models in the same team
 * - Defining custom tools with defineTool() and Zod schemas
 * - Building agents with a custom ToolRegistry so they can use custom tools
 * - Running a team goal that uses the custom tools
 *
 * Run:
 *   npx tsx examples/basics/multi-model-team.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY and OPENAI_API_KEY env vars must be set.
 *   (If you only have one key, set useOpenAI = false below.)
 */

import { z } from 'zod'
import { OpenMultiAgent, defineTool } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Custom tools — defined with defineTool() + Zod schemas
// ---------------------------------------------------------------------------

/**
 * A custom tool that fetches live exchange rates from a public API.
 */
const exchangeRateTool = defineTool({
  name: 'get_exchange_rate',
  description:
    'Get the current exchange rate between two currencies. ' +
    'Returns the rate as a decimal: 1 unit of `from` = N units of `to`.',
  inputSchema: z.object({
    from: z.string().describe('ISO 4217 currency code, e.g. "USD"'),
    to: z.string().describe('ISO 4217 currency code, e.g. "EUR"'),
  }),
  execute: async ({ from, to }) => {
    try {
      const url = `https://api.exchangerate.host/convert?from=${from}&to=${to}&amount=1`
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

      interface ExchangeRateResponse {
        result?: number
        info?: { rate?: number }
      }
      const json = (await resp.json()) as ExchangeRateResponse
      const rate: number | undefined = json?.result ?? json?.info?.rate

      if (typeof rate !== 'number') throw new Error('Unexpected API response shape')

      return {
        data: JSON.stringify({ from, to, rate, timestamp: new Date().toISOString() }),
        isError: false,
      }
    } catch (err) {
      // Graceful degradation — return a stubbed rate so the team can still proceed
      const stub = parseFloat((Math.random() * 0.5 + 0.8).toFixed(4))
      return {
        data: JSON.stringify({
          from,
          to,
          rate: stub,
          note: `Live fetch failed (${err instanceof Error ? err.message : String(err)}). Using stub rate.`,
        }),
        isError: false,
      }
    }
  },
})

/**
 * A custom tool that formats a number as a localised currency string.
 */
const formatCurrencyTool = defineTool({
  name: 'format_currency',
  description: 'Format a number as a localised currency string.',
  inputSchema: z.object({
    amount: z.number().describe('The numeric amount to format.'),
    currency: z.string().describe('ISO 4217 currency code, e.g. "USD".'),
    locale: z
      .string()
      .optional()
      .describe('BCP 47 locale string, e.g. "en-US". Defaults to "en-US".'),
  }),
  execute: async ({ amount, currency, locale = 'en-US' }) => {
    try {
      const formatted = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
      }).format(amount)
      return { data: formatted, isError: false }
    } catch {
      return { data: `${amount} ${currency}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Helper: build an AgentConfig whose tools list includes custom tool names.
//
// Agents reference tools by name in their AgentConfig.tools array.
// The ToolRegistry is injected via the Agent constructor. When using OpenMultiAgent
// convenience methods (runTeam, runTasks, runAgent), the orchestrator builds
// agents internally using buildAgent(), which registers only the five built-in
// tools. For custom tools, use AgentPool + Agent directly (see the note in the
// README) or provide the custom tool names in the tools array and rely on a
// registry you inject yourself.
//
// In this example we demonstrate the custom-tool pattern by running the agents
// directly through AgentPool rather than through the OpenMultiAgent high-level API.
// ---------------------------------------------------------------------------

import { Agent, AgentPool, ToolRegistry, ToolExecutor, registerBuiltInTools } from '../../packages/core/src/index.js'

/**
 * Build an Agent with both built-in and custom tools registered.
 */
function buildCustomAgent(
  config: AgentConfig,
  extraTools: ReturnType<typeof defineTool>[],
): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  for (const tool of extraTools) {
    registry.register(tool)
  }
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

// ---------------------------------------------------------------------------
// Agent definitions — mixed providers
// ---------------------------------------------------------------------------

const useOpenAI = Boolean(process.env.OPENAI_API_KEY)

const researcherConfig: AgentConfig = {
  name: 'researcher',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: `You are a financial data researcher.
Use the get_exchange_rate tool to fetch current rates between the currency pairs you are given.
Return the raw rates as a JSON object keyed by pair, e.g. { "USD/EUR": 0.91, "USD/GBP": 0.79 }.`,
  tools: ['get_exchange_rate'],
  maxTurns: 6,
  temperature: 0,
}

const analystConfig: AgentConfig = {
  name: 'analyst',
  model: useOpenAI ? 'gpt-5.4' : 'claude-sonnet-4-6',
  provider: useOpenAI ? 'openai' : 'anthropic',
  systemPrompt: `You are a foreign exchange analyst.
You receive exchange rate data and produce a short briefing.
Use format_currency to show example conversions.
Keep the briefing under 200 words.`,
  tools: ['format_currency'],
  maxTurns: 4,
  temperature: 0.3,
}

// ---------------------------------------------------------------------------
// Build agents with custom tools
// ---------------------------------------------------------------------------

const researcher = buildCustomAgent(researcherConfig, [exchangeRateTool])
const analyst = buildCustomAgent(analystConfig, [formatCurrencyTool])

// ---------------------------------------------------------------------------
// Run with AgentPool for concurrency control
// ---------------------------------------------------------------------------

console.log('Multi-model team with custom tools')
console.log(`Providers: researcher=anthropic, analyst=${useOpenAI ? 'openai (gpt-5.4)' : 'anthropic (fallback)'}`)
console.log('Custom tools:', [exchangeRateTool.name, formatCurrencyTool.name].join(', '))
console.log()

const pool = new AgentPool(1) // sequential for readability
pool.add(researcher)
pool.add(analyst)

// Step 1: researcher fetches the rates
console.log('[1/2] Researcher fetching FX rates...')
const researchResult = await pool.run(
  'researcher',
  `Fetch exchange rates for these pairs using the get_exchange_rate tool:
- USD to EUR
- USD to GBP
- USD to JPY
- EUR to GBP

Return the results as a JSON object: { "USD/EUR": <rate>, "USD/GBP": <rate>, ... }`,
)

if (!researchResult.success) {
  console.error('Researcher failed:', researchResult.output)
  process.exit(1)
}

console.log('Researcher done. Tool calls made:', researchResult.toolCalls.map(c => c.toolName).join(', '))

// Step 2: analyst writes the briefing, receiving the researcher output as context
console.log('\n[2/2] Analyst writing FX briefing...')
const analystResult = await pool.run(
  'analyst',
  `Here are the current FX rates gathered by the research team:

${researchResult.output}

Using format_currency, show what $1,000 USD and €1,000 EUR convert to in each of the other currencies.
Then write a short FX market briefing (under 200 words) covering:
- Each rate with a brief observation
- The strongest and weakest currency in the set
- One-sentence market comment`,
)

if (!analystResult.success) {
  console.error('Analyst failed:', analystResult.output)
  process.exit(1)
}

console.log('Analyst done. Tool calls made:', analystResult.toolCalls.map(c => c.toolName).join(', '))

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))

console.log('\nResearcher output:')
console.log(researchResult.output.slice(0, 400))

console.log('\nAnalyst briefing:')
console.log('─'.repeat(60))
console.log(analystResult.output)
console.log('─'.repeat(60))

const totalInput = researchResult.tokenUsage.input_tokens + analystResult.tokenUsage.input_tokens
const totalOutput = researchResult.tokenUsage.output_tokens + analystResult.tokenUsage.output_tokens
console.log(`\nTotal tokens — input: ${totalInput}, output: ${totalOutput}`)

// ---------------------------------------------------------------------------
// Bonus: show how defineTool() works in isolation (no LLM needed)
// ---------------------------------------------------------------------------

console.log('\n--- Bonus: testing custom tools in isolation ---\n')

const fmtResult = await formatCurrencyTool.execute(
  { amount: 1234.56, currency: 'EUR', locale: 'de-DE' },
  { agent: { name: 'test', role: 'test', model: 'test' } },
)
console.log(`format_currency(1234.56, EUR, de-DE) = ${fmtResult.data}`)

const rateResult = await exchangeRateTool.execute(
  { from: 'USD', to: 'EUR' },
  { agent: { name: 'test', role: 'test', model: 'test' } },
)
console.log(`get_exchange_rate(USD→EUR) = ${rateResult.data}`)
