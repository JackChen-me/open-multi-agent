/**
 * Adaptive Customer Support
 *
 * Demonstrates when `runTeam()` is the right customer-support primitive: the
 * specialists needed for an escalated ticket vary with the ticket. The
 * coordinator chooses a task DAG at runtime, while the fixed high-volume path
 * remains the Express `runTasks()` app in integrations/express-customer-support.
 *
 * Run:
 *   npx tsx examples/cookbook/adaptive-customer-support.ts
 *   TICKET_SCENARIO=billing npx tsx examples/cookbook/adaptive-customer-support.ts
 *
 * Prerequisites:
 *   OPENAI_API_KEY env var must be set. Works with any OpenAI-compatible
 *   provider: set OPENAI_BASE_URL + OMA_MODEL for DeepSeek, Groq, Ollama, etc.
 *   Or set OMA_PROVIDER=copilot and provide GITHUB_COPILOT_TOKEN / GITHUB_TOKEN.
 */

import { z } from 'zod'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import type { AgentConfig, OrchestratorEvent } from '../../packages/core/src/types.js'

type TicketScenario = 'shipping' | 'billing'
type ExampleProvider = 'openai' | 'copilot'

const requestedProvider = process.env.OMA_PROVIDER?.trim().toLowerCase()
if (requestedProvider && requestedProvider !== 'openai' && requestedProvider !== 'copilot') {
  throw new Error('OMA_PROVIDER must be "openai" or "copilot".')
}
const provider: ExampleProvider = requestedProvider === 'copilot' ? 'copilot' : 'openai'
const model = process.env.OMA_MODEL ?? (provider === 'copilot' ? 'gpt-4o' : 'gpt-5.4-mini')
const requestedScenario = process.env.TICKET_SCENARIO?.trim().toLowerCase()

if (requestedScenario && requestedScenario !== 'shipping' && requestedScenario !== 'billing') {
  throw new Error('TICKET_SCENARIO must be "shipping" or "billing".')
}

const scenario: TicketScenario = requestedScenario === 'billing' ? 'billing' : 'shipping'

const scenarios: Record<TicketScenario, { ticket: string, evidence: string, policy: string }> = {
  shipping: {
    ticket: 'Subject: Order #12345 has not arrived\nBody: I ordered two weeks ago. Tracking has not updated for six days and I need the item for an event this weekend. Please help.',
    evidence: 'Order #12345 was paid, packed, and handed to the carrier 13 days ago. The last carrier scan was "in transit" six days ago. No replacement or refund has been issued. The customer has no prior delivery claims.',
    policy: 'A shipment with no carrier movement for five or more days may receive a replacement or refund after identity and delivery-address confirmation. Never promise a delivery date the carrier has not confirmed.',
  },
  billing: {
    ticket: 'Subject: Charged twice for one subscription\nBody: My card shows two charges for the same monthly plan. I only have one workspace. Please reverse the duplicate charge.',
    evidence: 'The account has one active workspace. Two settled charges with the same amount were recorded eleven minutes apart. No previous refund exists for either charge.',
    policy: 'A confirmed duplicate charge may be refunded to the original payment method. Quote a five-to-ten-business-day bank processing window, not an exact arrival date.',
  },
}

const TriageOutput = z.object({
  category: z.enum(['billing', 'technical', 'shipping', 'returns', 'general']),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: z.string(),
})

const SpecialistOutput = z.object({
  findings: z.array(z.string()),
  unknowns: z.array(z.string()),
  recommendedAction: z.string(),
})

const PolicyOutput = z.object({
  allowedActions: z.array(z.string()),
  prohibitedPromises: z.array(z.string()),
  requiredChecks: z.array(z.string()),
})

const ResponseOutput = z.object({
  customerReply: z.string(),
  internalNotes: z.array(z.string()),
})

const triageAgent: AgentConfig = {
  name: 'triage-specialist',
  model,
  systemPrompt: 'Classify the supplied support ticket and explain its urgency. Use only facts included in the task description. Return structured JSON.',
  outputSchema: TriageOutput,
  maxTurns: 2,
  temperature: 0.1,
}

const orderAgent: AgentConfig = {
  name: 'order-specialist',
  model,
  systemPrompt: 'Investigate shipping and order evidence. Identify supported findings, missing checks, and the next operational action. Do not handle billing-only tickets. Return structured JSON.',
  outputSchema: SpecialistOutput,
  maxTurns: 2,
  temperature: 0.1,
}

const billingAgent: AgentConfig = {
  name: 'billing-specialist',
  model,
  systemPrompt: 'Investigate payment and subscription evidence. Identify supported findings, missing checks, and the next operational action. Do not handle shipping-only tickets. Return structured JSON.',
  outputSchema: SpecialistOutput,
  maxTurns: 2,
  temperature: 0.1,
}

const policyAgent: AgentConfig = {
  name: 'policy-specialist',
  model,
  systemPrompt: 'Apply only the supplied support policy. Separate allowed actions, promises the reply must avoid, and checks required before action. Return structured JSON.',
  outputSchema: PolicyOutput,
  maxTurns: 2,
  temperature: 0.1,
}

const responseAgent: AgentConfig = {
  name: 'response-specialist',
  model,
  systemPrompt: 'Draft the final customer reply from the triage, relevant operational investigation, and policy analysis in shared context. Be empathetic, make no unsupported promises, and include concise internal handoff notes. Return structured JSON.',
  outputSchema: ResponseOutput,
  maxTurns: 2,
  temperature: 0.3,
}

function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'task_start') {
    console.log(`[START] ${event.task} -> ${event.agent}`)
  }
  if (event.type === 'task_complete') {
    console.log(`[DONE]  ${event.task}`)
  }
  if (event.type === 'error') {
    const detail = event.data instanceof Error ? event.data.message : JSON.stringify(event.data)
    console.error(`[ERROR] ${event.agent ?? 'unknown'}: ${detail}`)
  }
}

const orchestrator = new OpenMultiAgent({
  defaultProvider: provider,
  defaultModel: model,
  defaultBaseURL: process.env.OPENAI_BASE_URL,
  maxConcurrency: 3,
  onProgress: handleProgress,
})

const team = orchestrator.createTeam('adaptive-support-team', {
  name: 'adaptive-support-team',
  agents: [triageAgent, orderAgent, billingAgent, policyAgent, responseAgent],
  sharedMemory: true,
  maxConcurrency: 3,
})

const selected = scenarios[scenario]
const goal = `Resolve this escalated customer-support ticket.

## Ticket
${selected.ticket}

## Available account and operational evidence
${selected.evidence}

## Applicable policy excerpt
${selected.policy}

Decide which specialists are relevant to this ticket. Always classify the ticket, investigate only the relevant operational domain, apply the policy, and produce a customer-facing reply plus internal handoff notes. Do not assign unrelated specialist work and do not invent facts outside the supplied context.`

console.log('Adaptive Customer Support')
console.log(`Scenario: ${scenario}`)
console.log(`Provider: ${provider}`)
console.log(`Model: ${model}`)
console.log()

const result = await orchestrator.runTeam(team, goal, {
  coordinator: {
    instructions: [
      'Choose only specialists relevant to the ticket category.',
      'Always use triage-specialist, policy-specialist, and response-specialist.',
      'For shipping tickets use order-specialist and skip billing-specialist.',
      'For billing tickets use billing-specialist and skip order-specialist.',
      'The response-specialist task must depend on every selected analysis task.',
      'Copy all ticket evidence and policy text needed by a specialist into that task description.',
    ].join(' '),
  },
})

console.log()
console.log(`Success: ${result.success}`)
console.log(`Tasks: ${result.tasks?.length ?? 0}`)
console.log(`Tokens: ${result.totalTokenUsage.input_tokens} input / ${result.totalTokenUsage.output_tokens} output`)

for (const task of result.tasks ?? []) {
  console.log(`  ${task.status.padEnd(10)} ${task.title} -> ${task.assignee ?? 'unassigned'}`)
}

const response = result.agentResults.get('response-specialist')?.structured
if (response) {
  console.log('\nStructured response:')
  console.log(JSON.stringify(response, null, 2))
}

const synthesis = result.agentResults.get('coordinator')
if (synthesis?.success) {
  console.log('\nCoordinator synthesis:')
  console.log(synthesis.output)
}

if (!result.success) {
  process.exitCode = 1
}
