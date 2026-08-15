import type { Team } from '../team/team.js'
import type {
  AgentConfig,
  AgentRunResult,
  ConsensusResult,
  ExecutionRoutingConfig,
  PlanArtifact,
  TeamRunResult,
  TraceAttributeValue,
} from '../types.js'

/** Per-sample context passed to an EvalTarget. */
export interface EvalTargetContext {
  readonly caseId: string
  readonly repeat: number
  readonly signal: AbortSignal
  readonly metadata: Readonly<Record<string, TraceAttributeValue>>
}

/** Output scored by the runner, plus an optional OMA result for trace and usage linkage. */
export interface TargetOutput {
  readonly output: unknown
  readonly result?: AgentRunResult | TeamRunResult | ConsensusResult
}

/** A framework-agnostic evaluation target. */
export type EvalTarget = (
  input: unknown,
  context: EvalTargetContext,
) => Promise<TargetOutput>

export interface TargetFromRunOptions {
  /** Extra per-run metadata merged into RunIdentityOptions.metadata. */
  readonly metadata?: Readonly<Record<string, TraceAttributeValue>>
  /** Per-run routing controls used by {@link targetFromTeam}. */
  readonly executionRouting?: ExecutionRoutingConfig
}

function targetPrompt(input: unknown): string {
  return typeof input === 'string' ? input : String(input)
}

function compactFingerprint(
  config: Pick<AgentConfig, 'model' | 'provider'>,
): Readonly<Record<string, TraceAttributeValue>> {
  return {
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
  }
}

function teamFingerprint(team: Team): Readonly<Record<string, TraceAttributeValue>> {
  const agents = team.getAgents()
  const models = [...new Set(agents.flatMap((agent) => agent.model === undefined ? [] : [agent.model]))]
  const providers = [...new Set(agents.flatMap((agent) => agent.provider === undefined ? [] : [agent.provider]))]
  return {
    ...(models.length > 0 ? { models } : {}),
    ...(providers.length > 0 ? { providers } : {}),
  }
}

function runMetadata(
  context: EvalTargetContext,
  options: TargetFromRunOptions | undefined,
  fingerprint: Readonly<Record<string, TraceAttributeValue>>,
): Readonly<Record<string, TraceAttributeValue>> {
  return {
    eval_case: context.caseId,
    eval_repeat: String(context.repeat),
    ...options?.metadata,
    ...fingerprint,
  }
}

function teamOutput(result: TeamRunResult): string {
  const synthesis = result.agentResults.get('coordinator')?.output
  if (synthesis !== undefined) return synthesis
  return [...result.agentResults.values()]
    .map((agentResult) => agentResult.output)
    .filter((output) => output.length > 0)
    .join('\n\n---\n\n')
}

/** Wrap one OMA agent as an EvalTarget. */
export function targetFromAgent(
  agent: AgentConfig,
  options?: TargetFromRunOptions,
): EvalTarget {
  return async (input, context) => {
    // Keep the eval subpath free of a static orchestrator (and its Node runtime imports).
    const { OpenMultiAgent } = await import('../orchestrator/orchestrator.js')
    const result = await new OpenMultiAgent().runAgent(agent, targetPrompt(input), {
      abortSignal: context.signal,
      metadata: runMetadata(context, options, compactFingerprint(agent)),
    })
    return { output: result.output, result }
  }
}

/** Wrap an OMA team run as an EvalTarget. */
export function targetFromTeam(
  team: Team,
  options?: TargetFromRunOptions,
): EvalTarget {
  return async (input, context) => {
    const { OpenMultiAgent } = await import('../orchestrator/orchestrator.js')
    const result = await new OpenMultiAgent().runTeam(team, targetPrompt(input), {
      abortSignal: context.signal,
      metadata: runMetadata(context, options, teamFingerprint(team)),
      ...(options?.executionRouting !== undefined
        ? { executionRouting: options.executionRouting }
        : {}),
    })
    return { output: teamOutput(result), result }
  }
}

/** Wrap deterministic plan replay as an EvalTarget. The plan, rather than input, fixes execution. */
export function targetFromPlan(
  team: Team,
  plan: PlanArtifact,
  options?: TargetFromRunOptions,
): EvalTarget {
  return async (_input, context) => {
    const { OpenMultiAgent } = await import('../orchestrator/orchestrator.js')
    const result = await new OpenMultiAgent().runFromPlan(team, plan, {
      abortSignal: context.signal,
      metadata: runMetadata(context, options, teamFingerprint(team)),
    })
    return { output: teamOutput(result), result }
  }
}
