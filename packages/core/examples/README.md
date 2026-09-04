# Examples

Runnable scripts demonstrating `open-multi-agent`. Organized by category — pick one that matches what you're trying to do.

## Run an example

Examples import the framework source directly (`../../src/index.js`), so they run from a repository checkout, not from an installed package:

```bash
git clone https://github.com/open-multi-agent/open-multi-agent.git
cd open-multi-agent
npm install
export ANTHROPIC_API_KEY=...   # or the key the example's header asks for
npx tsx packages/core/examples/basics/single-agent.ts
```

Every script starts with a docblock that lists its `Run:` command and prerequisites. Most scripts default to Claude and read `ANTHROPIC_API_KEY`; the `basics/` scripts also accept `OMA_PROVIDER` + `OMA_MODEL` to switch to any built-in provider (see [docs/providers.md](../../../docs/providers.md)). Scripts that use file tools write under `.agent-workspace/` in the current directory. Two exceptions to the `npx tsx` flow: [`integrations/observability-v2/`](integrations/observability-v2/) needs `npm run build` first, and the [full applications](#apps--full-applications) have their own `package.json` and start scripts.

Copying an example into your own project? Replace the `../../src/index.js` import with the published package name `@open-multi-agent/core`, or start from [`create-oma-app`](../../create-oma-app/).

### No API key needed

These run offline and deterministically, so they are the fastest way to see the framework move.

| Example | What it shows |
|---------|---------------|
| [`patterns/durable-approval`](patterns/durable-approval.ts) | Suspend a task, record a reviewer decision, restore it in a fresh orchestrator. |
| [`patterns/event-driven-dag`](patterns/event-driven-dag.ts) | A downstream task starts the moment its dependency completes. |
| [`patterns/eval-offline-regression`](patterns/eval-offline-regression.ts) | EvalSet regression across two configurations with rule + judge scorers and a gate. |
| [`patterns/eval-online-sampling`](patterns/eval-online-sampling.ts) | Online sampling into a local `FileEvalStore` with explicit flush and shutdown. |
| [`cookbook/commission-reconciliation-recovery`](cookbook/commission-reconciliation-recovery.ts) | Repairable reconciliation that fails closed to manual review. |
| [`integrations/observability-v2/`](integrations/observability-v2/) | Trace batching, stores, an application-owned OTel provider, and CLI/server/serverless lifecycles. Build first. |
| [`providers/gemma4-local`](providers/gemma4-local.ts) | 100% local via Ollama. Needs Ollama running, no key. |

---

## basics — start here

Core execution modes and input shapes. Read these first.

| Example | What it shows |
|---------|---------------|
| [`basics/single-agent`](basics/single-agent.ts) | One agent with bash + file tools, then streaming via the `Agent` class. |
| [`basics/structured-input`](basics/structured-input.ts) | Caller-owned message history and image blocks through `runAgent()`. |
| [`basics/team-collaboration`](basics/team-collaboration.ts) | `runTeam()` coordinator pattern — goal in, results out. |
| [`basics/task-pipeline`](basics/task-pipeline.ts) | `runTasks()` with explicit task DAG and dependencies. |
| [`basics/multi-model-team`](basics/multi-model-team.ts) | Different models per agent in one team. |

## cookbook — use-case recipes

End-to-end examples framed around a concrete problem (meeting summarization, translation QA, competitive monitoring, etc.) rather than a single orchestration primitive. Lighter bar than `production/`: no tests or pinned model versions required. Good entry point if you want to see how the patterns compose on a real task.

| Example | Problem solved |
|---------|----------------|
| [`cookbook/adaptive-customer-support`](cookbook/adaptive-customer-support.ts) | `runTeam()` picks only the specialists a shipping or billing escalation needs, then synthesizes a grounded reply. |
| [`cookbook/commission-reconciliation-recovery`](cookbook/commission-reconciliation-recovery.ts) | No-key repairable reconciliation: `--case recovered` repairs evidence, `--case unresolved` fails closed to manual review (exit 1 by design). |
| [`cookbook/meeting-summarizer`](cookbook/meeting-summarizer.ts) | Fan-out a transcript into summary, structured action items, and sentiment. |
| [`cookbook/contract-review-dag`](cookbook/contract-review-dag.ts) | 4-task DAG (extract → compliance-check + summary → notify) with step-level retry. `FORCE_FAIL=task2` exercises retry. |
| [`cookbook/incident-postmortem-dag`](cookbook/incident-postmortem-dag.ts) | 5-task DAG: three parallel root tasks feed a root-cause hypothesis and the final postmortem. |
| [`cookbook/competitive-monitoring`](cookbook/competitive-monitoring.ts) | Parallel source monitoring (Twitter/Reddit/News), contradiction detection, aggregated report. |
| [`cookbook/paper-replication-triage`](cookbook/paper-replication-triage.ts) | Multi-source replication triage with artifact discovery, seeded conflicts, and a go/no-go plan. |
| [`cookbook/rare-disease-information-triage`](cookbook/rare-disease-information-triage.ts) | Source-isolated medical information triage with seeded misinformation and safety-boundary arbitration. |
| [`cookbook/personalized-interview-simulator`](cookbook/personalized-interview-simulator.ts) | Interactive interviewer loop with observer flags, shared memory, and a structured debrief. |
| [`cookbook/narrative-puzzle-hint-arbitration`](cookbook/narrative-puzzle-hint-arbitration.ts) | Multi-source hint arbitration with an external safety veto outside the generation loop. |
| [`cookbook/market-data-integrity-verify-loop`](cookbook/market-data-integrity-verify-loop.ts) | Binance L2 integrity gate: source-specific judges refute a provisional report until a verified revision passes. |
| [`cookbook/translation-backtranslation`](cookbook/translation-backtranslation.ts) | Translate → back-translate with a different provider → flag semantic drift. |

## patterns — orchestration patterns

Reusable shapes for common multi-agent problems.

| Example | Pattern |
|---------|---------|
| [`patterns/fan-out-aggregate`](patterns/fan-out-aggregate.ts) | MapReduce-style fan-out via `AgentPool.runParallel()`. |
| [`patterns/structured-output`](patterns/structured-output.ts) | Zod-validated JSON output from an agent. |
| [`patterns/rich-tool-results`](patterns/rich-tool-results.ts) | Keep application-owned tool data separate while returning image content to the model. |
| [`patterns/task-retry`](patterns/task-retry.ts) | Per-task retry with exponential backoff. |
| [`patterns/multi-perspective-code-review`](patterns/multi-perspective-code-review.ts) | Multiple reviewer agents in parallel, then synthesis. |
| [`patterns/research-aggregation`](patterns/research-aggregation.ts) | Multi-source research collated by a synthesis agent. |
| [`patterns/event-driven-dag`](patterns/event-driven-dag.ts) | No-key proof that a downstream task starts when its dependency completes, without waiting for unrelated work. |
| [`patterns/cost-tiered-pipeline`](patterns/cost-tiered-pipeline.ts) | Run the same four-stage pipeline twice to compare flagship vs tiered model cost. |
| [`patterns/agent-handoff`](patterns/agent-handoff.ts) | Synchronous sub-agent delegation via `delegate_to_agent`. |
| [`patterns/risk-gated-bash`](patterns/risk-gated-bash.ts) | Per-call `onToolCall` gate + `classifyBashCommand`: auto-pass read-only bash, human-review ambiguous, block destructive. |
| [`patterns/durable-approval`](patterns/durable-approval.ts) | No-key suspend → atomic reviewer decision → fresh-orchestrator restore of the exact approved task. |
| [`patterns/plan-replay`](patterns/plan-replay.ts) | Pin a coordinator plan with `createPlanArtifact`, then replay it with `runFromPlan`, no coordinator re-run. |
| [`patterns/consensus`](patterns/consensus.ts) | Proposer→judge refutation loop via `runConsensus()`: default judge prompt and per-judge `judgePrompt` function. |
| [`patterns/cross-provider-reasoning`](patterns/cross-provider-reasoning.ts) | Preserve a reasoning model's thought stream across providers via `preserveReasoningAsText`. |
| [`patterns/eval-offline-regression`](patterns/eval-offline-regression.ts) | No-key EvalSet regression across two model configurations with rule + judge scorers and a gate. |
| [`patterns/eval-online-sampling`](patterns/eval-online-sampling.ts) | Best-effort online sampling into `FileEvalStore` with explicit flush and shutdown. |

## integrations — external systems

Hooking the framework up to outside-the-box tooling. Contribution rules, including the vendor integration policy, are in [`integrations/README.md`](integrations/README.md).

| Example | Integrates with |
|---------|-----------------|
| [`integrations/trace-observability`](integrations/trace-observability.ts) | `onTrace` spans for LLM calls, tools, and tasks. |
| [`integrations/observability-v2/`](integrations/observability-v2/) | No-key runnable v2 batching, InMemory/File TraceStore, OTel in-memory provider, CLI, SIGTERM server, and FaaS lifecycle examples. |
| [`integrations/mcp-github`](integrations/mcp-github.ts) | An MCP server's tools exposed to an agent via `connectMCPTools()`. |
| [`integrations/mcp-bilig-workpaper`](integrations/mcp-bilig-workpaper.ts) | Bilig WorkPaper MCP tools for formula readback, recalculation, and persisted workbook JSON. |
| [`integrations/mcp-open-design`](integrations/mcp-open-design.ts) | Batch fan-out over an MCP server's async jobs: N Open Design runs in parallel via `runTasks()`, each polled to completion by code. |
| [`integrations/external-agent-acp`](integrations/external-agent-acp.ts) | External coding agents (Gemini CLI, Claude Code) as team members via the `acp` backend. |
| [`integrations/external-agent-process`](integrations/external-agent-process.ts) | Deterministic local subprocesses as team members via the `process` backend. |
| [`integrations/with-engram/`](integrations/with-engram/) | Engram shared memory as a `MemoryStore` plus an agent toolkit (vendor integration). |
| [`integrations/with-tencentdb-memory/`](integrations/with-tencentdb-memory/) | TencentDB-Agent-Memory long-term memory via its Hermes Gateway sidecar (vendor integration). |

## apps — full applications

Complete, clone-and-run applications with their own `package.json` and dependencies. These embed OMA in a real backend, so they use `npm install` plus their own start script rather than `npx tsx`.

| Example | Stack | Run |
|---------|-------|-----|
| [`integrations/express-customer-support/`](integrations/express-customer-support/) | Express REST API: `runTasks()` behind `POST /tickets`, per-agent Zod schemas, swappable provider env vars, HTTP error mapping (400/502/504) | `npm install && npm start` |
| [`integrations/with-vercel-ai-sdk/`](integrations/with-vercel-ai-sdk/) | Next.js: OMA `runTeam()` plus AI SDK `useChat` streaming | `npm install && npm run dev` |

## providers — model & adapter examples

One example per supported provider. All follow the same three-agent (architect / developer / reviewer) shape so they're easy to compare. Anthropic and OpenAI are covered by the `basics/` scripts above.

| Example | Provider | Env var |
|---------|----------|---------|
| [`providers/ollama`](providers/ollama.ts) | Ollama (local) + Claude | `ANTHROPIC_API_KEY` |
| [`providers/gemma4-local`](providers/gemma4-local.ts) | Gemma 4 via Ollama (100% local) | — |
| [`providers/local-quantized`](providers/local-quantized.ts) | Quantized MoE on vLLM / llama-server with tuned sampling (`topK` / `minP` / `frequencyPenalty` / `parallelToolCalls` / `extraBody.repetition_penalty`) | — |
| [`providers/copilot`](providers/copilot.ts) | GitHub Copilot (GPT-4o + Claude) | `GITHUB_TOKEN` |
| [`providers/azure-openai`](providers/azure-openai.ts) | Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` (+ optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`) |
| [`providers/bedrock`](providers/bedrock.ts) | AWS Bedrock (Claude via Converse API) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| [`providers/grok`](providers/grok.ts) | xAI Grok | `XAI_API_KEY` |
| [`providers/gemini`](providers/gemini.ts) | Google Gemini | `GEMINI_API_KEY` |
| [`providers/minimax`](providers/minimax.ts) | MiniMax M3 | `MINIMAX_API_KEY` |
| [`providers/mimo`](providers/mimo.ts) | MiMo V2.5 Pro | `MIMO_API_KEY` |
| [`providers/hunyuan`](providers/hunyuan.ts) | Tencent Hunyuan (MaaS, hy3) | `HUNYUAN_API_KEY` |
| [`providers/deepseek`](providers/deepseek.ts) | DeepSeek Chat | `DEEPSEEK_API_KEY` |
| [`providers/openrouter`](providers/openrouter.ts) | OpenRouter (OpenAI-compatible) | `OPENROUTER_API_KEY` |
| [`providers/groq`](providers/groq.ts) | Groq (OpenAI-compatible) | `GROQ_API_KEY` |
| [`providers/mistral`](providers/mistral.ts) | Mistral (OpenAI-compatible) | `MISTRAL_API_KEY` |
| [`providers/zhipu`](providers/zhipu.ts) | Zhipu GLM (OpenAI-compatible) | `ZHIPU_API_KEY` |
| [`providers/doubao`](providers/doubao.ts) | Doubao / ByteDance (OpenAI-compatible) | `ARK_API_KEY` |
| [`providers/qiniu`](providers/qiniu.ts) | Qiniu (OpenAI-compatible) | `QINIU_API_KEY` |
| [`providers/qwen`](providers/qwen.ts) | Qwen / DashScope (OpenAI-compatible) | `DASHSCOPE_API_KEY` |
| [`providers/moonshot`](providers/moonshot.ts) | Moonshot AI / Kimi (OpenAI-compatible) | `MOONSHOT_API_KEY` |

## production — real-world use cases

Reserved for end-to-end examples with error handling, pinned model versions, and tests. **This directory is currently empty**: the `cookbook/` recipes above are the closest thing today. The acceptance criteria and layout for a first entry are in [`production/README.md`](production/README.md). Contributions welcome.

---

## Adding a new example

| You're adding… | Goes in… | Filename |
|----------------|----------|----------|
| A new model provider | `providers/` | `<provider-name>.ts` (lowercase, hyphenated) |
| A reusable orchestration pattern | `patterns/` | `<pattern-name>.ts` |
| A use-case-driven example (problem-first, uses one or more patterns) | `cookbook/` | `<use-case>.ts` |
| Integration with an outside system (MCP server, observability backend, framework) | `integrations/` | `<protocol>-<name>.ts` for single-file wiring, `with-<product>/` for multi-file vendor integrations |
| A full application with its own `package.json` | `integrations/` | `<name>/` directory; it is listed under **apps** above |
| A real-world end-to-end use case, production-grade | `production/` | `<use-case>/` directory with its own README |

Conventions:

- **No numeric prefixes.** Folders signal category; reading order is set by this README.
- **File header docstring** with one-line title, `Run:` block, and prerequisites.
- **Imports** should resolve as `from '../../src/index.js'` for scripts (one level deeper than the old flat layout); full applications with their own `package.json` import the published `@open-multi-agent/core` package name instead.
- **Match the provider template** when adding a provider: three-agent team (architect / developer / reviewer) building a small REST API. Keeps comparisons honest.
- **Add a row** to the table in this file for the corresponding category. `npm run test:example-catalog` fails when a catalog entry has no link in this README.
- **Add exactly one entry** to [`catalog.json`](catalog.json), including its user goal, capability tags, format, level, and any directory entrypoints. The catalog is the machine-readable inventory and the website's classification contract; the directories above remain the maintenance taxonomy, and a catalog `goal` controls discovery by user intent without requiring a file move. The same command validates the metadata and fails when a standalone example or top-level example directory is not registered. Do not move an example merely to change its website grouping.
- **Type-check before sending.** `npm run lint -w @open-multi-agent/core` compiles this directory together with `src/`, so an example that drifts from the current API fails CI. Examples with their own `package.json`/`tsconfig.json` are excluded from that pass and must be listed in [`tsconfig.lint.json`](../tsconfig.lint.json); they carry their own check instead.
