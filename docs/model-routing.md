# Model routing

Model Routing chooses models for calls inside an execution topology. It is orthogonal to [Execution Routing](execution-routing.md), which decides whether an automatic `runTeam()` call uses one Agent or a Coordinator-generated Team plan.

`modelRouting` is an opt-in, deterministic policy that sends different orchestration calls to different models without touching your team or agent configuration. The usual shape is "flagship model plans, a cheap model runs the leaf work":

```ts
import type { ModelRoutingPolicy } from '@open-multi-agent/core'

const modelRouting: ModelRoutingPolicy = {
  rules: [
    // Flagship model decomposes the goal and synthesizes the final answer.
    { match: { phase: 'coordinator' }, route: { model: 'claude-opus-4-7' } },
    { match: { phase: 'synthesis' },   route: { model: 'claude-opus-4-7' } },
    // Everything that has no dependents runs on a cheap model.
    { match: { leaf: true }, route: { model: 'claude-haiku-4-5' } },
  ],
}

const result = await orchestrator.runTeam(team, goal, { modelRouting })
```

`runTasks` takes the same option:

```ts
const result = await orchestrator.runTasks(team, tasks, { modelRouting })
```

A rule is `{ match, route }`. **Rules are evaluated in array order and the first match wins**, so put your most specific rules first. A call that matches no rule keeps the model it would have used anyway.

## Match dimensions

A rule matches only when **every** field set in `match` agrees with the call. An empty `match: {}` matches everything (useful as a final catch-all).

| Field | Matches when | Available on |
|-------|--------------|--------------|
| `phase` | the call is for this orchestration phase (`coordinator`, `synthesis`, `short-circuit`, `worker`, `delegated`) | every call |
| `agent` | the running agent's name equals this | every call |
| `taskRole` | the task's `role` equals this | worker / delegated calls (role comes from an explicit task or the coordinator's JSON) |
| `taskPriority` | the task's `priority` equals this (`low` \| `normal` \| `high` \| `critical`) | worker / delegated calls |
| `leaf` | the task has no dependents in the execution graph | worker / delegated calls |
| `hasDependencies` | the task's `dependsOn` is non-empty | worker / delegated calls |

`taskRole`, `taskPriority`, `leaf`, and `hasDependencies` are task-scoped, so they only ever match `worker` and `delegated` calls. The `coordinator`, `synthesis`, and `short-circuit` phases have no task attached, and a rule that sets a task field will simply never match them.

## Route config

The `route` is the override applied when the rule matches. Only `model` is required; the rest fall back to the agent's config, then the orchestrator defaults.

| Field | Meaning |
|-------|---------|
| `model` | Model for the matched call. Required. |
| `provider` | Provider override (`anthropic`, `openai`, `gemini`, …). Defaults to the agent's or default provider. |
| `baseURL` | Base URL for OpenAI-compatible or self-hosted endpoints. |
| `apiKey` | API key for the matched call. |
| `region` | AWS region, for Bedrock routes. |
| `fallback` | Ordered backup routes for retryable worker-provider failures. |

## Retryable provider fallback

Worker routes can declare an ordered `fallback` list. The initial attempt uses
the route itself. When a confirmed provider error is retryable, the next task
retry moves to the next entry in the list. Once the list is exhausted, later
retries keep using its final entry.

```ts
const modelRouting: ModelRoutingPolicy = {
  rules: [{
    match: { phase: 'worker' },
    route: {
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      fallback: [{
        model: 'gpt-5',
        provider: 'openai',
      }],
    },
  }],
}

await orchestrator.runTasks(team, [{
  title: 'Write report',
  description: 'Summarize the findings.',
  assignee: 'writer',
  maxRetries: 1,
}], { modelRouting })
```

Fallback is opt-in and reuses each task's existing retry settings, so set
`maxRetries` high enough to reach the backup entries you configure. Authentication,
validation, hook, and other non-provider errors never advance the fallback chain.
A failed task without a structured provider error continues to use its current
route. Each fallback entry is applied to the worker's effective configuration like
any other route. When a backup uses a different provider or endpoint, include its
`provider`, `baseURL`, `apiKey`, and `region` overrides as appropriate.

## Which calls are routed

A single policy covers all five orchestration phases:

- **`coordinator`** — the goal-decomposition call in `runTeam`.
- **`synthesis`** — the final answer-assembly call in `runTeam`.
- **`worker`** — a task agent running an assigned task (`runTeam` and `runTasks`).
- **`delegated`** — an agent reached through `delegate_to_agent`.
- **`short-circuit`** — the single-agent path `runTeam` takes when a goal is simple enough to skip decomposition.

## Opt-in and non-mutation

Two guarantees keep routing safe to leave configured:

- **Opt-in.** Omit `modelRouting` and model selection is byte-identical to before, on both `runTeam` and `runTasks`.
- **No mutation.** A matched route builds an ephemeral effective config for that one call. Your `Team`, its `AgentConfig`s, and the orchestrator defaults are never modified, so the same team can run with different policies across calls.

## Cost-tiered example

[`examples/patterns/cost-tiered-pipeline.ts`](../packages/core/examples/patterns/cost-tiered-pipeline.ts) runs the same four-stage pipeline twice (all-flagship vs. a tiered mix) and prints the per-model token and USD breakdown, so you can see what a routing policy saves before adopting one.
