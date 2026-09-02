/**
 * @fileoverview Coordinator subsystem: goal decomposition parsing, coordinator
 * prompt construction (system prompt, roster, output format, decomposition), the
 * synthesis pass, and task-spec loading.
 *
 * These were the coordinator-facing helpers on {@link OpenMultiAgent}; extracted
 * as free functions that take the orchestrator config explicitly where needed.
 */

import type { RunOptions } from '../agent/runner.js'
import { extractJSON } from '../agent/structured-output.js'
import type {
  AgentConfig,
  AgentRunResult,
  ConsensusVerifyOptions,
  CoordinatorConfig,
  ModelRoutingPolicy,
  OrchestratorConfig,
  RunIdentity,
  Task,
  TaskMetadata,
  TaskRequirements,
  TokenUsage,
} from '../types.js'
import type { Team } from '../team/team.js'
import type { TaskQueue } from '../task/queue.js'
import { createTask, validateTaskDependencies } from '../task/task.js'
import { classifyRunFailure } from '../observability/status.js'
import type { JournalRecorder } from '../journal/journal.js'
import type { TraceRuntime, TraceSpan } from '../observability/runtime.js'
import { totalTokens, DEFAULT_MODEL } from './run-context.js'
import { applyBudgetAccounting, buildCostEstimateContext, emitBudgetExceeded } from './budget.js'
import {
  applyDefaultToolPreset,
  buildAgent,
  resolveAgentToolDefinitions,
  withModelRoute,
  routeMatches,
} from './agent-config.js'
import { z } from 'zod'

/**
 * Partial verify config that the coordinator can emit in task JSON.
 * Contains only fields that are safe to include in LLM output — `judges`
 * (full AgentConfig objects) are always supplied by the caller via
 * {@link RunTeamOptions.verifyJudges} and are never in coordinator JSON.
 */
export interface CoordinatorVerifySpec {
  readonly mode?: 'refute' | 'lens'
  readonly quorum?: number
  readonly maxRounds?: number
  readonly onDissent?: 'revise' | 'reject' | 'keep'
}

export interface ParsedTaskSpec {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
  role?: string
  priority?: 'low' | 'normal' | 'high' | 'critical'
  requires?: TaskRequirements
  /**
   * Full verify options (used by explicit `runTasks` specs that already
   * include judges) OR a coordinator-emitted partial spec / boolean `true`
   * (resolved into full options by `loadSpecsIntoQueue` when
   * `verifyJudges` is available).
   */
  verify?: ConsensusVerifyOptions | CoordinatorVerifySpec | true
}

const coordinatorVerifySchema = z.union([
  z.literal(true),
  z.object({
    mode: z.enum(['refute', 'lens']).optional(),
    quorum: z.number().int().positive().optional(),
    maxRounds: z.number().int().positive().optional(),
    onDissent: z.enum(['revise', 'reject', 'keep']).optional(),
  }).strict(),
])

const coordinatorTaskSpecSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  assignee: z.string().trim().min(1).optional(),
  dependsOn: z.array(z.string().trim().min(1)).optional(),
  memoryScope: z.enum(['dependencies', 'all']).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  retryDelayMs: z.number().finite().nonnegative().optional(),
  retryBackoff: z.number().finite().positive().optional(),
  role: z.string().trim().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  requires: z.object({
    requiredTools: z.array(z.string().trim().min(1)).optional(),
    requiredCapabilities: z.array(z.string().trim().min(1)).optional(),
    requiredBackend: z.enum(['llm', 'process', 'acp']).optional(),
    requiredProvider: z.string().trim().min(1).optional(),
  }).strict().optional(),
  verify: coordinatorVerifySchema.optional(),
}).strict()

const coordinatorTaskSpecsSchema = z.array(coordinatorTaskSpecSchema).min(1)

/**
 * Build the coordinator output contract for one team. The roster and task
 * titles are runtime facts, so they belong in the same schema that triggers
 * the Agent's single structured-output repair attempt.
 */
export function buildCoordinatorTaskSpecsSchema(
  agents: readonly AgentConfig[],
  strictAssignees: boolean,
) {
  const roster = new Set(agents.map((agent) => agent.name))
  const normalizeTitle = (title: string) => title.toLowerCase().trim()

  return coordinatorTaskSpecsSchema.superRefine((tasks, ctx) => {
    const titleIndexes = new Map<string, number[]>()
    for (let index = 0; index < tasks.length; index++) {
      const key = normalizeTitle(tasks[index]!.title)
      const indexes = titleIndexes.get(key) ?? []
      indexes.push(index)
      titleIndexes.set(key, indexes)
    }

    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index]!
      if (strictAssignees && task.assignee !== undefined && !roster.has(task.assignee)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'assignee'],
          message: `Unknown assignee "${task.assignee}".`,
        })
      }
      for (const [dependencyIndex, dependency] of (task.dependsOn ?? []).entries()) {
        const matches = titleIndexes.get(normalizeTitle(dependency)) ?? []
        if (matches.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'dependsOn', dependencyIndex],
            message: matches.length === 0
              ? `Unknown dependency "${dependency}".`
              : `Ambiguous dependency "${dependency}".`,
          })
        }
      }
    }

    for (const [title, indexes] of titleIndexes) {
      if (indexes.length > 1) {
        for (const index of indexes) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'title'],
            message: `Duplicate task title "${title}".`,
          })
        }
      }
    }

    const visiting = new Set<number>()
    const visited = new Set<number>()
    const visit = (index: number): boolean => {
      if (visiting.has(index)) return true
      if (visited.has(index)) return false
      visiting.add(index)
      const task = tasks[index]!
      for (const dependency of task.dependsOn ?? []) {
        const matches = titleIndexes.get(normalizeTitle(dependency)) ?? []
        if (matches.length === 1 && visit(matches[0]!)) return true
      }
      visiting.delete(index)
      visited.add(index)
      return false
    }
    if (tasks.some((_, index) => visit(index))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Cyclic task dependency detected.',
      })
    }
  })
}

export interface InvalidAssigneeIssue {
  readonly taskTitle: string
  readonly assignee: string
}

/** Find coordinator-authored assignees that are not present in the team roster. */
export function findInvalidAssignees(
  specs: readonly ParsedTaskSpec[],
  agents: readonly AgentConfig[],
): readonly InvalidAssigneeIssue[] {
  const agentNames = new Set(agents.map((agent) => agent.name))
  return specs.flatMap((spec) =>
    spec.assignee !== undefined && !agentNames.has(spec.assignee)
      ? [{ taskTitle: spec.title, assignee: spec.assignee }]
      : [])
}

/**
 * Resolve a parsed task spec's `verify` field into a full
 * {@link ConsensusVerifyOptions} (or `undefined` when no verify should run).
 *
 * - Full `ConsensusVerifyOptions` (already has `judges`): used as-is.
 * - `true` or `CoordinatorVerifySpec` (no `judges`): merged with
 *   `verifyJudges` when provided; ignored when `verifyJudges` is absent.
 * - `undefined`: no verify.
 */
export function resolveVerify(
  spec: ConsensusVerifyOptions | CoordinatorVerifySpec | true | undefined,
  verifyJudges?: readonly AgentConfig[],
): ConsensusVerifyOptions | undefined {
  if (spec === undefined) return undefined
  if (spec !== true && 'judges' in spec) return spec as ConsensusVerifyOptions
  if (!verifyJudges || verifyJudges.length === 0) return undefined
  const partial: CoordinatorVerifySpec = spec === true ? {} : spec
  return {
    judges: verifyJudges,
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    ...(partial.quorum !== undefined ? { quorum: partial.quorum } : {}),
    ...(partial.maxRounds !== undefined ? { maxRounds: partial.maxRounds } : {}),
    ...(partial.onDissent !== undefined ? { onDissent: partial.onDissent } : {}),
  }
}

/**
 * Parse the coordinator-emitted `verify` field on a task JSON object.
 * Accepts `true` (use all defaults) or a partial object with `mode`,
 * `quorum`, `maxRounds`, and/or `onDissent`. Returns `undefined` for any
 * other value so missing / null / unrecognised values are ignored safely.
 */
export function parseCoordinatorVerify(raw: unknown): CoordinatorVerifySpec | true | undefined {
  if (raw === true) return true
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const mode = obj['mode'] === 'refute' || obj['mode'] === 'lens' ? obj['mode'] : undefined
  const quorum = typeof obj['quorum'] === 'number' && obj['quorum'] >= 1 ? Math.floor(obj['quorum']) : undefined
  const maxRounds = typeof obj['maxRounds'] === 'number' && obj['maxRounds'] >= 1 ? Math.floor(obj['maxRounds']) : undefined
  const onDissent = obj['onDissent'] === 'revise' || obj['onDissent'] === 'reject' || obj['onDissent'] === 'keep'
    ? obj['onDissent']
    : undefined
  if (mode === undefined && quorum === undefined && maxRounds === undefined && onDissent === undefined) return true
  return { mode, quorum, maxRounds, onDissent }
}

/**
 * Attempt to extract a JSON array of task specs from the coordinator's raw
 * output. The coordinator is prompted to emit JSON inside a ```json … ``` fence
 * or as a bare array. Returns `null` when no valid array can be extracted.
 */
export function parseTaskSpecs(raw: string): ParsedTaskSpec[] | null {
  try {
    const parsed = coordinatorTaskSpecsSchema.safeParse(extractJSON(raw))
    return parsed.success ? parsed.data as ParsedTaskSpec[] : null
  } catch {
    return null
  }
}

/** Parse the coordinator's optional, explicit task requirements. */
export function parseTaskRequirements(raw: unknown): TaskRequirements | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const strings = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const filtered = value.filter((item): item is string => typeof item === 'string')
    return filtered.length > 0 ? filtered : undefined
  }
  const requiredTools = strings(obj['requiredTools'])
  const requiredCapabilities = strings(obj['requiredCapabilities'])
  const requiredBackend =
    obj['requiredBackend'] === 'llm'
    || obj['requiredBackend'] === 'process'
    || obj['requiredBackend'] === 'acp'
      ? obj['requiredBackend']
      : undefined
  // Unknown strings remain a safe no-match at runtime; the public
  // RunTaskSpec type constrains caller-authored values to SupportedProvider.
  const requiredProvider = typeof obj['requiredProvider'] === 'string'
    ? obj['requiredProvider'] as TaskRequirements['requiredProvider']
    : undefined
  if (
    requiredTools === undefined
    && requiredCapabilities === undefined
    && requiredBackend === undefined
    && requiredProvider === undefined
  ) return undefined
  return {
    ...(requiredTools !== undefined ? { requiredTools } : {}),
    ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
    ...(requiredBackend !== undefined ? { requiredBackend } : {}),
    ...(requiredProvider !== undefined ? { requiredProvider } : {}),
  }
}

/** Build the system prompt given to the coordinator agent. */
export interface CoordinatorRosterContext {
  readonly defaultModel?: string
  readonly defaultToolPreset?: OrchestratorConfig['defaultToolPreset']
}

export interface CoordinatorRosterManifestEntry {
  readonly name: string
  readonly model: string
  readonly roleSummary?: string
  readonly capabilities?: readonly string[]
  readonly tools?: readonly string[]
  readonly costTier?: AgentConfig['costTier']
}

export const COORDINATOR_ROLE_SUMMARY_MAX_CHARS = 140
export const COORDINATOR_MANIFEST_MAX_CAPABILITIES = 20
export const COORDINATOR_MANIFEST_MAX_TOOLS = 24
const MANIFEST_MODEL_MAX_CHARS = 120

function bounded(value: string, maxChars: number): string {
  return value.trim().slice(0, maxChars)
}

function roleSummary(agent: AgentConfig): string | undefined {
  // This is an intentional, bounded summary exposure for coordinator routing:
  // one explicit sentence or at most the first 140 prompt characters, never
  // the previous unbounded full system prompt.
  const source = agent.description
    ?? agent.systemPrompt?.split(/\r?\n/, 1)[0]
  if (!source) return undefined
  const summary = bounded(source, COORDINATOR_ROLE_SUMMARY_MAX_CHARS)
  return summary.length > 0 ? summary : undefined
}

/** Build the bounded, allowlisted manifest shown to the coordinator. */
export function buildCoordinatorRosterManifest(
  agents: readonly AgentConfig[],
  context: CoordinatorRosterContext = {},
): readonly CoordinatorRosterManifestEntry[] {
  return agents.map((agent) => {
    const effective = applyDefaultToolPreset(agent, context.defaultToolPreset)
    const tools = resolveAgentToolDefinitions(effective, {
      includeDelegateTool: true,
    })
      .map((tool) => tool.name)
      .slice(0, COORDINATOR_MANIFEST_MAX_TOOLS)
    const capabilities = agent.capabilities
      ?.filter((capability) => capability.length > 0)
      .slice(0, COORDINATOR_MANIFEST_MAX_CAPABILITIES)
    const summary = roleSummary(agent)
    return {
      // Keep the assignment identity exact so coordinator output can always
      // pass loadSpecsIntoQueue's roster-name validation.
      name: agent.name,
      model: bounded(agent.model ?? context.defaultModel ?? 'unspecified', MANIFEST_MODEL_MAX_CHARS),
      ...(summary !== undefined ? { roleSummary: summary } : {}),
      ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(agent.costTier !== undefined ? { costTier: agent.costTier } : {}),
    }
  })
}

export function buildCoordinatorSystemPrompt(
  agents: AgentConfig[],
  hasVerifyJudges?: boolean,
  rosterContext: CoordinatorRosterContext = {},
): string {
  return [
    'You are a task coordinator responsible for decomposing high-level goals',
    'into concrete, actionable tasks and assigning them to the right team members.',
    '',
    buildCoordinatorRosterSection(agents, rosterContext),
    '',
    buildCoordinatorOutputFormatSection(hasVerifyJudges),
    '',
    buildCoordinatorSynthesisSection(),
  ].join('\n')
}

/** Build coordinator system prompt with optional caller overrides. */
export function buildCoordinatorPrompt(
  agents: AgentConfig[],
  config?: CoordinatorConfig,
  hasVerifyJudges?: boolean,
  rosterContext: CoordinatorRosterContext = {},
): string {
  if (config?.systemPrompt) {
    return [
      config.systemPrompt,
      '',
      buildCoordinatorRosterSection(agents, rosterContext),
      '',
      buildCoordinatorOutputFormatSection(hasVerifyJudges),
      '',
      buildCoordinatorSynthesisSection(),
    ].join('\n')
  }

  const base = buildCoordinatorSystemPrompt(agents, hasVerifyJudges, rosterContext)
  if (!config?.instructions) {
    return base
  }

  return [
    base,
    '',
    '## Additional Instructions',
    config.instructions,
  ].join('\n')
}

/** Build the coordinator team roster section. */
export function buildCoordinatorRosterSection(
  agents: AgentConfig[],
  context: CoordinatorRosterContext = {},
): string {
  const roster = JSON.stringify(buildCoordinatorRosterManifest(agents, context), null, 2)
  return [
    '## Team Roster',
    'Use only this bounded structured manifest. `roleSummary` is an intentionally exposed',
    `summary (maximum ${COORDINATOR_ROLE_SUMMARY_MAX_CHARS} characters), not the full system prompt.`,
    roster,
  ].join('\n')
}

/** Build the coordinator JSON output-format section. */
export function buildCoordinatorOutputFormatSection(hasVerifyJudges?: boolean): string {
  const lines = [
    '## Output Format',
    'When asked to decompose a goal, respond ONLY with a JSON array of task objects.',
    'Each task must have:',
    '  - "title":       Short descriptive title (string)',
    '  - "description": Full task description with context and expected output (string)',
    '  - "assignee":    One of the agent names listed in the roster (string).',
    '                   Prefer an agent whose manifest `capabilities` best match the task;',
    '                   use `roleSummary` and `tools` only as secondary assignment signals.',
    '  - "dependsOn":   Array of titles of tasks this task depends on (string[], may be empty).',
    '  - "requires":    (optional) Explicit hard requirements with optional "requiredTools" (string[]),',
    '                   "requiredCapabilities" (string[]), "requiredBackend" ("llm"|"process"|"acp"),',
    '                   and "requiredProvider" (string). Omit when there are no hard requirements.',
  ]
  if (hasVerifyJudges) {
    lines.push(
      '  - "verify":      (optional) Set to true to apply consensus judge verification on this task\'s result.',
      '                   Or set to an object with any of: "mode" ("refute"|"lens"), "quorum" (number),',
      '                   "maxRounds" (number), "onDissent" ("revise"|"reject"|"keep").',
      '                   Omit for tasks where a single agent\'s answer is sufficient.',
    )
  }
  lines.push(
    '',
    '## Dependency Guidance',
    'Prefer the minimum set of upstream tasks each assignee needs. When deciding dependsOn for agent X:',
    '  1. Use X\'s roleSummary and declared capabilities as the primary signals for what inputs it consumes.',
    '  2. Lean toward including a task only when the structured manifest describes X as needing that input.',
    '  3. Avoid adding a dependency just because the information "would be useful" or matches general best practice; if the manifest gives no indication X consumes that input, prefer to leave it out.',
    '  4. When uncertain, prefer fewer dependencies over more — extra parents cost parallelism and tokens.',
    '',
    'Return only the JSON array. Do not use Markdown code fences or extra text.',
  )
  return lines.join('\n')
}

/** Build the coordinator synthesis guidance section. */
export function buildCoordinatorSynthesisSection(): string {
  return [
    '## When synthesising results',
    'You will be given completed task outputs and asked to synthesise a final answer.',
    'Write a clear, comprehensive response that addresses the original goal.',
  ].join('\n')
}

/** Build the decomposition prompt for the coordinator. */
export function buildDecompositionPrompt(goal: string, agents: AgentConfig[]): string {
  const names = agents.map((a) => a.name).join(', ')
  return [
    `Decompose the following goal into tasks for your team (${names}).`,
    '',
    `## Goal`,
    goal,
    '',
    'Return ONLY the JSON task array. Do not use a Markdown code fence.',
  ].join('\n')
}

/**
 * Build the base coordinator {@link AgentConfig} shared by the decomposition
 * and synthesis passes. Falls back to orchestrator defaults for any field the
 * caller's {@link CoordinatorConfig} leaves unset.
 */
export function buildCoordinatorBaseConfig(
  config: OrchestratorConfig,
  coordinatorOverrides: CoordinatorConfig | undefined,
  agentConfigs: AgentConfig[],
  hasVerifyJudges: boolean,
): AgentConfig {
  return {
    name: 'coordinator',
    model: coordinatorOverrides?.model ?? config.defaultModel,
    ...(coordinatorOverrides?.adapter !== undefined ? { adapter: coordinatorOverrides.adapter } : {}),
    provider: coordinatorOverrides?.provider ?? config.defaultProvider,
    baseURL: coordinatorOverrides?.baseURL ?? config.defaultBaseURL,
    apiKey: coordinatorOverrides?.apiKey ?? config.defaultApiKey,
    egressPolicy: config.egressPolicy,
    systemPrompt: buildCoordinatorPrompt(
      agentConfigs,
      coordinatorOverrides,
      hasVerifyJudges,
      {
        defaultModel: config.defaultModel,
        defaultToolPreset: config.defaultToolPreset,
      },
    ),
    maxTurns: coordinatorOverrides?.maxTurns ?? 3,
    maxTokens: coordinatorOverrides?.maxTokens,
    temperature: coordinatorOverrides?.temperature,
    topP: coordinatorOverrides?.topP,
    topK: coordinatorOverrides?.topK,
    minP: coordinatorOverrides?.minP,
    parallelToolCalls: coordinatorOverrides?.parallelToolCalls,
    frequencyPenalty: coordinatorOverrides?.frequencyPenalty,
    presencePenalty: coordinatorOverrides?.presencePenalty,
    extraBody: coordinatorOverrides?.extraBody,
    toolPreset: coordinatorOverrides?.toolPreset,
    tools: coordinatorOverrides?.tools,
    disallowedTools: coordinatorOverrides?.disallowedTools,
    onToolCall: coordinatorOverrides?.onToolCall ?? config.onToolCall,
    shellExecutor:
      coordinatorOverrides?.shellExecutor ?? config.defaultShellExecutor,
    cwd: coordinatorOverrides?.cwd === undefined
      ? config.defaultCwd
      : coordinatorOverrides.cwd,
    loopDetection: coordinatorOverrides?.loopDetection,
    timeoutMs: coordinatorOverrides?.timeoutMs,
    callTimeoutMs: coordinatorOverrides?.callTimeoutMs,
  }
}

/**
 * Run the coordinator synthesis pass over completed task results. Returns the
 * synthesis result plus updated cumulative usage, or `null` when synthesis is
 * skipped (run aborted, or the token budget was already exhausted before the
 * pass). Emits `budget_exceeded` (when synthesis tips over budget) and
 * `agent_complete`, mirroring the inline `runTeam` path. Does not mutate
 * `agentResults` — the caller records the `'coordinator'` entry.
 */
export async function runCoordinatorSynthesis(
  config: OrchestratorConfig,
  team: Team,
  queue: TaskQueue,
  goal: string,
  coordinatorBaseConfig: AgentConfig,
  opts: {
    readonly identity: RunIdentity
    readonly modelRouting?: ModelRoutingPolicy
    readonly runId?: string
    readonly abortSignal?: AbortSignal
    readonly cumulativeUsage: TokenUsage
    readonly cumulativeCost: number
    readonly maxTokenBudget?: number
    readonly maxCostBudget?: number
    readonly estimateCost?: OrchestratorConfig['estimateCost']
    readonly traceRuntime?: TraceRuntime
    readonly consumedTaskSpans?: readonly TraceSpan[]
    readonly journal?: JournalRecorder
  },
): Promise<{ readonly result: AgentRunResult; readonly cumulativeUsage: TokenUsage; readonly cumulativeCost: number } | null> {
  if (opts.abortSignal?.aborted) return null
  if (
    opts.maxTokenBudget !== undefined
    && totalTokens(opts.cumulativeUsage) > opts.maxTokenBudget
  ) {
    return null
  }
  if (
    opts.maxCostBudget !== undefined
    && opts.estimateCost !== undefined
    && opts.cumulativeCost > opts.maxCostBudget
  ) {
    return null
  }

  const synthesisPrompt = await buildSynthesisPrompt(goal, queue.list(), team)
  const synthesisConfig = withModelRoute(
    coordinatorBaseConfig,
    routeMatches(opts.modelRouting, { phase: 'synthesis', agent: 'coordinator' }),
  )
  const synthesisAgent = buildAgent(synthesisConfig)
  const synthTraceOptions: Partial<RunOptions> = {
    identity: opts.identity,
    runId: opts.identity.runId,
    ...(opts.traceRuntime ? {
      traceRuntime: opts.traceRuntime,
      traceSpan: opts.traceRuntime.root,
      tracePhase: 'synthesis',
      traceLinks: (opts.consumedTaskSpans ?? []).map((span) => ({
        traceId: opts.identity.traceId,
        spanId: span.spanId,
        relation: 'consumed' as const,
      })),
    } : {}),
    ...(config.onTrace
      ? { onTrace: config.onTrace, traceAgent: 'coordinator' }
      : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.journal ? { journal: opts.journal } : {}),
  }
  let result = await synthesisAgent.run(synthesisPrompt, synthTraceOptions)
  const accounting = applyBudgetAccounting({
    currentUsage: opts.cumulativeUsage,
    currentCost: opts.cumulativeCost,
    usage: result.tokenUsage,
    maxTokenBudget: opts.maxTokenBudget,
    maxCostBudget: opts.maxCostBudget,
    estimateCost: opts.estimateCost,
    costContext: buildCostEstimateContext({
      agentName: 'coordinator',
      model: synthesisConfig.model ?? config.defaultModel ?? DEFAULT_MODEL,
      provider: synthesisConfig.provider,
      phase: 'synthesis',
    }),
  })

  if (accounting.exceeded) {
    emitBudgetExceeded(config, accounting.exceeded, 'coordinator')
    result = {
      ...result,
      success: false,
      budgetExceeded: true,
      ...classifyRunFailure(accounting.exceeded),
    }
  }

  config.onProgress?.({
    type: 'agent_complete',
    agent: 'coordinator',
    data: result,
  })

  return {
    result,
    cumulativeUsage: accounting.cumulativeUsage,
    cumulativeCost: accounting.cumulativeCost,
  }
}

/** Build the synthesis prompt shown to the coordinator after all tasks complete. */
export async function buildSynthesisPrompt(
  goal: string,
  tasks: Task[],
  team: Team,
): Promise<string> {
  const completedTasks = tasks.filter((t) => t.status === 'completed')
  const failedTasks = tasks.filter((t) => t.status === 'failed')
  const skippedTasks = tasks.filter((t) => t.status === 'skipped')

  const resultSections = completedTasks.map((t) => {
    const assignee = t.assignee ?? 'unknown'
    return `### ${t.title} (completed by ${assignee})\n${t.result ?? '(no output)'}`
  })

  const failureSections = failedTasks.map(
    (t) => `### ${t.title} (FAILED)\nError: ${t.result ?? 'unknown error'}`,
  )

  const skippedSections = skippedTasks.map(
    (t) => `### ${t.title} (SKIPPED)\nReason: ${t.result ?? 'approval rejected'}`,
  )

  // Also include shared memory summary for additional context
  let memorySummary = ''
  const sharedMem = team.getSharedMemoryInstance()
  if (sharedMem) {
    memorySummary = await sharedMem.getSummary()
  }

  return [
    `## Original Goal`,
    goal,
    '',
    `## Task Results`,
    ...resultSections,
    ...(failureSections.length > 0 ? ['', '## Failed Tasks', ...failureSections] : []),
    ...(skippedSections.length > 0 ? ['', '## Skipped Tasks', ...skippedSections] : []),
    ...(memorySummary ? ['', memorySummary] : []),
    '',
    '## Your Task',
    'Synthesise the above results into a comprehensive final answer that addresses the original goal.',
    'If some tasks failed or were skipped, note any gaps in the result.',
  ].join('\n')
}

/**
 * Load a list of task specs into a queue.
 *
 * Handles title-based `dependsOn` references by building a title→id map first,
 * then resolving them to real IDs before adding tasks to the queue.
 */
export function loadSpecsIntoQueue(
  specs: ReadonlyArray<ParsedTaskSpec & {
    memoryScope?: 'dependencies' | 'all'
    dependencyPayload?: 'output' | 'structured' | 'both'
    maxRetries?: number
    retryDelayMs?: number
    retryBackoff?: number
    role?: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    metadata?: TaskMetadata
    requires?: TaskRequirements
  }>,
  agentConfigs: AgentConfig[],
  queue: TaskQueue,
  verifyJudges?: readonly AgentConfig[],
): void {
  const agentNames = new Set(agentConfigs.map((a) => a.name))
  const normalizeTitle = (title: string): string => title.toLowerCase().trim()
  const titleCounts = new Map<string, number>()
  for (const spec of specs) {
    const key = normalizeTitle(spec.title)
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }

  // First pass: create tasks (without dependencies) to get stable IDs.
  const titleToId = new Map<string, string>()
  const createdTasks: Task[] = []

  for (const spec of specs) {
    const task = createTask({
      title: spec.title,
      description: spec.description,
      assignee: spec.assignee && agentNames.has(spec.assignee)
        ? spec.assignee
        : undefined,
      memoryScope: spec.memoryScope,
      dependencyPayload: spec.dependencyPayload,
      maxRetries: spec.maxRetries,
      retryDelayMs: spec.retryDelayMs,
      retryBackoff: spec.retryBackoff,
      role: spec.role,
      priority: spec.priority,
      metadata: spec.metadata,
      requires: spec.requires,
      verify: resolveVerify(spec.verify, verifyJudges),
    })
    const titleKey = normalizeTitle(spec.title)
    if ((titleCounts.get(titleKey) ?? 0) === 1) {
      titleToId.set(titleKey, task.id)
    }
    createdTasks.push(task)
  }

  // Second pass: resolve title-based dependsOn to IDs. Keep the resolved
  // tasks local until the whole graph has been validated so callers never
  // observe a partially loaded invalid plan.
  const resolvedTasks: Array<{ task: Task; unresolvedDeps: string[] }> = []
  for (let i = 0; i < createdTasks.length; i++) {
    const spec = specs[i]!
    const task = createdTasks[i]!

    if (!spec.dependsOn || spec.dependsOn.length === 0) {
      resolvedTasks.push({ task, unresolvedDeps: [] })
      continue
    }

    const resolvedDeps: string[] = []
    const unresolvedDeps: string[] = []
    for (const depRef of spec.dependsOn) {
      // Accept both raw IDs and title strings
      const byId = createdTasks.find((t) => t.id === depRef)
      const depTitleKey = normalizeTitle(depRef)
      const byTitle = titleToId.get(depTitleKey)
      const resolvedId = byId?.id ?? byTitle
      if (resolvedId) {
        resolvedDeps.push(resolvedId)
      } else {
        const count = titleCounts.get(depTitleKey) ?? 0
        unresolvedDeps.push(count > 1 ? `${depRef} (ambiguous duplicate title)` : depRef)
      }
    }

    const taskWithDeps: Task = {
      ...task,
      dependsOn: resolvedDeps.length > 0 ? resolvedDeps : undefined,
    }
    resolvedTasks.push({ task: taskWithDeps, unresolvedDeps })
  }

  const validation = validateTaskDependencies(resolvedTasks.map(({ task }) => task))
  if (!validation.valid) {
    throw Object.assign(
      new Error(`Invalid task dependencies: ${validation.errors.join(' ')}`),
      { code: 'INVALID_TASK_DEPENDENCIES' },
    )
  }

  for (const { task, unresolvedDeps } of resolvedTasks) {
    queue.add(task)
    if (unresolvedDeps.length > 0) {
      queue.fail(
        task.id,
        `Unresolved dependency reference(s): ${unresolvedDeps.join(', ')}`,
      )
    }
  }
}

/** Build an {@link AgentPool} from a list of agent configurations. */
