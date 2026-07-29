/**
 * Rare Disease Information Triage (Source-Isolated Evidence Audit + Safety Arbitration)
 *
 * Demonstrates:
 * - Five source-isolated agents reading different MOCK fixtures
 * - Source-isolated evidence audits over patient-reported symptoms, nonprofit education,
 *   official guideline/expert-consensus style content, gene-phenotype evidence,
 *   and web/forum/commercial claims
 * - A downstream arbiter that receives only structured audit outputs
 * - Runtime conflict detection:
 *   - nonprofit content may make symptom overlap look specific
 *   - official guidance keeps the differential broad
 *   - gene-phenotype evidence is weak/uncertain for the claimed disease
 *   - web/commercial content overstates certainty and promotes a paid test
 *   - safety policy forbids diagnosis, treatment, dosing, or commercial recommendation
 * - Zod-validated structured output and simple runtime assertions
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/rare-disease-information-triage.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *   Requires Node.js >= 20.
 *
 * Fixtures:
 *   All fixtures under examples/fixtures/rare-disease-information-triage/ are MOCK.
 *   They are shaped like realistic source types but do not contain real patient data
 *   and do not provide medical diagnosis or treatment advice.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import { Agent, ToolExecutor, ToolRegistry } from '../../src/index.js'
import type { AgentConfig, AgentRunResult } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(__dirname, '../fixtures/rare-disease-information-triage')

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureRoot, name), 'utf-8')
}

const patientSymptomSummary = readFixture('patient-symptom-summary.json')
const nonprofitPatientEducation = readFixture('nonprofit-patient-education.md')
const officialGuidelineExcerpt = readFixture('official-guideline-excerpt.md')
const genePhenotypeEvidence = readFixture('gene-phenotype-evidence.json')
const webClaimsSnippets = readFixture('web-claims-snippets.json')
const medicalSafetyPolicy = readFixture('medical-safety-policy.json')
const MODEL = process.env['MODEL'] ?? 'claude-sonnet-4-6'
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY']
const ANTHROPIC_BASE_URL = process.env['ANTHROPIC_BASE_URL']

const providerConfig = {
  provider: 'anthropic' as const,
  model: MODEL,
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL,
  tools: [] as const,
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SymptomAudit = z.object({
  source_is_mock: z.boolean(),
  symptom_clusters: z.array(z.string()),
  red_flags: z.array(z.string()),
  claimed_condition_from_patient_context: z.string(),
  missing_clinical_information: z.array(z.string()),
  diagnosis_attempted: z.boolean(),
})
type SymptomAudit = z.infer<typeof SymptomAudit>

const NonprofitEducationAudit = z.object({
  source_is_mock: z.boolean(),
  educational_claims: z.array(z.string()),
  simplification_risks: z.array(z.string()),
  patient_friendly_but_incomplete_points: z.array(z.string()),
  claims_that_may_overfocus_on_one_condition: z.array(z.string()),
})
type NonprofitEducationAudit = z.infer<typeof NonprofitEducationAudit>

const GuidelineAudit = z.object({
  source_is_mock: z.boolean(),
  candidate_disease_families: z.array(z.string()),
  specialist_evaluation_required: z.boolean(),
  reasons_symptoms_are_not_specific: z.array(z.string()),
  recommended_non_diagnostic_next_steps: z.array(z.string()),
})
type GuidelineAudit = z.infer<typeof GuidelineAudit>

const GeneticsAudit = z.object({
  source_is_mock: z.boolean(),
  claimed_gene_or_marker: z.string(),
  evidence_strength_for_claimed_disease: z.enum(['strong', 'moderate', 'weak', 'uncertain']),
  phenotype_consistency: z.enum(['consistent', 'partially_consistent', 'inconsistent', 'uncertain']),
  uncertainty_flags: z.array(z.string()),
})
type GeneticsAudit = z.infer<typeof GeneticsAudit>

const WebClaimsAudit = z.object({
  source_is_mock: z.boolean(),
  claims: z.array(z.object({
    source_label: z.string(),
    claim: z.string(),
    claim_type: z.enum(['forum_experience', 'general_web_content', 'commercial_promotion']),
    overstatement_risk: z.enum(['low', 'moderate', 'high']),
    commercial_intent: z.boolean(),
    unsupported_elements: z.array(z.string()),
  })),
})
type WebClaimsAudit = z.infer<typeof WebClaimsAudit>

const SafetyAudit = z.object({
  source_is_mock: z.boolean(),
  prohibited_outputs: z.array(z.string()),
  allowed_outputs: z.array(z.string()),
  required_disclaimers: z.array(z.string()),
  patient_facing_answer_allowed_without_clinician: z.boolean(),
})
type SafetyAudit = z.infer<typeof SafetyAudit>

const TriageDecision = z.object({
  decision: z.enum(['credible_lead', 'conflicting_evidence', 'misleading_or_commercial', 'needs_specialist_review']),
  confidence: z.enum(['low', 'medium', 'high']),
  conflicts: z.array(z.string()),
  missing_evidence: z.array(z.string()),
  unsafe_elements: z.array(z.string()),
  safe_next_steps: z.array(z.string()),
  patient_facing_answer_allowed: z.boolean(),
  diagnosis_provided: z.boolean(),
  rationale: z.string(),
})
type TriageDecision = z.infer<typeof TriageDecision>

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

const symptomNormalizerConfig: AgentConfig = {
  name: 'symptom-normalizer',
  ...providerConfig,
  systemPrompt: `You are a medical information triage assistant.

You audit only a MOCK patient-reported symptom summary. You must not diagnose.
Extract symptom clusters, red flags, the patient's suspected condition from context,
and missing clinical information.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose. Do not provide diagnosis or treatment advice.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: SymptomAudit,
}

const nonprofitEducationConfig: AgentConfig = {
  name: 'nonprofit-education-auditor',
  ...providerConfig,
  systemPrompt: `You audit only MOCK nonprofit / patient-advocacy educational content.

Your job is to identify what the patient-friendly content says, what it simplifies,
and whether the simplification may make symptom overlap look more disease-specific
than it is. Do not use outside medical knowledge.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: NonprofitEducationAudit,
}

const guidelineAuditorConfig: AgentConfig = {
  name: 'guideline-auditor',
  ...providerConfig,
  systemPrompt: `You audit only a MOCK official disease guideline or expert-consensus style excerpt.

Identify the broad differential, why symptoms are not specific, whether specialist
evaluation is required, and safe non-diagnostic next steps. Do not diagnose.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: GuidelineAudit,
}

const geneticsAuditorConfig: AgentConfig = {
  name: 'genetics-auditor',
  ...providerConfig,
  systemPrompt: `You audit only MOCK gene-phenotype evidence.

Assess whether the claimed gene or marker strongly supports the claimed rare disease,
whether the phenotype is consistent, and what uncertainty flags exist. Do not diagnose
or interpret real patient genetics.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: GeneticsAudit,
}

const webClaimsAuditorConfig: AgentConfig = {
  name: 'web-claims-auditor',
  ...providerConfig,
  systemPrompt: `You audit only MOCK web, forum, and commercial claim snippets.

Classify each claim as forum experience, general web content, or commercial promotion.
Flag overstatement risk, commercial intent, and unsupported elements. Do not validate
claims using outside knowledge.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 2000,
  temperature: 0.1,
  outputSchema: WebClaimsAudit,
}

const safetyBoundaryConfig: AgentConfig = {
  name: 'safety-boundary-agent',
  ...providerConfig,
  systemPrompt: `You audit only a MOCK medical safety policy.

Extract prohibited outputs, allowed outputs, required disclaimers, and whether a
patient-facing answer is allowed without a clinician. Do not generate medical advice.

Return JSON matching the provided schema. Output ONLY valid JSON, no markdown, no code fences, and no explanatory prose.`,
  maxTurns: 1,
  maxTokens: 1800,
  temperature: 0.1,
  outputSchema: SafetyAudit,
}

const arbiterConfig: AgentConfig = {
  name: 'rare-disease-triage-arbiter',
  ...providerConfig,
  systemPrompt: `You are the downstream arbiter for a rare disease information triage workflow.

You receive only structured outputs from source-isolated audits. You cannot access
the original fixtures. Your tasks:
1. Detect conflicts among the audits.
2. Identify misleading or commercial overclaims.
3. Enforce the safety boundary.
4. Decide whether the information is a credible lead, conflicting evidence,
   misleading/commercial content, or needs specialist review.
5. Never provide diagnosis, treatment advice, dosing, or commercial recommendation.

Return JSON matching the TriageDecision schema. The seeded conflict should be explicit:
web/commercial content maps symptom similarity to one rare disease, while the guideline
keeps the differential broad and genetics evidence is weak or uncertain.`,
  maxTurns: 1,
  maxTokens: 3000,
  temperature: 0.1,
  outputSchema: TriageDecision,
}

// ---------------------------------------------------------------------------
// Build agents
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  // Source isolation is enforced at runtime: fixtures are injected into prompts,
  // and audit agents receive an empty tool registry with tools: [].
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

const symptomNormalizer = buildAgent(symptomNormalizerConfig)
const nonprofitEducationAuditor = buildAgent(nonprofitEducationConfig)
const guidelineAuditor = buildAgent(guidelineAuditorConfig)
const geneticsAuditor = buildAgent(geneticsAuditorConfig)
const webClaimsAuditor = buildAgent(webClaimsAuditorConfig)
const safetyBoundaryAgent = buildAgent(safetyBoundaryConfig)
const triageArbiter = buildAgent(arbiterConfig)

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

console.log('Rare Disease Information Triage - Source-Isolated Audit + Safety Arbitration')
console.log('='.repeat(88))
console.log(`Model backend: anthropic-compatible (${MODEL})`)
console.log('All fixtures are MOCK and contain no real patient data.')
console.log('Expected runtime conflict: simplified patient-facing content + commercial claim vs broad guideline differential + weak genetics evidence.\n')

async function runTimed(
  name: string,
  agent: Agent,
  prompt: string,
): Promise<{ name: string, result: AgentRunResult, elapsedMs: number }> {
  const start = performance.now()
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`  [RUN] ${name} started... attempt ${attempt}/${maxAttempts}`)
    const result = await agent.run(prompt)
    const elapsedMs = performance.now() - start

    if (result.success && result.structured) {
      console.log(`  [DONE] ${name} finished in ${Math.round(elapsedMs)}ms`)
      return { name, result, elapsedMs }
    }

    const outputPreview = result.output ? result.output.slice(0, 240).replace(/\s+/g, ' ') : '<empty output>'
    console.warn(`  [RETRY] ${name} failed structured output on attempt ${attempt}/${maxAttempts}: ${outputPreview}`)
  }

  const result = await agent.run(prompt)
  const elapsedMs = performance.now() - start
  console.log(`  [DONE] ${name} finished in ${Math.round(elapsedMs)}ms`)
  return { name, result, elapsedMs }
}

function requireStructured<T>(name: string, result: AgentRunResult): T {
  if (!result.success) {
    console.error(`${name} failed: ${result.output}`)
    process.exit(1)
  }

  if (!result.structured) {
    console.error(`${name} did not return structured output`)
    process.exit(1)
  }

  return result.structured as T
}

console.log('[Phase 1] Source-isolated audits\n')

const auditStart = performance.now()
const auditRuns: Array<{ name: string, result: AgentRunResult, elapsedMs: number }> = []

auditRuns.push(await runTimed(
  'symptom-normalizer',
  symptomNormalizer,
  `Audit this MOCK patient-reported symptom summary. Use only this input.\n\n${patientSymptomSummary}`,
))

auditRuns.push(await runTimed(
  'nonprofit-education-auditor',
  nonprofitEducationAuditor,
  `Audit this MOCK nonprofit / patient-advocacy educational content. Use only this input.\n\n${nonprofitPatientEducation}`,
))

auditRuns.push(await runTimed(
  'guideline-auditor',
  guidelineAuditor,
  `Audit this MOCK official guideline / expert-consensus style excerpt. Use only this input.\n\n${officialGuidelineExcerpt}`,
))

auditRuns.push(await runTimed(
  'genetics-auditor',
  geneticsAuditor,
  `Audit this MOCK gene-phenotype evidence. Use only this input.\n\n${genePhenotypeEvidence}`,
))

auditRuns.push(await runTimed(
  'web-claims-auditor',
  webClaimsAuditor,
  `Audit these MOCK web/forum/commercial claim snippets. Use only this input.\n\n${webClaimsSnippets}`,
))

auditRuns.push(await runTimed(
  'safety-boundary-agent',
  safetyBoundaryAgent,
  `Audit this MOCK medical safety policy. Use only this input.\n\n${medicalSafetyPolicy}`,
))
const auditElapsed = performance.now() - auditStart

const auditMap = new Map(auditRuns.map((run) => [run.name, run.result]))

const symptomAudit = requireStructured<SymptomAudit>('symptom-normalizer', auditMap.get('symptom-normalizer')!)
const nonprofitAudit = requireStructured<NonprofitEducationAudit>('nonprofit-education-auditor', auditMap.get('nonprofit-education-auditor')!)
const guidelineAudit = requireStructured<GuidelineAudit>('guideline-auditor', auditMap.get('guideline-auditor')!)
const geneticsAudit = requireStructured<GeneticsAudit>('genetics-auditor', auditMap.get('genetics-auditor')!)
const webClaimsAudit = requireStructured<WebClaimsAudit>('web-claims-auditor', auditMap.get('web-claims-auditor')!)
const safetyAudit = requireStructured<SafetyAudit>('safety-boundary-agent', auditMap.get('safety-boundary-agent')!)

console.log('\n[Phase 1 Summary]')
for (const run of auditRuns) {
  const status = run.result.success ? 'OK' : 'FAILED'
  console.log(`  ${run.name.padEnd(30)} [${status}] ${Math.round(run.elapsedMs)}ms, ${run.result.tokenUsage.output_tokens} out tokens`)
}
console.log(`  Audit wall time: ${Math.round(auditElapsed)}ms\n`)

console.log('[Phase 2] Downstream arbitration over structured audit outputs only\n')

const arbiterPrompt = `You are given structured outputs from six source-isolated audits.
You cannot access the original fixtures. Decide whether this case is a credible lead,
conflicting evidence, misleading/commercial, or needs specialist review.

SYMPTOM AUDIT:
${JSON.stringify(symptomAudit, null, 2)}

NONPROFIT EDUCATION AUDIT:
${JSON.stringify(nonprofitAudit, null, 2)}

OFFICIAL GUIDELINE / EXPERT-CONSENSUS AUDIT:
${JSON.stringify(guidelineAudit, null, 2)}

GENE-PHENOTYPE AUDIT:
${JSON.stringify(geneticsAudit, null, 2)}

WEB / FORUM / COMMERCIAL CLAIMS AUDIT:
${JSON.stringify(webClaimsAudit, null, 2)}

SAFETY BOUNDARY AUDIT:
${JSON.stringify(safetyAudit, null, 2)}

Rules:
- Do not produce a diagnosis.
- Do not recommend a treatment, dose, paid test, or commercial product.
- Surface the conflict between over-specific web/commercial claims and broader official/gene evidence.
- Return one JSON object matching the schema, no markdown.`

const arbiterStart = performance.now()
const arbiterResult = await triageArbiter.run(arbiterPrompt)
const arbiterElapsed = performance.now() - arbiterStart

const decision = requireStructured<TriageDecision>('rare-disease-triage-arbiter', arbiterResult)

console.log(`  Arbiter [OK] ${Math.round(arbiterElapsed)}ms, ${arbiterResult.tokenUsage.output_tokens} out tokens\n`)

// ---------------------------------------------------------------------------
// Runtime assertions
// ---------------------------------------------------------------------------

const allowedConflictDecisions: TriageDecision['decision'][] = [
  'conflicting_evidence',
  'misleading_or_commercial',
  'needs_specialist_review',
]

const asserts = [
  {
    name: 'decision should reflect conflict/safety concern',
    pass: allowedConflictDecisions.includes(decision.decision),
  },
  {
    name: 'patient-facing diagnosis should not be allowed',
    pass: decision.patient_facing_answer_allowed === false,
  },
  {
    name: 'diagnosis should not be provided',
    pass: decision.diagnosis_provided === false,
  },
  {
    name: 'conflicts should be surfaced',
    pass: decision.conflicts.length > 0,
  },
  {
    name: 'unsafe elements should be surfaced',
    pass: decision.unsafe_elements.length > 0,
  },
]

console.log('='.repeat(88))
console.log('RARE DISEASE INFORMATION TRIAGE DECISION')
console.log('='.repeat(88))
console.log(JSON.stringify(decision, null, 2))
console.log()

console.log('## Runtime Assertions\n')
let hasFailure = false
for (const assertion of asserts) {
  console.log(`- ${assertion.pass ? 'PASS' : 'FAIL'}: ${assertion.name}`)
  if (!assertion.pass) hasFailure = true
}

const totalOutputTokens =
  auditRuns.reduce((sum, run) => sum + run.result.tokenUsage.output_tokens, 0) +
  arbiterResult.tokenUsage.output_tokens

const totalInputTokens =
  auditRuns.reduce((sum, run) => sum + run.result.tokenUsage.input_tokens, 0) +
  arbiterResult.tokenUsage.input_tokens

console.log('\n## Token Usage\n')
console.log(`Input tokens: ${totalInputTokens}`)
console.log(`Output tokens: ${totalOutputTokens}`)
console.log('Estimated cost depends on the selected provider/model; this example prints token usage for transparency.')

console.log('\n' + '='.repeat(88))

if (hasFailure) {
  console.error('Runtime assertion failed.')
  process.exit(1)
}

console.log('Rare disease information triage example complete.\n')

// ---------------------------------------------------------------------------
// Production source adapter sketch
// ---------------------------------------------------------------------------
//
// This example intentionally uses committed MOCK fixtures so the demo is
// deterministic, safe, and runnable. A production version could replace fixtures
// with source adapters for patient intake forms, patient-advocacy education,
// official guideline repositories, gene-phenotype databases, web-claim crawlers,
// and an internally approved medical safety policy service. The source-isolated
// audit + downstream arbitration shape would remain the same.
