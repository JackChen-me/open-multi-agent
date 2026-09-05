# Documentation

Every page under `docs/`, grouped by what you are trying to do. Each line says
which question the page answers, so you can pick one without opening five.

## Start here

| Page | What it answers |
|---|---|
| [Core package guide](../packages/core/README.md) | What are the three execution modes, and how do I get a team running? |
| [Examples](../packages/core/examples/README.md) | Which runnable script is closest to what I am building? |
| [Glossary](glossary.md) | What does OMA mean by coordinator, task, run, span, gate, or budget? |
| [Production checklist](production-checklist.md) | Which defaults are deliberately permissive, and what must I decide before going live? |

## Configure models and tools

| Page | What it answers |
|---|---|
| [Providers](providers.md) | Which providers are built in, what credentials do they need, and how do I point one at a local or OpenAI-compatible endpoint? |
| [LLM egress policy](egress-policy.md) | Which network requests can OMA restrict before an adapter opens them, and which are outside that boundary? |
| [Self-hosting and data residency](self-hosting.md) | What does the framework run, reach, and persist when it runs on my own infrastructure? |
| [Tool configuration](tool-configuration.md) | How are built-in, custom, and delegation tools granted, filtered, and gated per call? |
| [Sandbox and shell execution](sandbox-and-shell.md) | Where can a filesystem tool reach, and where does a granted `bash` command actually run? |
| [MCP tools](mcp.md) | What does `connectMCPTools()` do, and which OMA controls extend into the MCP child process? |
| [Structured agent input](structured-input.md) | How do I pass caller-owned conversation history, images, or files instead of a single prompt string? |
| [External agents](external-agents.md) | How do process and ACP backends put coding CLIs on the same task DAG, and what stops applying to them? |

## Control orchestration

| Page | What it answers |
|---|---|
| [Coordinator](coordinator.md) | What does the planning agent decide, what does it see, and how do I configure or replace it? |
| [Task scheduling and dispatch](task-scheduling.md) | In what order do tasks run, how do dependency payloads reach them, and what happens on retry, approval, or abort? |
| [Execution routing](execution-routing.md) | Should an automatic `runTeam()` call use one agent or a coordinator-built team plan? |
| [Model routing](model-routing.md) | How do I send planning and leaf work to different models without changing the team? |
| [Consensus](consensus.md) | How do judge agents verify an answer, and what does a quorum cost against the budget? |
| [Plan preview and replay](plan-replay.md) | How do I freeze a coordinator plan as reviewable data and replay it without planning again? |
| [Adaptive recovery](adaptive-recovery.md) | When may a run revise the not-yet-executed part of its own graph? |
| [Durable approval gates](durable-approvals.md) | How does a run suspend at an approval boundary and resume from the same reviewed content after a restart? |
| [Hooks and callbacks](hooks-and-callbacks.md) | Which function-typed field fires when, in which run mode, and what can its return value change? |
| [Shared memory](shared-memory.md) | How do agents read each other's findings, and which store backs that? |
| [Streaming](streaming.md) | Which APIs return incremental output, what does each `StreamEvent` carry, and which paths never stream? |
| [Budgets and limits](budgets-and-limits.md) | Which ceilings bound a run, where are they checked, and what happens when one trips? |

## Operate

| Page | What it answers |
|---|---|
| [Observability](observability.md) | What do progress events, trace spans, and stores record, and what does telemetry cost? |
| [Run Viewer](run-viewer.md) | How do I render one finished run as a self-contained page with a task DAG and span waterfall? |
| [Run event journal](run-journal.md) | What exactly did each agent see at the moment it was asked, and can that be verified offline? |
| [Checkpoint and resume](checkpoint.md) | How does an interrupted run resume without repeating completed work? |
| [Context management](context-management.md) | How does a long conversation shrink as it grows, and what happens to reasoning blocks? |
| [Evaluation](evaluation.md) | How do EvalSets, scorers, and stores measure quality without changing the business result? |
| [Evaluation in CI](evaluation-ci.md) | How do I turn an EvalSet into a pass/fail signal a CI job can act on? |
| [Routing evaluation](evaluation-routing.md) | Which frozen EvalSets guard routing decisions, and what would let a routing regression through? |
| [Migrating to Observability v2](observability-migration.md) | How do I move an `onTrace` integration to the v2 path one layer at a time? |
| [Errors](errors.md) | Which error class is this, who raised it, and does a retry help? |
| [CLI](cli.md) | Which `oma` subcommands exist, what JSON do they print, and which exit codes do they use? |

## Partners

| Page | What it answers |
|---|---|
| [Featured Partner program](featured-partner.md) | What does a featured placement in the project README include, and who qualifies? |
| [Atlas Cloud setup guide](providers-atlascloud.md) | How do I configure the Atlas Cloud provider sponsor's endpoint and credentials? |
| [Atlas Cloud 接入指南](providers-atlascloud_zh.md) | Chinese translation of the Atlas Cloud setup guide. |

## Internal records

[`internal/`](internal/README.md) holds engineering records kept for
auditability, such as benchmark snapshots and release-readiness reviews. They
describe a specific point in time on specific hardware and are not user
documentation; nothing there is a supported contract.
