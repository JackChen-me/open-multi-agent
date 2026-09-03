# Adaptive recovery

OMA keeps task graphs fixed by default. Opt into `recovery.mode: 'repairable'`
when an application needs to revise the not-yet-executed part of a run after a
task succeeds, fails, or is rejected by consensus verification.

Adaptive recovery is an outcome barrier, not another retry:

1. A task produces an outcome.
2. The configured `Replanner` (or `onTaskOutcome` callback) may propose a
   `PlanPatch`.
3. OMA validates agent eligibility, limits, task states, references, and the
   resulting DAG.
4. The optional `onPlanPatch` gate approves or rejects the proposal.
5. OMA applies the patch atomically, persists a checkpoint when checkpointing
   is enabled, then publishes newly-ready work.
6. Only after that barrier does the triggering task complete or fail and
   release or cascade its original dependents.

This ordering prevents an original downstream task from starting while its
replacement is still being decided.

## Configure a replanner

```ts
import {
  OpenMultiAgent,
  type Replanner,
  type TaskOutcome,
} from '@open-multi-agent/core'

const replanner: Replanner = {
  name: 'fallback-search',
  replan(outcome: TaskOutcome) {
    if (outcome.kind !== 'failure' || outcome.task.title !== 'Search') {
      return undefined
    }

    const oldAnalysis = outcome.tasks.find((task) => task.title === 'Analysis')
    if (!oldAnalysis) return undefined

    return {
      reason: 'Primary search failed; use the fallback source.',
      supersedePending: [oldAnalysis.id],
      addTasks: [
        {
          key: 'fallback-search',
          title: 'Fallback Search',
          description: 'Fetch the source through the fallback path.',
          assignee: 'researcher-b',
        },
        {
          key: 'replacement-analysis',
          title: 'Replacement Analysis',
          description: 'Analyze the fallback result.',
          assignee: 'analyst',
          dependsOn: ['fallback-search'],
        },
      ],
    }
  },
}

const result = await oma.runTasks(team, tasks, {
  recovery: {
    mode: 'repairable',
    replanner,
    maxPlanRevisions: 3,
    maxAddedTasks: 20,
    onPlanPatch: async (patch, outcome) => {
      return await applicationPolicyApproves(patch, outcome)
    },
  },
})
```

`onTaskOutcome` is a shorthand for applications that do not need a named
`Replanner` object. Configure one or the other, not both. A custom replanner may
call an LLM or another service, but that external I/O and its usage accounting
remain owned by the application.

## Patch operations

- `addTasks` appends tasks. Every appended task has a patch-local `key`.
  Dependencies may refer to another key in the same patch or to an existing
  task ID.
- `retargetPending` changes the assignee of a `pending` or `blocked` task after
  the new agent passes the same eligibility checks used by scheduling.
- `supersedePending` marks a `pending` or `blocked` task `skipped`. Replacement
  tasks are appended rather than rewriting or deleting history.

Started or terminal tasks cannot be retargeted or superseded. A failure or
verification rejection is classified as recovered only when the accepted patch
appends at least one replacement task. Successful tasks may append or reshape
downstream work without being marked recovered.

Patch references use task IDs, not titles. This avoids ambiguity when multiple
runtime tasks have the same title.

## Failure, durability, and restore

Without an accepted patch, existing behavior is unchanged: failed tasks cascade
failure to their dependents while independent branches may continue.

Accepted revisions are stored in queue snapshot version 2. Snapshot version 1
remains the fixed-DAG format and is still readable. When checkpointing is
enabled, OMA saves the patched graph before it dispatches appended work. If that
save fails, the unpublished patch is rolled back and the original failure path
continues.

Restore resets an interrupted task for execution while retaining durable plan
revision history. A revision with the same trigger task and outcome is not
appended twice after a crash.

Historical tasks remain truthful in `result.tasks`: a repaired failure is still
`failed` with `recoveredByRevision`, and a replaced branch is `skipped` with
`supersededByRevision`. Those historical records do not make the overall run
fail when the active repaired graph finishes successfully. Accepted revisions
are returned in `result.planRevisions`.

## Complete cookbook recipe

[`commission-reconciliation-recovery.ts`](../packages/core/examples/cookbook/commission-reconciliation-recovery.ts)
is a no-key, synthetic example of the full outcome-barrier flow. Three
source-scoped investigations produce an initial temporal-evidence gap, a named
`Replanner` adds targeted agreement and policy history tasks, and replacement
tasks reconcile only their validated direct dependencies.

```bash
# Accepted repair: exits 0 with a RECONCILED outcome.
npx tsx packages/core/examples/cookbook/commission-reconciliation-recovery.ts --case recovered

# Still missing evidence: intentionally exits 1 with MANUAL_REVIEW_REQUIRED.
npx tsx packages/core/examples/cookbook/commission-reconciliation-recovery.ts --case unresolved
```

The recipe caps recovery at one accepted revision and four added tasks. In the
unresolved case, the replanner proposes further evidence work, OMA rejects it at
`maxPlanRevisions`, and the application maps the final typed evidence gap to
manual review after orchestration finishes. Manual review is an application
terminal state, not a framework task status. Neither case performs a payment.

## Boundaries

- Recovery is opt-in. Existing callers remain fixed-DAG.
- `runFromPlan()` is exact replay and rejects repairable recovery.
- Repairable recovery is incompatible with legacy round-based `onApproval`.
  Use `onTaskDispatch` and/or `onPlanPatch` gates.
- Limits reject further patches; they never silently truncate a patch.
- Policy, validation, approval, revision, and checkpoint decisions are exposed
  through progress events and observability spans.
- A repair is forward-only. OMA does not undo external side effects already
  performed by a task.
