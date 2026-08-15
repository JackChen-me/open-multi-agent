# Command-line interface (`oma`)

The package ships a small binary **`oma`** that exposes the same primitives as the TypeScript API: `runTeam`, `runTasks`, offline EvalSet execution, single-run dashboard export, plus a static provider reference. It is meant for **shell scripts and CI** (JSON on stdout, stable exit codes).

It does **not** provide an interactive REPL, working-directory injection into tools, human approval gates, or session persistence. Those stay in application code.

## Installation and invocation

After installing the package, the binary is on `PATH` when using `npx` or a local `node_modules/.bin`:

```bash
npm install @open-multi-agent/core
npx oma help
```

From a clone of the repository you need a build first:

```bash
npm run build
node packages/core/dist/cli/oma.js help
```

Set the usual provider API keys in the environment (see [README](../packages/core/README.md#quick-start)); the CLI does not read secrets from flags. MiniMax additionally reads `MINIMAX_BASE_URL` to select the global (`https://api.minimax.io/v1`) or China (`https://api.minimaxi.com/v1`) endpoint. MiMo additionally reads `MIMO_BASE_URL` for Token Plan cluster endpoints such as `https://token-plan-cn.xiaomimimo.com/v1`.

OpenRouter works through the OpenAI-compatible adapter: set `provider` to `openai`, `baseURL` to `https://openrouter.ai/api/v1`, and pass `OPENROUTER_API_KEY` as the agent or orchestrator `apiKey`.

---

## Commands

### `oma run`

Runs **`OpenMultiAgent.runTeam(team, goal)`**: coordinator decomposition, task queue, optional synthesis.

When invoked with `--dashboard`, the CLI captures structured trace records for
that run in addition to any configured sinks, combines them with the exact
`TeamRunResult`, and writes a static Run Viewer to
`oma-dashboards/runTeam-<timestamp>.html`. The generated page includes the task
DAG, hierarchy-aware span Waterfall, filters, and safe evidence details.

The dashboard path is printed to stderr. The normal run JSON and exit status on
stdout are unchanged. If trace capture cannot be materialized, the CLI emits
`DASHBOARD_TRACE_CAPTURE_FAILED` on stderr and falls back to a result-only
Viewer. Render or write failures use `DASHBOARD_RENDER_FAILED` or
`DASHBOARD_WRITE_FAILED` and do not change the completed run result.

The dashboard page is self-contained: it does not load remote scripts, stylesheets, or fonts, and sensitive-looking values in the embedded run payload are redacted before rendering.

| Argument | Required | Description |
|----------|----------|-------------|
| `--goal` | Yes | Natural-language goal passed to the team run. |
| `--team` | Yes | Path to JSON (see [Team file](#team-file)). |
| `--orchestrator` | No | Path to JSON merged into `new OpenMultiAgent(...)` after any orchestrator fragment from the team file. |
| `--coordinator` | No | Path to JSON passed as `runTeam(..., { coordinator })` (`CoordinatorConfig`). |
| `--dashboard` | No | Write a post-execution Run Viewer HTML to `oma-dashboards/runTeam-<timestamp>.html`; the output path and any dashboard-only warning go to stderr. |

Global flags: [`--pretty`](#output-flags), [`--include-messages`](#output-flags).

### `oma dashboard`

Exports exactly one existing `FileTraceStore` run without invoking a model,
coordinator, agent, tool, or OpenTelemetry provider:

```bash
oma dashboard \
  --trace-store ./.oma/traces.ndjson \
  --run-id <runId> \
  [--output ./oma-dashboards/run.html] \
  [--pretty]
```

`--trace-store` and `--run-id` are required. The source file must already
exist. The command opens it with the documented `FileTraceStore` recovery
rules, reads one run with its records, renders the Viewer, and closes the store
on both success and failure. It does not append, delete, compact, or apply
retention.

Without `--output`, the CLI creates a timestamped file under
`oma-dashboards/`. An explicit destination is never overwritten: an existing
file returns `dashboard_output_exists` with exit code 2.

### `oma task`

Runs **`OpenMultiAgent.runTasks(team, tasks)`** with a fixed task list (no coordinator decomposition).

| Argument | Required | Description |
|----------|----------|-------------|
| `--file` | Yes | Path to [tasks file](#tasks-file). |
| `--team` | No | Path to JSON `TeamConfig`. When set, overrides the `team` object inside `--file`. |

Global flags: [`--pretty`](#output-flags), [`--include-messages`](#output-flags).

### `oma eval run`

Runs a versioned EvalSet against a user-supplied target, writes one or more
offline reports, and optionally applies a quality gate:

```bash
oma eval run --set ./evals/greetings.json --target ./evals/target.mjs \
  [--scorers ./evals/scorers.mjs] \
  [--repeats 3] [--concurrency 2] [--tags smoke,regression] \
  [--report json] [--report markdown] [--report junit] \
  [--out ./eval-results] [--meta prompt_version=v2] \
  [--gate ./evals/gate.json] [--baseline ./evals/baseline.json] [--pretty]
```

`--set` and `--target` are required. The EvalSet file is parsed as JSON and
validated by the same `defineEvalSet()` contract used by the TypeScript API.
`--repeats`, `--concurrency`, and `--tags` override the matching runner
options. Repeat `--meta key=value` to attach string metadata to every record.

The target path is dynamically imported as an ES module. Its default export is
either an `EvalTarget` function or an object containing `{ target, scorers? }`:

```js
const target = async (input) => ({ output: String(input).toUpperCase() })

const exact = {
  name: 'exact',
  score({ output, evalCase }) {
    const pass = output === evalCase.expected
    return { score: pass ? 1 : 0, pass }
  },
}

export default { target, scorers: [exact] }
```

When `--scorers` is set, that ES module must default-export a `Scorer[]`.
Explicit scorers are appended to any embedded scorers. Every scorer name must
be unique, and an evaluation with no scorers is a usage error. Dynamic import
executes the supplied modules with the current process permissions; only load
code you trust. The CLI does not sandbox target or scorer modules.

Reference factories such as `toolCallSuccessScorer()`,
`costBudgetScorer()`, and `createAnswerRelevancyScorer()` can be imported from
`@open-multi-agent/core/eval` inside either module. Version custom and judge
scorers so baseline drift warnings remain actionable.

Repeat `--report` to request any combination of `json`, `markdown`, and
`junit`; JSON is the default. The output root defaults to `./eval-results`.
Every invocation writes into `<out>/<evalRunId>/`, using `report.json`,
`report.md`, and `report.junit.xml` respectively. JSON is the authoritative
`EvalRunReport` representation. Markdown contains human-readable aggregates
and failure details. JUnit maps `pass: false` to `<failure>` and target/scorer
errors to `<error>`.

A completed evaluation without `--gate` exits 0 even when it contains low or
failing scores. With `--gate`, the CLI loads a validated `GatePolicy`, applies
threshold, scorer/target-health, and optional baseline-regression checks, adds
`verdict` and `verdictPath` to the stdout summary, and writes the exact verdict
to `<out>/<evalRunId>/verdict.json`. A failed gate or every selected target
failing exits 1. File, module, argument, and contract errors exit 2.

`--baseline` loads a prior JSON `EvalRunReport` and requires `--gate`. A policy
with baseline rules but no `--baseline` still runs threshold and health checks,
then reports a warning that regression checks were skipped.

### `oma eval gate`

Applies a gate to an existing authoritative JSON report without rerunning the
target:

```bash
oma eval gate --report ./candidate/report.json --gate ./evals/gate.json \
  [--baseline ./evals/baseline.json] [--pretty]
```

`--report` and `--gate` are required. The command prints the exact
`GateVerdict` JSON (`pass`, `failures`, and `warnings`) to stdout. It exits 0
when the verdict passes, 1 when it fails, and 2 when a report, policy, baseline,
or argument is invalid. See [Evaluation](evaluation.md#gate-quality-in-ci) for
the GatePolicy reference, baseline workflow, deterministic gate example, and
GitHub Actions wiring.

### `oma provider`

Read-only helper for wiring JSON configs and env vars.

- **`oma provider`** or **`oma provider list`** — Prints JSON: built-in provider ids, API key environment variable names, whether `baseURL` is supported, and short notes (e.g. OpenAI-compatible servers, Copilot in CI).
- **`oma provider template <provider>`** — Prints a JSON object with example `orchestrator` and `agent` fields plus placeholder `env` entries. `<provider>` is one of: `anthropic`, `azure-openai`, `openai`, `gemini`, `grok`, `minimax`, `mimo`, `deepseek`, `doubao`, `qiniu`, `copilot`, `bedrock`.

For OpenRouter, use the `openai` provider template, set `baseURL` to `https://openrouter.ai/api/v1`, and set `apiKey` from `OPENROUTER_API_KEY` in your JSON config.

Supports `--pretty`.

### `oma`, `oma help`, `oma -h`, `oma --help`

Prints usage text to stdout and exits **0**.

---

## Configuration files

Shapes match the library types `TeamConfig`, `OrchestratorConfig`, `CoordinatorConfig`, and the task objects accepted by `runTasks()`.

### Team file

Used with **`oma run --team`** (and optionally **`oma task --team`**).

**Option A — plain `TeamConfig`**

```json
{
  "name": "api-team",
  "agents": [
    {
      "name": "architect",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "systemPrompt": "You design APIs.",
      "tools": ["file_read", "file_write"],
      "maxTurns": 6
    }
  ],
  "sharedMemory": true
}
```

**Option B — team plus default orchestrator settings**

```json
{
  "team": {
    "name": "api-team",
    "agents": [{ "name": "worker", "model": "claude-sonnet-4-6", "systemPrompt": "…" }]
  },
  "orchestrator": {
    "defaultModel": "claude-sonnet-4-6",
    "defaultProvider": "anthropic",
    "maxConcurrency": 3
  }
}
```

Validation rules enforced by the CLI:

- Root (or `team`) must be an object.
- `team.name` is a non-empty string.
- `team.agents` is a non-empty array; each agent must have non-empty `name` and `model`.

Any other fields are passed through to the library as in TypeScript.

**SDK-only fields**: `sharedMemoryStore` (custom `MemoryStore` instance) cannot be set from JSON since it is a runtime object. Use `sharedMemory: true` for the default in-memory store, or wire a custom store in TypeScript via `orchestrator.createTeam()`.

### Tasks file

Used with **`oma task --file`**.

```json
{
  "orchestrator": {
    "defaultModel": "claude-sonnet-4-6"
  },
  "team": {
    "name": "pipeline",
    "agents": [
      { "name": "designer", "model": "claude-sonnet-4-6", "systemPrompt": "…" },
      { "name": "builder", "model": "claude-sonnet-4-6", "systemPrompt": "…" }
    ],
    "sharedMemory": true
  },
  "tasks": [
    {
      "title": "Design",
      "description": "Produce a short spec for the feature.",
      "assignee": "designer"
    },
    {
      "title": "Implement",
      "description": "Implement from the design.",
      "assignee": "builder",
      "dependsOn": ["Design"]
    }
  ]
}
```

- **`dependsOn`** — Task titles (not internal ids), same convention as the coordinator output in the library.
- Optional per-task fields: `memoryScope` (`"dependencies"` \| `"all"`),
  `dependencyPayload` (`"output"` \| `"structured"` \| `"both"`), `role`,
  `priority`, bounded `metadata`, `maxRetries`, `retryDelayMs`, and
  `retryBackoff`. `dependencyPayload` defaults to raw output; structured modes
  require a validated upstream structured result and enforce the same 64 KiB
  per-dependency limit as the SDK. Task metadata follows the bounds and
  credential-redaction rules in
  [Task scheduling and dispatch](task-scheduling.md#task-role-and-provenance-metadata).
  When retry is enabled (`maxRetries > 0`), backoff is jittered and
  provably-terminal failures — 4xx client errors other than 408/409/429, plus
  token-budget and invalid-message errors — skip retries automatically; no
  extra config.
- **`tasks`** must be a non-empty array; each item needs string `title` and `description`.

If **`--team path.json`** is passed, the file’s top-level `team` property is ignored and the external file is used instead (useful when the same team definition is shared across several pipeline files).

### Orchestrator and coordinator JSON

These files are arbitrary JSON objects merged into **`OrchestratorConfig`** and **`CoordinatorConfig`**. Function-valued options (`onProgress`, `onApproval`, `onTaskDispatch`, etc.) cannot appear in JSON and are not supported by the CLI.

Set `defaultCwd` on the orchestrator JSON, or `cwd` on individual agents/coordinator JSON, to choose the sandbox root for built-in filesystem tools. Paths passed to `file_read`, `file_write`, `file_edit`, `grep`, and `glob` must be absolute and resolve inside that root. When `defaultCwd` is omitted, the sandbox defaults to `<cwd>/.agent-workspace` (auto-created on first write). Pass the string `"<process.cwd()>"`-equivalent absolute path to widen it to the full working directory, or `null` to disable the sandbox. The `bash` tool is intentionally not covered — see `docs/tool-configuration.md` for the rationale and recommended posture.

---

## Output

### Stdout

Every invocation prints **one JSON document** to stdout, followed by a newline.

**Successful `run` / `task`**

```json
{
  "command": "run",
  "success": true,
  "goal": "Build a REST API with token auth",
  "tasks": [
    {
      "id": "task-1",
      "title": "Design the database schema",
      "assignee": "architect",
      "status": "completed",
      "dependsOn": []
    }
  ],
  "totalTokenUsage": { "input_tokens": 0, "output_tokens": 0 },
  "agentResults": {
    "architect": {
      "success": true,
      "output": "…",
      "tokenUsage": { "input_tokens": 0, "output_tokens": 0 },
      "toolCalls": [],
      "structured": null,
      "loopDetected": false,
      "budgetExceeded": false
    }
  }
}
```

`agentResults` keys are agent names. When an agent ran multiple tasks, the
library merges results; the CLI mirrors the merged `AgentRunResult` fields.
`taskResults` is also emitted when available, keyed by stable task ID with each
unmerged result. `--include-messages` applies to both indexes.

**Successful historical dashboard export**

```json
{
  "command": "dashboard",
  "runId": "run-01",
  "dashboard": "/absolute/path/to/oma-dashboards/run-2026-07-18.html"
}
```

**Successful offline evaluation**

```json
{
  "command": "eval",
  "subcommand": "run",
  "evalRunId": "eval_run_...",
  "caseCount": 2,
  "repeats": 1,
  "targetErrors": 0,
  "scorers": [
    { "name": "exact", "avg": 1, "passRate": 1, "errorCount": 0 }
  ],
  "reports": {
    "json": "/workspace/eval-results/eval_run_.../report.json"
  }
}
```

**Errors (usage, validation, I/O, runtime)**

```json
{
  "error": {
    "kind": "usage",
    "message": "--goal and --team are required"
  }
}
```

For existing commands, `kind` remains one of `usage`, `validation`, `io`,
`runtime`, or `internal`. Dashboard export additionally uses stable categories
such as `trace_store_not_found`, `run_not_found`, `dashboard_output_exists`,
`trace_store_close_failed`, and lower-case `FileTraceStoreError` codes (for
example `corrupt_file`). Error messages never include trace payloads.

### Output flags

| Flag | Effect |
|------|--------|
| `--pretty` | Pretty-print JSON with indentation. |
| `--include-messages` | Include each agent’s full `messages` array in `agentResults`. **Very large** for long runs; default is omit. |

Dashboard paths and dashboard-only diagnostics go to stderr. There is no
separate progress stream; for live telemetry use the TypeScript API with
`onProgress` or `observability.sinks`.

---

## Exit codes

| Code | Meaning |
|------|---------|
| **0** | Success: `run`/`task` succeeded; dashboard export completed; eval completed without every target failing and any configured gate passed; or help / `provider` completed normally. Low eval scores alone still exit 0 when no gate is configured. |
| **1** | `run`/`task` reported failure, every selected eval target invocation failed, or an eval gate failed. |
| **2** | Usage, validation, readable JSON errors, module-load errors, or file access issues (e.g. missing file). |
| **3** | Unexpected error, including typical LLM/API failures surfaced as thrown errors. |

In scripts:

```bash
npx oma run --goal "Summarize README" --team team.json > result.json
code=$?
case $code in
  0) echo "OK" ;;
  1) echo "Run reported failure — inspect result.json" ;;
  2) echo "Bad inputs or files" ;;
  3) echo "Crash or API error" ;;
esac
```

---

## Argument parsing

- Long options only: `--goal`, `--team`, `--file`, etc.
- Values may be attached with `=`: `--team=./team.json`.
- `oma eval run` accepts repeated `--report` and `--meta` options in either attached or separate-value form. Gate, baseline, and report-file options accept one path each.
- Boolean-style flags (`--pretty`, `--include-messages`) take no value; if the next token does not start with `--`, it is treated as the value of the previous option (standard `getopt`-style pairing).

---

## Limitations (by design)

- No TTY session, history, or `stdin` goal input.
- No dedicated flag for the filesystem sandbox root; configure it through `defaultCwd` / `cwd` in the orchestrator or agent JSON.
- No **`onApproval`** or **`onTaskDispatch`** from JSON; CLI runs are non-interactive.
- Coordinator **`runTeam`** path still requires network and API keys like any other run.
