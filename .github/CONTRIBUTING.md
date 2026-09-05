# Contributing

Thanks for your interest in contributing to Open Multi-Agent! This guide covers the basics to get you started.

## Setup

```bash
git clone https://github.com/open-multi-agent/open-multi-agent.git
cd open-multi-agent
npm install
```

Requires Node.js >= 20.0.0. Node.js 20 is upstream-EOL and retained only as a migration compatibility window; OMA will remove it in the next major release, no earlier than 2026-10-31.

## Development Commands

```bash
npm run build          # Compile every workspace
npm run dev            # Watch-mode compilation for @open-multi-agent/core
npm run lint           # Type-check every workspace (tsc --noEmit)
npm test               # Run unit tests in every workspace
npm run test:watch     # Core Vitest watch mode
npm run test:coverage  # Core unit tests with coverage
npm run test:scaffold  # End-to-end create-oma-app scaffold smoke test
npm run test:example-catalog  # Validate example catalog metadata and coverage
npm run test:e2e       # Core provider E2E; requires real API keys

node packages/core/dist/cli/oma.js help  # After build; `oma` when installed from npm
```

## Running Tests

Unit tests live in each workspace's `tests/` directory: currently `packages/core/tests/`, `packages/create-oma-app/tests/`, `packages/otel/tests/`, and `packages/release-bot/tests/`. They run without API keys or network access — provider SDKs and external processes are mocked where needed.

```bash
npm test
```

Core E2E tests are separate because they require `RUN_E2E=1` and real provider credentials. Each provider suite runs only when its matching credential is present, so a single-key canary does not fail on unrelated providers:

```bash
# Runs only the suites whose credentials are set.
# Supported keys: OPENAI_API_KEY, ANTHROPIC_API_KEY,
# GEMINI_API_KEY / GOOGLE_API_KEY, and DEEPSEEK_API_KEY.
npm run test:e2e
```

Set `DEEPSEEK_E2E_MODEL` to override the DeepSeek canary model; it defaults to `deepseek-v4-flash`.

The `Provider Canary` workflow runs the DeepSeek suite daily and can also be started manually. Maintainers must configure `DEEPSEEK_API_KEY` as a GitHub Actions repository secret; never add a provider credential to source files or workflow YAML.

Run checks that match the surface you changed and record the commands and results in the PR description. For code changes, start with `npm run lint && npm test`; also run `npm run build` when package output or public entry points may be affected, and `npm run test:scaffold` when changing `create-oma-app` scaffolding or templates.

CI is the source of truth for the full pre-merge matrix. It runs lint, unit tests on Node 20/22/24, coverage, workspace builds, package/import smoke tests, template type-checking, tarball assertions, and the scaffold E2E test.

## Making a Pull Request

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests and user-facing documentation when behavior changes
4. Run the checks relevant to your change and note any skipped checks with a reason
5. Open a PR against `main`, titled as a conventional commit such as `fix(core): reject empty tool names`

Opening a PR prefills the [pull request template](pull_request_template.md), which carries the review checklist. Fill in the sections it asks for instead of deleting them, and write "None" or "Not applicable" where a category does not apply.

## Code Style

- TypeScript strict mode, ES modules (`.js` extensions in imports)
- No additional linter/formatter configured — follow existing patterns
- Keep dependency ownership explicit. Core must remain importable and runnable without optional integrations
- Pin what stays in the repository; keep ranges on what a consumer installs. Every `devDependencies` entry is pinned to an exact version and the root [`.npmrc`](../.npmrc) sets `save-exact=true`, but core's `dependencies`, every `peerDependencies`, and otel's `@open-multi-agent/core` stay semver ranges. `save-exact` will pin a new dependency added to one of those blocks, so widen it by hand — CI fails when one is left exact
- Add new optional provider SDKs as peer dependencies and load them lazily with dynamic `import()`
- Keep OpenTelemetry APIs, SDKs, semantic-convention packages, and exporters in `@open-multi-agent/otel`, never in the core root import
- Version `@open-multi-agent/otel` independently from core and express core compatibility in its dependency range
- Justify dependency changes to other workspaces in the PR description

## Architecture Overview

See the [README](../packages/core/README.md#architecture) for an architecture diagram. Key entry points:

- **Orchestrator**: `packages/core/src/orchestrator/orchestrator.ts`. Top-level API.
- **Task system**: `packages/core/src/task/queue.ts`, `packages/core/src/task/task.ts`. Dependency DAG.
- **Agent**: `packages/core/src/agent/runner.ts`. Conversation loop.
- **Tools**: `packages/core/src/tool/framework.ts`, `packages/core/src/tool/executor.ts`. Tool registry and execution.
- **Team**: `packages/core/src/team/team.ts`, `packages/core/src/team/messaging.ts`. The team container and the in-memory inter-agent message bus.
- **LLM adapters**: `packages/core/src/llm/`. Built-in providers + OpenAI-compatible + AI SDK bridge (see [docs/providers.md](../docs/providers.md)).
- **Memory and checkpoints**: `packages/core/src/memory/`. Shared memory, stores, and checkpoint snapshots (see [docs/shared-memory.md](../docs/shared-memory.md) and [docs/checkpoint.md](../docs/checkpoint.md)).
- **Durable approvals**: `packages/core/src/approval/durable.ts`. Suspended approval requests and decision records (see [docs/durable-approvals.md](../docs/durable-approvals.md)).
- **Run journal**: `packages/core/src/journal/`. Append-only run events, offline verification, and tail replay (see [docs/run-journal.md](../docs/run-journal.md)).
- **Observability**: `packages/core/src/observability/`. Trace records, sinks, exporters, and stores.
- **Run Viewer**: `packages/core/src/dashboard/`. Offline single-run DAG and waterfall HTML rendering (see [docs/run-viewer.md](../docs/run-viewer.md)).
- **Evaluation**: `packages/core/src/eval/`. EvalSets, scorers, gates, reports, and stores (see [docs/evaluation.md](../docs/evaluation.md)).
- **OpenTelemetry adapter**: `packages/otel/src/`. Optional OTel mapping and export integration kept outside core.
- **App scaffolder**: `packages/create-oma-app/src/` and `packages/create-oma-app/templates/`. CLI and starter templates.

## Where to Contribute

Check the [issues](https://github.com/open-multi-agent/open-multi-agent/issues) page. Issues labeled `good first issue` are scoped and approachable. Issues labeled `help wanted` are larger but well-defined.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
