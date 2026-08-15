import type {
  AgentRunResult,
  RunFlag,
  TeamRunResult,
  TraceEvent,
} from '../types.js'

/** A dependency observed between tasks assigned to different worker roles. */
export interface ExecutionReceiptDependencyEdge {
  readonly from: string
  readonly to: string
}

/** Approval fact derived from a run result; the primary row stays in MemoryStore. */
export interface ExecutionReceiptApprovalDecision {
  readonly requestId: string
  readonly scope: 'plan' | 'task_round' | 'task_dispatch' | 'tool_call'
  readonly requestHash: string
  readonly decision: 'approved' | 'rejected'
  readonly reviewerId: string
  readonly reviewerDisplayName?: string
  readonly decidedAt: string
}

/**
 * Structured execution facts derived from run records and optional trace events.
 * Agent output text is deliberately excluded as a source of evidence.
 */
export interface ExecutionReceipt {
  /** Stable ID referenced by the corresponding routing-decision record. */
  readonly id?: string
  /** Stable decision ID referenced by this receipt. */
  readonly routingDecisionId?: string
  /** Trace span containing the decision-time explanation, when traced. */
  readonly routingDecisionSpanId?: string
  /** Machine-readable warnings copied from the run result, when present. */
  readonly flags?: readonly RunFlag[]
  readonly mode: 'single' | 'multi-agent'
  /** Legacy worker/assignee list retained for compatibility. */
  readonly rolesExecuted: readonly string[]
  /** Explicit alias that distinguishes concrete worker instances from task roles. */
  readonly workerInstancesExecuted?: readonly string[]
  /** Distinct caller-declared logical task roles observed in executed tasks. */
  readonly taskRolesExecuted?: readonly string[]
  readonly executionOrder: readonly string[]
  readonly dependencyEdges: readonly ExecutionReceiptDependencyEdge[]
  readonly independentRolesCount: number
  readonly independentReviewOccurred: boolean
  readonly approvalDecisions?: readonly ExecutionReceiptApprovalDecision[]
  readonly totalTokens: {
    readonly input: number
    readonly output: number
  } | null
  readonly durationMs: number | null
  readonly partial: boolean
}

type UnknownRecord = Readonly<Record<string, unknown>>

interface TraceFacts {
  readonly events: readonly UnknownRecord[]
  readonly partial: boolean
}

interface TaskFact {
  readonly id?: string
  readonly role?: string
  readonly taskRole?: string
  readonly dependsOn: readonly string[]
  readonly startMs?: number
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isCoordinator(role: string): boolean {
  return role === 'coordinator' || role.startsWith('coordinator:')
}

function readWorkerRole(value: unknown): string | undefined {
  const role = readString(value)
  return role && role !== 'unknown' && !isCoordinator(role) ? role : undefined
}

function readTokenUsage(value: unknown): ExecutionReceipt['totalTokens'] {
  if (!isRecord(value)) return null
  const input = value['input_tokens']
  const output = value['output_tokens']
  return isFiniteNumber(input) && isFiniteNumber(output) ? { input, output } : null
}

function readFlags(value: unknown): readonly RunFlag[] | undefined {
  if (!Array.isArray(value)) return undefined
  const flags = value.filter((flag): flag is RunFlag =>
    flag === 'consequential-no-independence'
    || flag === 'governance-overridden'
    || flag === 'review-skipped-due-to-budget')
  return flags.length > 0 ? [...new Set(flags)] : undefined
}

function readApprovalDecisions(
  value: unknown,
): readonly ExecutionReceiptApprovalDecision[] | undefined {
  if (!Array.isArray(value)) return undefined
  const decisions: ExecutionReceiptApprovalDecision[] = []
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item['reviewer'])) continue
    const requestId = readString(item['requestId'])
    const scope = item['scope']
    const requestHash = readString(item['requestHash'])
    const decision = item['decision']
    const reviewerId = readString(item['reviewer']['id'])
    const reviewerDisplayName = readString(item['reviewer']['displayName'])
    const decidedAt = readString(item['decidedAt'])
    if (
      !requestId
      || (scope !== 'plan'
        && scope !== 'task_round'
        && scope !== 'task_dispatch'
        && scope !== 'tool_call')
      || !requestHash
      || (decision !== 'approved' && decision !== 'rejected')
      || !reviewerId
      || !decidedAt
    ) continue
    decisions.push({
      requestId,
      scope,
      requestHash,
      decision,
      reviewerId,
      ...(reviewerDisplayName ? { reviewerDisplayName } : {}),
      decidedAt,
    })
  }
  return decisions.length > 0 ? decisions : undefined
}

function readTraceFacts(trace: readonly TraceEvent[] | undefined): TraceFacts {
  if (trace === undefined) return { events: [], partial: false }
  if (!Array.isArray(trace)) return { events: [], partial: true }

  const events: UnknownRecord[] = []
  let partial = false
  for (const event of trace) {
    if (isRecord(event)) events.push(event)
    else partial = true
  }
  return { events, partial }
}

function readTraceTaskFacts(trace: TraceFacts): Map<string, TaskFact> {
  const facts = new Map<string, TaskFact>()
  for (const event of trace.events) {
    if (event['type'] !== 'task') continue
    const id = readString(event['taskId'])
    if (!id) continue

    const candidate: TaskFact = {
      id,
      role: readWorkerRole(event['agent']),
      taskRole: readString(event['taskRole']),
      dependsOn: [],
      startMs: isFiniteNumber(event['startMs']) ? event['startMs'] : undefined,
    }
    const existing = facts.get(id)
    if (!existing || (candidate.startMs !== undefined
      && (existing.startMs === undefined || candidate.startMs < existing.startMs))) {
      facts.set(id, candidate)
    }
  }
  return facts
}

function emptyReceipt(): ExecutionReceipt {
  return {
    mode: 'single',
    rolesExecuted: [],
    workerInstancesExecuted: [],
    executionOrder: [],
    dependencyEdges: [],
    independentRolesCount: 0,
    independentReviewOccurred: false,
    totalTokens: null,
    durationMs: null,
    partial: true,
  }
}

function isTeamRunResult(result: unknown): result is TeamRunResult {
  if (!isRecord(result)) return false
  return Array.isArray(result['tasks'])
    || result['agentResults'] instanceof Map
    || 'totalTokenUsage' in result
}

function buildAgentReceipt(result: AgentRunResult, trace: TraceFacts): ExecutionReceipt {
  const rawResult = result as unknown as UnknownRecord
  const agentEvents = trace.events.filter((event) => event['type'] === 'agent')
  const workerAgentEvents = agentEvents.filter((event) => readWorkerRole(event['agent']) !== undefined)
  const earliestByRole = new Map<string, number>()
  let missingRoleOrStart = false

  for (const event of workerAgentEvents) {
    const role = readWorkerRole(event['agent'])
    const startMs = event['startMs']
    if (!role || !isFiniteNumber(startMs)) {
      missingRoleOrStart = true
      continue
    }
    const previous = earliestByRole.get(role)
    if (previous === undefined || startMs < previous) earliestByRole.set(role, startMs)
  }

  const rolesExecuted = [...earliestByRole.keys()]
  const executionOrder = [...rolesExecuted].sort((left, right) =>
    earliestByRole.get(left)! - earliestByRole.get(right)!)

  const starts = workerAgentEvents
    .map((event) => event['startMs'])
    .filter(isFiniteNumber)
  const ends = workerAgentEvents
    .map((event) => event['endMs'])
    .filter(isFiniteNumber)
  const durationMs = starts.length > 0 && ends.length > 0
    ? Math.max(0, Math.max(...ends) - Math.min(...starts))
    : null
  const totalTokens = readTokenUsage(rawResult['tokenUsage'])
  const flags = readFlags(rawResult['flags'])
  const approvalDecisions = readApprovalDecisions(rawResult['approvalDecisions'])
  const partial = trace.partial
    || workerAgentEvents.length === 0
    || rolesExecuted.length === 0
    || missingRoleOrStart
    || durationMs === null
    || totalTokens === null

  return {
    ...(flags ? { flags } : {}),
    ...(approvalDecisions ? { approvalDecisions } : {}),
    mode: rolesExecuted.length > 1 ? 'multi-agent' : 'single',
    rolesExecuted,
    workerInstancesExecuted: rolesExecuted,
    executionOrder,
    dependencyEdges: [],
    independentRolesCount: rolesExecuted.length,
    independentReviewOccurred: false,
    totalTokens,
    durationMs,
    partial,
  }
}

function buildTeamReceipt(result: TeamRunResult, trace: TraceFacts): ExecutionReceipt {
  const rawResult = result as unknown as UnknownRecord
  const routingDecision = isRecord(rawResult['routingDecision'])
    ? rawResult['routingDecision']
    : undefined
  const receiptId = readString(routingDecision?.['receiptId'])
  const routingDecisionId = readString(routingDecision?.['decisionId'])
  const routingDecisionSpanId = readString(routingDecision?.['traceSpanId'])
  const rawTasks = rawResult['tasks']
  const tasks = Array.isArray(rawTasks) ? rawTasks : []
  const traceTasks = readTraceTaskFacts(trace)
  const taskFacts: TaskFact[] = []
  let partial = trace.partial || !Array.isArray(rawTasks)

  for (const value of tasks) {
    if (!isRecord(value)) {
      partial = true
      continue
    }

    const id = readString(value['id'])
    const traced = id ? traceTasks.get(id) : undefined
    const metrics = isRecord(value['metrics']) ? value['metrics'] : undefined
    const hasExecutionEvidence = metrics !== undefined || traced !== undefined
    const status = readString(value['status'])
    if (!hasExecutionEvidence && (status === 'pending' || status === 'blocked' || status === 'skipped')) {
      continue
    }

    const rawRole = readString(value['assignee'])
    const role = readWorkerRole(rawRole) ?? traced?.role
    const taskRole = readString(value['role']) ?? traced?.taskRole
    const rawDependsOn = value['dependsOn']
    const dependsOn = Array.isArray(rawDependsOn)
      ? rawDependsOn.filter((dependency): dependency is string => typeof dependency === 'string')
      : []
    const startMs = metrics && isFiniteNumber(metrics['startMs'])
      ? metrics['startMs']
      : traced?.startMs

    if (!id || (!rawRole && !traced?.role) || !Array.isArray(rawDependsOn)) partial = true
    if (Array.isArray(rawDependsOn) && dependsOn.length !== rawDependsOn.length) partial = true
    if (role && startMs === undefined) partial = true
    taskFacts.push({ id, role, taskRole, dependsOn, startMs })
  }

  const rolesExecuted: string[] = []
  const knownRoles = new Set<string>()
  const earliestByRole = new Map<string, number>()
  let orderComplete = true

  for (const task of taskFacts) {
    if (!task.role) continue
    if (!knownRoles.has(task.role)) {
      knownRoles.add(task.role)
      rolesExecuted.push(task.role)
    }
    if (task.startMs === undefined) {
      orderComplete = false
      continue
    }
    const previous = earliestByRole.get(task.role)
    if (previous === undefined || task.startMs < previous) earliestByRole.set(task.role, task.startMs)
  }

  const executionOrder = orderComplete && earliestByRole.size === rolesExecuted.length
    ? [...rolesExecuted].sort((left, right) => earliestByRole.get(left)! - earliestByRole.get(right)!)
    : []
  const taskRolesExecuted = [...new Set(taskFacts
    .filter((task) => task.role !== undefined)
    .map((task) => task.taskRole)
    .filter((role): role is string => role !== undefined))]

  const roleByTaskId = new Map<string, string>()
  for (const task of taskFacts) {
    if (task.id && task.role) roleByTaskId.set(task.id, task.role)
  }

  const dependencyEdges: ExecutionReceiptDependencyEdge[] = []
  for (const task of taskFacts) {
    if (!task.role) continue
    for (const dependencyId of task.dependsOn) {
      const predecessor = roleByTaskId.get(dependencyId)
      if (!predecessor) {
        const dependency = taskFacts.find((candidate) => candidate.id === dependencyId)
        if (!dependency || dependency.role !== undefined) partial = true
        continue
      }
      if (predecessor !== task.role) dependencyEdges.push({ from: predecessor, to: task.role })
    }
  }

  const totalTokens = readTokenUsage(rawResult['totalTokenUsage'])
  const flags = readFlags(rawResult['flags'])
  const approvalDecisions = readApprovalDecisions(rawResult['approvalDecisions'])
  const rawMetrics = rawResult['metrics']
  const durationMs = isRecord(rawMetrics) && isFiniteNumber(rawMetrics['totalDurationMs'])
    ? rawMetrics['totalDurationMs']
    : null
  if (rolesExecuted.length === 0 || !orderComplete || totalTokens === null || durationMs === null) {
    partial = true
  }

  return {
    ...(receiptId ? { id: receiptId } : {}),
    ...(routingDecisionId ? { routingDecisionId } : {}),
    ...(routingDecisionSpanId ? { routingDecisionSpanId } : {}),
    ...(flags ? { flags } : {}),
    ...(approvalDecisions ? { approvalDecisions } : {}),
    mode: rolesExecuted.length > 1 ? 'multi-agent' : 'single',
    rolesExecuted,
    workerInstancesExecuted: rolesExecuted,
    ...(taskRolesExecuted.length > 0 ? { taskRolesExecuted } : {}),
    executionOrder,
    dependencyEdges,
    independentRolesCount: rolesExecuted.length,
    independentReviewOccurred: rolesExecuted.length >= 2 && dependencyEdges.length > 0,
    totalTokens,
    durationMs,
    partial,
  }
}

/**
 * Builds a non-throwing execution receipt without inspecting model output text.
 */
export function buildExecutionReceipt(
  result: AgentRunResult | TeamRunResult,
  trace?: readonly TraceEvent[],
): ExecutionReceipt {
  try {
    const traceFacts = readTraceFacts(trace)
    if (!isRecord(result)) return emptyReceipt()
    return isTeamRunResult(result)
      ? buildTeamReceipt(result, traceFacts)
      : buildAgentReceipt(result, traceFacts)
  } catch {
    return emptyReceipt()
  }
}
