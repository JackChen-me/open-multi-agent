/**
 * @fileoverview Opt-in runtime plan repair contracts and validation helpers.
 *
 * The executor owns the outcome barrier and durable commit ordering. This
 * module keeps policy resolution and eligibility checks deterministic.
 */

import type {
  AgentConfig,
  PlanPatch,
  RecoveryOptions,
  Task,
  TaskOutcome,
  TaskVerificationOutcome,
  AgentRunResult,
} from '../types.js'
import type { TaskQueue } from '../task/queue.js'
import { AgentSelector } from './agent-selector.js'

export interface ResolvedRecoveryOptions {
  readonly mode: 'fixed' | 'repairable'
  readonly onTaskOutcome?: RecoveryOptions['onTaskOutcome']
  readonly onPlanPatch?: RecoveryOptions['onPlanPatch']
  readonly maxPlanRevisions: number
  readonly maxAddedTasks: number
}

const DEFAULT_MAX_PLAN_REVISIONS = 3
const DEFAULT_MAX_ADDED_TASKS = 20

export function resolveRecoveryOptions(
  configured: RecoveryOptions | undefined,
  perRun: RecoveryOptions | undefined,
): ResolvedRecoveryOptions {
  const selected = perRun ?? configured
  if (!selected || (selected.mode ?? 'fixed') === 'fixed') {
    return {
      mode: 'fixed',
      maxPlanRevisions: DEFAULT_MAX_PLAN_REVISIONS,
      maxAddedTasks: DEFAULT_MAX_ADDED_TASKS,
    }
  }
  if (selected.onTaskOutcome && selected.replanner) {
    throw new Error("Recovery mode 'repairable' accepts either onTaskOutcome or replanner, not both.")
  }
  const onTaskOutcome = selected.onTaskOutcome
    ?? (selected.replanner
      ? (outcome: TaskOutcome) => selected.replanner!.replan(outcome)
      : undefined)
  if (!onTaskOutcome) {
    throw new Error("Recovery mode 'repairable' requires onTaskOutcome or replanner.")
  }
  return {
    mode: 'repairable',
    onTaskOutcome,
    onPlanPatch: selected.onPlanPatch,
    maxPlanRevisions: positiveInteger(
      selected.maxPlanRevisions,
      DEFAULT_MAX_PLAN_REVISIONS,
      'maxPlanRevisions',
    ),
    maxAddedTasks: positiveInteger(
      selected.maxAddedTasks,
      DEFAULT_MAX_ADDED_TASKS,
      'maxAddedTasks',
    ),
  }
}

export function buildTaskOutcome(input: {
  readonly queue: TaskQueue
  readonly task: Task
  readonly result: AgentRunResult
  readonly verification?: TaskVerificationOutcome
  readonly tokenBudgetRemaining?: number
  readonly costBudgetRemaining?: number
}): TaskOutcome {
  const kind = input.verification?.verdict === 'rejected'
    ? 'verification_rejected'
    : input.result.success
      ? 'success'
      : 'failure'
  return {
    kind,
    task: cloneTask(input.task),
    result: cloneAgentResult(input.result),
    ...(input.verification ? { verification: { ...input.verification } } : {}),
    planRevision: input.queue.getPlanRevision(),
    tasks: input.queue.list().map(cloneTask),
    ...(input.tokenBudgetRemaining !== undefined
      ? { tokenBudgetRemaining: input.tokenBudgetRemaining }
      : {}),
    ...(input.costBudgetRemaining !== undefined
      ? { costBudgetRemaining: input.costBudgetRemaining }
      : {}),
  }
}

export function validatePlanPatchEligibility(
  patch: PlanPatch,
  queue: TaskQueue,
  agents: readonly AgentConfig[],
  context: {
    readonly defaultProvider?: AgentConfig['provider']
    readonly defaultToolPreset?: 'readonly' | 'readwrite' | 'full'
  },
): void {
  const byName = new Map(agents.map((agent) => [agent.name, agent]))
  const selector = new AgentSelector()

  for (const retarget of patch.retargetPending ?? []) {
    const task = queue.get(retarget.taskId)
    const agent = byName.get(retarget.assignee)
    if (!task) throw new Error(`Plan patch retarget task "${retarget.taskId}" not found.`)
    if (!agent) throw new Error(`Plan patch retarget agent "${retarget.assignee}" is not in the team roster.`)
    const selection = selector.select(task, [agent], {
      defaultProvider: context.defaultProvider,
      defaultToolPreset: context.defaultToolPreset,
      includeDelegateTool: true,
    })
    if (selection.error) {
      throw new Error(
        `Plan patch retarget agent "${retarget.assignee}" is ineligible for task ` +
          `"${task.id}": ${selection.error.reasons.join(' ')}`,
      )
    }
  }

  for (const task of patch.addTasks ?? []) {
    const candidates = task.assignee === undefined
      ? agents
      : byName.has(task.assignee)
        ? [byName.get(task.assignee)!]
        : []
    if (task.assignee !== undefined && candidates.length === 0) {
      throw new Error(`Plan patch task "${task.key}" names unknown assignee "${task.assignee}".`)
    }
    const selection = selector.select(task, candidates, {
      defaultProvider: context.defaultProvider,
      defaultToolPreset: context.defaultToolPreset,
      includeDelegateTool: true,
    })
    if (selection.error) {
      throw new Error(
        `No eligible agent for plan patch task "${task.key}": ${selection.error.reasons.join(' ')}`,
      )
    }
  }
}

export function countAddedTasks(revisions: readonly { readonly addedTasks: Readonly<Record<string, string>> }[]): number {
  return revisions.reduce((sum, revision) => sum + Object.keys(revision.addedTasks).length, 0)
}

export function planPatchSignature(patch: PlanPatch): string {
  return JSON.stringify({
    reason: patch.reason,
    addTasks: patch.addTasks ?? [],
    retargetPending: patch.retargetPending ?? [],
    supersedePending: patch.supersedePending ?? [],
  })
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Recovery ${name} must be a positive integer.`)
  }
  return value
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    ...(task.dependsOn !== undefined ? { dependsOn: [...task.dependsOn] } : {}),
    ...(task.metadata !== undefined ? { metadata: { ...task.metadata } } : {}),
    ...(task.requires !== undefined
      ? {
          requires: {
            ...task.requires,
            ...(task.requires.requiredTools !== undefined
              ? { requiredTools: [...task.requires.requiredTools] }
              : {}),
            ...(task.requires.requiredCapabilities !== undefined
              ? { requiredCapabilities: [...task.requires.requiredCapabilities] }
              : {}),
          },
        }
      : {}),
    ...(task.verify !== undefined
      ? { verify: { ...task.verify, judges: [...task.verify.judges] } }
      : {}),
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  }
}

function cloneAgentResult(result: AgentRunResult): AgentRunResult {
  return {
    ...result,
    messages: structuredClone(result.messages),
    tokenUsage: { ...result.tokenUsage },
    toolCalls: structuredClone(result.toolCalls),
    ...(result.errorInfo !== undefined ? { errorInfo: { ...result.errorInfo } } : {}),
  }
}
