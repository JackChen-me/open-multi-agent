import { describe, it, expect, vi } from 'vitest'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple task with a predictable id. */
function task(id: string, opts: { dependsOn?: string[]; assignee?: string } = {}) {
  const t = createTask({ title: id, description: `task ${id}`, assignee: opts.assignee })
  // Override the random UUID so tests can reference tasks by name.
  return { ...t, id, dependsOn: opts.dependsOn } as ReturnType<typeof createTask>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskQueue', () => {
  // -------------------------------------------------------------------------
  // Basic add & query
  // -------------------------------------------------------------------------

  it('adds a task and lists it', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    expect(q.list()).toHaveLength(1)
    expect(q.list()[0].id).toBe('a')
    expect(q.get('a')?.title).toBe('a')
  })

  it('fires task:ready for a task with no dependencies', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    q.on('task:ready', handler)

    q.add(task('a'))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].id).toBe('a')
  })

  it('blocks a task whose dependency is not yet completed', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    const b = q.list().find((t) => t.id === 'b')!
    expect(b.status).toBe('blocked')
  })

  // -------------------------------------------------------------------------
  // Dependency resolution
  // -------------------------------------------------------------------------

  it('unblocks a dependent task when its dependency completes', () => {
    const q = new TaskQueue()
    const readyHandler = vi.fn()
    q.on('task:ready', readyHandler)

    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    // 'a' fires task:ready, 'b' is blocked
    expect(readyHandler).toHaveBeenCalledTimes(1)

    q.complete('a', 'done')

    // 'b' should now be unblocked → fires task:ready
    expect(readyHandler).toHaveBeenCalledTimes(2)
    expect(readyHandler.mock.calls[1][0].id).toBe('b')
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('pending')
  })

  it('keeps a task blocked until ALL dependencies complete', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a', 'b'] }))

    q.complete('a')

    const cAfterA = q.list().find((t) => t.id === 'c')!
    expect(cAfterA.status).toBe('blocked')

    q.complete('b')

    const cAfterB = q.list().find((t) => t.id === 'c')!
    expect(cAfterB.status).toBe('pending')
  })

  // -------------------------------------------------------------------------
  // Cascade failure
  // -------------------------------------------------------------------------

  it('cascades failure to direct dependents', () => {
    const q = new TaskQueue()
    const failHandler = vi.fn()
    q.on('task:failed', failHandler)

    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    q.fail('a', 'boom')

    expect(failHandler).toHaveBeenCalledTimes(2) // a + b
    expect(q.list().find((t) => t.id === 'b')!.status).toBe('failed')
    expect(q.list().find((t) => t.id === 'b')!.result).toContain('dependency')
  })

  it('cascades failure transitively (a → b → c)', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))
    q.add(task('c', { dependsOn: ['b'] }))

    q.fail('a', 'boom')

    expect(q.list().every((t) => t.status === 'failed')).toBe(true)
  })

  it('does not cascade failure to independent tasks', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a'] }))

    q.fail('a', 'boom')

    expect(q.list().find((t) => t.id === 'b')!.status).toBe('pending')
    expect(q.list().find((t) => t.id === 'c')!.status).toBe('failed')
  })

  it('applies an append-only plan patch atomically and publishes events later', () => {
    const q = new TaskQueue()
    const readyHandler = vi.fn()
    const skippedHandler = vi.fn()
    q.on('task:ready', readyHandler)
    q.on('task:skipped', skippedHandler)
    q.add(task('source'))
    q.add(task('old-downstream', { dependsOn: ['source'] }))
    q.update('source', { status: 'in_progress' })
    readyHandler.mockClear()

    const applied = q.applyPlanPatch({
      reason: 'Use a fallback source.',
      supersedePending: ['old-downstream'],
      addTasks: [
        {
          key: 'fallback',
          title: 'Fallback',
          description: 'Fetch from the fallback source.',
          assignee: 'worker',
        },
        {
          key: 'replacement',
          title: 'Replacement',
          description: 'Consume the fallback.',
          assignee: 'worker',
          dependsOn: ['fallback'],
        },
      ],
    }, 'source', 'failure')

    expect(q.getPlanRevision()).toBe(1)
    expect(q.get('source')?.recoveredByRevision).toBe(1)
    expect(q.get('old-downstream')?.status).toBe('skipped')
    expect(q.get('old-downstream')?.supersededByRevision).toBe(1)
    expect(q.get(applied.revision.addedTasks['fallback']!)?.status).toBe('pending')
    expect(q.get(applied.revision.addedTasks['replacement']!)?.status).toBe('blocked')
    expect(readyHandler).not.toHaveBeenCalled()
    expect(skippedHandler).not.toHaveBeenCalled()

    q.publishPlanRevision(applied.revision)
    expect(readyHandler).toHaveBeenCalledTimes(1)
    expect(skippedHandler).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid plan patch without changing the queue', () => {
    const q = new TaskQueue()
    q.add(task('source'))
    q.add(task('downstream', { dependsOn: ['source'] }))
    q.update('source', { status: 'in_progress' })
    const before = q.snapshot()

    expect(() => q.applyPlanPatch({
      reason: 'Invalid repair.',
      addTasks: [{
        key: 'replacement',
        title: 'Replacement',
        description: 'Cannot depend on a missing task.',
        dependsOn: ['missing'],
      }],
    }, 'source', 'failure')).toThrow('unknown dependency')

    expect(q.snapshot()).toEqual(before)
  })

  it('rejects a patch outside the trigger outcome barrier', () => {
    const q = new TaskQueue()
    q.add(task('source'))
    const before = q.snapshot()

    expect(() => q.applyPlanPatch({
      reason: 'Too early.',
      addTasks: [{
        key: 'replacement',
        title: 'Replacement',
        description: 'Must not be appended.',
      }],
    }, 'source', 'failure')).toThrow('must be in_progress')

    expect(q.snapshot()).toEqual(before)
  })

  it('does not classify a failure as recovered without an appended replacement', () => {
    const q = new TaskQueue()
    q.add(task('source'))
    q.add(task('downstream', { dependsOn: ['source'] }))
    const before = q.snapshot()

    expect(() => q.applyPlanPatch({
      reason: 'Only retarget downstream.',
      retargetPending: [{ taskId: 'downstream', assignee: 'worker-b' }],
    }, 'source', 'failure')).toThrow('must append at least one replacement task')

    expect(q.snapshot()).toEqual(before)
  })

  it('round-trips adaptive plan revisions through snapshot v2', () => {
    const q = new TaskQueue()
    q.add(task('source'))
    q.update('source', { status: 'in_progress' })
    const { revision } = q.applyPlanPatch({
      reason: 'Add follow-up.',
      addTasks: [{
        key: 'follow-up',
        title: 'Follow-up',
        description: 'Continue after source.',
        dependsOn: ['source'],
      }],
    }, 'source', 'success')
    q.publishPlanRevision(revision)

    const snapshot = q.snapshot()
    expect(snapshot.version).toBe(2)
    const restored = TaskQueue.fromSnapshot(snapshot)
    expect(restored.getPlanRevision()).toBe(1)
    expect(restored.getPlanRevisions()).toEqual([revision])
    expect(restored.list()).toEqual(q.list())
  })

  it('rejects a corrupt adaptive revision sequence during restore', () => {
    const q = new TaskQueue()
    q.add(task('source'))
    q.update('source', { status: 'in_progress' })
    q.applyPlanPatch({
      reason: 'Add follow-up.',
      addTasks: [{
        key: 'follow-up',
        title: 'Follow-up',
        description: 'Continue.',
      }],
    }, 'source', 'success')
    const snapshot = q.snapshot()
    if (snapshot.version !== 2) throw new Error('expected adaptive snapshot')

    expect(() => TaskQueue.fromSnapshot({
      ...snapshot,
      planRevision: 2,
    })).toThrow('invalid plan revision sequence')
  })

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  it('fires all:complete when every task reaches a terminal state', () => {
    const q = new TaskQueue()
    const allComplete = vi.fn()
    q.on('all:complete', allComplete)

    q.add(task('a'))
    q.add(task('b'))

    q.complete('a')
    expect(allComplete).not.toHaveBeenCalled()

    q.complete('b')
    expect(allComplete).toHaveBeenCalledTimes(1)
  })

  it('fires all:complete when mix of completed and failed', () => {
    const q = new TaskQueue()
    const allComplete = vi.fn()
    q.on('all:complete', allComplete)

    q.add(task('a'))
    q.add(task('b', { dependsOn: ['a'] }))

    q.fail('a', 'err') // cascades to b
    expect(allComplete).toHaveBeenCalledTimes(1)
  })

  it('isComplete returns true for an empty queue', () => {
    const q = new TaskQueue()
    expect(q.isComplete()).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Query: next / nextAvailable
  // -------------------------------------------------------------------------

  it('next() returns a pending task for the given assignee', () => {
    const q = new TaskQueue()
    q.add(task('a', { assignee: 'alice' }))
    q.add(task('b', { assignee: 'bob' }))

    expect(q.next('bob')?.id).toBe('b')
  })

  it('next() returns undefined when no pending task matches', () => {
    const q = new TaskQueue()
    q.add(task('a', { assignee: 'alice' }))
    expect(q.next('bob')).toBeUndefined()
  })

  it('nextAvailable() prefers unassigned tasks', () => {
    const q = new TaskQueue()
    q.add(task('assigned', { assignee: 'alice' }))
    q.add(task('unassigned'))

    expect(q.nextAvailable()?.id).toBe('unassigned')
  })

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------

  it('getProgress() returns correct counts', () => {
    const q = new TaskQueue()
    q.add(task('a'))
    q.add(task('b'))
    q.add(task('c', { dependsOn: ['a'] }))

    q.complete('a')

    const p = q.getProgress()
    expect(p.total).toBe(3)
    expect(p.completed).toBe(1)
    expect(p.pending).toBe(2) // b + c (unblocked)
    expect(p.blocked).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Event unsubscribe
  // -------------------------------------------------------------------------

  it('unsubscribe stops receiving events', () => {
    const q = new TaskQueue()
    const handler = vi.fn()
    const off = q.on('task:ready', handler)

    q.add(task('a'))
    expect(handler).toHaveBeenCalledTimes(1)

    off()
    q.add(task('b'))
    expect(handler).toHaveBeenCalledTimes(1) // no new call
  })

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('throws when completing a non-existent task', () => {
    const q = new TaskQueue()
    expect(() => q.complete('ghost')).toThrow('not found')
  })

  it('throws when failing a non-existent task', () => {
    const q = new TaskQueue()
    expect(() => q.fail('ghost', 'err')).toThrow('not found')
  })
})
