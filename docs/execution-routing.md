# Execution routing

Execution Routing decides the execution topology for an automatic `runTeam()` call: use one Agent directly (`single`) or ask the Coordinator to build and execute a Team plan (`team`). It is orthogonal to [Model Routing](model-routing.md), which chooses the model for calls inside the selected topology.

## Precedence

`runTeam()` resolves topology in this order:

1. Explicit `mode: 'single' | 'team'`.
2. Declared governance topology or `preferredUnderBudget` degradation policy.
3. The per-run or orchestrator-level custom `executionRouter`.
4. The built-in `DeterministicRouter`.
5. When `executionRouting.strategy` is `hybrid` and the default/fallback
   deterministic result is Single, the semantic `TaskProfiler` and deterministic
   semantic policy.

Routers run only for automatic, non-`planOnly` topology selection. They never override an explicit mode, declared role topology, or governance budget policy. `governanceIntent: 'none'` retains automatic topology selection, while still counting as an explicit governance declaration for consequential-tool confirmation.

A valid custom Router decision is final and is never reinterpreted by the
Profiler. If a custom Router fails and its deterministic fallback selects
Single, Hybrid routing may profile that fallback candidate.

## Hybrid semantic routing

Hybrid is opt-in. It preserves the cheap deterministic Team decision and adds
at most one no-tool model call only when that router would otherwise choose
Single:

```ts
const orchestrator = new OpenMultiAgent({
  executionRouting: {
    strategy: 'hybrid',
    confidenceThreshold: 0.7,
    failurePolicy: 'fallback',
  },
})
```

`LLMTaskProfiler` produces a strict, provider-neutral `TaskProfile` containing
only inferred semantic signals: independent evidence sources, independent
review, conflicting objectives, side-effect intent, permission isolation,
decomposability, parallelism, complexity, confidence, and bounded reasons. The
goal is treated as untrusted data. The Profiler receives no Agent/Coordinator
system prompts, credentials, tool implementations, or complete permission
details and cannot call tools.

The model does not choose the topology. A deterministic policy consumes the
profile together with framework-computed facts:

- high-confidence independent evidence, review, conflict, or genuinely
  parallel work may upgrade Single to Team;
- inferred side-effect/isolation needs that intersect with consequential
  effective grants or multiple caller-declared `permissionBoundary` values
  produce `ROUTING_DECLARATION_REQUIRED`;
- low confidence or no material signal keeps Single;
- V1 never changes Team to Single.

`ROUTING_DECLARATION_REQUIRED` is raised before any Coordinator, worker, or
tool-capable Agent starts. A profile never creates `requiredRoles`, approves a
side effect, or proves that governance was satisfied. The thrown class and how
to clear it are in
[errors](errors.md#routingdeclarationrequirederror).

The built-in Profiler resolves its adapter in this order:

1. per-run `executionRouting.adapter`;
2. orchestrator `executionRouting.adapter`;
3. the effective Coordinator adapter;
4. an adapter created from the orchestrator's default provider/model.

The selected adapter receives the goal text as untrusted user data. In
particular, step 4 can send the goal to `defaultProvider` even when every worker
uses its own adapter and the deterministic Single path previously needed no
default-provider call. Applications with data-residency or provider-boundary
requirements should configure `executionRouting.adapter`, provide a Coordinator
adapter, or select `strategy: 'deterministic'`.

`executionRouting.model` follows the same per-run-over-orchestrator precedence,
then the Coordinator model and default model. Profiler usage is charged to the
run token/cost budget and appears in routing tracing and
`TeamRunResult.totalTokenUsage`.

## Contract

```ts
import type {
  ExecutionRouter,
  RoutingContext,
  RoutingDecision,
} from '@open-multi-agent/core'

class ApplicationRouter implements ExecutionRouter {
  readonly version = 'application-router-v1'

  decide(context: RoutingContext): RoutingDecision {
    const mode = context.goal.startsWith('[team]') ? 'team' : 'single'
    return {
      mode,
      reasons: [`Application policy selected ${mode}.`],
      routerVersion: this.version,
    }
  }
}
```

`RoutingContext` contains the goal, a structured roster summary, and optional remaining token/cost ceilings at the point routing begins. Roster entries contain `name`, effective `model`, and an optional directly declared tool count. Full `systemPrompt` values, credentials, API keys, tool implementations, and model output are never supplied to the router. The summary is intentionally small so a later structured capability model can extend it without exposing prompts.

Set a default on the orchestrator or override it for one call:

```ts
const orchestrator = new OpenMultiAgent({
  executionRouter: new ApplicationRouter(),
})

const result = await orchestrator.runTeam(team, goal, {
  executionRouter: requestScopedRouter,
})
```

The per-run router wins over the orchestrator router. A decision is valid only when `mode` is `single` or `team`, `reasons` is a string array, `routerVersion` matches the router's non-empty `version`, optional `confidence` is between 0 and 1, and `single` has at least one roster member.

## Failure behavior

The default `failurePolicy: 'fallback'` keeps routing infrastructure advisory.
If a custom Router throws, rejects, times out, or returns an invalid decision,
OMA falls back to `DeterministicRouter`. Profiler timeout, refusal, throw, or
invalid structured output keeps that deterministic route.

Set `failurePolicy: 'fail'` to terminate instead. Profiler failures use
`ROUTING_PROFILER_FAILED`; Router/Profiler deadlines use `ROUTING_TIMEOUT`.
The run trace is closed with the corresponding error or timeout status before
the typed error is rethrown, so failed routing does not leave an incomplete run.
Machine-readable `status`, `requestedRouterVersion`, and `fallbackCode` fields
remove the need to parse human-readable `reasons`.

```ts
result.routingDecision
// {
//   mode: 'single',
//   reasons: [
//     'The goal has one concise action and no multi-stage structure.',
//     'Execution router fallback: custom decision failed (Error).'
//   ],
//   routerVersion: 'deterministic-v1',
//   status: 'fallback',
//   requestedRouterVersion: 'application-router-v1',
//   fallbackCode: 'router-error'
// }
```

Every `runTeam()` topology choice exposes `TeamRunResult.routingDecision`.
Its `source` distinguishes caller `override`, governance `declared`, framework
`policy`, and automatic `router` decisions; only `router` records carry the
actual `routerVersion`. See the
[five routing trace source classifications](./observability.md#trace-spans),
including the compatibility-only `legacy-deterministic` label.

When semantic profiling ran, `semanticRoutingAssessment` is attached both to
the result and routing record. It reports the inferred profile/version,
deterministic legacy decision, semantic recommendation, actual topology, usage,
and structured fallback state. The executed task topology, final tool grants,
and `ExecutionReceipt` remain governance truth.

## Deterministic default

Omitting `executionRouting` uses the no-profiler deterministic router. Set the
strategy explicitly when you want configuration-level clarity:

```ts
const orchestrator = new OpenMultiAgent({
  executionRouting: { strategy: 'deterministic' },
})
```

This makes no extra model call and retains deterministic Router results and
custom-Router fallback behavior. Hybrid should be enabled only for providers
and models that have passed the documented Shadow gate.

Explicitly installing `new DeterministicRouter()` as `executionRouter` also
makes that valid Router decision final under the precedence rules, so the
Profiler does not reinterpret it. Prefer `strategy: 'deterministic'` when the
intent is compatibility mode because it states the no-profiler behavior
directly.

## Built-in deterministic policy

`DeterministicRouter` wraps the single `isSimpleGoal()` heuristic; OMA does not maintain a second competing heuristic.

- An empty roster cannot select the Single path; otherwise the goal heuristic decides.
- English sequence, coordination, parallelism, and multi-deliverable signals remain supported.
- Chinese sequence markers (`先…然后`, `第一步/第二步`), circled steps, action enumerations, semicolon-separated clauses, and connected action verbs are recognized.
- Japanese (`まず…次に`, `第一に…第二に`, `ステップ1/手順1`) and Korean (`먼저…그다음`, `첫째…둘째`, `1단계/2단계`) sequence markers are recognized, and dense `、` enumeration counts for kana- and Hangul-initial lists as well as Han. Each marker pair must appear, so a lone marker does not force Team.
- Length uses a cheap script-aware information estimate. CJK characters — Han, Japanese kana, and Korean Hangul — count as 2.25 units; ordinary Latin word runs approximate token density; long unbroken runs keep their raw length.

Language coverage is tiered honestly rather than claimed uniform:

- **Chinese, Japanese, and Korean** are one tier: the structural markers above plus 2.25-unit length weighting.
- **Latin-script languages** share English's length treatment (word runs approximate token density). The structural word patterns are English-specific, so other Latin languages are routed by length and punctuation, not by their own sequence words.
- **Other scripts** fall back conservatively: each non-space character counts as one unit and no structural markers apply, so routing relies on the length threshold alone.

CJK verb-connective sequencing is a deliberate non-goal. Chinese keeps a verb-connective pattern because its verbs are invariant tokens, but Japanese and Korean verbs inflect (Japanese て-form, Korean agglutinative endings), so matching them would require morphological analysis this heuristic intentionally avoids; explicit markers and enumeration cover the structural signal instead.

This policy remains intentionally cheap rather than semantically ambitious.
Hybrid routing corrects high-confidence false-Single cases after this step.
Applications that need domain-specific, authoritative decisions should still
inject an `ExecutionRouter` or declare an explicit mode/governance topology.

## Governance boundary

Execution Routing does not declare governance. The consequential-tool fallback
still treats only `governanceIntent === undefined` as undeclared, regardless of
which router selected Single or Team. Router decisions and TaskProfiles cannot
satisfy named-role or independent-review requirements; those facts continue to
come from structured governance declarations and the executed topology.

## Promotion criteria

Shadow evaluation is a release-engineering technique, not a user-facing runtime
mode: run fixed fixtures in CI and canaries, compare its recommendation without
changing production topology, and promote a provider/model to supported Hybrid
use only after the documented accuracy, invalid-output, cost, and latency gates
pass. Online historical-success learning and Team-to-Single optimization are
outside V1.
