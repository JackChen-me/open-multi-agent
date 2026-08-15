/**
 * Explainable, deterministic agent selection.
 *
 * Hard eligibility is based only on framework-resolved tool grants, backend
 * discriminants, providers, and caller-declared capability tags. In
 * particular, permissions and capabilities are never inferred from
 * `systemPrompt`, names, or task prose.
 */

import type {
  AgentConfig,
  OrchestratorConfig,
  Task,
  TaskRequirementIssue,
  TaskRequirements,
} from '../types.js'
import type { SupportedProvider } from '../llm/adapter.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'
import {
  applyDefaultToolPreset,
  resolveAgentToolDefinitions,
} from './agent-config.js'

export type AgentSelectionSubject =
  | string
  | {
      readonly title: string
      readonly description: string
      readonly requires?: TaskRequirements
    }

export interface AgentSelectorContext {
  readonly defaultProvider?: SupportedProvider
  readonly defaultToolPreset?: OrchestratorConfig['defaultToolPreset']
  /** Team workers register delegation; standalone selection does not. */
  readonly includeDelegateTool?: boolean
  /** Resolve the effective worker config for one task before hard filtering. */
  readonly resolveCandidate?: (task: Task, candidate: AgentConfig) => AgentConfig
}

export interface EligibleAgentScore {
  readonly agent: AgentConfig
  readonly score: number
  readonly reasons: readonly string[]
}

export interface AgentSelectionFailure {
  readonly code: 'NO_ELIGIBLE_AGENT'
  readonly message: string
  readonly reasons: readonly string[]
}

export interface AgentSelectionResult {
  readonly agent?: AgentConfig
  readonly score: number
  readonly reasons: readonly string[]
  readonly eligible: readonly EligibleAgentScore[]
  readonly error?: AgentSelectionFailure
}

interface SubjectDetails {
  readonly text: string
  readonly requires: TaskRequirements
}

function subjectDetails(subject: AgentSelectionSubject): SubjectDetails {
  return typeof subject === 'string'
    ? { text: subject, requires: {} }
    : {
        text: `${subject.title} ${subject.description}`,
        requires: subject.requires ?? {},
      }
}

function backendKind(agent: AgentConfig): 'llm' | 'process' | 'acp' {
  return agent.backend?.kind ?? 'llm'
}

function missingValues(
  required: readonly string[] | undefined,
  available: ReadonlySet<string>,
): string[] {
  return required?.filter((value) => !available.has(value)) ?? []
}

/**
 * Unified selector used by the short-circuit and capability-match paths.
 *
 * Declared capability affinity is compared before keyword affinity. The
 * returned numeric score encodes that ordering: each capability-affinity
 * point occupies a whole-number band while keyword affinity is a monotonic
 * fraction within that band. With no declared capabilities, keyword ordering
 * is therefore exactly the legacy ordering.
 */
export class AgentSelector {
  select(
    subject: AgentSelectionSubject,
    candidates: readonly AgentConfig[],
    context: AgentSelectorContext = {},
  ): AgentSelectionResult {
    const { text, requires } = subjectDetails(subject)
    const subjectKeywords = extractKeywords(text)
    const eligible: EligibleAgentScore[] = []
    const excludedReasons: string[] = []

    for (const candidate of candidates) {
      const effective = applyDefaultToolPreset(
        candidate,
        context.defaultToolPreset,
      )
      const grantedTools = new Set(
        resolveAgentToolDefinitions(effective, {
          includeDelegateTool: context.includeDelegateTool,
        }).map((tool) => tool.name),
      )
      const declaredCapabilities = new Set(candidate.capabilities ?? [])
      const missingTools = missingValues(requires.requiredTools, grantedTools)
      const missingCapabilities = missingValues(
        requires.requiredCapabilities,
        declaredCapabilities,
      )
      const candidateBackend = backendKind(candidate)
      // External backends and custom adapters own their provider lifecycle;
      // AgentConfig.provider/defaultProvider do not describe their real backend.
      const candidateProvider = candidate.backend !== undefined || candidate.adapter !== undefined
        ? undefined
        : candidate.provider ?? context.defaultProvider
      const ineligible: string[] = []

      if (missingTools.length > 0) {
        ineligible.push(`missing required tools: ${missingTools.join(', ')}`)
      }
      if (missingCapabilities.length > 0) {
        ineligible.push(`missing required capabilities: ${missingCapabilities.join(', ')}`)
      }
      if (
        requires.requiredBackend !== undefined
        && candidateBackend !== requires.requiredBackend
      ) {
        ineligible.push(
          `backend ${candidateBackend} does not satisfy required backend ${requires.requiredBackend}`,
        )
      }
      if (
        requires.requiredProvider !== undefined
        && candidateProvider !== requires.requiredProvider
      ) {
        ineligible.push(
          `provider ${candidateProvider ?? 'undeclared'} does not satisfy required provider ${requires.requiredProvider}`,
        )
      }

      if (ineligible.length > 0) {
        excludedReasons.push(`${candidate.name} excluded: ${ineligible.join('; ')}.`)
        continue
      }

      const agentText = `${candidate.name} ${candidate.systemPrompt ?? ''}`
      const agentKeywords = extractKeywords(
        `${candidate.name} ${candidate.systemPrompt ?? ''} ${candidate.model}`,
      )
      const keywordAffinity =
        keywordScore(agentText, subjectKeywords)
        + keywordScore(text, agentKeywords)
      const capabilityText = (candidate.capabilities ?? []).join(' ')
      const capabilityKeywords = extractKeywords(capabilityText)
      const capabilityAffinity = capabilityText.length === 0
        ? 0
        : keywordScore(capabilityText, subjectKeywords)
          + keywordScore(text, capabilityKeywords)
      const keywordFraction = keywordAffinity === 0
        ? 0
        : keywordAffinity / (keywordAffinity + 1)
      const score = capabilityAffinity + keywordFraction

      eligible.push({
        agent: candidate,
        score,
        reasons: [
          `${candidate.name} passed all explicit hard requirements.`,
          `declared capability affinity: ${capabilityAffinity}.`,
          `keyword affinity: ${keywordAffinity}.`,
        ],
      })
    }

    if (eligible.length === 0) {
      const reasons = excludedReasons.length > 0
        ? excludedReasons
        : ['No candidates were provided.']
      return {
        agent: undefined,
        score: 0,
        reasons,
        eligible: [],
        error: {
          code: 'NO_ELIGIBLE_AGENT',
          message: 'No agent satisfies all explicit task requirements.',
          reasons,
        },
      }
    }

    eligible.sort((left, right) => {
      const scoreOrder = right.score - left.score
      if (scoreOrder !== 0) return scoreOrder
      if (left.agent.name < right.agent.name) return -1
      if (left.agent.name > right.agent.name) return 1
      return 0
    })
    const selected = eligible[0]!
    return {
      agent: selected.agent,
      score: selected.score,
      reasons: [
        ...excludedReasons,
        ...selected.reasons,
        `${selected.agent.name} selected by score, then ascending name tie-break.`,
      ],
      eligible,
    }
  }
}

export function hasExplicitTaskRequirements(
  requires: TaskRequirements | undefined,
): boolean {
  return requires !== undefined && (
    (requires.requiredTools?.length ?? 0) > 0
    || (requires.requiredCapabilities?.length ?? 0) > 0
    || requires.requiredBackend !== undefined
    || requires.requiredProvider !== undefined
  )
}

/**
 * Validate every task's hard requirements before any task is dispatched.
 *
 * Unassigned tasks must have at least one eligible roster candidate. Explicitly
 * assigned tasks are checked only against their named agent so assignment
 * conflicts fail instead of being silently reassigned.
 */
export function validateTaskRequirements(
  tasks: readonly Task[],
  candidates: readonly AgentConfig[],
  context: AgentSelectorContext = {},
): readonly TaskRequirementIssue[] {
  const selector = new AgentSelector()
  const issues: TaskRequirementIssue[] = []

  for (const task of tasks) {
    if (
      task.status === 'completed'
      || task.status === 'failed'
      || task.status === 'skipped'
    ) continue
    if (!hasExplicitTaskRequirements(task.requires)) continue

    if (task.assignee !== undefined) {
      const assignee = candidates.find((candidate) => candidate.name === task.assignee)
      // Unknown assignees retain the existing INVALID_ASSIGNEE/not-found path.
      if (!assignee) continue
      const effectiveAssignee = context.resolveCandidate?.(task, assignee) ?? assignee
      const selection = selector.select({
        title: task.title,
        description: task.description,
        requires: task.requires,
      }, [effectiveAssignee], context)
      if (selection.error) {
        issues.push({
          code: 'ASSIGNEE_REQUIREMENTS_MISMATCH',
          taskId: task.id,
          taskTitle: task.title,
          assignee: task.assignee,
          reasons: selection.error.reasons,
        })
      }
      continue
    }

    const effectiveCandidates = candidates.map((candidate) =>
      context.resolveCandidate?.(task, candidate) ?? candidate)
    const selection = selector.select({
      title: task.title,
      description: task.description,
      requires: task.requires,
    }, effectiveCandidates, context)
    if (selection.error) {
      issues.push({
        code: 'NO_ELIGIBLE_AGENT',
        taskId: task.id,
        taskTitle: task.title,
        reasons: selection.error.reasons,
      })
    }
  }

  return issues
}
