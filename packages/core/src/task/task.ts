/**
 * @fileoverview Pure task utility functions.
 *
 * These helpers operate on plain {@link Task} values without any mutable
 * state, making them safe to use in reducers, tests, and reactive pipelines.
 * Stateful orchestration belongs in {@link TaskQueue}.
 */

import { randomUUID } from 'node:crypto'
import type {
  ConsensusVerifyOptions,
  Task,
  TaskMetadata,
  TaskRequirements,
  TaskStatus,
} from '../types.js'
import { validateTaskMetadata } from './metadata.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new {@link Task} with a generated UUID, `'pending'` status, and
 * `createdAt`/`updatedAt` timestamps set to the current instant.
 *
 * @example
 * ```ts
 * const task = createTask({
 *   title: 'Research competitors',
 *   description: 'Identify the top 5 competitors and their pricing',
 *   assignee: 'researcher',
 * })
 * ```
 */
export function createTask(input: {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  dependencyPayload?: 'output' | 'structured' | 'both'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
  role?: string
  priority?: 'low' | 'normal' | 'high' | 'critical'
  metadata?: TaskMetadata
  requires?: TaskRequirements
  verify?: ConsensusVerifyOptions
}): Task {
  const now = new Date()
  const metadata = validateTaskMetadata(input.metadata)
  return {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    status: 'pending' as TaskStatus,
    assignee: input.assignee,
    dependsOn: input.dependsOn ? [...input.dependsOn] : undefined,
    memoryScope: input.memoryScope,
    dependencyPayload: input.dependencyPayload,
    result: undefined,
    createdAt: now,
    updatedAt: now,
    maxRetries: input.maxRetries,
    retryDelayMs: input.retryDelayMs,
    retryBackoff: input.retryBackoff,
    role: input.role,
    priority: input.priority,
    metadata,
    requires: input.requires,
    verify: input.verify,
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `task` can be started immediately.
 *
 * A task is considered ready when:
 * 1. Its status is `'pending'`.
 * 2. Every task listed in `task.dependsOn` has status `'completed'`.
 *
 * Tasks whose dependencies are missing from `allTasks` are treated as
 * unresolvable and therefore **not** ready.
 *
 * @param task      - The task to evaluate.
 * @param allTasks  - The full collection of tasks in the current queue/plan.
 * @param taskById  - Optional pre-built id→task map. When provided the function
 *                    skips rebuilding the map, reducing the complexity of
 *                    call-sites that invoke `isTaskReady` inside a loop from
 *                    O(n²) to O(n).
 */
export function isTaskReady(
  task: Task,
  allTasks: Task[],
  taskById?: Map<string, Task>,
): boolean {
  if (task.status !== 'pending') return false
  if (!task.dependsOn || task.dependsOn.length === 0) return true

  const map = taskById ?? new Map<string, Task>(allTasks.map((t) => [t.id, t]))

  for (const depId of task.dependsOn) {
    const dep = map.get(depId)
    if (!dep || dep.status !== 'completed') return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/**
 * Returns `tasks` sorted so that each task appears after all of its
 * dependencies — a standard topological (Kahn's algorithm) ordering.
 *
 * Tasks with no dependencies come first. If the graph contains a cycle the
 * function returns a partial result containing only the tasks that could be
 * ordered; use {@link validateTaskDependencies} to detect cycles before calling
 * this function in production paths.
 *
 * @example
 * ```ts
 * const ordered = getTaskDependencyOrder(tasks)
 * for (const task of ordered) {
 *   await run(task)
 * }
 * ```
 */
export function getTaskDependencyOrder(tasks: Task[]): Task[] {
  if (tasks.length === 0) return []

  const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]))

  // Build adjacency: dependsOn edges become "predecessors" for in-degree count.
  const inDegree = new Map<string, number>()
  // successors[id] = list of task IDs that depend on `id`
  const successors = new Map<string, string[]>()

  for (const task of tasks) {
    if (!inDegree.has(task.id)) inDegree.set(task.id, 0)
    if (!successors.has(task.id)) successors.set(task.id, [])

    for (const depId of task.dependsOn ?? []) {
      // Only count dependencies that exist in this task set.
      if (taskById.has(depId)) {
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
        const deps = successors.get(depId) ?? []
        deps.push(task.id)
        successors.set(depId, deps)
      }
    }
  }

  // Kahn's algorithm: start with all nodes of in-degree 0.
  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const ordered: Task[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    const task = taskById.get(id)
    if (task) ordered.push(task)

    for (const successorId of successors.get(id) ?? []) {
      const newDegree = (inDegree.get(successorId) ?? 0) - 1
      inDegree.set(successorId, newDegree)
      if (newDegree === 0) queue.push(successorId)
    }
  }

  return ordered
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates the dependency graph of a task collection.
 *
 * Checks for:
 * - References to unknown task IDs in `dependsOn`.
 * - Cycles (a task depending on itself, directly or transitively).
 * - Self-dependencies (`task.dependsOn` includes its own `id`).
 *
 * @returns An object with `valid: true` when no issues were found, or
 *          `valid: false` with a non-empty `errors` array describing each
 *          problem.
 *
 * @example
 * ```ts
 * const { valid, errors } = validateTaskDependencies(tasks)
 * if (!valid) throw new Error(errors.join('\n'))
 * ```
 */
export function validateTaskDependencies(tasks: Task[]): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]))

  // Pass 1: check for unknown references and self-dependencies.
  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      if (depId === task.id) {
        errors.push(
          `Task "${task.title}" (${task.id}) depends on itself.`,
        )
        continue
      }
      if (!taskById.has(depId)) {
        errors.push(
          `Task "${task.title}" (${task.id}) references unknown dependency "${depId}".`,
        )
      }
    }
  }

  // Pass 2: cycle detection via DFS colouring (white=0, grey=1, black=2).
  const colour = new Map<string, 0 | 1 | 2>()
  for (const task of tasks) colour.set(task.id, 0)

  const visit = (id: string, path: string[]): void => {
    if (colour.get(id) === 2) return // Already fully explored.
    if (colour.get(id) === 1) {
      // Found a back-edge — cycle.
      const cycleStart = path.indexOf(id)
      const cycle = path.slice(cycleStart).concat(id)
      errors.push(`Cyclic dependency detected: ${cycle.join(' -> ')}`)
      return
    }

    colour.set(id, 1)
    const task = taskById.get(id)
    for (const depId of task?.dependsOn ?? []) {
      if (taskById.has(depId)) {
        visit(depId, [...path, id])
      }
    }
    colour.set(id, 2)
  }

  for (const task of tasks) {
    if (colour.get(task.id) === 0) {
      visit(task.id, [])
    }
  }

  return { valid: errors.length === 0, errors }
}
