/**
 * @fileoverview Dependency-aware task queue.
 *
 * {@link TaskQueue} owns the mutable lifecycle of every task it holds.
 * Completing a task automatically unblocks dependents and fires events so
 * orchestrators can react without polling.
 */

import { randomUUID } from 'node:crypto'
import type {
  PlanPatch,
  PlanRevision,
  Task,
  TaskQueueSnapshot,
  TaskSnapshot,
  TaskStatus,
} from '../types.js'
import { createTask, isTaskReady, validateTaskDependencies } from './task.js'
import { validateTaskMetadata } from './metadata.js'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Named event types emitted by {@link TaskQueue}. */
export type TaskQueueEvent =
  | 'task:ready'
  | 'task:complete'
  | 'task:failed'
  | 'task:skipped'
  | 'all:complete'

/** Handler for `'task:ready' | 'task:complete' | 'task:failed'` events. */
type TaskHandler = (task: Task) => void
/** Handler for `'all:complete'` (no task argument). */
type AllCompleteHandler = () => void

type HandlerFor<E extends TaskQueueEvent> = E extends 'all:complete'
  ? AllCompleteHandler
  : TaskHandler

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

/**
 * Mutable, event-driven queue with topological dependency resolution.
 *
 * Tasks enter in `'pending'` state. The queue promotes them to `'blocked'`
 * when unresolved dependencies exist, and back to `'pending'` (firing
 * `'task:ready'`) when those dependencies complete. Callers drive execution by
 * calling {@link next} / {@link nextAvailable} and updating task state via
 * {@link complete} or {@link fail}.
 *
 * @example
 * ```ts
 * const queue = new TaskQueue()
 * queue.on('task:ready', (task) => scheduleExecution(task))
 * queue.on('all:complete', () => shutdown())
 *
 * queue.addBatch(tasks)
 * ```
 */
export class TaskQueue {
  private readonly tasks = new Map<string, Task>()
  private planRevision = 0
  private planRevisions: PlanRevision[] = []

  /** Listeners keyed by event type, stored as symbol → handler pairs. */
  private readonly listeners = new Map<
    TaskQueueEvent,
    Map<symbol, TaskHandler | AllCompleteHandler>
  >()

  // ---------------------------------------------------------------------------
  // Mutation: add
  // ---------------------------------------------------------------------------

  /**
   * Adds a single task.
   *
   * If the task has unresolved dependencies it is immediately promoted to
   * `'blocked'`; otherwise it stays `'pending'` and `'task:ready'` fires.
   */
  add(task: Task): void {
    const resolved = this.resolveInitialStatus(task)
    this.tasks.set(resolved.id, resolved)
    if (resolved.status === 'pending') {
      this.emit('task:ready', resolved)
    }
  }

  /**
   * Adds multiple tasks at once.
   *
   * Processing each task re-evaluates the current map state, so inserting a
   * batch where some tasks satisfy others' dependencies produces correct initial
   * statuses when the dependencies appear first in the array. Use
   * {@link getTaskDependencyOrder} from `task.ts` to pre-sort if needed.
   */
  addBatch(tasks: Task[]): void {
    for (const task of tasks) {
      this.add(task)
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot / restore
  // ---------------------------------------------------------------------------

  /** Returns a serializable snapshot of all tasks and their status partitions. */
  snapshot(): TaskQueueSnapshot {
    const tasks = this.list()
    const base = {
      tasks: tasks.map(TaskQueue.taskToSnapshot),
      pending: tasks.filter((task) => task.status === 'pending').map((task) => task.id),
      inProgress: tasks.filter((task) => task.status === 'in_progress').map((task) => task.id),
      completed: tasks.filter((task) => task.status === 'completed').map((task) => task.id),
      failed: tasks.filter((task) => task.status === 'failed').map((task) => task.id),
      blocked: tasks.filter((task) => task.status === 'blocked').map((task) => task.id),
      skipped: tasks.filter((task) => task.status === 'skipped').map((task) => task.id),
    }
    return this.planRevision === 0
      ? { version: 1, ...base }
      : {
          version: 2,
          ...base,
          planRevision: this.planRevision,
          planRevisions: this.planRevisions.map(TaskQueue.clonePlanRevision),
        }
  }

  /**
   * Rebuilds a queue from a snapshot.
   *
   * By default this is an exact round-trip, including `'in_progress'` tasks.
   * Restores that resume execution should pass `{ resetInProgress: true }` so
   * a task that was running during a crash becomes runnable again once its
   * dependencies are satisfied.
   */
  static fromSnapshot(
    snapshot: TaskQueueSnapshot,
    options: { readonly resetInProgress?: boolean } = {},
  ): TaskQueue {
    const queue = new TaskQueue()
    const tasks = snapshot.tasks.map((task) => TaskQueue.taskFromSnapshot(task))
    const restored = options.resetInProgress
      ? TaskQueue.resetRestoredInProgress(tasks)
      : tasks

    for (const task of restored) {
      queue.tasks.set(task.id, task)
    }
    if (snapshot.version === 2) {
      TaskQueue.validatePlanSnapshot(snapshot)
      queue.planRevision = snapshot.planRevision
      queue.planRevisions = snapshot.planRevisions.map(TaskQueue.clonePlanRevision)
    }
    return queue
  }

  /** Current append-only runtime plan revision. */
  getPlanRevision(): number {
    return this.planRevision
  }

  /** Immutable copies of the accepted runtime plan-repair history. */
  getPlanRevisions(): readonly PlanRevision[] {
    return this.planRevisions.map(TaskQueue.clonePlanRevision)
  }

  /**
   * Atomically apply an append-only plan patch without publishing queue events.
   *
   * Call {@link publishPlanRevision} after durable persistence succeeds. Until
   * then, newly-ready tasks are present in the queue but invisible to the
   * event-driven executor.
   */
  applyPlanPatch(
    patch: PlanPatch,
    triggerTaskId: string,
    trigger: PlanRevision['trigger'],
  ): { readonly revision: PlanRevision; readonly before: TaskQueueSnapshot } {
    const reason = patch.reason.trim()
    if (!reason) throw new Error('TaskQueue.applyPlanPatch: patch reason must not be empty.')

    const addSpecs = [...(patch.addTasks ?? [])]
    const retargets = [...(patch.retargetPending ?? [])]
    const supersedeIds = [...(patch.supersedePending ?? [])]
    if (addSpecs.length === 0 && retargets.length === 0 && supersedeIds.length === 0) {
      throw new Error('TaskQueue.applyPlanPatch: patch must contain at least one operation.')
    }
    if (trigger !== 'success' && addSpecs.length === 0) {
      throw new Error(
        'TaskQueue.applyPlanPatch: failure recovery must append at least one replacement task.',
      )
    }

    const before = this.snapshot()
    const draft = new Map<string, Task>(
      Array.from(this.tasks, ([id, task]) => [id, TaskQueue.cloneTask(task)]),
    )
    const nextVersion = this.planRevision + 1
    const now = new Date()
    const triggerTask = draft.get(triggerTaskId)
    if (!triggerTask) {
      throw new Error(`TaskQueue.applyPlanPatch: trigger task "${triggerTaskId}" not found.`)
    }
    if (triggerTask.status !== 'in_progress') {
      throw new Error(
        `TaskQueue.applyPlanPatch: trigger task "${triggerTaskId}" must be in_progress; ` +
          `it is ${triggerTask.status}.`,
      )
    }

    const retargetIds = new Set<string>()
    for (const retarget of retargets) {
      if (retargetIds.has(retarget.taskId)) {
        throw new Error(`TaskQueue.applyPlanPatch: task "${retarget.taskId}" is retargeted more than once.`)
      }
      retargetIds.add(retarget.taskId)
      const task = draft.get(retarget.taskId)
      if (!task) throw new Error(`TaskQueue.applyPlanPatch: task "${retarget.taskId}" not found.`)
      if (task.status !== 'pending' && task.status !== 'blocked') {
        throw new Error(
          `TaskQueue.applyPlanPatch: only pending or blocked tasks can be retargeted; ` +
            `"${task.id}" is ${task.status}.`,
        )
      }
      if (!retarget.assignee.trim()) {
        throw new Error(`TaskQueue.applyPlanPatch: retarget assignee for "${task.id}" must not be empty.`)
      }
      draft.set(task.id, { ...task, assignee: retarget.assignee, updatedAt: now })
    }

    const superseded = new Set<string>()
    for (const taskId of supersedeIds) {
      if (superseded.has(taskId)) {
        throw new Error(`TaskQueue.applyPlanPatch: task "${taskId}" is superseded more than once.`)
      }
      if (retargetIds.has(taskId)) {
        throw new Error(`TaskQueue.applyPlanPatch: task "${taskId}" cannot be retargeted and superseded.`)
      }
      superseded.add(taskId)
      const task = draft.get(taskId)
      if (!task) throw new Error(`TaskQueue.applyPlanPatch: task "${taskId}" not found.`)
      if (task.status !== 'pending' && task.status !== 'blocked') {
        throw new Error(
          `TaskQueue.applyPlanPatch: only pending or blocked tasks can be superseded; ` +
            `"${task.id}" is ${task.status}.`,
        )
      }
      draft.set(task.id, {
        ...task,
        status: 'skipped',
        result: `Superseded by plan revision ${nextVersion}: ${reason}`,
        supersededByRevision: nextVersion,
        updatedAt: now,
      })
    }

    const keys = new Set<string>()
    const created = new Map<string, Task>()
    for (const spec of addSpecs) {
      const key = spec.key.trim()
      if (!key) throw new Error('TaskQueue.applyPlanPatch: appended task key must not be empty.')
      if (keys.has(key)) {
        throw new Error(`TaskQueue.applyPlanPatch: appended task key "${key}" is duplicated.`)
      }
      if (draft.has(key)) {
        throw new Error(
          `TaskQueue.applyPlanPatch: appended task key "${key}" conflicts with an existing task id.`,
        )
      }
      keys.add(key)
      const task = createTask({
        title: spec.title,
        description: spec.description,
        assignee: spec.assignee,
        memoryScope: spec.memoryScope,
        dependencyPayload: spec.dependencyPayload,
        metadata: spec.metadata,
        maxRetries: spec.maxRetries,
        retryDelayMs: spec.retryDelayMs,
        retryBackoff: spec.retryBackoff,
        role: spec.role,
        priority: spec.priority,
        requires: spec.requires,
        verify: spec.verify,
      })
      created.set(key, task)
    }

    const addedTasks: Record<string, string> = {}
    for (const spec of addSpecs) {
      const task = created.get(spec.key.trim())!
      const dependencies = (spec.dependsOn ?? []).map((reference) => {
        const newTask = created.get(reference)
        const dependencyId = newTask?.id ?? reference
        const dependency = draft.get(dependencyId) ?? newTask
        if (!dependency) {
          throw new Error(
            `TaskQueue.applyPlanPatch: appended task "${spec.key}" has unknown dependency "${reference}".`,
          )
        }
        if (dependency.status === 'failed' || dependency.status === 'skipped') {
          throw new Error(
            `TaskQueue.applyPlanPatch: appended task "${spec.key}" cannot depend on ` +
              `${dependency.status} task "${dependency.id}".`,
          )
        }
        return dependencyId
      })
      if (new Set(dependencies).size !== dependencies.length) {
        throw new Error(`TaskQueue.applyPlanPatch: appended task "${spec.key}" has duplicate dependencies.`)
      }
      const resolved: Task = {
        ...task,
        id: task.id || randomUUID(),
        ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
      }
      created.set(spec.key.trim(), resolved)
      addedTasks[spec.key.trim()] = resolved.id
      draft.set(resolved.id, resolved)
    }

    // Resolve references between appended tasks after every patch-local id exists.
    for (const spec of addSpecs) {
      const task = created.get(spec.key.trim())!
      const dependencies = (spec.dependsOn ?? []).map((reference) =>
        created.get(reference)?.id ?? reference)
      const allTasks = Array.from(draft.values())
      const taskById = new Map(allTasks.map((candidate) => [candidate.id, candidate]))
      const pendingTask: Task = {
        ...task,
        ...(dependencies.length > 0 ? { dependsOn: dependencies } : { dependsOn: undefined }),
        status: 'pending',
      }
      const status: TaskStatus = isTaskReady(pendingTask, allTasks, taskById)
        ? 'pending'
        : 'blocked'
      draft.set(task.id, { ...pendingTask, status })
    }

    const validation = validateTaskDependencies(Array.from(draft.values()))
    if (!validation.valid) {
      throw new Error(`TaskQueue.applyPlanPatch: invalid patched graph: ${validation.errors.join(' ')}`)
    }

    const revision: PlanRevision = {
      id: randomUUID(),
      version: nextVersion,
      triggerTaskId,
      trigger,
      reason,
      addedTasks,
      retargetedTasks: retargets.map((item) => ({ ...item })),
      supersededTaskIds: [...supersedeIds],
      createdAt: now.toISOString(),
    }

    if (trigger !== 'success') {
      draft.set(triggerTaskId, {
        ...draft.get(triggerTaskId)!,
        recoveredByRevision: nextVersion,
        updatedAt: now,
      })
    }
    this.tasks.clear()
    for (const [id, task] of draft) this.tasks.set(id, task)
    this.planRevision = nextVersion
    this.planRevisions = [...this.planRevisions, revision]
    return { revision: TaskQueue.clonePlanRevision(revision), before }
  }

  /** Roll back an unpublished plan patch while preserving queue listeners. */
  restorePlanSnapshot(snapshot: TaskQueueSnapshot): void {
    const restored = TaskQueue.fromSnapshot(snapshot)
    this.tasks.clear()
    for (const task of restored.list()) this.tasks.set(task.id, task)
    this.planRevision = restored.planRevision
    this.planRevisions = [...restored.planRevisions]
  }

  /** Publish buffered skipped/ready events after a plan revision is durable. */
  publishPlanRevision(revision: PlanRevision): void {
    for (const taskId of revision.supersededTaskIds) {
      const task = this.tasks.get(taskId)
      if (task) this.emit('task:skipped', task)
    }
    for (const taskId of Object.values(revision.addedTasks)) {
      const task = this.tasks.get(taskId)
      if (task?.status === 'pending') this.emit('task:ready', task)
    }
    if (this.isComplete()) this.emitAllComplete()
  }

  // ---------------------------------------------------------------------------
  // Mutation: update / complete / fail
  // ---------------------------------------------------------------------------

  /**
   * Applies a partial update to an existing task.
   *
   * Only `status`, `result`, and `assignee` are accepted to keep the update
   * surface narrow. Use {@link complete} and {@link fail} for terminal states.
   *
   * @throws {Error} when `taskId` is not found.
   */
  update(
    taskId: string,
    update: Partial<Pick<Task, 'status' | 'result' | 'assignee'>>,
  ): Task {
    const task = this.requireTask(taskId)
    const updated: Task = {
      ...task,
      ...update,
      updatedAt: new Date(),
    }
    this.tasks.set(taskId, updated)
    return updated
  }

  /**
   * Marks `taskId` as `'completed'`, records an optional `result` string, and
   * unblocks any dependents that are now ready to run.
   *
   * Fires `'task:complete'`, then `'task:ready'` for each newly-unblocked task,
   * then `'all:complete'` when the queue is fully resolved.
   *
   * @throws {Error} when `taskId` is not found.
   */
  complete(taskId: string, result?: string): Task {
    const completed = this.update(taskId, { status: 'completed', result })
    this.emit('task:complete', completed)
    this.unblockDependents(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return completed
  }

  /**
   * Marks `taskId` as `'failed'` and records `error` in the `result` field.
   *
   * Fires `'task:failed'` for the failed task and for every downstream task
   * that transitively depended on it (cascade failure). This prevents blocked
   * tasks from remaining stuck indefinitely when an upstream dependency fails.
   *
   * @throws {Error} when `taskId` is not found.
   */
  fail(taskId: string, error: string): Task {
    const failed = this.update(taskId, { status: 'failed', result: error })
    this.emit('task:failed', failed)
    this.cascadeFailure(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return failed
  }

  /**
   * Marks `taskId` as `'skipped'` and records `reason` in the `result` field.
   *
   * Fires `'task:skipped'` for the skipped task and cascades to every
   * downstream task that transitively depended on it — even if the dependent
   * has other dependencies that are still pending or completed. A skipped
   * upstream is treated as permanently unsatisfiable, mirroring `fail()`.
   *
   * @throws {Error} when `taskId` is not found.
   */
  skip(taskId: string, reason: string): Task {
    const skipped = this.update(taskId, { status: 'skipped', result: reason })
    this.emit('task:skipped', skipped)
    this.cascadeSkip(taskId)
    if (this.isComplete()) {
      this.emitAllComplete()
    }
    return skipped
  }

  /**
   * Marks all non-terminal tasks as `'skipped'`.
   *
   * Used when an approval gate rejects continuation — every pending, blocked,
   * or in-progress task is skipped with the given reason.
   *
   * **Important:** Call only after active execution has drained. The
   * orchestrator first stops new dispatches, waits for its in-flight map to
   * settle, and only then calls this method. Direct callers must provide the
   * same drain-before-skip ordering.
   */
  skipRemaining(reason = 'Skipped: approval rejected.'): void {
    // Snapshot first — update() mutates the live map, which is unsafe to
    // iterate over during modification.
    const snapshot = Array.from(this.tasks.values())
    for (const task of snapshot) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'skipped') continue
      const skipped = this.update(task.id, { status: 'skipped', result: reason })
      this.emit('task:skipped', skipped)
    }
    if (this.isComplete()) {
      this.emitAllComplete()
    }
  }

  /**
   * Recursively marks all tasks that (transitively) depend on `failedTaskId`
   * as `'failed'` with an informative message, firing `'task:failed'` for each.
   *
   * Only tasks in `'blocked'` or `'pending'` state are affected; tasks already
   * in a terminal state are left untouched.
   */
  private cascadeFailure(failedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'blocked' && task.status !== 'pending') continue
      if (!task.dependsOn?.includes(failedTaskId)) continue

      const cascaded = this.update(task.id, {
        status: 'failed',
        result: `Cancelled: dependency "${failedTaskId}" failed.`,
      })
      this.emit('task:failed', cascaded)
      // Recurse to handle transitive dependents.
      this.cascadeFailure(task.id)
    }
  }

  /**
   * Recursively marks all tasks that (transitively) depend on `skippedTaskId`
   * as `'skipped'`, firing `'task:skipped'` for each.
   */
  private cascadeSkip(skippedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'blocked' && task.status !== 'pending') continue
      if (!task.dependsOn?.includes(skippedTaskId)) continue

      const cascaded = this.update(task.id, {
        status: 'skipped',
        result: `Skipped: dependency "${skippedTaskId}" was skipped.`,
      })
      this.emit('task:skipped', cascaded)
      this.cascadeSkip(task.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns the next `'pending'` task for `assignee` (matched against
   * `task.assignee`), or `undefined` if none exists.
   *
   * If `assignee` is omitted, behaves like {@link nextAvailable}.
   */
  next(assignee?: string): Task | undefined {
    if (assignee === undefined) return this.nextAvailable()

    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && task.assignee === assignee) {
        return task
      }
    }
    return undefined
  }

  /**
   * Returns the next `'pending'` task that has no `assignee` restriction, or
   * the first `'pending'` task overall when all pending tasks have an assignee.
   */
  nextAvailable(): Task | undefined {
    let fallback: Task | undefined

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue
      if (!task.assignee) return task
      if (!fallback) fallback = task
    }

    return fallback
  }

  /** Returns a snapshot array of all tasks (any status). */
  list(): Task[] {
    return Array.from(this.tasks.values())
  }

  /** Returns all tasks whose `status` matches `status`. */
  getByStatus(status: TaskStatus): Task[] {
    return this.list().filter((t) => t.status === status)
  }

  /** Returns a task by ID, if present. */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * Returns `true` when every task in the queue has reached a terminal state
   * (`'completed'`, `'failed'`, or `'skipped'`), **or** the queue is empty.
   */
  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'skipped') return false
    }
    return true
  }

  /**
   * Returns a progress snapshot.
   *
   * @example
   * ```ts
   * const { completed, total } = queue.getProgress()
   * console.log(`${completed}/${total} tasks done`)
   * ```
   */
  getProgress(): {
    total: number
    completed: number
    failed: number
    skipped: number
    inProgress: number
    pending: number
    blocked: number
  } {
    let completed = 0
    let failed = 0
    let skipped = 0
    let inProgress = 0
    let pending = 0
    let blocked = 0

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'completed':
          completed++
          break
        case 'failed':
          failed++
          break
        case 'skipped':
          skipped++
          break
        case 'in_progress':
          inProgress++
          break
        case 'pending':
          pending++
          break
        case 'blocked':
          blocked++
          break
      }
    }

    return {
      total: this.tasks.size,
      completed,
      failed,
      skipped,
      inProgress,
      pending,
      blocked,
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to a queue event.
   *
   * @returns An unsubscribe function. Calling it is idempotent.
   *
   * @example
   * ```ts
   * const off = queue.on('task:ready', (task) => execute(task))
   * // later…
   * off()
   * ```
   */
  on<E extends TaskQueueEvent>(
    event: E,
    handler: HandlerFor<E>,
  ): () => void {
    let map = this.listeners.get(event)
    if (!map) {
      map = new Map()
      this.listeners.set(event, map)
    }
    const id = Symbol()
    map.set(id, handler as TaskHandler | AllCompleteHandler)
    return () => {
      map!.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evaluates whether `task` should start as `'blocked'` based on the tasks
   * already registered in the queue.
   */
  private resolveInitialStatus(task: Task): Task {
    if (!task.dependsOn || task.dependsOn.length === 0) return task

    const allCurrent = Array.from(this.tasks.values())
    const ready = isTaskReady(task, allCurrent)
    if (ready) return task

    return { ...task, status: 'blocked', updatedAt: new Date() }
  }

  /**
   * After a task completes, scan all `'blocked'` tasks and promote any that are
   * now fully satisfied to `'pending'`, firing `'task:ready'` for each.
   *
   * The task array and lookup map are built once for the entire scan to keep
   * the operation O(n) rather than O(n²).
   */
  private unblockDependents(completedId: string): void {
    const allTasks = Array.from(this.tasks.values())
    const taskById = new Map<string, Task>(allTasks.map((t) => [t.id, t]))

    for (const task of allTasks) {
      if (task.status !== 'blocked') continue
      if (!task.dependsOn?.includes(completedId)) continue

      // Re-check against the current state of the whole task set.
      // Pass the pre-built map to avoid rebuilding it for every candidate task.
      if (isTaskReady({ ...task, status: 'pending' }, allTasks, taskById)) {
        const unblocked: Task = {
          ...task,
          status: 'pending',
          updatedAt: new Date(),
        }
        this.tasks.set(task.id, unblocked)
        // Update the map so subsequent iterations in the same call see the new status.
        taskById.set(task.id, unblocked)
        this.emit('task:ready', unblocked)
      }
    }
  }

  private emit(event: 'task:ready' | 'task:complete' | 'task:failed' | 'task:skipped', task: Task): void {
    const map = this.listeners.get(event)
    if (!map) return
    for (const handler of map.values()) {
      ;(handler as TaskHandler)(task)
    }
  }

  private emitAllComplete(): void {
    const map = this.listeners.get('all:complete')
    if (!map) return
    for (const handler of map.values()) {
      ;(handler as AllCompleteHandler)()
    }
  }

  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`TaskQueue: task "${taskId}" not found.`)
    return task
  }

  private static taskToSnapshot(task: Task): TaskSnapshot {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      ...(task.dependsOn !== undefined ? { dependsOn: [...task.dependsOn] } : {}),
      ...(task.memoryScope !== undefined ? { memoryScope: task.memoryScope } : {}),
      ...(task.dependencyPayload !== undefined ? { dependencyPayload: task.dependencyPayload } : {}),
      ...(task.role !== undefined ? { role: task.role } : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
      ...(task.requires !== undefined ? { requires: task.requires } : {}),
      ...(task.result !== undefined ? { result: task.result } : {}),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
      ...(task.retryDelayMs !== undefined ? { retryDelayMs: task.retryDelayMs } : {}),
      ...(task.retryBackoff !== undefined ? { retryBackoff: task.retryBackoff } : {}),
      ...(task.supersededByRevision !== undefined
        ? { supersededByRevision: task.supersededByRevision }
        : {}),
      ...(task.recoveredByRevision !== undefined
        ? { recoveredByRevision: task.recoveredByRevision }
        : {}),
    }
  }

  private static taskFromSnapshot(snapshot: TaskSnapshot): Task {
    return {
      id: snapshot.id,
      title: snapshot.title,
      description: snapshot.description,
      status: snapshot.status,
      ...(snapshot.assignee !== undefined ? { assignee: snapshot.assignee } : {}),
      ...(snapshot.dependsOn !== undefined ? { dependsOn: [...snapshot.dependsOn] } : {}),
      ...(snapshot.memoryScope !== undefined ? { memoryScope: snapshot.memoryScope } : {}),
      ...(snapshot.dependencyPayload !== undefined
        ? { dependencyPayload: snapshot.dependencyPayload }
        : {}),
      ...(snapshot.role !== undefined ? { role: snapshot.role } : {}),
      ...(snapshot.priority !== undefined ? { priority: snapshot.priority } : {}),
      ...(snapshot.metadata !== undefined
        ? { metadata: validateTaskMetadata(snapshot.metadata) }
        : {}),
      ...(snapshot.requires !== undefined ? { requires: snapshot.requires } : {}),
      ...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
      createdAt: TaskQueue.parseSnapshotDate(snapshot.createdAt),
      updatedAt: TaskQueue.parseSnapshotDate(snapshot.updatedAt),
      ...(snapshot.maxRetries !== undefined ? { maxRetries: snapshot.maxRetries } : {}),
      ...(snapshot.retryDelayMs !== undefined ? { retryDelayMs: snapshot.retryDelayMs } : {}),
      ...(snapshot.retryBackoff !== undefined ? { retryBackoff: snapshot.retryBackoff } : {}),
      ...(snapshot.supersededByRevision !== undefined
        ? { supersededByRevision: snapshot.supersededByRevision }
        : {}),
      ...(snapshot.recoveredByRevision !== undefined
        ? { recoveredByRevision: snapshot.recoveredByRevision }
        : {}),
    }
  }

  private static cloneTask(task: Task): Task {
    return {
      ...task,
      ...(task.dependsOn !== undefined ? { dependsOn: [...task.dependsOn] } : {}),
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt),
    }
  }

  private static clonePlanRevision(revision: PlanRevision): PlanRevision {
    return {
      ...revision,
      addedTasks: { ...revision.addedTasks },
      retargetedTasks: revision.retargetedTasks.map((item) => ({ ...item })),
      supersededTaskIds: [...revision.supersededTaskIds],
    }
  }

  private static validatePlanSnapshot(
    snapshot: Extract<TaskQueueSnapshot, { readonly version: 2 }>,
  ): void {
    if (
      !Number.isInteger(snapshot.planRevision)
      || snapshot.planRevision < 1
      || snapshot.planRevisions.length !== snapshot.planRevision
    ) {
      throw new Error('TaskQueue.fromSnapshot: invalid plan revision sequence.')
    }
    const taskIds = new Set(snapshot.tasks.map((task) => task.id))
    for (const [index, revision] of snapshot.planRevisions.entries()) {
      if (revision.version !== index + 1 || !taskIds.has(revision.triggerTaskId)) {
        throw new Error('TaskQueue.fromSnapshot: invalid plan revision history.')
      }
      const referenced = [
        ...Object.values(revision.addedTasks),
        ...revision.retargetedTasks.map((item) => item.taskId),
        ...revision.supersededTaskIds,
      ]
      if (referenced.some((taskId) => !taskIds.has(taskId))) {
        throw new Error('TaskQueue.fromSnapshot: plan revision references an unknown task.')
      }
    }
  }

  private static parseSnapshotDate(value: string): Date {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? new Date() : date
  }

  private static resetRestoredInProgress(tasks: Task[]): Task[] {
    const initial = tasks.map((task): Task =>
      task.status === 'in_progress'
        ? { ...task, status: 'pending', updatedAt: new Date() }
        : task,
    )
    const taskById = new Map<string, Task>(initial.map((task) => [task.id, task]))

    return initial.map((task): Task => {
      if (task.status !== 'pending' && task.status !== 'blocked') return task
      const pendingTask = { ...task, status: 'pending' as TaskStatus }
      const ready = isTaskReady(pendingTask, initial, taskById)
      if (ready && task.status === 'blocked') {
        return { ...task, status: 'pending', updatedAt: new Date() }
      }
      if (!ready && task.status === 'pending') {
        return { ...task, status: 'blocked', updatedAt: new Date() }
      }
      return task
    })
  }
}
