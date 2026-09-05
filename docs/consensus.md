# Consensus

`runConsensus` adds a proposer→judge verification loop on top of a single prompt: a **proposer** agent emits an answer, then a roster of **judge** agents try to refute it over up to `maxRounds`. The loop exits early once a `quorum` of judges accept.

```ts
const result = await orchestrator.runConsensus(team, 'Is this proof correct?', {
  proposer: { name: 'solver', model: 'claude-opus-4-6' },
  judges: [
    { name: 'judge-a', model: 'claude-opus-4-6' },
    { name: 'judge-b', model: 'claude-sonnet-4-6' },
  ],
  mode: 'refute',       // identical skeptic framing for every judge
  quorum: 2,            // default: ceil(judges.length / 2)
  maxRounds: 2,         // default: 2
  onDissent: 'revise',  // default: feed dissent back to the proposer
})

result.answer      // the (possibly revised) answer
result.verdict     // 'accepted' | 'rejected'
result.dissent     // critiques recorded across all rounds
result.rounds      // judging rounds executed
result.tokenUsage  // proposer + judges + revisions
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `proposer` | — | One agent, or an array (N-best — all candidates are shown to the judges). |
| `judges` | — | Verifier roster. Judges run **sequentially** so quorum and budget can stop the rest. |
| `mode` | `'refute'` | `'refute'`: every judge gets the same skeptic framing. `'lens'`: each judge gets a distinct angle (correctness, completeness, edge cases, …). |
| `quorum` | `ceil(judges.length / 2)` | Accepting judges required to reach consensus. |
| `maxRounds` | `2` | Upper bound on proposer↔judge rounds. |
| `verdictSchema` | — | Optional Zod schema validated against each judge's parsed verdict; a failure counts as dissent. |
| `onDissent` | `'revise'` | `'revise'`: feed dissent back to the proposer for another round. `'reject'`: stop, verdict `rejected`. `'keep'`: stop but keep the answer, verdict `accepted`. |
| `judgePrompt` | built-in | Override the verifier prompt — a `string` for all judges, or a `(judge) => string` function for per-judge framing. |

Every judge prompt includes the **original question** alongside the proposed answer, so judges (including lens-mode ones) score the answer against what was actually asked. A judge replies with `{"accept": boolean, "critique": string}`.

## Per-task `verify` hook

Any task in a `runTasks` pipeline can opt into consensus verification of its own result — the task's assignee is the proposer, so you supply everything *except* `proposer`:

```ts
await orchestrator.runTasks(team, [
  {
    title: 'derive-bound',
    description: 'Prove the O(n log n) bound.',
    assignee: 'mathematician',
    verify: { judges: [judgeA, judgeB], mode: 'refute', maxRounds: 2 },
  },
])
```

After the task completes, its result is fed into the same consensus loop. Only an **accepted** revision supersedes the task output: when the verdict is `accepted` and the loop produced a different answer, that answer becomes the task's `output` (and its `structured` value) for the queue, shared memory, progress events, and `agentResults` alike. A `rejected` verdict is recorded as dissent and the task finalises with its original output. Judge and revision usage is added to the task's own `tokenUsage` either way. Tasks **without** `verify` run unchanged and pay nothing — the hook is fully opt-in.

## Coordinator-generated verification in `runTeam`

`runTeam()` has no per-task specs to hang `verify` on, so the roster is supplied at the run level instead. Set `RunTeamOptions.verifyJudges` and the coordinator can opt individual tasks into the same hook:

```ts
await orchestrator.runTeam(team, goal, {
  verifyJudges: [judgeA, judgeB],
})
```

Setting it changes two things:

- The coordinator's output-format contract gains a `verify` field, described as `true` or an object with any of `mode`, `quorum`, `maxRounds`, and `onDissent`. Without `verifyJudges` that field is never described to the coordinator at all.
- Each task the coordinator marks is resolved into full verify options before it enters the queue.

The merge is a plain field-by-field overlay: judges always come from `verifyJudges`, and any option the coordinator emitted overrides that option's default.

| Coordinator emits | With `verifyJudges` | Without `verifyJudges` |
|---|---|---|
| no `verify` key | no verification | no verification |
| `"verify": true` | judges from `verifyJudges`; every other option at its default | ignored, task runs unverified |
| `"verify": { "mode": "lens", "quorum": 1 }` | judges from `verifyJudges` plus the emitted fields | ignored, task runs unverified |
| any other value (`null`, a number, a string) | plan fails structured validation | plan fails structured validation |

An unrecognised `verify` value is not silently dropped. It fails the coordinator plan schema, and after the single structured-output repair attempt the run ends with `success: false` and `errorInfo.code` `COORDINATOR_PLAN_INVALID` rather than executing a partially understood plan.

Judges are never part of coordinator JSON. The coordinator-facing spec carries only `mode`, `quorum`, `maxRounds`, and `onDissent`, so a model cannot invent a judge roster or reach `verdictSchema` and `judgePrompt`; those two remain caller-only and are unavailable on the `runTeam` path. `verifyJudges` does not apply to `runTasks()`, whose specs already carry complete verify options including their own judges.

## Budget invariant

Consensus token usage counts against the parent budget exactly like delegation does. Proposer, judge, and revision usage all accumulate into the running total and are checked against `OrchestratorConfig.maxTokenBudget`. Once the cumulative total crosses the budget, consensus **stops issuing further judge calls** — no separate budget knob, no escape hatch. For the per-task `verify` hook, judge usage rolls into the same run-level budget as the rest of the pipeline and trips the same gate. The same holds for cost: when `estimateCost` and `maxCostBudget` are configured, verify-hook usage is priced into the run's cumulative estimated cost and stops further judge calls at the same boundary once the cap is crossed. Because `maxCostBudget` is a run-level cap, the standalone `runConsensus` primitive tracks tokens only. See [budgets and limits](budgets-and-limits.md) for how those ceilings are accounted and where they are checked.

## Observability

Consensus reports through both trace surfaces, from the same call site.

**Legacy `onTrace`.** Every judge verdict is emitted as a `consensus` trace event, with `agent` set to the judge, `round` to the round number, `accepted` to the judge's decision, and `dissent` carrying the critique when it objected. Both `runConsensus` and the per-task hook emit it, so you can audit each round.

**Schema v2 records.** Consensus is a **span**, not an event: `runConsensus` and the verify hook each open a span of kind `consensus` named `verify_consensus`, and every judge verdict is a `consensus_verdict` **span event** on it. The span carries `oma.consensus.scope` (`'top_level'` for `runConsensus`, `'task'` plus `oma.task.id` for the verify hook) and ends with `oma.consensus.verdict` and `oma.consensus.rounds`. Each `consensus_verdict` event carries `oma.consensus.round`, `oma.consensus.accepted`, and `oma.agent.name`. Every proposer, judge, and revision call opens an `agent` span (`invoke_agent`) beneath the consensus span with `oma.phase` set to `proposer`, `judge`, or `revision`, so a round is reconstructable from the span tree alone. The verify hook has no proposer phase: the task result is the answer being judged. See [observability](observability.md).

**Shared memory.** Dissenting critiques are written under the judge's namespace with key `consensus:round:N:dissent`. The per-task hook additionally writes the task-level outcome under the assignee's namespace with key `task:<taskId>:verdict`, holding `accepted` or `rejected` plus the joined dissent, so downstream agents and the final synthesis can see whether a result survived scrutiny.
