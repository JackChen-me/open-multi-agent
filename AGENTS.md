# AGENTS.md

This file is the canonical working agreement for AI agents editing this repository. Keep durable execution rules, high-risk invariants, and verification expectations here. Keep conceptual architecture and subsystem behavior in [`packages/core/README.md`](packages/core/README.md) and [`docs/`](docs/) so this file stays concise and accurate.

## Repository map

This is a private npm-workspaces root. Run the commands below from the repository root unless a workspace-specific command is shown.

| Workspace | Purpose | Main paths |
|---|---|---|
| `@open-multi-agent/core` | Multi-agent orchestration framework and `oma` CLI | `packages/core/src/`, `packages/core/tests/`, `packages/core/examples/` |
| `@open-multi-agent/otel` | Optional OpenTelemetry adapter; versioned independently from core | `packages/otel/src/`, `packages/otel/tests/` |
| `create-oma-app` | Published scaffolder and starter templates | `packages/create-oma-app/src/`, `packages/create-oma-app/templates/`, `packages/create-oma-app/tests/` |

Root-level `README.md`, `docs/`, `.github/`, and `scripts/` apply across workspaces. Paths in this file are repository-relative; do not assume an unprefixed `src/` or `tests/` means the workspace you intend.

## Commands

```bash
npm run build          # Compile every workspace
npm run lint           # Type-check every workspace
npm test               # Run unit tests in every workspace (no API keys required)
npm run test:scaffold  # End-to-end create-oma-app scaffold smoke test
npm run test:example-catalog  # Validate example catalog metadata and coverage

npm run dev            # Watch-mode compilation for @open-multi-agent/core
npm run test:watch     # Core Vitest watch mode
npm run test:coverage  # Core coverage suite
npm run test:e2e       # Core provider E2E; requires real API keys

node packages/core/dist/cli/oma.js help  # After build; `oma` when installed from npm
```

Examples and core E2E tests may require real provider credentials. Unit tests mock provider SDKs and external processes and should run without network access or API keys.

## Working rules

- Use strict TypeScript and ESM imports with `.js` extensions: `import { X } from './foo.js'` even when the source file is TypeScript. There is no eslint/prettier configuration; match nearby style.
- Change source files, tests, templates, or docs rather than generated `dist/` output.
- Add or update tests for behavior changes. Update user-facing docs and examples when public behavior changes, or state why they are not applicable.
- Keep dependency ownership explicit. Core must remain importable and runnable without optional integrations.
- Add optional provider SDKs as peer dependencies and load them lazily with dynamic `import()`. Do not maintain a fixed dependency or adapter count in documentation.
- OpenTelemetry APIs, SDKs, semantic-convention packages, and exporters belong in `@open-multi-agent/otel`, never in the core root import. The application owns its tracer/provider lifecycle unless an API explicitly says otherwise.
- Treat `docs/` as the source of truth for subsystem behavior. Keep this file to rules and concise invariants; link to docs instead of copying long explanations.
- Follow conventional commits when a commit is requested. Reference a PR or issue when one exists. The full contribution flow is in [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).
- Publishing spans three packages with independent version tracks, a fixed publish order, and template pins that must move with the core version. Do not infer any of that from this file: [`.github/RELEASING.md`](.github/RELEASING.md) is the source of truth.
- **Managed Git worktrees share repository metadata.** Never repair access by changing `.git` ownership or permissions. Use the current tool's normal Git and approval flow.
- **Keep worktree dependencies isolated.** Run `npm ci` in each worktree and never symlink `node_modules` from another checkout.

## Validation by change type

Always inspect the focused diff and run `git diff --check`. Run the smallest relevant checks first, then broaden in proportion to the change.

- **Documentation-only:** `git diff --check`; tests are not required unless commands, generated artifacts, or executable examples changed.
- **Core code:** relevant core tests, then `npm run lint -w @open-multi-agent/core` and `npm run test -w @open-multi-agent/core`. Run `npm run build -w @open-multi-agent/core` when public entry points, declarations, package output, or CLI output may be affected.
- **OpenTelemetry adapter:** relevant tests, then `npm run lint -w @open-multi-agent/otel`, `npm run test -w @open-multi-agent/otel`, and build when package output or public types may be affected.
- **Scaffolder or templates:** relevant tests, then `npm run lint -w create-oma-app`, `npm run test -w create-oma-app`, and `npm run typecheck:template -w create-oma-app`. Run `npm run test:scaffold -w create-oma-app` when generated-project behavior changes.
- **Examples or catalog metadata:** `npm run test:example-catalog`; add a runnable example smoke test when executable behavior changes.
- **Cross-workspace or dependency changes:** `npm run lint`, `npm test`, and `npm run build`; add the package/import/template smoke checks relevant to the changed surface.
- **Provider E2E:** run only when the changed surface requires real-provider verification and the necessary credentials are safely available. Never expose credential values.

Before finishing, report every command run and its outcome. If a relevant check was skipped or could not run, state the reason and residual risk. CI remains the source of truth for the complete Node 20/22/24 pre-merge matrix.

## Architecture entry points

`packages/core/src/` is organized one directory per subsystem (`orchestrator/`, `agent/`, `team/`, `task/`, `tool/`, `llm/`, `memory/`, `observability/`, `eval/`, `dashboard/`, `cli/`); run `ls packages/core/src/` to locate code, and use the linked docs below for behavior and contracts. Inside `orchestrator/`, `orchestrator.ts` is the entry point that the peer modules in that directory hang off.

The published surface is `packages/core/src/index.ts` plus the dedicated subpath entry points declared under `exports` in `packages/core/package.json`: `/observability`, `/observability/file`, `/eval`, `/eval/file`, `/mcp`, `/ai-sdk`, `/acp`, `/process`, and `/classifiers`. Keep that declaration and the backing source files in sync when adding or renaming one.

`OpenMultiAgent` exposes three primary modes: `runAgent()` for a one-shot agent, `runTeam()` for coordinator-generated task DAGs, and `runTasks()` for explicit dependency pipelines. See the [core package README](packages/core/README.md#architecture) for the conceptual architecture.

## Non-obvious invariants

These constraints span multiple files and can cause behavioral or compatibility bugs when missed:

- **Tool errors are values:** tool failures are returned as `ToolResult` with `isError: true`; they do not throw through the runner. LLM API failures propagate. Task failures cascade to dependents while independent tasks may continue.
- **Built-in tools are default-deny:** a built-in is granted only through `AgentConfig.tools`, `toolPreset`, or `OrchestratorConfig.defaultToolPreset`. Registered custom/runtime tools are granted by registration but still honor `disallowedTools`. Ungranted calls return an error rather than executing. See [tool configuration](docs/tool-configuration.md).
- **Per-call gates run below grants:** `onToolCall` runs after Zod validation and before execution. Denial returns an error `ToolResult`; throwing or invalid gates fail closed. Ungranted tools never reach the gate. `AgentConfig.onToolCall` overrides the orchestrator default. The optional shell classifier is exported from `/classifiers`.
- **Delegation is orchestration-only and separately granted:** `delegate_to_agent` exists only in `runTeam()` and `runTasks()` workers and must be explicitly granted. Standalone `runAgent()` and the simple-goal short circuit do not register it. Self-delegation, cycles, unknown targets, excess depth, and unavailable pool capacity are rejected; delegated usage counts against the parent budget.
- **Filesystem tools are sandboxed; `bash` is not:** filesystem built-ins resolve paths and symlinks within `AgentConfig.cwd` or `OrchestratorConfig.defaultCwd`, defaulting to `<cwd>/.agent-workspace`. `null` disables that sandbox and `process.cwd()` widens it. Shell execution has no equivalent filesystem boundary.
- **Reasoning is dropped unless opted in:** provider-native reasoning blocks that the target adapter cannot echo are discarded unless `preserveReasoningAsText` is enabled. Inline `<thinking>` text is never reconstructed into a signed reasoning block. See [context management](docs/context-management.md).
- **Native tool calls win:** the local-model text extractor runs only when a server emits no native tool calls.
- **External backends replace the LLM runner:** process and ACP backends perform their own work in `cwd`; the runner tool loop, sandbox, and context strategy do not apply, while queue, scheduler, memory, and budget behavior remain backend-agnostic. ACP permissions default to auto-approve and its cumulative context usage is recorded as per-turn deltas when updates exist. See [external agents](docs/external-agents.md).
- **Telemetry is not execution state:** losing telemetry must not roll back a durable run. Deleting traces must not delete checkpoints, shared memory, or remotely exported OpenTelemetry data. Observability delivery/export failures do not become agent, task, or run failures. See [observability](docs/observability.md).
- **Evaluation observes results:** offline evaluation is separate; online sampling, scoring, and persistence are best-effort and isolated from the business response. Scorer failures become `scorer_error` and are excluded from score aggregates rather than converted to zero. See [evaluation](docs/evaluation.md).
- **Secrets and PII are redacted best-effort:** traces, shell output, and dashboard payloads pass through redaction, but callers must still avoid deliberately persisting or logging secrets.

## Subsystem documentation

**This table is a curated selection, not a complete index.** `docs/` contains more files than are listed here. Run `ls docs/` for the full set before concluding that a topic is undocumented.

| Topic | Source of truth |
|---|---|
| Context strategies and reasoning round-tripping | [docs/context-management.md](docs/context-management.md) |
| Tool grants, presets, sandbox, delegation, MCP, and gates | [docs/tool-configuration.md](docs/tool-configuration.md) |
| Providers, environment variables, local servers, and AI SDK | [docs/providers.md](docs/providers.md) |
| Shared memory and custom stores | [docs/shared-memory.md](docs/shared-memory.md) |
| Checkpoint and restore | [docs/checkpoint.md](docs/checkpoint.md) |
| Tracing, stores, progress, Run Viewer, privacy, and OpenTelemetry | [docs/observability.md](docs/observability.md) |
| Evaluation, scorers, stores, reports, sampling, and gates | [docs/evaluation.md](docs/evaluation.md) |
| CLI commands and JSON schemas | [docs/cli.md](docs/cli.md) |
| Process and ACP backends | [docs/external-agents.md](docs/external-agents.md) |
| Routing, scheduling, consensus, recovery, and replay | [model-routing](docs/model-routing.md), [execution-routing](docs/execution-routing.md), [task-scheduling](docs/task-scheduling.md), [consensus](docs/consensus.md), [adaptive-recovery](docs/adaptive-recovery.md), [plan-replay](docs/plan-replay.md) |

## Adding an LLM adapter

Implement `LLMAdapter.chat()` and `LLMAdapter.stream()`, add the provider to `SupportedProvider`, and register it in `packages/core/src/llm/adapter.ts` through dynamic `import()` so unused SDKs never resolve. OpenAI-compatible providers should accept `baseURL` and reuse `openai-common.ts`. Add focused adapter tests and update [docs/providers.md](docs/providers.md) without introducing a hard-coded provider count.
