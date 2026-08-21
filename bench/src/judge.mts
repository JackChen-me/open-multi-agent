/**
 * Blind pairwise LLM-as-judge.
 *
 * Quality here is judge-scored, not human-scored. Two outputs for the same task
 * and repetition are shown to the judge without group labels, scored against a
 * rubric fixed before any run, and then scored again with the two positions
 * swapped. The reported score is the mean of a candidate's two positions, so a
 * judge that simply prefers whichever output it sees first cannot move the
 * result.
 *
 * `createJudgeScorer()` from `@open-multi-agent/core/eval` is single-candidate:
 * its verdict contract hard-requires one top-level `score`, so it cannot carry
 * a pairwise verdict. The judge call is therefore made directly, and each
 * resulting number is still validated through the repo's `defineScorer()`.
 */

import { z } from 'zod'
import { OpenMultiAgent } from '../../packages/core/src/index.js'
import { defineScorer } from '../../packages/core/src/eval/index.js'
import type { AgentConfig } from '../../packages/core/src/index.js'
import type { BenchConfig } from './config.mts'
import type { BenchTaskDefinition } from './tasks.mts'

const VerdictSchema = z.object({
  output_1: z.object({
    score: z.number().min(0).max(1).describe('Rubric score for Output 1, 0.0 to 1.0'),
    reason: z.string().describe('One or two sentences citing the rubric criteria that drove the score'),
  }),
  output_2: z.object({
    score: z.number().min(0).max(1).describe('Rubric score for Output 2, 0.0 to 1.0'),
    reason: z.string().describe('One or two sentences citing the rubric criteria that drove the score'),
  }),
  preferred: z.enum(['1', '2', 'tie']).describe('Which output is better overall'),
})

type Verdict = z.infer<typeof VerdictSchema>

const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluator of written deliverables.

Two systems produced a deliverable from the same input. You do not know which
system produced which output, and the order they appear in carries no meaning.

Score each output independently against every rubric criterion, then assign each
a single score from 0.0 to 1.0. Judge only the substance and the stated
requirements: do not reward length, formatting flourish, or confident tone on
their own. If an output invents facts that are not in the input, that is a
serious defect.

Return JSON matching the schema.`

export interface PairScores {
  readonly scores: Readonly<Record<string, number>>
  readonly preferred: Readonly<Record<string, 'win' | 'loss' | 'tie'>>
  readonly reasons: readonly string[]
  readonly judgeTokens: { input: number; output: number }
  readonly calls: number
}

/** Validation wrapper so judge numbers pass through the repo's scorer contract. */
function makeScorer(version: string) {
  return defineScorer({
    name: 'oma-bench-pairwise-rubric',
    version,
    score({ metadata }) {
      const raw = (metadata as { judgeScore?: unknown } | undefined)?.judgeScore
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new TypeError('bench judge: missing numeric judgeScore in scorer metadata.')
      }
      return { score: raw }
    },
  })
}

function buildJudgePrompt(
  task: BenchTaskDefinition,
  input: string,
  first: string,
  second: string,
): string {
  return [
    '## Input given to both systems',
    '',
    input,
    '',
    '## Required deliverable',
    '',
    task.deliverable,
    '',
    '## Rubric',
    '',
    ...task.rubric.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    '## Output 1',
    '',
    first,
    '',
    '## Output 2',
    '',
    second,
  ].join('\n')
}

export interface JudgeOverrides {
  /** Offline stand-in endpoint; used only by `--mock`. */
  readonly baseURL?: string
  readonly apiKey?: string
}

export class Judge {
  private readonly orchestrator = new OpenMultiAgent({})
  private readonly agentConfig: AgentConfig

  constructor(private readonly config: BenchConfig, overrides: JudgeOverrides = {}) {
    if (!config.judge.provider || !config.judge.model) {
      throw new Error('bench: judge.provider and judge.model must be set in bench/config.json.')
    }
    this.agentConfig = {
      name: 'judge',
      provider: config.judge.provider,
      model: config.judge.model,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      maxTurns: 1,
      temperature: config.judge.temperature,
      outputSchema: VerdictSchema,
      ...(overrides.baseURL ? { baseURL: overrides.baseURL } : {}),
      ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
    }
  }

  get model(): string {
    return `${this.config.judge.provider}/${this.config.judge.model}`
  }

  /**
   * Score two labelled candidates against each other in both presentation
   * orders. Returns the mean score per label.
   */
  async scorePair(
    task: BenchTaskDefinition,
    input: string,
    candidates: ReadonlyArray<{ group: string; output: string }>,
  ): Promise<PairScores> {
    if (candidates.length !== 2) {
      throw new Error(`bench judge: scorePair needs exactly 2 candidates, got ${candidates.length}.`)
    }
    const [left, right] = candidates as [{ group: string; output: string }, { group: string; output: string }]

    const orders: Array<[typeof left, typeof right]> = [
      [left, right],
      [right, left],
    ]

    const totals: Record<string, number[]> = { [left.group]: [], [right.group]: [] }
    const wins: Record<string, number> = { [left.group]: 0, [right.group]: 0 }
    let ties = 0
    const reasons: string[] = []
    let judgeInput = 0
    let judgeOutput = 0
    let calls = 0

    for (const [first, second] of orders) {
      const prompt = buildJudgePrompt(task, input, first.output, second.output)
      // A dropped connection or a one-off schema miss should not cost the pair.
      // Bounded at two attempts: a judge that fails twice is a real problem and
      // the caller needs to see it rather than have it retried away.
      let verdict: Verdict | undefined
      let lastFailure = ''
      for (let attempt = 1; attempt <= 2 && verdict === undefined; attempt += 1) {
        let result
        try {
          result = await this.orchestrator.runAgent(this.agentConfig, prompt)
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error)
          continue
        }
        calls += 1
        judgeInput += result.tokenUsage.input_tokens
        judgeOutput += result.tokenUsage.output_tokens
        if (result.success && result.structured !== undefined) {
          verdict = result.structured as Verdict
        } else {
          lastFailure = result.output.slice(0, 300)
        }
      }
      if (verdict === undefined) {
        throw new Error(`bench judge: judge call failed twice or returned no structured verdict: ${lastFailure}`)
      }
      totals[first.group]!.push(verdict.output_1.score)
      totals[second.group]!.push(verdict.output_2.score)
      if (verdict.preferred === '1') wins[first.group]! += 1
      else if (verdict.preferred === '2') wins[second.group]! += 1
      else ties += 1
      reasons.push(`[${first.group} as Output 1] ${verdict.output_1.reason} || [${second.group} as Output 2] ${verdict.output_2.reason}`)
    }

    const scorer = makeScorer(this.config.judge.rubricVersion)
    const scores: Record<string, number> = {}
    for (const [group, values] of Object.entries(totals)) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const validated = await scorer.score({
        evalCase: { id: `${task.id}:${group}`, input },
        output: '',
        metadata: { judgeScore: mean },
        signal: new AbortController().signal,
      })
      scores[group] = validated.score
    }

    const preferred: Record<string, 'win' | 'loss' | 'tie'> = {}
    for (const group of Object.keys(totals)) {
      const other = Object.keys(totals).find((g) => g !== group)!
      if (ties === orders.length) preferred[group] = 'tie'
      else if (wins[group]! > wins[other]!) preferred[group] = 'win'
      else if (wins[group]! < wins[other]!) preferred[group] = 'loss'
      else preferred[group] = 'tie'
    }

    return {
      scores,
      preferred,
      reasons,
      judgeTokens: { input: judgeInput, output: judgeOutput },
      calls,
    }
  }
}
