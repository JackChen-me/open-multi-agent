# Budgets and limits

An agent loop that is allowed to run forever eventually will. This page
collects every ceiling OMA enforces on its own execution: how many turns an
agent may take, how long a run and a single model call may take, when a
repeating agent is stopped, and how token and cost budgets are accounted and
enforced. For each one it states the layer it acts on, its default, and exactly
what a caller observes when it trips.

Two properties hold across all of them and are easy to get wrong:

- **Budgets are checked at turn and task boundaries, not mid-call.** A run can
  overshoot its ceiling by up to one model turn. Treat a cost budget as a
  bound, never as a cent-exact stop.
- **Exhausting a budget does not throw.** The framework reports it as a
  `budget_exceeded` progress event plus result fields. The
  `TokenBudgetExceededError` and `CostBudgetExceededError` classes exist to
  carry the numbers and to classify the outcome, not as control flow you catch.

## Where each limit acts

| Layer | Limits that act here |
|---|---|
| One LLM call | `callTimeoutMs` |
| One agent turn | `maxTokenBudget` on the agent, `loopDetection` |
| One agent run | `maxTurns`, `timeoutMs`, `maxTokenBudget` on the agent |
| One task | Run-level token and cost accounting after each attempt |
| One orchestrator run | `maxTokenBudget`, `maxCostBudget`, `maxConcurrency`, `maxDelegationDepth` |

## Turn ceiling: `maxTurns`

`AgentConfig.maxTurns` bounds how many model turns one agent run may take.
`AgentRunner` defaults it to `10`
(`packages/core/src/agent/runner.ts`, `this.maxTurns = options.maxTurns ?? 10`).
The internal coordinator has its own default of `3`
(`packages/core/src/orchestrator/coordinator.ts`), overridable through
`CoordinatorConfig.maxTurns`.

When the ceiling is reached the loop simply stops before the next model call.
The result's `output` falls back to the most recent assistant text, and the run
is reported as **successful**: `success: true`, `status.code === 'ok'`, and no
flag distinguishes it from an agent that finished on its own. If you need to
know, compare `result.toolCalls` or the message count against what a completed
task should look like, or set a lower `maxTurns` deliberately and treat a
suspiciously long run as an alert.

`ContextStrategy` of type `sliding-window` also takes a field named `maxTurns`.
That one selects how much history to keep, not how long the agent may run. See
[context management](context-management.md).

## Wall-clock ceilings: `timeoutMs` and `callTimeoutMs`

Neither has a default. Unset means the run is bounded only by whatever the
vendor SDK does on its own, which is inconsistent across providers and absent
for some.

`AgentConfig.timeoutMs` bounds the **whole agent run**. A fresh
`AbortSignal.timeout()` is minted per `run()` / `stream()` call and merged with
any caller `abortSignal`. On expiry the result is `success: false` with
`status.code === 'timeout'` and a `TimeoutError` whose message names the agent
and the configured value.

`AgentConfig.callTimeoutMs` bounds a **single `adapter.chat()` request**,
re-armed for every model call the runner makes, including the `summarize`
context strategy's own call. A fresh signal per call is what keeps it from
degrading into a second whole-run deadline. When the per-call deadline fires
and the caller's own signal did not, the provider's abort rejection is
translated into an `LLMCallTimeoutError` (`code: 'LLM_CALL_TIMEOUT'`, carrying
`timeoutMs` and `agent`). A caller abort is rethrown as-is rather than
mislabeled as a timeout.

The two compose with each other and with a caller `abortSignal`: whichever
fires first wins. Because the runner calls the model non-streaming, this is a
deadline over the entire response, so keep it generous for slow local models
and large reasoning outputs. Both fields also exist on `CoordinatorConfig`.

An `LLMCallTimeoutError` is classified **retryable**, so a task with
`maxRetries` will try again. A caller cancellation is not.

## Loop detection

`AgentConfig.loopDetection` is off unless configured. When set, the runner
tracks a sliding window of assistant turns and stops an agent that is repeating
itself before `maxTurns` would.

| Field | Default | Meaning |
|---|---|---|
| `maxRepetitions` | `3` | Consecutive identical turns that trigger detection |
| `loopDetectionWindow` | `4` | Recent turns tracked, clamped up to `maxRepetitions` |
| `onLoopDetected` | `'warn'` | `'warn'`, `'terminate'`, or a callback |

Two signatures are tracked independently: the tool signature (tool name plus
recursively key-sorted arguments, so `{b,a}` and `{a,b}` match) and the
whitespace-normalized text output. Either repeating `maxRepetitions` times
consecutively fires detection. Existing assistant turns in the conversation
handed to the runner are replayed into the detector first, so a loop that
started before this run is caught on the first repeat rather than after three
more.

Actions:

- `'terminate'` stops immediately, before any `tool_use` event for that turn,
  so no unpaired tool call is left in the conversation.
- `'warn'` (the default) injects a "you appear to be stuck" message once and
  gives the model another chance. A second detection terminates. Recovering
  resets the cycle, so a later loop gets a fresh warning.
- A callback receives `LoopDetectionInfo` and returns `'continue'`, `'inject'`,
  or `'terminate'`, sync or async.

Detection also calls `onWarning` with the diagnostic detail and emits a
`loop_detected` [stream event](streaming.md#the-streamevent-union). The result
carries `loopDetected: true`, but like `maxTurns` exhaustion it is **not** a
failure: `success` stays `true`. Check the flag if a truncated answer must not
be treated as a finished one.

## Token and cost budgets

`maxTokenBudget` caps cumulative input plus output tokens. `maxCostBudget` caps
cumulative estimated cost in whatever unit `estimateCost` returns. Both are
declarable at more than one scope:

| Field | Scopes |
|---|---|
| `maxTokenBudget` | `AgentConfig`, `OrchestratorConfig`, `RunTasksOptions` / `RunTeamOptions` |
| `maxCostBudget` | `OrchestratorConfig`, `RunTasksOptions` / `RunTeamOptions` |
| `estimateCost` | `OrchestratorConfig` only |

**When two scopes both set a ceiling, the lower one wins.** A per-run or
per-agent value can narrow its parent but never widen it
(`resolveBudgetCeiling` in `packages/core/src/orchestrator/budget.ts`).

`maxCostBudget` without `estimateCost` throws rather than being silently
ignored, both from the `OpenMultiAgent` constructor and when a run option sets
it: `maxCostBudget requires estimateCost so cost caps cannot be silently
ignored.` `RunAgentOptions` carries no budget fields; use the orchestrator or
agent scope for a `runAgent()` call.

### What happens when a budget trips

Comparison is strictly greater than: crossing the ceiling trips, reaching it
exactly does not. On the first crossing in a run:

1. `onProgress` receives a `budget_exceeded` event whose `data` is the
   `TokenBudgetExceededError` or `CostBudgetExceededError`.
2. The affected result gets `budgetExceeded: true`, `success: false`, and
   `status.code === 'budget_exhausted'` with `errorInfo.kind === 'budget'`.
3. In a team or task run, dispatch stops and the remaining pending or blocked
   tasks are marked `skipped` after in-flight tasks settle. Coordinator
   synthesis is skipped entirely when the budget was already exhausted, so a
   run over budget returns raw task output rather than paying for one more
   call.

Nothing is thrown. Only a caller-supplied `estimateCost` that returns a
non-finite or negative number throws, and that surfaces as a failed task with a
`Cost estimator returned invalid cost` error.

For task retry, a budget outcome is **terminal**: `errorInfo.retryable` is
`false`, so `executeWithRetry` does not spend another attempt on it. See
[task retry boundaries](task-scheduling.md#task-retry-boundaries).

### Where accounting happens

- **`runAgent()`** resolves the agent and orchestrator token ceilings to the
  lower value and pushes it into the agent config, so the runner enforces it at
  each turn boundary. Cost is priced once from the finished result, with
  `phase: 'agent'`.
- **`runTeam()` / `runTasks()`** enforce the run ceiling at task boundaries:
  each attempt's usage is recorded after the task settles, so retry usage
  counts toward the budget. Worker agents do **not** inherit the run ceiling
  into their own config; an `AgentConfig.maxTokenBudget` on a worker bounds
  that one agent run, and the run ceiling bounds the whole DAG.
- **The `runTeam()` short circuit** resolves the selected agent's ceiling
  against the run ceiling exactly like `runAgent()` does.
- **The coordinator** checks the budget before decomposition output is priced
  and again before synthesis runs.

Reaching the ceiling mid-turn does not leave the conversation malformed. The
runner defers its break until the pending `tool_result` blocks are appended, so
no unmatched `tool_use` block can be replayed on a later restore.

## `estimateCost`

OMA ships no model price table on purpose: provider prices, cached-token rules,
regions, and contract rates vary, and a stale built-in table is worse than
none. You supply the pricing.

```typescript
import { OpenMultiAgent, type CostEstimateContext, type TokenUsage } from '@open-multi-agent/core'

const priceTable: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
}

const orchestrator = new OpenMultiAgent({
  maxCostBudget: 1,
  estimateCost: (usage: TokenUsage, context: CostEstimateContext): number => {
    const price = priceTable[context.model] ?? { input: 0, output: 0 }
    return usage.input_tokens * price.input + usage.output_tokens * price.output
  },
})
```

The callback receives the usage of **one** LLM result, not a cumulative total,
and returns the amount to add to the run's estimate. Its `context` carries:

| Field | Notes |
|---|---|
| `agentName` | The agent whose usage is being priced |
| `model` | The effective model after defaults and model routing |
| `provider` | Present when known; a model-route fallback prices each attempt with the route that handled it |
| `phase` | `agent`, `routing`, `short-circuit`, `coordinator`, `worker`, `synthesis`, `consensus`, or `delegated` |
| `taskId` | Present when the usage came from a task |

`phase` and `provider` are what make a per-provider or per-stage price table
possible without threading your own state through the run.

## Delegation, consensus, and external backends

- **Delegation.** A delegated run's usage is added to the parent agent's total
  and re-checked against the agent budget on the same turn, so a sub-agent
  cannot spend outside the parent's ceiling. Depth is separately bounded by
  `maxDelegationDepth` (default `3`), and delegation is granted per agent like
  any other built-in tool. See
  [delegation](tool-configuration.md#delegation-with-delegate_to_agent).
- **Consensus.** Proposer, judge, and revision usage accumulate into the same
  run total and stop further judge calls once the cap is crossed. There is no
  separate consensus budget knob. See
  [consensus](consensus.md#budget-invariant).
- **External backends.** A process-backend agent reports `{0, 0}` tokens and is
  therefore not budget-gated in practice; an ACP agent is gated only when it
  emits `usage_update`, and its cumulative context figure is recorded as
  per-turn deltas. Size the budget on your LLM agents and bound external agents
  with their own flags. See
  [external agents](external-agents.md#acp-token-accounting-caveat).

Governed `runTeam()` calls interact with budgets in one more way: a `required`
run that exhausts its ceiling before its required execution facts are complete
reports `governanceConclusion: 'unsatisfied'` with `governanceReason: 'budget'`
rather than a clean success, and `preferredUnderBudget: 'degrade'` chooses the
Single topology whenever a ceiling applies. See
[budget ceilings and governed runs](providers.md#budget-ceilings-and-governed-runs).

## Setting these from the CLI

The `oma` CLI merges arbitrary JSON into `OrchestratorConfig` and passes
unrecognized agent fields straight through, so anything JSON-expressible can be
set without writing TypeScript:

- **Works:** `maxTokenBudget` in the orchestrator JSON; `maxTurns`,
  `timeoutMs`, `callTimeoutMs`, `maxToolOutputChars`, and `loopDetection` with
  a string `onLoopDetected` on each agent in the team JSON.
- **Does not work:** `maxCostBudget`, because it requires `estimateCost`, and a
  function cannot appear in JSON. Configuring it from the CLI throws at
  orchestrator construction. Likewise a function-valued `onLoopDetected`.

See [CLI reference](cli.md#configuration-files).

## Limits at a glance

| Field | Layer | Default | On breach | Configured on |
|---|---|---|---|---|
| `maxTurns` | Agent run | `10` (coordinator `3`) | Loop stops; `success: true`, no flag | `AgentConfig`, `CoordinatorConfig` |
| `timeoutMs` | Agent run | none | `success: false`, `status.code: 'timeout'`, `TimeoutError` | `AgentConfig`, `CoordinatorConfig` |
| `callTimeoutMs` | One `adapter.chat()` call | none | `LLMCallTimeoutError`, retryable | `AgentConfig`, `CoordinatorConfig` |
| `loopDetection.maxRepetitions` | Agent turn | `3` | `loop_detected` event; warn once then terminate | `AgentConfig`, `CoordinatorConfig` |
| `loopDetection.loopDetectionWindow` | Agent turn | `4`, clamped up to `maxRepetitions` | Widens or narrows the detection window | `AgentConfig`, `CoordinatorConfig` |
| `loopDetection.onLoopDetected` | Agent turn | `'warn'` | Selects warn / terminate / callback | `AgentConfig`, `CoordinatorConfig` |
| `maxTokenBudget` | Agent run | none | `budgetExceeded: true`, `status.code: 'budget_exhausted'` | `AgentConfig` |
| `maxTokenBudget` | Orchestrator run | none | Same, plus remaining tasks `skipped` | `OrchestratorConfig`, `RunTasksOptions`, `RunTeamOptions` |
| `maxCostBudget` | Orchestrator run | none | Same as the token budget; requires `estimateCost` | `OrchestratorConfig`, `RunTasksOptions`, `RunTeamOptions` |
| `estimateCost` | Per LLM result | none | Invalid return throws; the task fails | `OrchestratorConfig` |
| `maxToolOutputChars` | One tool result | none | String result truncated head plus tail | `AgentConfig`; per-tool `maxOutputChars` wins |
| `maxConcurrency` | Orchestrator run | `5` | Additional tasks wait for a slot | `OrchestratorConfig` |
| `maxDelegationDepth` | Delegation chain | `3` | The delegate call is rejected | `OrchestratorConfig` |
| `ToolExecutor` `maxConcurrency` | Parallel tool calls | `4` | Extra calls wait for a slot | `ToolExecutor` constructor only; not reachable from `AgentConfig` |

## Related pages

- [Streaming](streaming.md) for the `budget_exceeded` and `loop_detected` events.
- [Task scheduling](task-scheduling.md#interruption-budgets-and-checkpoints) for
  the drain-then-skip path and retry classification.
- [Consensus](consensus.md#budget-invariant) and
  [tool configuration](tool-configuration.md) for judge and delegation usage.
- [External agents](external-agents.md) for backend token accounting.
- [Context management](context-management.md) for bounding input growth rather
  than run length.
- [Production checklist](production-checklist.md) for where these fit in a
  go-live review.
