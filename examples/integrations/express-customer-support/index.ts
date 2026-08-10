/**
 * Express Customer Support
 *
 * POST /tickets { subject, body } → runs a three-agent pipeline
 * (classifier → drafter → QA reviewer) and returns structured JSON.
 *
 * Run:
 *   npm install && npm start
 *
 * Prerequisites:
 *   API key for the chosen provider(s) — defaults to DEEPSEEK_API_KEY.
 *   CLASSIFIER_PROVIDER / DRAFTER_PROVIDER / QA_PROVIDER (optional, default 'deepseek')
 *   CLASSIFIER_MODEL    / DRAFTER_MODEL    / QA_MODEL    (optional, see defaults below)
 *   PORT (optional, default 3000)
 */

import { fileURLToPath } from 'node:url'
import express from 'express'
import { z } from 'zod'
import { OpenMultiAgent } from '@open-multi-agent/core'
import type { AgentConfig, SupportedProvider } from '@open-multi-agent/core'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ClassifierOutput = z.object({
  category: z.enum(['billing', 'technical', 'shipping', 'returns', 'general']),
  urgency:  z.enum(['low', 'medium', 'high', 'critical']),
})

const DrafterOutput = z.object({
  draft_reply: z.string().describe('Polished customer-facing reply'),
})

const QAOutput = z.object({
  qa_notes: z.string().describe('Tone and accuracy feedback for the draft'),
})

export const SupportTicketResponse = z.object({
  category:    ClassifierOutput.shape.category,
  urgency:     ClassifierOutput.shape.urgency,
  draft_reply: DrafterOutput.shape.draft_reply,
  qa_notes:    QAOutput.shape.qa_notes,
})
export type SupportTicketResponse = z.infer<typeof SupportTicketResponse>

// ---------------------------------------------------------------------------
// Provider / model configuration
// ---------------------------------------------------------------------------
// Each agent's provider and model are independently overridable via env vars,
// so free-tier users can mix providers per tier. Validate at startup to fail
// fast instead of erroring deep inside an HTTP request's LLM call.

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic:      'ANTHROPIC_API_KEY',
  openai:         'OPENAI_API_KEY',
  gemini:         'GEMINI_API_KEY',
  grok:           'XAI_API_KEY',
  copilot:        'GITHUB_TOKEN',
  deepseek:       'DEEPSEEK_API_KEY',
  minimax:        'MINIMAX_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
}

function pickAgent(envPrefix: string, defaultProvider: SupportedProvider, defaultModel: string) {
  const provider = (process.env[`${envPrefix}_PROVIDER`] ?? defaultProvider) as SupportedProvider
  const model    = process.env[`${envPrefix}_MODEL`]    ?? defaultModel
  const envKey   = PROVIDER_ENV_KEYS[provider]
  if (envKey && !process.env[envKey]?.trim()) {
    console.error(`Missing ${envKey}: required for ${envPrefix}_PROVIDER="${provider}".`)
    process.exit(1)
  }
  return { provider, model }
}

const classifierCfg = pickAgent('CLASSIFIER', 'deepseek', 'deepseek-v4-flash')
const drafterCfg    = pickAgent('DRAFTER',    'deepseek', 'deepseek-v4-pro')
const qaCfg         = pickAgent('QA',         'deepseek', 'deepseek-v4-pro')

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const classifier: AgentConfig = {
  name: 'classifier',
  provider: classifierCfg.provider,
  model:    classifierCfg.model,
  systemPrompt: 'You are a customer support classifier. Given a ticket subject and body, classify it into exactly one category (billing, technical, shipping, returns, general) and one urgency level (low, medium, high, critical). Respond ONLY with valid JSON: {"category":"<one of the above>","urgency":"<one of the above>"}.',
  outputSchema: ClassifierOutput,
  maxTurns: 3,
  temperature: 0.1,
}

const drafter: AgentConfig = {
  name: 'drafter',
  provider: drafterCfg.provider,
  model:    drafterCfg.model,
  systemPrompt: 'You are a customer support specialist. Your task prompt will contain the original support ticket and a "Context from prerequisite tasks" section with the classifier\'s JSON output (category and urgency). Use both to write a clear, empathetic customer-facing reply. Respond ONLY with valid JSON.',
  outputSchema: DrafterOutput,
  maxTurns: 4,
  temperature: 0.4,
}

const qaReviewer: AgentConfig = {
  name: 'qa-reviewer',
  provider: qaCfg.provider,
  model:    qaCfg.model,
  systemPrompt: 'You are a QA reviewer for customer support. Your task prompt will contain a "Context from prerequisite tasks" section with the classifier\'s category/urgency and the drafter\'s reply. Review the draft reply for tone, empathy, and accuracy against the original ticket. Provide concise QA notes. Respond ONLY with valid JSON.',
  outputSchema: QAOutput,
  maxTurns: 3,
  temperature: 0.2,
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }
    next(err)
  })

  const orchestrator = new OpenMultiAgent({
    onProgress: (event) => {
      const agent = 'agent' in event ? event.agent : ''
      const extra = event.type === 'error' && 'data' in event ? ` — ${JSON.stringify(event.data)}` : ''
      console.log(`[${event.type}] ${agent}${extra}`)
    },
  })

  const team = orchestrator.createTeam('support-team', {
    name: 'support-team',
    agents: [classifier, drafter, qaReviewer],
  })

  app.post('/tickets', async (req, res) => {
    const { subject, body } = req.body ?? {}
    if (typeof subject !== 'string' || typeof body !== 'string' || !subject || !body) {
      res.status(400).json({ error: 'Request body must include non-empty string fields: subject, body' })
      return
    }

    // `runTasks` resolves normally on abort (skipRemaining → success: false), so
    // race it against a sentinel to distinguish a 60s timeout from a generic
    // pipeline failure. Keep the AbortSignal wired through so in-flight LLM
    // fetches still get cancelled when the timer fires.
    const TIMEOUT_MS = 60_000
    const abortController = new AbortController()
    const timeoutSentinel = Symbol('timeout')
    const timeoutHandle = setTimeout(() => abortController.abort(), TIMEOUT_MS)
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(timeoutSentinel), { once: true })
    })

    try {
      const ticketContext = `Subject: "${subject}"\nBody: "${body}"`
      const raced = await Promise.race([
        orchestrator.runTasks(team, [
          {
            title: 'Classify ticket',
            description: `Classify the following support ticket.\n\n${ticketContext}`,
            assignee: 'classifier',
          },
          {
            title: 'Draft reply',
            description: `Write a customer-facing reply for the following support ticket.\n\n${ticketContext}`,
            assignee: 'drafter',
            dependsOn: ['Classify ticket'],
          },
          {
            title: 'QA review',
            description: `Review the draft reply for tone, empathy, and accuracy.\n\n${ticketContext}`,
            assignee: 'qa-reviewer',
            dependsOn: ['Classify ticket', 'Draft reply'],
          },
        ], { abortSignal: abortController.signal }),
        timeoutPromise,
      ])

      if (raced === timeoutSentinel) {
        res.status(504).json({ error: 'Pipeline timed out after 60 seconds' })
        return
      }

      const result = raced
      if (!result.success) {
        res.status(502).json({ error: 'Pipeline did not complete successfully' })
        return
      }

      const classifierResult = result.agentResults.get('classifier')
      const drafterResult    = result.agentResults.get('drafter')
      const qaResult         = result.agentResults.get('qa-reviewer')

      const classOut = classifierResult?.structured as z.infer<typeof ClassifierOutput> | undefined
      const draftOut = drafterResult?.structured    as z.infer<typeof DrafterOutput>    | undefined
      const qaOut    = qaResult?.structured         as z.infer<typeof QAOutput>         | undefined

      if (!classOut || !draftOut || !qaOut) {
        res.status(502).json({ error: 'One or more agents failed to produce structured output' })
        return
      }

      const response: SupportTicketResponse = {
        category:    classOut.category,
        urgency:     classOut.urgency,
        draft_reply: draftOut.draft_reply,
        qa_notes:    qaOut.qa_notes,
      }
      res.json(response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(502).json({ error: `LLM pipeline failed: ${message}` })
    } finally {
      clearTimeout(timeoutHandle)
    }
  })

  return app
}

// Only start the server when this file is executed directly (e.g. `npm start`).
// Importers like the smoke test get the factory + schema with no side effects,
// so they can bind their own ephemeral port without colliding on PORT 3000.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = parseInt(process.env.PORT ?? '3000', 10)
  createApp().listen(PORT, () => console.log(`Support API listening on http://localhost:${PORT}`))
}
