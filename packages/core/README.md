<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg">
    <img alt="" src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/logo-mark-light.svg" width="72">
  </picture>
  <br>Open Multi-Agent
</h1>

<p align="center">
  <strong>Describe the goal, not the graph.</strong><br/>
  A self-organizing team of agents that runs in your environment, pauses for approval on consequential actions, and leaves a verifiable record of every run.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-multi-agent/core"><img src="https://img.shields.io/npm/v/@open-multi-agent/core" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@open-multi-agent/core" alt="Node.js version"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/supply-chain-audit.yml"><img src="https://github.com/open-multi-agent/open-multi-agent/actions/workflows/supply-chain-audit.yml/badge.svg" alt="Supply chain audit"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <a href="https://codecov.io/gh/open-multi-agent/open-multi-agent"><img src="https://codecov.io/gh/open-multi-agent/open-multi-agent/graph/badge.svg" alt="codecov"></a>
</p>

<p align="center">
  <a href="https://open-multi-agent.com/?utm_source=npm&utm_medium=package_readme">Website</a> ·
  <a href="https://open-multi-agent.com/getting-started/introduction/?utm_source=npm&utm_medium=package_readme">Docs</a> ·
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

<details>
<summary>Pause consequential tool calls for approval</summary>

```typescript
import { FileStore, OpenMultiAgent } from '@open-multi-agent/core'

// Your keys and your endpoint: a hosted provider, or a local server through baseURL.
const oma = new OpenMultiAgent({
  defaultProvider: 'openai',
  defaultModel: 'gpt-5.4',
  // Consequential tool calls (file writes, shell) pause for a human decision.
  onToolCall: ({ consequential }) => (consequential ? { action: 'suspend' } : { action: 'allow' }),
})

const team = oma.createTeam('ops', {
  name: 'ops',
  agents: [{ name: 'operator', systemPrompt: 'Reconcile overdue invoices.', toolPreset: 'readwrite' }],
})

// The coordinator plans the task DAG from the goal; the checkpoint store keeps the run durable.
const result = await oma.runTeam(team, 'Find overdue invoices and draft the reminders.', {
  checkpoint: { store: new FileStore('./.oma/run.json') },
})

// result.status?.code === 'suspended' until a reviewer decides result.pendingApprovals,
// each bound to a hash of exactly what the reviewer was shown.
```

</details>

Set `OPENAI_API_KEY` for this example. For other hosted or local models, see [Providers](#providers).

## Execution Modes

| Mode | Method | When to use | Example |
|------|--------|-------------|---------|
| Single agent | `runAgent()` | One agent, one prompt | [`basics/single-agent`](examples/basics/single-agent.ts) |
| Auto-orchestrated team | `runTeam()` | Give a goal, let the coordinator plan and execute | [`basics/team-collaboration`](examples/basics/team-collaboration.ts) |
| Explicit pipeline | `runTasks()` | You define the task graph and assignments | [`basics/task-pipeline`](examples/basics/task-pipeline.ts) |

Use `planOnly` to inspect a generated task graph before execution, then `createPlanArtifact()` and `runFromPlan()` to replay it. `runConsensus()` adds a proposer→judge verification loop when one answer needs extra scrutiny.

### Structured single-agent input

`Agent.run()`, `Agent.stream()`, and `OpenMultiAgent.runAgent()` keep the string form above and also accept a complete `LLMMessage[]`, for caller-owned conversation history or blocks such as base64 images. Structured input is validated and defensively copied, and process and ACP backends stay string-only: they reject structured arguments rather than discarding history or images. See [structured agent input](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/structured-input.md) for copy, hook, and external-backend semantics, or run [`basics/structured-input`](examples/basics/structured-input.ts).

### Execution routing

`runTeam()` uses the deterministic router by default and makes no extra model call. `executionRouting: { strategy: 'hybrid' }` keeps deterministic Team decisions and sends only Single candidates to a one-call, no-tool `TaskProfiler`; results then expose `routingDecision` and `semanticRoutingAssessment`. The Profiler falls back to the Coordinator adapter and then the orchestrator's default provider, so it can make a provider call even when every worker has its own adapter. See [execution routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/execution-routing.md) for that provider boundary and the full policy precedence; [model routing](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/model-routing.md) selects models inside the chosen topology.

### Declared governance roles

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

The topology comes only from these structured fields, so equivalent goals in different languages produce the same roles and order. `governanceConclusion` comes from the structured execution receipt rather than from role names or approval wording in the model answer, so governance-sensitive applications must check it separately from `success`. See [declared governance roles](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md#declared-governance-roles-in-runteam).

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

Agents may declare `description`, `capabilities`, `costTier`, and `latencyClass`, and tasks may add hard `requires` constraints; every strategy fails before worker execution when they cannot be satisfied. Weight semantics, load normalization, `strictAssignees`, and the `NO_ELIGIBLE_AGENT` and `INVALID_ASSIGNEE` failure modes are covered in [task scheduling and dispatch](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/task-scheduling.md).

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
| **External agents** | ACP and process backends let coding CLIs participate while OMA keeps scheduling, memory, and budgets; the per-call tool gate, filesystem sandbox, and LLM egress policy do not cover them. |

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

See [Providers](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers.md), [framework-owned LLM egress policy](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/egress-policy.md), [Self-hosting and data residency](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/self-hosting.md), and [Tool configuration](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md) for credentials, models, the AI SDK bridge, reasoning settings, MCP, local endpoints, self-hosted deployment, and the exact network-enforcement boundary.

**Provider sponsors**

Paid sponsors supporting `open-multi-agent`. Sponsorship does not affect technical decisions or model recommendations.

- **[Atlas Cloud](https://www.atlascloud.ai/console/coding-plan)**: Full-modal AI inference platform giving one API for video, image, and LLM across 300+ curated models. $5 credit vouchers for OMA users, first come first served. See the [Atlas Cloud setup guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/providers-atlascloud.md).

## Production

| Goal | Configure |
|---|---|
| Bound work | `maxTurns`, `timeoutMs`, `callTimeoutMs`, `contextStrategy`, `loopDetection` |
| Control spend | `maxTokenBudget`; `maxCostBudget` + application-owned `estimateCost` |
| Limit tools | `tools` / `toolPreset`, `cwd` / `defaultCwd`, tool-output caps |
| Recover | Task retries, checkpointing, `restore()`, and opt-in adaptive plan repair |
| Review work | `planOnly`, inline approval callbacks, or [durable approval gates](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/durable-approvals.md); your application owns the approval surface and transport |
| Observe | Trace sinks, TraceStore, execution receipts, Run Viewer, or the optional OTel adapter |

Budget checks run at turn and task boundaries, so a run can overshoot by up to one model turn; they are not a cent-exact stop. `estimateCost` receives each call's token usage plus the agent, effective `model`, `provider`, phase, and `taskId`, and your application owns the price table.

Built-in tools are default-deny, and every model-visible tool result is sent to
your model provider, so grant read and exec access deliberately. Tools may keep
application-owned data separate while returning text, image, or file content
through `modelOutput`; see the [tool configuration guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/tool-configuration.md#rich-image-and-file-results).
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

<p align="center">
  <img src="https://raw.githubusercontent.com/open-multi-agent/open-multi-agent/main/.github/brand/demo-dashboard-hero.gif" alt="OMA Run Viewer replaying a real multi-agent run: task DAG and span waterfall views with per-task status, assignee, tokens, and tool calls" width="960" height="540" loading="lazy">
</p>
<p align="center"><em>The offline Run Viewer replaying a real run from the trace store: task DAG, span waterfall, and per-task evidence, with no hosted service involved.</em></p>

### Run journal

When a long run goes wrong, the record usually missing is what each agent actually saw at the moment it was asked. The opt-in run journal keeps it: every message and tool result as an appended event, plus the exact block a context strategy put in place of the turns it dropped, so a finished run can be read back instead of reconstructed by guesswork. `verifyRun()` then checks offline that every block the model saw is reproducible from the log rather than trusting the log's own account of itself, which establishes order and lineage rather than tamper-evidence, and `restore()` can resume from the last appended event instead of the last snapshot. It is off by default, costs nothing when off, and is documented in the [run journal guide](https://github.com/open-multi-agent/open-multi-agent/blob/main/docs/run-journal.md).

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

Per-contributor credits by area are in [CONTRIBUTORS.md](https://github.com/open-multi-agent/open-multi-agent/blob/main/CONTRIBUTORS.md).

## License

MIT
