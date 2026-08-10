/**
 * Personalized Interview Simulator (Interviewer + Observer)
 *
 * Demonstrates:
 * - A stateful `interviewer` agent using `Agent.prompt()` across turns
 * - A stateless `observer` agent that reads full transcript context between turns
 * - Manual `SharedMemory` seeding and prompt injection outside `runTeam()` / `runTasks()`
 * - Human input handled at app level with `readline`
 * - Structured debrief via Zod at the end of the interview loop
 *
 * Run:
 *   npx tsx examples/cookbook/personalized-interview-simulator.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY env var must be set.
 *
 * Optional:
 *   Set INTERVIEW_CANDIDATE_DIR to point at your own materials directory.
 *   Expected files:
 *   - resume.md
 *   - project-notes.md
 *   - code.ts
 *   - job-description.md
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Agent, SharedMemory, ToolExecutor, ToolRegistry } from '../../packages/core/src/index.js'
import type { AgentConfig } from '../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Candidate materials
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CANDIDATE_DIR = path.join(__dirname, '../fixtures/interview-candidate')
const CANDIDATE_DIR = process.env.INTERVIEW_CANDIDATE_DIR ?? DEFAULT_CANDIDATE_DIR
const MAX_TURNS = 10

function loadText(fileName: string): string {
  return readFileSync(path.join(CANDIDATE_DIR, fileName), 'utf-8').trim()
}

const resumeText = loadText('resume.md')
const projectNotes = loadText('project-notes.md')
const codeSnippet = loadText('code.ts')
const jobDescription = loadText('job-description.md')

// ---------------------------------------------------------------------------
// Structured debrief
// ---------------------------------------------------------------------------

const DebriefSchema = z.object({
  questions_asked: z.array(
    z.object({
      question: z.string(),
      why_it_mattered: z.string(),
    }),
  ),
  weak_spots: z.array(z.string()),
  strong_spots: z.array(z.string()),
  overall_assessment: z.object({
    recommendation: z.enum(['strong-hire', 'hire', 'lean-hire', 'lean-no-hire', 'no-hire']),
    summary: z.string(),
  }),
})
type Debrief = z.infer<typeof DebriefSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

async function readlineFromCandidate(prompt: string, rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log('\n' + '='.repeat(60))
  console.log('INTERVIEWER')
  console.log('='.repeat(60))
  console.log(prompt)
  console.log()

  const answer = await rl.question('Candidate > ')
  return answer.trim()
}

function isExitAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === 'exit' || normalized === 'quit'
}

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('[skip] This example needs ANTHROPIC_API_KEY.')
  process.exit(0)
}

const interviewerConfig: AgentConfig = {
  name: 'interviewer',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are a senior technical interviewer.

You are running a personalized interview grounded in:
- the candidate's resume
- project notes
- a code sample
- the target job description
- observer flags written after each turn

Rules:
- Ask exactly one question per turn.
- Prefer probing follow-ups over switching topics too early.
- Use the role expectations and candidate materials together.
- If the observer flags a contradiction, vague answer, or missing dimension, use that.
- Keep each question concise but sharp.
- Do not answer your own question.
- Do not output analysis, just the next interview question.`,
  maxTurns: 2,
  temperature: 0.3,
}

const observerConfig: AgentConfig = {
  name: 'observer',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are an interview observer.

You will receive shared memory containing:
- candidate resume
- project notes
- code sample
- target job spec
- the full interview transcript so far

Write compact flags for the next interviewer turn.
Focus on:
- contradictions with candidate claims
- vague or incomplete answers
- important dimensions not yet tested
- specific follow-up hooks hidden in the answer

Output 3-6 short bullets. Be concrete. No prose introduction.`,
  maxTurns: 1,
  temperature: 0.2,
}

const reporterConfig: AgentConfig = {
  name: 'reporter',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: `You are writing a compact interview debrief.

Use the complete interview record to produce:
- questions_asked: the most important questions and why each mattered
- weak_spots: concise bullets for weak areas
- strong_spots: concise bullets for strengths
- overall_assessment: recommendation plus a short summary

Return JSON only, matching the schema exactly.`,
  maxTurns: 2,
  temperature: 0.1,
  outputSchema: DebriefSchema,
}

// ---------------------------------------------------------------------------
// Seed memory
// ---------------------------------------------------------------------------

const mem = new SharedMemory()

await mem.write('candidate', 'resume', resumeText)
await mem.write('candidate', 'project-notes', projectNotes)
await mem.write('candidate', 'code', codeSnippet)
await mem.write('role', 'target-job-spec', jobDescription)

const interviewer = buildAgent(interviewerConfig)
const observer = buildAgent(observerConfig)
const reporter = buildAgent(reporterConfig)

const rl = createInterface({ input, output })

console.log('Personalized Interview Simulator')
console.log('='.repeat(60))
console.log(`Candidate materials: ${CANDIDATE_DIR}`)
console.log('Type "exit" or "quit" to stop early.')
console.log()

// ---------------------------------------------------------------------------
// Interactive loop
// ---------------------------------------------------------------------------

let answer = ''
let turnsCompleted = 0

try {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const ctx = await mem.getSummary()
    const result = await interviewer.prompt(
      turn === 0
        ? [
            `Context:\n${ctx}`,
            'Ask the most probing opening question you can justify from the materials and role.',
          ].join('\n\n')
        : [
            `Context:\n${ctx}`,
            `Candidate answer:\n${answer}`,
            'Ask the next question.',
          ].join('\n\n'),
    )

    if (!result.success) {
      console.error('Interviewer failed:', result.output)
      process.exit(1)
    }

    answer = await readlineFromCandidate(result.output, rl)
    if (isExitAnswer(answer)) {
      console.log('\nInterview stopped by candidate.')
      break
    }

    turnsCompleted++
    await mem.write('interviewer', `turn-${turn}`, `Q: ${result.output}\nA: ${answer}`)

    const observerResult = await observer.run(
      [
        'Review transcript and candidate materials. Write flags for the next turn.',
        await mem.getSummary(),
      ].join('\n\n'),
    )

    if (!observerResult.success) {
      console.error('Observer failed:', observerResult.output)
      process.exit(1)
    }

    await mem.write('observer', 'flags', observerResult.output)
  }
} finally {
  rl.close()
}

// ---------------------------------------------------------------------------
// Structured debrief
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log('DEBRIEF')
console.log('='.repeat(60))

const debriefResult = await reporter.run(`Summarize the full interview:\n\n${await mem.getSummary()}`)

if (!debriefResult.success || !debriefResult.structured) {
  console.error('Debrief generation failed:', debriefResult.output)
  process.exit(1)
}

const debrief = debriefResult.structured as Debrief

console.log(JSON.stringify(debrief, null, 2))
console.log()
console.log(`Turns completed: ${turnsCompleted}`)
console.log('Done.')
