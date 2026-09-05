# Coordinator

`runTeam(team, goal)` is the only entry point that plans. It builds a temporary agent named `coordinator`, asks it to turn the goal into a task DAG, hands that DAG to the scheduler, and afterwards asks the same configuration to write a final answer from the completed task outputs. This page covers what the coordinator decides, what it is allowed to see, how to configure or replace it, and the paths that skip it entirely.

## What the coordinator does, and what it does not

The coordinator has three jobs:

1. **Decompose.** One model call produces a JSON array of task specs (title, description, assignee, `dependsOn`, and optional `requires`, `verify`, and scheduling fields).
2. **Assign.** Each spec names an assignee from the team roster. Unassigned tasks are left for the scheduler.
3. **Synthesize.** After execution, a second model call with the same base config turns the completed task outputs into the run's final answer.

It does **not** run the tasks and it does not decide their order at runtime. Decomposition happens once, before execution. From that point on, `TaskQueue` tracks readiness from `dependsOn` edges and `Scheduler` picks which ready task goes to which agent, using the configured [assignment strategy](task-scheduling.md#assignment-strategies). The coordinator is never consulted again mid-run.

Two things can change the plan after decomposition, and neither is the coordinator:

- **Adaptive recovery** appends tasks through an application-owned replanner at a task-outcome barrier. See [adaptive recovery](adaptive-recovery.md).
- **`onPlanReady`** can reject or suspend the plan before execution starts.

The coordinator agent is also not a worker: it is built without `delegate_to_agent` (only pool workers register that tool), and `OrchestratorConfig.defaultToolPreset` deliberately does not apply to it, so it has no built-in tools unless `CoordinatorConfig.tools` or `CoordinatorConfig.toolPreset` grants them.

## What the coordinator sees

The decomposition system prompt is assembled from four sections: a preamble, the team roster, the output format, and synthesis guidance.

The roster is a **bounded structured manifest**, not the team's raw configs. For each agent it carries:

| Field | Source | Bound |
|---|---|---|
| `name` | `AgentConfig.name`, exact | none, so plan validation can match it |
| `model` | `AgentConfig.model`, else the default model | 120 characters |
| `roleSummary` | `AgentConfig.description`, else the first line of `systemPrompt` | 140 characters (`COORDINATOR_ROLE_SUMMARY_MAX_CHARS`) |
| `capabilities` | `AgentConfig.capabilities` | first 20 entries (`COORDINATOR_MANIFEST_MAX_CAPABILITIES`) |
| `tools` | resolved grants, including `delegate_to_agent` | first 24 names (`COORDINATOR_MANIFEST_MAX_TOOLS`) |
| `costTier` | `AgentConfig.costTier` | none |

A full `systemPrompt` is never exposed. The prompt says so explicitly, so the model does not assume the summary is the whole prompt. Dependency guidance instructs the coordinator to prefer the minimum set of upstream tasks, using `roleSummary` and declared `capabilities` as the primary signal for what an agent consumes.

## Validating the plan

Decomposition uses the agent's structured-output path: `buildCoordinatorTaskSpecsSchema()` builds a Zod schema from the live roster and passes it as `outputSchema`, so an invalid plan gets the Agent's single corrective retry before anything else runs. The schema is `.strict()` and rejects unknown keys, unknown assignees (when `strictAssignees` is on), and `dependsOn` references that do not resolve to exactly one task title.

After parsing, three more checks run in order, and each failure ends the run rather than degrading to a different topology:

- **Assignee check.** `strictAssignees` defaults to `true`: a plan naming an agent outside the roster fails validation with `INVALID_ASSIGNEE`. Set it to `false` for the legacy behavior of emitting a warning, clearing that assignment, and letting the scheduler choose.
- **Dependency check.** `loadSpecsIntoQueue()` resolves title-based `dependsOn` into task ids and validates the graph. An invalid DAG fails with `INVALID_TASK_DEPENDENCIES`, and no task is loaded partially. A reference that resolves to no task, or to an ambiguous duplicate title, fails that individual task instead of the run; for a coordinator plan the structured-output schema normally rejects it one step earlier.
- **Requirement check.** Every task's `requires` is validated against the roster before dispatch; see [errors](errors.md#invalidtaskrequirementserror).

If the coordinator produced no usable array at all, the run fails with `COORDINATOR_PLAN_INVALID`. A coordinator plan is treated as an execution boundary: an invalid plan is not silently converted into a single-agent run, because that could duplicate side effects.

## Configuring the coordinator

Pass `RunTeamOptions.coordinator`. Every field is optional; unset fields fall back to orchestrator defaults or coordinator built-ins.

```ts
const result = await orchestrator.runTeam(team, goal, {
  coordinator: {
    model: 'gpt-5.4',
    provider: 'openai',
    instructions: 'Prefer three tasks or fewer. Never assign research to the writer.',
    maxTurns: 3,
    toolPreset: 'readonly',
  },
})
```

| Field | Falls back to |
|---|---|
| `model` | `OrchestratorConfig.defaultModel` (default `'claude-opus-4-6'`) |
| `adapter` | none; when set, `provider` / `apiKey` / `baseURL` are ignored |
| `provider`, `baseURL`, `apiKey` | `defaultProvider`, `defaultBaseURL`, `defaultApiKey` |
| `systemPrompt` | the built-in preamble and decomposition guidance |
| `instructions` | nothing; ignored when `systemPrompt` is set |
| `maxTurns` | `3` |
| `maxTokens`, `temperature`, `topP`, `topK`, `minP`, `frequencyPenalty`, `presencePenalty`, `parallelToolCalls`, `extraBody` | unset, so the adapter default applies |
| `tools`, `toolPreset`, `disallowedTools` | unset, and `defaultToolPreset` does **not** apply |
| `onToolCall` | `OrchestratorConfig.onToolCall` |
| `shellExecutor` | `OrchestratorConfig.defaultShellExecutor` |
| `cwd` | `OrchestratorConfig.defaultCwd`; pass `null` to disable the sandbox for the coordinator only |
| `loopDetection`, `timeoutMs`, `callTimeoutMs` | unset |

Two prompt-override modes, and they do not compose. `systemPrompt` **replaces** the preamble and decomposition guidance; the roster, output-format, and synthesis sections are still appended afterwards, so a full override cannot break the JSON contract or hide the roster. `instructions` instead appends an `## Additional Instructions` section to the default prompt, and is ignored entirely when `systemPrompt` is set.

Three things are not configurable per coordinator. `egressPolicy` is inherited from the effective orchestrator policy. `outputSchema` is owned by the framework for the decomposition pass. And the fields absent from `CoordinatorConfig` (`maxTokenBudget`, `contextStrategy`, `thinking`, `customTools`, `credentials`, `beforeRun`, `afterRun`) are not forwarded at all; the run-level budget still applies to coordinator usage through the orchestrator's own accounting.

The same base config is reused for synthesis, with one difference: `modelRouting` is matched again with `phase: 'synthesis'` instead of `phase: 'coordinator'`, so the two passes can run on different models. See [model routing](model-routing.md#match-dimensions).

Coordinator usage lands in `TeamRunResult.agentResults` under two keys: `coordinator:decompose` and `coordinator`. Neither counts toward the run's completed-task count.

## `revealCoordinator`: what workers know about the plan

By default a worker's prompt contains its own task and its dependency results, and nothing about the goal or the rest of the team. `RunTeamOptions.revealCoordinator: true` prepends a fixed block to every worker prompt:

```text
## Team context
Goal: <the original goal>
Team: <comma-separated roster names>
Your role in this team: <this worker's assignee name>
Assignment: You are responsible for the prompt below in this team run.
```

Scope and limits worth knowing:

- Default is `false`, and with it off worker prompts are byte-identical to a run without the option.
- It reveals **roster names and the goal**, not other agents' prompts, capabilities, or task descriptions.
- It applies to task workers and to agents reached through `delegate_to_agent` within the run.
- It is a `runTeam()` option only. `runTasks()` has no goal concept and ignores it, and the simple-goal short circuit has no coordinator context to reveal.

Use it when workers produce off-target output because they cannot tell what the larger deliverable is; leave it off when you want each task's context minimal, which is the framework's default posture (see [task scheduling](task-scheduling.md#task-results-and-dependency-payloads)).

## The simple-goal short circuit

For a goal that a single agent can handle, spinning up a coordinator costs two extra model calls and buys nothing. `runTeam()` therefore has a path that skips both decomposition and synthesis and dispatches straight to one agent.

**When it triggers.** All of these must hold:

- `planOnly` is not set.
- The roster is non-empty.
- The topology resolves to Single, which happens when `mode: 'single'` was passed explicitly, when a `preferred` governance declaration degraded under a budget ceiling, or when the execution router returned `mode: 'single'`.

The built-in `DeterministicRouter` returns Single when `isSimpleGoal(goal)` holds, which requires both of:

1. The goal's estimated information length is at most `SIMPLE_GOAL_MAX_LENGTH` (200 units, script-weighted: CJK characters count as 2.25 units, Latin word runs approximate token density).
2. It matches none of the `COMPLEXITY_PATTERNS`: explicit sequencing, coordination directives, parallelism, or multi-deliverable enumerations, in English, Chinese, Japanese, and Korean.

The patterns are deliberately conservative. They fire on imperative directives ("coordinate the team"), not descriptive uses ("how do pods coordinate state"). The full policy, including its honest language-coverage tiers, is in [execution routing](execution-routing.md#built-in-deterministic-policy).

**What the short circuit changes.** `selectBestAgent()` picks one roster agent by two-directional keyword affinity, matching the `capability-match` scheduler strategy, with ties broken by ascending agent name. Then:

- No coordinator call happens, so no decomposition and no synthesis. Token usage covers the single agent only.
- `delegate_to_agent` is **not registered**. Only pool workers get it, and the short circuit builds the agent directly. A goal that needs one agent to hand off to another must not take this path; force `mode: 'team'` or declare governance roles.
- `onPlanReady` never fires, because there is no plan.
- `revealCoordinator` is ignored.
- The result still looks like a team run: `tasks` contains one synthetic record with id `short-circuit`, title `Short-circuit: <agent>`, and that agent as assignee, and `agentResults` is keyed by the agent's name.
- Model routing matches with `phase: 'short-circuit'`.

To bypass it, pass `mode: 'team'`, set `planOnly: true`, or declare `governanceIntent`. Note that `mode: 'single'` and `planOnly: true` together are rejected.

## Previewing and gating the plan

`planOnly: true` runs decomposition and stops. No task agent runs, `tasks` comes back with every task `pending` and no metrics, `agentResults` holds only the decomposition call, and `planOnly: true` is set on the result. It also bypasses the short circuit, so a trivial goal still yields a real plan to inspect.

`OrchestratorConfig.onPlanReady` receives the full `Task[]` after decomposition and before execution. It is reached only by this coordinator path: not by the short circuit, not by a declared-governance topology, and not by `runTasks()` or `runFromPlan()`. Returning `false` ends the run with `success: false` while still reporting the coordinator's decomposition tokens; returning `{ action: 'suspend' }` persists the exact plan for a later durable decision. With `planOnly: true`, a rejection wins and `planOnly` is unset on the result.

Configuring `onPlanReady` (or `onApproval`, or `planOnly`) also makes the scheduler auto-assign unassigned tasks before the gate runs, so a reviewer sees assignees rather than blanks.

Freeze an approved plan with `createPlanArtifact()` and replay it later with `runFromPlan()`, which never calls the coordinator. See [plan replay](plan-replay.md) and [hooks and callbacks](hooks-and-callbacks.md#onplanready).

## Declared governance replaces the coordinator

`governanceIntent: 'required'` or `'preferred'` with `requiredRoles` skips coordinator decomposition **and** the short circuit. OMA builds one task per declared role, keeps each assigned to that roster agent, and derives dependency edges from `requiredOrder` when present. The goal text is never inspected to choose that topology, so the same declaration produces the same DAG in any language.

This is the deterministic alternative to trusting an LLM to produce the right shape. The trade-off is that you own the decomposition. Role names, order validation, the post-run `governanceConclusion` check, and how `mode` and budget policy interact with a declaration are all covered in [tool configuration](tool-configuration.md#declared-governance-roles-in-runteam); this page does not repeat them.

## Letting the coordinator opt tasks into verification

`RunTeamOptions.verifyJudges` is the switch that makes coordinator-generated tasks eligible for the per-task `verify` hook. Without it, a `verify` key in the coordinator's JSON is parsed and then ignored, because a coordinator can never emit judge configs itself.

With judges supplied, the output-format section gains a `verify` line and the coordinator may emit either `"verify": true` or a partial object with `mode` (`'refute' | 'lens'`), `quorum`, `maxRounds`, and `onDissent` (`'revise' | 'reject' | 'keep'`). `resolveVerify()` merges that partial with the caller-supplied `judges` into full `ConsensusVerifyOptions`. Judge usage counts against the same parent token budget.

This applies to `runTeam()` only. `runTasks()` specs carry full `ConsensusVerifyOptions` per task instead. See [coordinator-generated verification](consensus.md#coordinator-generated-verification-in-runteam) and the [per-task `verify` hook](consensus.md#per-task-verify-hook).

## Execution routing and the hybrid profiler

Execution routing chooses Single versus Team **before** the coordinator would run; model routing chooses which model each phase uses. They are orthogonal.

With `executionRouting: { strategy: 'hybrid' }`, a deterministic Single candidate gets one semantic profiling call before being accepted. That profiler resolves its adapter and model with a coordinator fallback:

1. `executionRouting.profiler` if supplied, used as-is.
2. Otherwise `executionRouting.adapter`, else `coordinator.adapter`.
3. If neither, an adapter built from `defaultProvider`, `defaultApiKey`, and `defaultBaseURL`.
4. The model is `executionRouting.model`, else `coordinator.model`, else `defaultModel`.

So a `CoordinatorConfig` that pins a cheap planning model also pins the profiler's model, unless `executionRouting.model` overrides it. Note the asymmetry: `adapter` and `model` fall back to the coordinator, but `provider`, `apiKey`, and `baseURL` do not.

If the profiler recommends `needs-declaration`, `runTeam()` throws `RoutingDeclarationRequiredError` instead of guessing a topology. Timeouts and profiler failures fall back to the deterministic decision unless `failurePolicy: 'fail'`. See [execution routing](execution-routing.md) and [errors](errors.md#timeout-and-routing-errors).

## From the CLI

`oma run --goal <text> --team team.json --coordinator coord.json` passes the parsed JSON straight through as `runTeam(..., { coordinator })`. The file must be a JSON object; it is not otherwise validated at the CLI boundary, so a typo surfaces as coordinator behavior rather than a usage error.

Only JSON-serializable `CoordinatorConfig` fields work there. `adapter`, `onToolCall`, and `shellExecutor` are runtime objects and cannot be expressed in a config file, which is the same limitation the orchestrator JSON has. See [CLI configuration files](cli.md#orchestrator-and-coordinator-json).
