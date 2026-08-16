<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="Open Multi-Agent" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="96">
  </picture>
</p>

<br />

<h1 align="center">Open Multi-Agent</h1>

<p align="center">
  <strong>Describe the goal, not the graph.</strong><br/>
  Multi-agent orchestration that runs in your own environment.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-blue" alt="TypeScript"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/stargazers"><img src="https://img.shields.io/github/stars/open-multi-agent/open-multi-agent" alt="GitHub stars"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/network/members"><img src="https://img.shields.io/github/forks/open-multi-agent/open-multi-agent" alt="GitHub forks"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer replaying a real multi-agent run: task DAG and span waterfall views with per-task status, assignee, tokens, and tool calls" width="960" height="540" loading="eager">
</p>

<br />

<p align="center">
  <a href="https://open-multi-agent.com">Website</a> ·
  <a href="https://open-multi-agent.com/getting-started/introduction/">Docs</a> ·
  <a href="https://www.npmjs.com/package/@open-multi-agent/core">npm</a> ·
  <a href="https://github.com/open-multi-agent/open-multi-agent/discussions">Discussions</a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README_zh.md">中文</a>
</p>

<br />

`@open-multi-agent/core` is the OMA orchestration runtime for TypeScript backends. Give it one agent, an explicit task graph, or a **dynamic workflow** that the coordinator generates from a goal at runtime.

The runtime schedules dependencies, runs independent work in parallel, shares context across agents, and returns an inspectable result. For product positioning and known users, see the [project overview](https://github.com/open-multi-agent/open-multi-agent#readme).

## Contents

[Quick Start](#quick-start) · [Execution Modes](#execution-modes) · [Scheduling](#scheduling) · [Capabilities](#capabilities) · [Architecture](#architecture) · [Examples](#examples) · [Providers](#providers) · [Production](#production) · [Documentation](#documentation)

## Quick Start

Requires Node.js 20 or newer. For production, use a currently maintained
Node.js LTS release. Scaffold and run a starter in one command:

```bash
npm create oma-app@latest my-oma
```

In an interactive terminal, the scaffolder selects a starter and Cloud/Ollama runtime, installs dependencies, then runs a deterministic demo and produces an offline dashboard. The demo uses scripted model responses, needs no API key, and makes no model request; OMA orchestration still runs locally for real. Pass `--no-install` to generate files only, or `--no-run` to install without starting the demo.

To add OMA to an existing backend:

```bash
npm install @open-multi-agent/core
```

*Migrating from `@jackchen_me/open-multi-agent`? That package is deprecated; install `@open-multi-agent/core` instead.*

```typescript
import { OpenMultiAgent, type AgentConfig } from '@open-multi-agent/core'

const model = process.env.OMA_MODEL ?? 'gpt-5.4'

const agents: AgentConfig[] = [
  { name: 'researcher', model, systemPrompt: 'Find the relevant facts.' },
  { name: 'analyst', model, systemPrompt: 'Compare evidence and identify tradeoffs.' },
]

const orchestrator = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: model,
})

const team = orchestrator.createTeam('research-team', {
  name: 'research-team',
  agents,
  sharedMemory: true,
})

const result = await orchestrator.runTeam(team, 'Compare three approaches and recommend one.')
console.log(result.agentResults.get('coordinator')?.output)
```

Set `OPENAI_API_KEY` for this example. For other hosted or local models, see [Providers](#providers).

## Execution Modes

| Mode | Method | When to use | Example |
|------|--------|-------------|---------|
| Single agent | `runAgent()` | One agent, one prompt | [`basics/single-agent`](examples/basics/single-agent.ts) |
| Auto-orchestrated team | `runTeam()` | Give a goal, let the coordinator plan and execute | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

Use `planOnly` to inspect a generated task graph before execution, then `createPlanArtifact()` and `runFromPlan()` to replay it. `runConsensus()` adds a proposer→judge verification loop when one answer needs extra scrutiny.

### Structured single-agent input

`Agent.run()`, `Agent.stream()`, and `OpenMultiAgent.runAgent()` keep the string
form above and also accept a complete `LLMMessage[]`. Use the message form for
caller-owned conversation history or blocks such as base64 images:

```typescript
import { OpenMultiAgent, type LLMMessage } from '@open-multi-agent/core'

const messages: LLMMessage[] = [{
  role: 'user',
  content: [
    { type: 'text', text: 'Describe this image.' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    },
  ],
}]

const result = await new OpenMultiAgent().runAgent(
  { name: 'vision', model: 'claude-sonnet-4-6' },
  messages,
)
```

For a persistent `Agent.prompt()` conversation, pass a string or one
`ContentBlock[]` user turn; restore earlier turns through `AgentConfig.history`.
Structured input is validated and defensively copied. `beforeRun` receives both
the complete `messages` and its backwards-compatible latest-user `prompt` view.
Process and ACP backends remain string-only and reject structured arguments
instead of discarding history or images. See [Structured Agent
Input](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/structured-input.md) for copy, hook, progress/evaluation, and
external-backend semantics, or run
[`basics/structured-input`](examples/basics/structured-input.ts).

Automatic `runTeam()` uses the deterministic router by default: no extra model
call is made. Opt into Hybrid Semantic Routing with
`executionRouting: { strategy: 'hybrid' }`; it keeps deterministic Team
decisions and sends only Single candidates to a one-call, no-tool
`TaskProfiler`. Deterministic policy may keep Single, upgrade to Team, or
require an explicit governance declaration. Valid custom `executionRouter`
decisions, explicit `mode`, and declared governance retain higher priority.
Auto results expose `routingDecision` and, when profiling ran,
`semanticRoutingAssessment`. See [Execution
Routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/execution-routing.md).
Execution Routing selects Single versus Team; [Model
Routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md)
selects models inside that topology.

When Hybrid is enabled, the Profiler sends the goal to the configured routing adapter, then the
Coordinator adapter, or finally the orchestrator's default provider. That last
fallback can make a provider call even when every worker has its own adapter.
Configure `executionRouting.adapter` or use deterministic strategy when the goal
must not cross that provider boundary.

When an application must enforce named independent roles, declare that governance intent instead of relying on wording in the goal:

```typescript
const governed = await orchestrator.runTeam(team, 'Review the evidence and assess the risk.', {
  governanceIntent: 'required',
  requiredRoles: ['researcher', 'analyst'],
  requiredOrder: ['researcher', 'analyst'],
})

if (governed.governanceConclusion !== 'satisfied') {
  throw new Error('Required governance was not satisfied by the executed topology.')
}
```

`required` and `preferred` both bypass automatic decomposition and the simple-goal short circuit. OMA creates one task per declared roster name, assigns it to that agent, and chains tasks in `requiredOrder`; dependency outputs are passed to downstream roles. The topology comes only from these structured fields, so equivalent goals in different languages use the same roles and order. `none` or an omitted `governanceIntent` preserves the existing automatic `runTeam()` behavior.

After execution, `governanceConclusion` is `satisfied`, `unsatisfied`, or `not-applicable`. Governance-sensitive applications must check it separately from `success`: the verdict comes from the structured execution receipt, not from role names or approval wording in the model answer. See [Tool configuration](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md#declared-governance-roles-in-runteam).

## Scheduling

Set `schedulingStrategy` on `OpenMultiAgent` to choose how unassigned tasks are
mapped to agents. The setting applies to coordinator-generated `runTeam()`
plans and explicit or restored task queues. Tasks with an explicit `assignee`
keep that assignment.

Task DAG execution is event-driven: a downstream task starts as soon as its
dependencies are satisfied, without waiting for unrelated tasks from the same
ready set, and dependency outputs reach dependents as task-scoped results and
validated structured handoffs.

```typescript
const orchestrator = new OpenMultiAgent({
  schedulingStrategy: 'composite',
  schedulingWeights: { fit: 0.7, load: 0.3 },
})
```

| Strategy | Assignment behavior | Recommended when |
|----------|---------------------|------------------|
| `dependency-first` (default) | Assigns tasks that unblock the most downstream work first, rotating eligible agents | The task graph has meaningful dependencies |
| `round-robin` | Distributes tasks in queue order across eligible agents | Agents are interchangeable |
| `least-busy` | Chooses the eligible agent with the fewest active or newly assigned tasks | Task duration varies and load balance matters |
| `capability-match` | Filters explicit task requirements, then prefers declared capability tags before legacy keyword affinity | Tasks or agents declare differentiated requirements/capabilities |
| `composite` | Ranks tasks by blocked dependents, then maximizes fit and available capacity across eligible agents | Criticality, capability fit, and current load should influence one decision |

Agents may declare `description`, `capabilities`, `costTier`, and
`latencyClass`, and tasks may add hard `requires` constraints. All strategies
fail before worker execution when those constraints cannot be satisfied.
Coordinator plans also fail fast by default when they name an agent outside
the roster; set `strictAssignees: false` only to retain legacy reassignment.
Weight semantics, load normalization, `NO_ELIGIBLE_AGENT` and
`INVALID_ASSIGNEE` behavior, approval compatibility, and progress-event migration
are covered in
[Task scheduling and dispatch](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/task-scheduling.md).

## Capabilities

| Capability | What you get |
|------------|--------------|
| **Dynamic orchestration** | Runtime goal decomposition, dependency-aware scheduling, parallel branches, configurable assignment, task-scoped results and handoffs, opt-in team context for workers (`revealCoordinator`), and final synthesis. |
| **Models and reasoning** | Mix built-in, OpenAI-compatible, AI SDK, or local models; map one `thinking` config to each provider's reasoning setting, route phases separately, and preserve reasoning only when explicitly enabled. |
| **Tools and handoffs** | Built-in tools are default-deny; custom tools, MCP, and guarded `delegate_to_agent` handoffs are opt-in, and consequential tools on undeclared runs are flagged for confirmation. |
| **Controlled outputs** | Send text or structured single-agent input, stream per agent, validate results with Zod, approve or durably suspend plans, task rounds, dispatches, and tool calls, rewrite messages/prompts or post-process results with `beforeRun` / `afterRun`, and cancel with `AbortSignal`. |
| **Evaluation** | Version EvalSets, run reference scorers, gate CI with offline reports, persist results, or sample production runs on a best-effort path. |
| **Memory and recovery** | Shared memory is pluggable; checkpoints resume interrupted runs without repeating completed tasks. |
| **Observability** | Stable run identity, traces, execution receipts, redaction, TraceStore, and the offline DAG/Waterfall Viewer are available without a hosted service. |
| **External agents** | ACP and process backends let coding CLIs participate while OMA keeps scheduling, memory, and budgets. |

## Architecture

```text
goal or explicit tasks
         |
         v
Coordinator -> Task DAG -> Scheduler -> AgentPool
                    |                       |-- LLM adapters
                    |                       `-- tools / external backends
                    |
                    |-- SharedMemory / checkpoints
                    |-- TraceRecord -> TraceStore / Run Viewer / OTel
                    `-- results -> evaluation (offline / sampled, observe-only)
```

The coordinator plans once by default; the scheduler owns execution order. Applications can opt into append-only adaptive recovery when task outcomes need to revise the unstarted part of the graph. Agents share results through memory, while checkpoints and traces form separate recovery and observability paths. Evaluation observes completed results and never changes them. Detailed contracts live in the linked subsystem guides below.

## Examples

Start with one example that matches the behavior you need:

| Goal | Example |
|---|---|
| Send image blocks and caller-owned history | [`basics/structured-input`](examples/basics/structured-input.ts) |
| See coordinator planning | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| Build an explicit DAG | [`cookbook/contract-review-dag`](examples/cookbook/contract-review-dag.ts) |
| Observe event-driven DAG dispatch | [`patterns/event-driven-dag`](examples/patterns/event-driven-dag.ts) |
| Validate structured output | [`patterns/structured-output`](examples/patterns/structured-output.ts) |
| Delegate between agents | [`patterns/agent-handoff`](examples/patterns/agent-handoff.ts) |
| Replay a frozen plan | [`patterns/plan-replay`](examples/patterns/plan-replay.ts) |
| Suspend and resume an approval | [`patterns/durable-approval`](examples/patterns/durable-approval.ts) |
| Embed OMA in a backend | [`integrations/express-customer-support`](examples/integrations/express-customer-support/) |
| Export an offline trace viewer | [`integrations/observability-v2/run-viewer`](examples/integrations/observability-v2/run-viewer.ts) |

The [example index](examples/README.md) lists 50+ runnable examples across basics, cookbook workflows, patterns, providers, and integrations.

## Providers

Change `provider`, `model`, and credentials; the agent shape stays the same.

| Route | Use |
|---|---|
| Built in | Anthropic, OpenAI, Azure OpenAI, Copilot, Grok, DeepSeek, Doubao, Hunyuan, MiniMax, MiMo, Qiniu |
| Optional peers | Gemini (`@google/genai`) and Bedrock (`@aws-sdk/client-bedrock-runtime`) |
| OpenAI-compatible | Set `provider: 'openai'` + `baseURL` for Ollama, vLLM, LM Studio, OpenRouter, Groq, Mistral, Kimi, Qwen, or Zhipu |
| AI SDK | Use `AISdkAdapter` with `ai` and your selected `@ai-sdk/*` provider (AI SDK 7 needs Node.js 22+) |

Optional integrations load only when used: core directly installs only `@anthropic-ai/sdk`, `openai`, and `zod`; other SDKs are lazy-loading opt-in peers, and OpenTelemetry lives entirely in `@open-multi-agent/otel`. Dependency changes are weighed on demonstrated value plus security, size, maintenance, and compatibility cost, not a fixed count.

See [Providers](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md), [framework-owned LLM egress policy](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/egress-policy.md), and [Tool configuration](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) for credentials, models, the AI SDK bridge, reasoning settings, MCP, local endpoints, and the exact network-enforcement boundary.

**Provider sponsors**

Paid sponsors supporting `open-multi-agent`. Sponsorship does not affect technical decisions or model recommendations.

- **[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)**: Full-modal AI inference platform giving one API for video, image, and LLM across 300+ curated models. OMA users can request a limited $5 credit voucher. See the [Atlas Cloud setup guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers-atlascloud.md).

## Production

| Goal | Configure |
|---|---|
| Bound work | `maxTurns`, `timeoutMs`, `callTimeoutMs`, `contextStrategy`, `loopDetection` |
| Control spend | `maxTokenBudget`; `maxCostBudget` + application-owned `estimateCost` |
| Limit tools | `tools` / `toolPreset`, `cwd` / `defaultCwd`, tool-output caps |
| Recover | Task retries, checkpointing, `restore()`, and opt-in adaptive plan repair |
| Review work | `planOnly`, inline approval callbacks, or [durable approval gates](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/durable-approvals.md) |
| Observe | Trace sinks, TraceStore, execution receipts, Run Viewer, or the optional OTel adapter |

Budget checks run at turn and task boundaries, so a run can overshoot by up to one model turn; they are not a cent-exact stop. `estimateCost` receives each call's token usage plus the agent, effective `model`, `provider`, phase, and `taskId`, and your application owns the price table.

Built-in tools are default-deny, and every model-visible tool result is sent to
your model provider, so grant read and exec access deliberately. Tools may keep
application-owned data separate while returning text, image, or file content
through `modelOutput`; see the [tool configuration guide](../../docs/tool-configuration.md#rich-image-and-file-results).
Filesystem tools stay within the configured `cwd`; granted `bash` is not
sandboxed. Its execution target can be replaced through a
[`ShellExecutor`](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md#shell-executors),
while the default `LocalShellExecutor` preserves host execution and is not a
security boundary. Secrets are redacted from traces, shell output, and Viewer
payloads by default, but result messages and checkpoints have their own
persistence boundary.

### Observability

Core already provides run identity, trace sinks, execution receipts, queryable in-memory/file stores, and an offline Run Viewer. These cover local debugging, audit artifacts, and post-run analysis without OpenTelemetry.

[`@open-multi-agent/otel`](https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/otel/README.md) is an **optional enterprise integration** for teams that already operate a centralized OpenTelemetry stack. It converts OMA traces into standard OTel spans so multi-agent runs can join company-wide monitoring, alerting, and incident workflows. The application owns the provider and its lifecycle; telemetry failures never change the run result.

See the [observability guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md), [migration guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-migration.md), and [performance guidance](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability-performance.md).

## Documentation

| Area | Guides |
|---|---|
| Build agents | [Providers](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md), [structured input](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/structured-input.md), [tools](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md), [context](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/context-management.md) |
| Run reliably | [Evaluation](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/evaluation.md), [checkpoint & resume](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/checkpoint.md), [durable approvals](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/durable-approvals.md), [adaptive recovery](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/adaptive-recovery.md), [execution routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/execution-routing.md), [model routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md), [consensus](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/consensus.md) |
| Control workflows | [Plan preview & replay](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/plan-replay.md), [shared memory](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/shared-memory.md), [external agents](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/external-agents.md) |
| Operate | [Observability](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/observability.md), [CLI](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/cli.md), [production examples](examples/production/README.md) |

## Contributing

Issues and PRs are welcome. For production examples, follow the [acceptance criteria](examples/production/README.md); for code changes, see the [contribution guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/.github/CONTRIBUTING.md).

## Contributors

<a href="https://github.com/open-multi-agent/open-multi-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=open-multi-agent/open-multi-agent&max=100" />
</a>

<details>
<summary>Contributor credits by area</summary>

**Framework features**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (token budget, context strategy, dependency-scoped context, tool presets, glob, MCP integration, configurable coordinator, CLI, dashboard rendering, trace event types)
- [@apollo-mg](https://github.com/apollo-mg) (context compaction fix, sampling parameters)
- [@tizerluo](https://github.com/tizerluo) (onPlanReady, onAgentStream)
- [@CodingBangboo](https://github.com/CodingBangboo) (planOnly mode)
- [@Xin-Mai](https://github.com/Xin-Mai) (output schema validation)
- [@JasonOA888](https://github.com/JasonOA888) (AbortSignal support)
- [@EchoOfZion](https://github.com/EchoOfZion) (coordinator skip for simple goals)
- voidborne-d (OpenAI mixed-content fix, text-tool-extractor depth fix)
- [@NamelessNATM](https://github.com/NamelessNATM) (agent delegation base implementation)
- [@MyPrototypeWhat](https://github.com/MyPrototypeWhat) (reasoning blocks, reasoning_effort, sampling parity, trace input/output)
- [@SiMinus](https://github.com/SiMinus) (streaming reasoning events)
- [@matthewYang08](https://github.com/matthewYang08) (OpenAI reasoning-to-text fallback)
- [@dvirarad](https://github.com/dvirarad) (OpenAI-family adapter hardening)
- [@cat0825](https://github.com/cat0825) (model routing policy, plan replay, structured shared-memory handoff)
- [@mvanhorn](https://github.com/mvanhorn) (checkpoint & resume)
- [@lesbass](https://github.com/lesbass) (run-level metrics rollup on `TeamRunResult`)
- [@tlysanhuo](https://github.com/tlysanhuo) (trace span parent linkage)
- [@LambIessz](https://github.com/LambIessz) (orchestrator cost budget, MessageBus persistence in checkpoints, retryable route fallback)
- [@Bobuyoucrypto](https://github.com/Bobuyoucrypto) (Windows bash timeout process-tree kill)

**Provider integrations**

- [@ibrahimkzmv](https://github.com/ibrahimkzmv) (Gemini)
- [@hkalex](https://github.com/hkalex) (DeepSeek, MiniMax)
- [@marceloceccon](https://github.com/marceloceccon) (Grok)
- [@Klarline](https://github.com/Klarline) (Azure OpenAI)
- [@Deathwing](https://github.com/Deathwing) (GitHub Copilot)
- [@JackChiang233](https://github.com/JackChiang233) (Qiniu)
- [@CodingBangboo](https://github.com/CodingBangboo) (AWS Bedrock)
- [@kidoom](https://github.com/kidoom) (MiMo, Doubao)
- [@KaitlynFeng](https://github.com/KaitlynFeng) (Hunyuan)
- [@octo-patch](https://github.com/octo-patch) (MiniMax-M3 model upgrade)

**Examples & cookbook**

- [@mvanhorn](https://github.com/mvanhorn) (research aggregation, code review, meeting summarizer, Groq example, Mistral example)
- [@Kinoo0](https://github.com/Kinoo0) (code review upgrade)
- [@Optimisttt](https://github.com/Optimisttt) (research aggregation upgrade)
- [@Agentscreator](https://github.com/Agentscreator) (Engram memory integration)
- [@fault-segment](https://github.com/fault-segment) (contract-review DAG)
- [@HuXiangyu123](https://github.com/HuXiangyu123) (cost-tiered example)
- [@zouhh22333-beep](https://github.com/zouhh22333-beep) (translation/backtranslation)
- [@pei-pei45](https://github.com/pei-pei45) (competitive monitoring)
- [@mmjwxbc](https://github.com/mmjwxbc) (interview simulator)
- [@binghuaren96](https://github.com/binghuaren96) (incident postmortem DAG)
- [@DaiMao-UT](https://github.com/DaiMao-UT) (paper replication triage)
- [@oooooowoooooo](https://github.com/oooooowoooooo) (rare disease information triage)
- [@CodingBangboo](https://github.com/CodingBangboo) (Express customer support pipeline)
- [@nuthalapativarun](https://github.com/nuthalapativarun) (Doubao and Zhipu provider examples)
- [@goodneamtakenbydogs](https://github.com/goodneamtakenbydogs) (Moonshot and Qwen provider examples)
- [@suans4746-del](https://github.com/suans4746-del) (narrative puzzle hint arbitration)
- [@gregkonush](https://github.com/gregkonush) (Bilig WorkPaper MCP integration)

**Docs & tests**

- [@tmchow](https://github.com/tmchow) (llama.cpp docs)
- [@kenrogers](https://github.com/kenrogers) (OpenRouter docs)
- [@jadegold55](https://github.com/jadegold55) (LLM adapter test coverage)
- [@btroops](https://github.com/btroops) (DeepSeek tool-calling tests)
- [@nuthalapativarun](https://github.com/nuthalapativarun) (context-management docs)
- [@Oxygen56](https://github.com/Oxygen56) (errors.ts tests, provider docs for Grok/DeepSeek/Doubao)
- [@RheagalFire](https://github.com/RheagalFire) (LiteLLM gateway docs)

</details>

## License

MIT
