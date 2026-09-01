import { z, type ZodSchema } from 'zod'
import type { AgentConfig, AgentRunInput, CostEstimateContext, TokenUsage } from '../types.js'
import {
  buildStructuredOutputInstruction,
  extractJSON,
  validateOutput,
} from '../agent/structured-output.js'
import {
  attachScoreCostInputs,
  defineScorer,
  scoreCostInputs,
  type ScoreCostInput,
  type Scorer,
  type ScorerContext,
} from './scorer.js'

export interface JudgeScorerOptions {
  readonly name: string
  readonly version?: string
  readonly judges: readonly AgentConfig[]
  readonly quorum?: number
  readonly verdictSchema?: ZodSchema
  readonly judgePrompt?: string | ((context: ScorerContext, judge: AgentConfig) => AgentRunInput)
  readonly timeoutMs?: number
}

interface JudgeVerdict {
  readonly judge: string
  readonly model: string
  readonly score: number
  readonly pass?: boolean
  readonly reason?: string
}

const DEFAULT_VERDICT_SCHEMA = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
})

const DEFAULT_JUDGE_INSTRUCTION =
  'You are an impartial quality evaluator. Score how well the candidate output satisfies the case input and expected result.'

function formatValue(value: unknown): string {
  if (value === undefined) return '(not provided)'
  if (typeof value === 'string') return value
  const serialized = JSON.stringify(value, null, 2)
  return serialized === undefined ? String(value) : serialized
}

function buildPrompt(
  context: ScorerContext,
  instruction: string,
  verdictSchema: ZodSchema,
): string {
  return [
    instruction,
    '',
    '## Case input',
    formatValue(context.evalCase.input),
    '',
    '## Expected output',
    formatValue(context.evalCase.expected),
    '',
    '## Candidate output',
    formatValue(context.output),
    '',
    '## Evaluation metadata',
    formatValue(context.metadata),
    buildStructuredOutputInstruction(verdictSchema),
  ].join('\n')
}

function parseVerdict(output: string, schema: ZodSchema, judge: AgentConfig): JudgeVerdict {
  const validated = validateOutput(schema, extractJSON(output))
  if (typeof validated !== 'object' || validated === null || Array.isArray(validated)) {
    throw new TypeError(`Judge "${judge.name}" verdict must be an object.`)
  }

  const verdict = validated as Record<string, unknown>
  if (
    typeof verdict['score'] !== 'number'
    || !Number.isFinite(verdict['score'])
    || verdict['score'] < 0
    || verdict['score'] > 1
  ) {
    throw new RangeError(`Judge "${judge.name}" verdict.score must be in the range [0, 1].`)
  }
  if (verdict['pass'] !== undefined && typeof verdict['pass'] !== 'boolean') {
    throw new TypeError(`Judge "${judge.name}" verdict.pass must be a boolean when provided.`)
  }
  if (verdict['reason'] !== undefined && typeof verdict['reason'] !== 'string') {
    throw new TypeError(`Judge "${judge.name}" verdict.reason must be a string when provided.`)
  }

  return {
    judge: judge.name,
    model: judge.model ?? (judge.backend ? `${judge.backend.kind}-backend` : 'unknown'),
    score: verdict['score'],
    ...(typeof verdict['pass'] === 'boolean' ? { pass: verdict['pass'] } : {}),
    ...(typeof verdict['reason'] === 'string' ? { reason: verdict['reason'] } : {}),
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Judge scorer was aborted.')
  error.name = 'AbortError'
  return error
}

function createDeadline(
  callerSignal: AbortSignal,
  timeoutMs: number | undefined,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal.reason)
  callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal.aborted) onCallerAbort()

  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    const error = new Error(`Judge scorer exceeded timeout of ${timeoutMs}ms.`)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs)
  timer?.unref?.()

  return {
    signal: controller.signal,
    dispose() {
      callerSignal.removeEventListener('abort', onCallerAbort)
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/**
 * Resolve one judge's input. A string `judgePrompt` result (the default
 * shorthand) is wrapped into the standard text prompt via `buildPrompt`, same
 * as before this judge ever existed as an argument. A structured
 * `readonly LLMMessage[]` result is passed through as-is, letting a caller
 * build per-judge content — e.g. an image block only for judges whose
 * `AgentConfig.capabilities` declare vision support.
 */
function resolveJudgeInput(
  context: ScorerContext,
  judge: AgentConfig,
  judgePrompt: JudgeScorerOptions['judgePrompt'],
  schema: ZodSchema,
): AgentRunInput {
  const resolved = typeof judgePrompt === 'function'
    ? judgePrompt(context, judge)
    : judgePrompt ?? DEFAULT_JUDGE_INSTRUCTION
  return typeof resolved === 'string' ? buildPrompt(context, resolved, schema) : resolved
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal)

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function runJudge(
  judge: AgentConfig,
  promptInput: AgentRunInput,
  schema: ZodSchema,
  signal: AbortSignal,
): Promise<{
  readonly verdict: JudgeVerdict
  readonly usage: TokenUsage
  readonly costContext: CostEstimateContext
}> {
  // Keep the eval barrel browser-safe to import. The Node-capable Agent path is
  // loaded only when a judge scorer actually executes.
  const { buildAgent } = await import('../orchestrator/agent-config.js')
  const result = await buildAgent(judge).run(promptInput, { abortSignal: signal })
  const model = judge.model ?? (judge.backend ? `${judge.backend.kind}-backend` : 'unknown')
  const costInput: ScoreCostInput = {
    usage: result.tokenUsage,
    context: {
      agentName: judge.name,
      model,
      phase: 'agent',
      ...(judge.provider !== undefined ? { provider: judge.provider } : {}),
    },
  }
  if (!result.success) {
    const error = result.error instanceof Error
      ? result.error
      : new Error(result.errorInfo?.message ?? `Judge "${judge.name}" failed.`)
    throw attachScoreCostInputs(error, [costInput])
  }
  let verdict: JudgeVerdict
  try {
    verdict = parseVerdict(result.output, schema, judge)
  } catch (error) {
    if (error instanceof Error) attachScoreCostInputs(error, [costInput])
    throw error
  }
  return {
    verdict,
    usage: result.tokenUsage,
    costContext: costInput.context,
  }
}

/** Create an OMA-agent-backed scorer with mean-score and quorum aggregation. */
export function createJudgeScorer(options: JudgeScorerOptions): Scorer {
  if (!Array.isArray(options.judges) || options.judges.length === 0) {
    throw new TypeError('JudgeScorerOptions.judges must contain at least one judge.')
  }
  const judges = options.judges.map((judge) => ({ ...judge }))
  const quorum = options.quorum ?? Math.ceil(judges.length / 2)
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > judges.length) {
    throw new RangeError('JudgeScorerOptions.quorum must be an integer between 1 and judges.length.')
  }
  if (
    options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new RangeError('JudgeScorerOptions.timeoutMs must be a positive finite number.')
  }

  const schema = options.verdictSchema ?? DEFAULT_VERDICT_SCHEMA
  const judgePrompt = options.judgePrompt
  const timeoutMs = options.timeoutMs
  return defineScorer({
    name: options.name,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async score(context) {
      const deadline = createDeadline(context.signal, timeoutMs)

      try {
        const verdicts: JudgeVerdict[] = []
        const costInputs: ScoreCostInput[] = []
        try {
          for (const judge of judges) {
            const promptInput = resolveJudgeInput(context, judge, judgePrompt, schema)
            const judged = await raceWithAbort(
              runJudge(judge, promptInput, schema, deadline.signal),
              deadline.signal,
            )
            verdicts.push(judged.verdict)
            costInputs.push({ usage: judged.usage, context: judged.costContext })
          }
        } catch (error) {
          if (error instanceof Error) {
            attachScoreCostInputs(error, [...costInputs, ...scoreCostInputs(error)])
          }
          throw error
        }

        const score = verdicts.reduce((sum, verdict) => sum + verdict.score, 0) / verdicts.length
        const passVotes = verdicts.filter((verdict) => verdict.pass === true).length
        const hasPass = verdicts.some((verdict) => verdict.pass !== undefined)
        const reasons = verdicts
          .filter((verdict) => verdict.reason)
          .map((verdict) => `${verdict.judge}: ${verdict.reason}`)

        return attachScoreCostInputs({
          score,
          ...(hasPass ? { pass: passVotes >= quorum } : {}),
          ...(reasons.length > 0 ? { reason: reasons.join('\n') } : {}),
          // Parallel arrays keep the judge/model/score association by index
          // while remaining valid TraceAttributeValue payloads.
          details: {
            judges: verdicts.map((verdict) => verdict.judge),
            models: verdicts.map((verdict) => verdict.model),
            scores: verdicts.map((verdict) => verdict.score),
          },
        }, costInputs)
      } finally {
        deadline.dispose()
      }
    },
  })
}
