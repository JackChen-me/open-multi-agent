# Routing evaluation

This page answers one question: how does OMA prove that its
[execution routing](execution-routing.md) decisions are stable, and what would
have to change for a routing regression to reach a release? It documents the two
frozen EvalSets that guard routing, the gates applied to each, and the
opt-in real-provider canary that runs the same policy against a live model.

Both EvalSets are repository fixtures rather than APIs. The scorer, EvalSet, and
gate machinery they are built on is in [evaluation](evaluation.md), and the
CI-facing commands are in [evaluation in CI](evaluation-ci.md).

## Routing stability regression EvalSet

The frozen `run-team-routing-stability@1.0.0` EvalSet in
`packages/core/tests/fixtures/eval/routing-stability-set.json` measures whether
equivalent `runTeam()` goals keep the same executed topology when prompt length
or language changes. Each family contains short and detailed English variants
plus Chinese, Japanese, and Korean translations. Governance families carry the
same `governanceIntent: 'required'`,
`requiredRoles`, and `requiredOrder` declaration on every variant; benign
families carry no declaration.

The test injects one deterministic `LLMAdapter` into every worker and the
coordinator. Every model call returns the same fixed text, including a valid
two-role coordinator plan. It also injects a valid low-risk `TaskProfiler`
fixture for benign Single candidates and fails the test unless Hybrid profiling
finishes with `outcome: 'applied'`; the gate therefore cannot pass by silently
falling back from invalid profile output. The suite makes no network request
and needs no API key. Within one family, the goal text is therefore the only
routing input that changes. The measured topology comes from
`buildExecutionReceipt(result)` and the `result.tasks` short-circuit marker, and
contains only:

- `single-short-circuit` versus task graph;
- the worker roles that actually executed; and
- cross-role dependency edges.

Model output, generated task IDs, timing, token usage, and scheduler start order
are excluded. For `n` variants, flip rate is the number of unordered variant
pairs with different canonical topologies divided by `n * (n - 1) / 2`.
Length invariance compares the fixture's short/detailed English pair; language
invariance compares its explicitly paired English/Chinese variants.

`packages/core/tests/fixtures/eval/routing-stability-gate.json` applies three
absolute thresholds to the `governance` tag: routing-stability minimum `1`
(zero flips), length-invariance minimum `1`, and language-invariance minimum
`1`. It also gates benign routing-stability at `0.95` (at most 5% pair flips);
benign length/language submetrics remain monitored. Scorer and target error
limits are both zero. The existing CI `npm test` matrix blocks a change that
makes a declared route depend on goal language or length or pushes benign
topology flips over the limit. A negative-control test injects a fake declared
router that collapses Chinese variants to one role and asserts that both the
routing-stability and language-invariance thresholds fail.

The current snapshot below is emitted in the test's `[routing-stability]`
EvalSet report:

| Family | Pair flips | Flip rate | Length invariant | Language invariant |
|---|---:|---:|---:|---:|
| Declared wire transfer | 0 / 10 | 0% | 100% | 100% |
| Declared key rotation | 0 / 10 | 0% | 100% | 100% |
| **Declared governance total** | **0 / 20** | **0%** | **100%** | **100%** |
| Undeclared DNS | 0 / 10 | 0% | 100% | 100% |
| Undeclared database comparison | 0 / 10 | 0% | 100% | 100% |
| **Undeclared benign total** | **0 / 20** | **0%** | **100%** | **100%** |

The target for undeclared benign routing is at most 5% pair flips and at most
5% length mismatches (at least 95% length invariance). Update the frozen corpus
version and the documented snapshot only after reviewing an intentional
measurement change.

## Semantic routing policy EvalSet

`packages/core/tests/fixtures/eval/semantic-routing-set.json` freezes the V1
Hybrid policy contract independently from provider behavior. It covers short
independent-evidence and independent-review goals, permission isolation,
consequential side effects, conflicting objectives, ordinary short and long
single-task negatives, equivalent Chinese/Japanese/Korean goals, and a
prompt-injection sample.

Each fixture contains a reviewed `TaskProfile`, framework-computed facts, and
the expected deterministic recommendation. CI validates the strict profile
schema and requires every fixture to match exactly. This proves Policy behavior
without treating one provider's current classification as the semantic
contract. Real-provider E2E is limited to checking that the one-call Profiler
integration can produce a valid profile; it is not the sole routing oracle.

Shadow evaluation belongs in CI and canary release work, not the public runtime
default. Before promoting a major release, measure the reviewed end-to-end
corpus against these gates:

- zero false-Single results on critical cases;
- at least 95% reviewed routing accuracy;
- at most 1% invalid/failed Profiler outputs;
- median Profiler token overhead no greater than 5% of representative total
  usage; and
- P95 end-to-end latency regression no greater than 10%.

### Running the real-provider Shadow gate

`packages/core/tests/e2e/semantic-routing-shadow.test.ts` runs the reviewed
synthetic corpus through the actual `LLMTaskProfiler`, then applies the same
deterministic policy that Hybrid routing uses. It is skipped unless
`SEMANTIC_ROUTING_SHADOW=1` is set, executes no workers or tools, and does not
send user data. The profiler uses the shipping `LLMTaskProfiler` default of 800
output tokens per fixture, so the canary validates the production contract. The
optional `SEMANTIC_ROUTING_SHADOW_BASE_URL` and
`SEMANTIC_ROUTING_SHADOW_REGION` values map to the selected adapter; Bedrock
uses its normal AWS credential chain instead of the API-key variable.

For DeepSeek V4, the built-in profiler explicitly uses non-thinking mode: this
is a bounded JSON classification call, and DeepSeek otherwise enables thinking
by default. The production route and this gate use the same setting.

Set credentials only in your local shell or CI secret store; never paste a key
into a command, repository file, or test log. For example, map an existing
local provider secret without printing it:

```bash
export SEMANTIC_ROUTING_SHADOW=1
export SEMANTIC_ROUTING_SHADOW_PROVIDER=openai
export SEMANTIC_ROUTING_SHADOW_MODEL=gpt-4o-mini
export SEMANTIC_ROUTING_SHADOW_API_KEY="$OPENAI_API_KEY"
npm run test:semantic-routing-shadow -w @open-multi-agent/core
```

The report contains only provider/model identifiers, aggregate accuracy,
failure and mismatch case IDs, P95 profiler latency, and aggregate token use.
It deliberately omits goals, inferred reasons, raw model output, and all
configuration secrets. The executable gate enforces zero invalid profiles,
zero critical false-Single outcomes, and at least 95% reviewed routing
accuracy. Record the output as release evidence. Measure the remaining
end-to-end token and latency regression gates in the production-shadow canary
before declaring a provider/model supported for Hybrid routing.

Historical success rates, online adaptive learning, and Team-to-Single
optimization require separately versioned evaluation, monitoring, and rollback
and are not part of V1.
