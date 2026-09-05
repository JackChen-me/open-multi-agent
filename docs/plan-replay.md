# Plan preview & replay

`runTeam` normally decomposes a goal and executes it in a single call. You can split that in two: have the coordinator decompose the goal into a task DAG **without executing it**, freeze that plan as a serializable artifact, then **replay the exact same graph later without calling the coordinator again**.

This buys three things: the coordinator pass (an extra LLM round-trip on every `runTeam`) runs once instead of on every execution; the task graph is fixed instead of re-derived by an LLM each time, so runs are structurally reproducible; and the plan is plain, reviewable, version-controllable data. It covers `runTeam(planOnly)` → `createPlanArtifact` → `runFromPlan`. `restore()` also accepts a plan artifact — see [Checkpoint & resume](checkpoint.md).

## Preview a plan

Pass `planOnly: true` to `runTeam`. The coordinator decomposes the goal, but no task agents run:

```typescript
import { OpenMultiAgent, Team } from '@open-multi-agent/core'

const orchestrator = new OpenMultiAgent()
const team = new Team({ name: 'research', agents: [researcher, writer] })

const preview = await orchestrator.runTeam(team, goal, { planOnly: true })
// preview.planOnly === true
// preview.tasks        — the decomposed DAG, every task 'pending', no metrics
// preview.totalTokenUsage — the coordinator decomposition only
```

The returned `TeamRunResult` has `planOnly: true`, `success: true`, and `tasks` populated (all `pending`); `agentResults` holds only the coordinator's decomposition call. Two things to know:

- **`planOnly` bypasses the simple-goal short-circuit.** A trivial goal that a normal `runTeam` would hand straight to a single agent still goes through the coordinator here, so you always get a real plan to inspect.
- **`onPlanReady` still gates.** If you've wired `OrchestratorConfig.onPlanReady` and it returns `false`, the plan is rejected: the result is `success: false` and `planOnly` is unset. See [previewing and gating the plan](coordinator.md#previewing-and-gating-the-plan) for how the gate sits relative to the coordinator's own validation.

## Freeze it

Turn a plan-only result into a `PlanArtifact` — plain JSON you can diff, commit, and hand to another process:

```typescript
const plan = orchestrator.createPlanArtifact(preview)

// It's just data — persist it however you like.
import { writeFileSync } from 'node:fs'
writeFileSync('plan.json', JSON.stringify(plan, null, 2))
```

`createPlanArtifact` accepts only a **plan-only** result; an executed run is rejected because its task records are not a replay contract. Every task must carry a description.

## Edit before replay

A `PlanArtifact` is plain data, so you can hand-edit it before replaying — retarget an `assignee`, reword a `description`, add or remove tasks, or rewire `dependsOn`:

```typescript
import { readFileSync } from 'node:fs'
const plan = JSON.parse(readFileSync('plan.json', 'utf8'))
plan.tasks[0].assignee = 'writer' // e.g. reassign the first task
```

`runFromPlan` validates the dependency graph before it runs anything. If an edit references a task id that doesn't exist or introduces a cycle, it throws rather than run a broken plan.

## Replay

Run the frozen plan. The coordinator is **not** invoked — task ids, dependencies, and assignees are used exactly as stored:

```typescript
const result = await orchestrator.runFromPlan(team, plan)
```

`runFromPlan` reuses the same execution path as `runTasks` (dependency-ordered, independents in parallel), and like `runTasks` it accepts the opt-in `checkpoint` option for durable snapshot/resume. It is execution-only: it does **not** synthesize a coordinator final answer, so `result` carries the per-task outputs rather than a combined `'coordinator'` result. When you need synthesis, use `runTeam`.

## What the artifact contains

```typescript
interface PlanArtifact {
  version: 1
  goal?: string
  tasks: PlanTaskArtifact[]
}

interface PlanTaskArtifact {
  id: string
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}
```

The artifact is versioned; `runFromPlan` throws on an unsupported `version`. Only the fields that shape the task graph and its execution are stored — no results, status, or metrics from any run.

## Limitations

- **It freezes the structure, not the outputs.** The plan pins the task graph — who does what, in what order. Each task is still a live LLM call at replay time, so the same plan run twice can produce different task content. Pin the graph, not the answer.
- **No synthesis on replay.** `runFromPlan` returns raw per-task outputs; it does not run the coordinator's final synthesis step. Use `runTeam` (or `restore` of a `runTeam` checkpoint) when you need a synthesized answer.
- **You pin ahead of time, not retroactively.** `createPlanArtifact` takes a plan-only preview, not an executed run. To capture a plan, run `planOnly` first — you cannot freeze the DAG from a run you have already executed.
- **A simple goal previews differently than it runs.** Because `planOnly` bypasses the single-agent short-circuit, the plan for a trivial goal may not match what a normal `runTeam` would do (which would skip the coordinator entirely).
```

