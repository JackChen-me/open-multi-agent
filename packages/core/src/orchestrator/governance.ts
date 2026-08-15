import type {
  AgentConfig,
  GovernanceConclusion,
  GovernanceUnsatisfiedReason,
  RunFlag,
  RunTaskSpec,
  RunTeamOptions,
  TeamRunResult,
} from '../types.js'
import type { ExecutionReceipt } from '../observability/execution-receipt.js'

export const GOVERNANCE_OVERRIDDEN_FLAG =
  'governance-overridden' as const satisfies RunFlag
export const REVIEW_SKIPPED_DUE_TO_BUDGET_FLAG =
  'review-skipped-due-to-budget' as const satisfies RunFlag

/** The structured governance fields accepted by {@link RunTeamOptions}. */
export type GovernanceDeclaration = Pick<
  RunTeamOptions,
  'governanceIntent' | 'requiredRoles' | 'requiredOrder'
>

export interface GovernanceRunResolution {
  /** True when an explicit `mode` displaced the declared governance topology. */
  readonly modeOverride?: boolean
  /** True when the application selected the preferred-under-budget Single path. */
  readonly preferredBudgetDegraded?: boolean
}

/**
 * Compare required governance with an execution receipt.
 *
 * The evaluator deliberately has no access to agent output text. Required
 * order is established by both observed start order and a dependency path
 * between every adjacent declared role.
 */
export function evaluateGovernance(
  declaration: GovernanceDeclaration | undefined,
  receipt: ExecutionReceipt,
): GovernanceConclusion {
  if (declaration?.governanceIntent !== 'required') return 'not-applicable'

  const requiredRoles = declaration.requiredRoles ?? []
  if (requiredRoles.length === 0 || new Set(requiredRoles).size !== requiredRoles.length) {
    return 'unsatisfied'
  }

  const executedRoles = new Set(receipt.rolesExecuted)
  if (requiredRoles.some((role) => !executedRoles.has(role))) return 'unsatisfied'

  const requiredOrder = declaration.requiredOrder
  if (requiredOrder !== undefined) {
    if (!isPermutation(requiredOrder, requiredRoles)) return 'unsatisfied'
    if (!matchesRequiredOrder(requiredOrder, receipt, executedRoles)) return 'unsatisfied'
  }

  if (requiredRoles.length >= 2 && !receipt.independentReviewOccurred) {
    return 'unsatisfied'
  }

  return 'satisfied'
}

/**
 * Attach the I3 conclusion plus additive I5-style conflict disclosures.
 * Runtime success remains untouched; callers must continue to read the
 * governance fields independently.
 */
export function finalizeGovernanceRun(
  result: TeamRunResult,
  declaration: GovernanceDeclaration | undefined,
  receipt: ExecutionReceipt,
  resolution: GovernanceRunResolution = {},
): TeamRunResult {
  const governanceConclusion = evaluateGovernance(declaration, receipt)
  let governanceReason: GovernanceUnsatisfiedReason | undefined
  const flags = new Set(result.flags ?? [])

  if (
    declaration?.governanceIntent === 'required'
    && governanceConclusion === 'unsatisfied'
  ) {
    if (resolution.modeOverride) {
      governanceReason = 'overridden'
      flags.add(GOVERNANCE_OVERRIDDEN_FLAG)
    } else if (result.status?.code === 'budget_exhausted') {
      governanceReason = 'budget'
    }
  }

  if (resolution.preferredBudgetDegraded) {
    flags.add(REVIEW_SKIPPED_DUE_TO_BUDGET_FLAG)
  }

  return {
    ...result,
    governanceConclusion,
    ...(governanceReason !== undefined ? { governanceReason } : {}),
    ...(flags.size > 0 ? { flags: [...flags] } : {}),
  }
}

/**
 * Build the explicit role topology requested by a structured governance
 * declaration. `undefined` means the caller selected the legacy automatic
 * `runTeam()` route.
 */
export function buildGovernanceTaskSpecs(
  goal: string,
  agentConfigs: readonly AgentConfig[],
  options?: RunTeamOptions,
): readonly RunTaskSpec[] | undefined {
  const intent = options?.governanceIntent
  if (intent !== 'required' && intent !== 'preferred') return undefined

  const requiredRoles = options?.requiredRoles ?? []
  if (requiredRoles.length === 0) {
    throw new Error(
      `runTeam governanceIntent '${intent}' requires at least one role in requiredRoles.`,
    )
  }

  const duplicateRoles = findDuplicates(requiredRoles)
  if (duplicateRoles.length > 0) {
    throw new Error(
      `runTeam requiredRoles must contain unique team agent names; duplicate role(s): ${duplicateRoles.join(', ')}.`,
    )
  }

  const rosterNames = new Set(agentConfigs.map((agent) => agent.name))
  const unknownRoles = requiredRoles.filter((role) => !rosterNames.has(role))
  if (unknownRoles.length > 0) {
    throw new Error(
      `runTeam requiredRoles must exist in the team roster; unknown role(s): ${unknownRoles.join(', ')}.`,
    )
  }

  const requiredOrder = options?.requiredOrder
  if (requiredOrder !== undefined) {
    const declaredRoles = new Set(requiredRoles)
    const unknownOrderRoles = requiredOrder.filter((role) => !declaredRoles.has(role))
    if (unknownOrderRoles.length > 0) {
      throw new Error(
        `runTeam requiredOrder may reference only requiredRoles; invalid role(s): ${unknownOrderRoles.join(', ')}.`,
      )
    }

    const duplicateOrderRoles = findDuplicates(requiredOrder)
    if (duplicateOrderRoles.length > 0) {
      throw new Error(
        `runTeam requiredOrder must contain each required role once; duplicate role(s): ${duplicateOrderRoles.join(', ')}.`,
      )
    }

    if (requiredOrder.length !== requiredRoles.length) {
      const orderedRoles = new Set(requiredOrder)
      const missingRoles = requiredRoles.filter((role) => !orderedRoles.has(role))
      throw new Error(
        `runTeam requiredOrder must be a permutation of requiredRoles; missing role(s): ${missingRoles.join(', ')}.`,
      )
    }
  }

  const executionOrder = requiredOrder ?? requiredRoles
  // Keep task text role-neutral: assignment selects the roster agent, whose
  // systemPrompt owns the role semantics. Titles exist only for dependency IDs.
  const titleByRole = new Map(
    executionOrder.map((role, index) => [role, `Governance task ${index + 1}`]),
  )

  return executionOrder.map((role, index) => ({
    title: titleByRole.get(role)!,
    description: goal,
    assignee: role,
    ...(index > 0 && requiredOrder !== undefined
      ? { dependsOn: [titleByRole.get(executionOrder[index - 1]!)!] }
      : {}),
    memoryScope: 'dependencies',
  }))
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function isPermutation(values: readonly string[], expected: readonly string[]): boolean {
  if (values.length !== expected.length || new Set(values).size !== values.length) return false
  const expectedValues = new Set(expected)
  return values.every((value) => expectedValues.has(value))
}

function matchesRequiredOrder(
  requiredOrder: readonly string[],
  receipt: ExecutionReceipt,
  executedRoles: ReadonlySet<string>,
): boolean {
  const positionByRole = new Map(receipt.executionOrder.map((role, index) => [role, index]))
  const adjacency = new Map<string, Set<string>>()
  for (const edge of receipt.dependencyEdges) {
    if (!executedRoles.has(edge.from) || !executedRoles.has(edge.to)) continue
    const targets = adjacency.get(edge.from) ?? new Set<string>()
    targets.add(edge.to)
    adjacency.set(edge.from, targets)
  }

  for (let index = 1; index < requiredOrder.length; index++) {
    const predecessor = requiredOrder[index - 1]!
    const successor = requiredOrder[index]!
    const predecessorPosition = positionByRole.get(predecessor)
    const successorPosition = positionByRole.get(successor)
    if (
      predecessorPosition === undefined
      || successorPosition === undefined
      || predecessorPosition >= successorPosition
      || !hasDependencyPath(predecessor, successor, adjacency)
    ) {
      return false
    }
  }

  return true
}

function hasDependencyPath(
  from: string,
  to: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const pending = [from]
  const visited = new Set([from])

  while (pending.length > 0) {
    const current = pending.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true
      if (visited.has(next)) continue
      visited.add(next)
      pending.push(next)
    }
  }

  return false
}
