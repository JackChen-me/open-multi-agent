/**
 * @fileoverview Consensus subsystem: the proposer/judge verification loop and
 * the per-task `verify` hook.
 *
 * {@link runConsensusCore} runs judges sequentially so quorum/budget can stop
 * the rest, records dissent, and applies the `onDissent` policy (revise / reject
 * / keep). {@link runTaskVerify} adapts that loop into the per-task verify hook,
 * folding judge usage into the run's cumulative budget.
 */

import type { ZodSchema } from 'zod'
import type {
  AgentConfig,
  AgentRunResult,
  ConsensusResult,
  OrchestratorConfig,
  RunIdentity,
  Task,
  TokenUsage,
} from '../types.js'
import { AgentPool } from '../agent/pool.js'
import type { Team } from '../team/team.js'
import { extractJSON, validateOutput } from '../agent/structured-output.js'
import { emitTrace, generateSpanId } from '../utils/trace.js'
import { statusOnly } from '../observability/status.js'
import type { TraceRuntime, TraceSpan } from '../observability/runtime.js'
import {
  ZERO_USAGE,
  addUsage,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MODEL,
  type RunContext,
} from './run-context.js'
import { recordRunUsage, buildCostEstimateContext } from './budget.js'
import { applyAgentDefaults, buildAgent } from './agent-config.js'

/** Orchestrator-level defaults applied to ephemeral consensus agents. */
export interface ConsensusAgentDefaults {
  readonly defaultModel: OrchestratorConfig['defaultModel']
  readonly defaultProvider: OrchestratorConfig['defaultProvider']
  readonly defaultBaseURL: OrchestratorConfig['defaultBaseURL']
  readonly defaultApiKey: OrchestratorConfig['defaultApiKey']
  readonly egressPolicy: OrchestratorConfig['egressPolicy']
  readonly defaultCwd: OrchestratorConfig['defaultCwd']
  readonly defaultShellExecutor: OrchestratorConfig['defaultShellExecutor']
  readonly onToolCall: OrchestratorConfig['onToolCall']
  readonly maxConcurrency: number
}

/** Skeptic framing applied to every judge (refute mode and lens-mode base). */
export const DEFAULT_VERIFIER_INSTRUCTION =
  'You are a rigorous skeptic reviewing a proposed answer to the question shown below. ' +
  'Judge the answer against what that question actually asks: hunt for errors, unsupported ' +
  'claims, gaps, and faulty reasoning, then decide whether it withstands scrutiny.'

/** Per-judge review angles used in `lens` mode (assigned round-robin by index). */
export const CONSENSUS_LENSES = [
  'factual correctness and logical soundness',
  'completeness and coverage of the question',
  'edge cases, failure modes, and counterexamples',
  'clarity, precision, and freedom from ambiguity',
  'hidden assumptions and unstated premises',
  'evidence, citations, and verifiability',
] as const

/** Verdict contract appended to every judge prompt. */
export const VERDICT_INSTRUCTION =
  'Respond ONLY with a JSON object {"accept": <true|false>, "critique": "<concise reason>"}. ' +
  'Set "accept" to true only if the answer withstands scrutiny; otherwise set it false ' +
  'and explain the problem in "critique".'

/** Apply orchestrator defaults to a consensus agent config, mirroring buildPool. */
export function applyConsensusDefaults(config: AgentConfig, defaults: ConsensusAgentDefaults): AgentConfig {
  return applyAgentDefaults(config, defaults)
}

/** Build the user prompt sent to a single judge, always including the original question. */
export function buildJudgePrompt(p: {
  judge: string
  answer: string
  prompt: string
  mode: 'refute' | 'lens'
  judgeIndex: number
  judgePrompt?: string | ((judge: string) => string)
}): string {
  let instruction: string
  if (p.judgePrompt !== undefined) {
    instruction = typeof p.judgePrompt === 'function' ? p.judgePrompt(p.judge) : p.judgePrompt
  } else if (p.mode === 'lens') {
    const lens = CONSENSUS_LENSES[p.judgeIndex % CONSENSUS_LENSES.length]!
    instruction = `${DEFAULT_VERIFIER_INSTRUCTION}\nFocus specifically on: ${lens}. ` +
      'If that angle is irrelevant to this question, accept the answer rather than inventing objections.'
  } else {
    instruction = DEFAULT_VERIFIER_INSTRUCTION
  }
  return [
    instruction,
    '',
    '## Question',
    p.prompt,
    '',
    '## Proposed answer',
    p.answer,
    '',
    '## Your verdict',
    VERDICT_INSTRUCTION,
  ].join('\n')
}

/** Build the proposer prompt for a revision round, feeding back the prior answer and the dissent. */
export function buildRevisePrompt(prompt: string, answer: string, dissent: readonly string[]): string {
  return [
    prompt,
    '',
    '## Your previous answer',
    answer,
    '',
    '## Reviewer critiques to address',
    ...dissent.map((d) => `- ${d}`),
    '',
    'Revise the previous answer to address every critique above. Respond with the improved answer only.',
  ].join('\n')
}

/** Parse a judge's raw output into an accept/critique decision. */
export function parseJudgeVerdict(
  output: string,
  verdictSchema?: ZodSchema,
): { accept: boolean; critique: string } {
  let parsed: unknown
  try {
    parsed = extractJSON(output)
  } catch {
    return { accept: false, critique: 'Judge output was not valid JSON.' }
  }
  if (verdictSchema) {
    try {
      validateOutput(verdictSchema, parsed)
    } catch (err) {
      return { accept: false, critique: `Verdict failed schema validation: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const accept = typeof obj['accept'] === 'boolean' ? obj['accept'] : false
  const critique = typeof obj['critique'] === 'string' && obj['critique']
    ? obj['critique']
    : accept ? '' : 'No critique provided.'
  return { accept, critique }
}

/** Inputs to {@link runConsensusCore} — the judge loop shared by `runConsensus` and the `verify` hook. */
export interface ConsensusCoreParams {
  readonly team: Team
  readonly prompt: string
  /** Proposed answer to scrutinise (proposer output, or the task result). */
  readonly initialAnswer: string
  /** Parsed output paired with `initialAnswer`, when the proposer uses an output schema. */
  readonly initialStructured?: unknown
  /** Usage attributable so far that should be reported back (proposer usage, or zero for the verify hook). */
  readonly initialUsage: TokenUsage
  /** Tokens already spent that count toward the budget but are not re-reported (e.g. prior task usage). */
  readonly budgetBaseTokens: number
  readonly judges: readonly AgentConfig[]
  readonly mode: 'refute' | 'lens'
  readonly quorum: number
  readonly maxRounds: number
  readonly verdictSchema?: ZodSchema
  readonly onDissent: 'revise' | 'reject' | 'keep'
  readonly judgePrompt?: string | ((judge: string) => string)
  readonly budget?: number
  /** Re-run on a revision round (the proposer, or the task assignee). */
  readonly reviseProposer?: AgentConfig
  readonly defaults: ConsensusAgentDefaults
  readonly onTrace?: OrchestratorConfig['onTrace']
  readonly runId?: string
  readonly identity?: RunIdentity
  readonly abortSignal?: AbortSignal
  readonly onUsage?: (usage: TokenUsage, effectiveConfig: AgentConfig) => void
  readonly shouldStop?: () => boolean
  /** Existing pool to reuse; a fresh one is created when omitted. */
  readonly pool?: AgentPool
  readonly traceRuntime?: TraceRuntime
  readonly consensusSpan?: TraceSpan
}

/** Internal consensus result that preserves parsed output across revision rounds. */
interface ConsensusCoreResult extends ConsensusResult {
  readonly structured?: unknown
}

/**
 * Run the judge/refutation loop over a proposed answer: judges run sequentially
 * (so quorum and budget can stop the rest), dissent is recorded to shared memory
 * and trace, and `onDissent` decides whether to revise, reject, or keep.
 */
export async function runConsensusCore(params: ConsensusCoreParams): Promise<ConsensusCoreResult> {
  const {
    team, prompt, judges, mode, quorum, maxRounds, verdictSchema, onDissent,
    judgePrompt, budget, budgetBaseTokens, reviseProposer, defaults, onTrace, runId,
  } = params

  const pool = params.pool ?? new AgentPool(Math.max(1, defaults.maxConcurrency))
  const sharedMem = team.getSharedMemoryInstance()

  let answer = params.initialAnswer
  let structured = params.initialStructured
  let usage = params.initialUsage
  const dissent: string[] = []
  let rounds = 0
  let accepted = false
  let executionFailure: AgentRunResult | undefined

  const overBudget = (): boolean =>
    budget !== undefined && budgetBaseTokens + usage.input_tokens + usage.output_tokens > budget

  const runEphemeral = async (
    config: AgentConfig,
    text: string,
    phase: 'judge' | 'revision',
  ): Promise<AgentRunResult> => {
    const effective = applyConsensusDefaults(config, defaults)
    const result = await pool.runEphemeral(buildAgent(effective), text, {
      ...(params.identity ? { identity: params.identity, runId: params.identity.runId } : {}),
      ...(params.traceRuntime && params.consensusSpan ? {
        traceRuntime: params.traceRuntime,
        traceSpan: params.consensusSpan,
        tracePhase: phase,
      } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    })
    params.onUsage?.(result.tokenUsage, effective)
    return result
  }

  // Proposer usage was already accumulated by the caller; bail before judging if it blew the budget.
  if (overBudget() || params.shouldStop?.()) {
    return { answer, verdict: 'rejected', dissent, rounds, tokenUsage: usage }
  }

  let budgetHit = false
  for (let round = 1; round <= maxRounds; round++) {
    rounds = round
    let acceptCount = 0
    const roundDissent: string[] = []

    for (let j = 0; j < judges.length; j++) {
      const judge = judges[j]!
      const judgeText = buildJudgePrompt({ judge: judge.name, answer, prompt, mode, judgeIndex: j, judgePrompt })
      const r = await runEphemeral(judge, judgeText, 'judge')
      usage = addUsage(usage, r.tokenUsage)
      if (!r.success && executionFailure === undefined) executionFailure = r
      if (overBudget() || params.shouldStop?.()) { budgetHit = true; break }

      const verdict = parseJudgeVerdict(r.output, verdictSchema)

      // Trace every verdict (accept or dissent); shared memory records dissent only.
      const now = Date.now()
      const legacyEvent = onTrace ? {
          type: 'consensus',
          runId: runId ?? '',
          spanId: generateSpanId(),
          agent: judge.name,
          round,
          accepted: verdict.accept,
          ...(verdict.accept ? {} : { dissent: verdict.critique }),
          startMs: now,
          endMs: now,
          durationMs: 0,
        } as const : undefined
      if (params.consensusSpan) {
        params.consensusSpan.event('consensus_verdict', {
          'oma.consensus.round': round,
          'oma.consensus.accepted': verdict.accept,
          'oma.agent.name': judge.name,
        }, legacyEvent)
      } else if (legacyEvent) {
        emitTrace(onTrace, legacyEvent)
      }

      if (verdict.accept) {
        acceptCount++
        if (acceptCount >= quorum) { accepted = true; break }
      } else {
        const labelled = `${judge.name}: ${verdict.critique}`
        roundDissent.push(labelled)
        dissent.push(labelled)
        if (sharedMem) {
          await sharedMem.write(judge.name, `consensus:round:${round}:dissent`, verdict.critique)
        }
      }
    }

    if (budgetHit || accepted) break

    // Round missed quorum. Revise (if rounds remain) or stop.
    if (onDissent === 'revise' && round < maxRounds && reviseProposer) {
      const r = await runEphemeral(
        reviseProposer,
        buildRevisePrompt(prompt, answer, roundDissent),
        'revision',
      )
      usage = addUsage(usage, r.tokenUsage)
      if (!r.success && executionFailure === undefined) executionFailure = r
      if (r.success && r.output) {
        answer = r.output
        structured = r.structured
      }
      if (overBudget() || params.shouldStop?.()) { budgetHit = true; break }
      continue
    }
    break
  }

  const verdict: 'accepted' | 'rejected' =
    accepted || (!budgetHit && onDissent === 'keep') ? 'accepted' : 'rejected'
  return {
    answer,
    ...(structured !== undefined ? { structured } : {}),
    verdict,
    dissent,
    rounds,
    tokenUsage: usage,
    ...(executionFailure?.status ? { status: executionFailure.status } : {}),
    ...(executionFailure?.errorInfo ? { errorInfo: executionFailure.errorInfo } : {}),
  }
}

/**
 * Run the per-task `verify` hook before a task is finalised: feed the task
 * result into the consensus loop, fold judge usage into the run's cumulative
 * budget, surface the verdict, and return the effective result — the accepted
 * revision when judges revise it, otherwise the original. The caller uses this
 * to finalise the task so the queue, shared memory, events, and agentResults
 * all agree on the verified outcome.
 */
export async function runTaskVerify(
  task: Task,
  assignee: string,
  result: AgentRunResult,
  sharedMem: ReturnType<Team['getSharedMemoryInstance']>,
  ctx: RunContext,
): Promise<{
  readonly result: AgentRunResult
  readonly verification: {
    readonly verdict: 'accepted' | 'rejected'
    readonly dissent: readonly string[]
    readonly rounds: number
  }
}> {
  const verify = task.verify!
  const { team, config } = ctx
  const assigneeConfig = team.getAgents().find((a) => a.name === assignee)
  const consensusSpan = ctx.traceRuntime?.startSpan({
    kind: 'consensus',
    name: 'verify_consensus',
    parent: ctx.taskSpans.get(task.id) ?? ctx.traceRuntime.root,
    attributes: {
      'oma.consensus.scope': 'task',
      'oma.task.id': task.id,
    },
  })

  const consensus = await runConsensusCore({
    team,
    prompt: task.description,
    initialAnswer: result.output,
    initialStructured: result.structured,
    initialUsage: ZERO_USAGE,
    budgetBaseTokens: ctx.cumulativeUsage.input_tokens + ctx.cumulativeUsage.output_tokens,
    judges: verify.judges,
    mode: verify.mode ?? 'refute',
    quorum: Math.min(
      verify.judges.length,
      Math.max(1, verify.quorum ?? Math.ceil(verify.judges.length / 2)),
    ),
    maxRounds: Math.max(1, verify.maxRounds ?? 2),
    verdictSchema: verify.verdictSchema,
    onDissent: verify.onDissent ?? 'revise',
    judgePrompt: verify.judgePrompt,
    budget: ctx.maxTokenBudget,
    reviseProposer: assigneeConfig,
    defaults: {
      defaultModel: config.defaultModel,
      defaultProvider: config.defaultProvider,
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      egressPolicy: config.egressPolicy,
      defaultCwd: config.defaultCwd,
      defaultShellExecutor: config.defaultShellExecutor,
      onToolCall: config.onToolCall,
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    },
    onTrace: config.onTrace,
    runId: ctx.runId,
    identity: ctx.identity,
    abortSignal: ctx.abortSignal,
    onUsage: (usage, effectiveConfig) => {
      recordRunUsage(ctx, usage, buildCostEstimateContext({
        agentName: effectiveConfig.name,
        model: effectiveConfig.model ?? config.defaultModel ?? DEFAULT_MODEL,
        provider: effectiveConfig.provider,
        phase: 'consensus',
        taskId: task.id,
      }), assignee, task.id)
    },
    shouldStop: () => ctx.budgetExceededTriggered,
    ...(ctx.traceRuntime && consensusSpan ? {
      traceRuntime: ctx.traceRuntime,
      consensusSpan,
    } : {}),
  })

  consensusSpan?.end({
    status: consensus.status ?? statusOnly('ok'),
    ...(consensus.errorInfo ? { error: consensus.errorInfo } : {}),
    attributes: {
      'oma.consensus.verdict': consensus.verdict,
      'oma.consensus.rounds': consensus.rounds,
    },
  })

  if (consensus.status && consensus.status.code !== 'ok') {
    ctx.outcomeStatus = consensus.status
    ctx.outcomeErrorInfo = consensus.errorInfo
  }

  // Surface the verdict as a task-level outcome so downstream agents and the
  // final synthesis can see whether the result survived scrutiny.
  if (sharedMem) {
    const summary = consensus.verdict === 'accepted'
      ? 'accepted'
      : `rejected${consensus.dissent.length ? `: ${consensus.dissent.join('; ')}` : ''}`
    await sharedMem.write(assignee, `task:${task.id}:verdict`, summary)
  }

  // Only an *accepted* revision supersedes the task result; a rejected revision is
  // recorded as dissent but the caller finalises with the original output. Judge
  // usage rolls into the per-task usage (mirrors how delegation usage rolls in).
  const useRevision =
    consensus.verdict === 'accepted' && consensus.answer && consensus.answer !== result.output
  return {
    result: {
      ...result,
      output: useRevision ? consensus.answer : result.output,
      structured: useRevision ? consensus.structured : result.structured,
      tokenUsage: addUsage(result.tokenUsage, consensus.tokenUsage),
    },
    verification: {
      verdict: consensus.verdict,
      dissent: [...consensus.dissent],
      rounds: consensus.rounds,
    },
  }
}
