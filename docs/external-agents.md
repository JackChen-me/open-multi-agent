# External Agents

OMA can orchestrate **external agents that run as local processes** alongside its
LLM-backed agents. Two backend kinds are built in:

- `process` starts a generic local command for each agent run, sends the prompt by
  stdin or argument, and maps stdout/stderr/exit status into a normal agent result.
- `acp` drives a coding agent over the
  [Agent Client Protocol (ACP)](https://agentclientprotocol.com) — a
  JSON-RPC-over-stdio standard implemented by Gemini CLI, Claude Code, Codex, and
  others.

An external agent is a first-class team member: it sits in the same task DAG,
writes to the same shared memory, cascades failure to its dependents, and returns
the same result shape as any LLM agent. The motivating shape is a **hybrid team**
— an LLM planner decomposes the goal, an external coding agent writes the code,
an LLM reviewer audits the diff — all in one `runTeam` / `runTasks` call.

## Quick start

Declare an agent with `backend` instead of a model. Everything else about the team
is unchanged:

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent({ defaultModel: 'claude-sonnet-4-6', defaultProvider: 'anthropic' })

const team = oma.createTeam('hybrid-dev', {
  name: 'hybrid-dev',
  agents: [
    { name: 'planner',  systemPrompt: 'Break the task into a short plan. Do not write code.' },
    {
      name: 'coder',
      systemPrompt: 'Writes and edits code by running an external coding CLI.',
      backend: {
        kind: 'process',
        command: 'node',
        args: ['scripts/code-agent.js'],
        cwd: process.cwd(),
      },
    },
    { name: 'reviewer', systemPrompt: 'Review the change and summarize risks. Do not edit files.' },
  ],
  sharedMemory: true,
})

const result = await oma.runTeam(team, 'Add a slugify() utility with tests, then review it.')
```

The coordinator routes the coding work to `coder` based on its roster description; the
subprocess does the file edits; `reviewer` then reads the result from shared memory.

A runnable `process` version is at
[`examples/integrations/external-agent-process.ts`](../packages/core/examples/integrations/external-agent-process.ts).
A runnable ACP version is at
[`examples/integrations/external-agent-acp.ts`](../packages/core/examples/integrations/external-agent-acp.ts).

## Installation

The `process` backend has no extra dependencies. It uses Node's built-in child
process APIs and starts whatever local command you configure.

ACP support requires the optional peer dependency, loaded lazily so it never affects
consumers that don't use ACP:

```bash
npm install @agentclientprotocol/sdk
```

You also need an ACP-speaking agent. Set the backend's `command` / `args` to launch
it — any ACP agent works. Common choices:

| Agent | `command` / `args` | Notes |
|-------|--------------------|-------|
| **Claude Code** | `npx -y @agentclientprotocol/claude-agent-acp` | Official [Claude Agent SDK adapter](https://github.com/agentclientprotocol/claude-agent-acp) (Claude Code has no native ACP). Auth via `ANTHROPIC_API_KEY`. |
| Gemini CLI | `gemini --acp` | Native ACP. Note: Google is reportedly retiring the free-tier Gemini CLI (and its `--experimental-acp` flag) — verify availability before relying on it. |
| Codex | `codex-acp` (or `codex --experimental-acp`) | Experimental ACP support. |

The ACP examples in this guide use Claude Code, which fits OMA's Anthropic-centric
default and needs only one key (`ANTHROPIC_API_KEY`) for the whole team.

## Configuration

`AgentConfig.backend` takes an `ExternalAgentBackendConfig` discriminated union:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `kind` | `'process' \| 'acp'` | — | Backend discriminant. |
| `command` | `string` | — | Executable to spawn (`'npx'`, `'gemini'`, …). |
| `args` | `string[]` | `[]` | Arguments passed to `command`. |
| `env` | `Record<string,string>` | — | Extra env vars, merged over `process.env`. |
| `cwd` | `string` | `process.cwd()` | Working directory for the subprocess. |
| `input` | `'stdin' \| 'argument' \| 'none'` | `'stdin'` | `process` only: how to pass the prompt to the command. |
| `permission` | `'auto-approve' \| 'reject' \| fn` | `'auto-approve'` | `acp` only: how to answer permission prompts (below). |

When `backend` is set, the LLM-specific fields (`model`, `provider`, `adapter`,
sampling, `tools`, context strategy) do not apply — the external agent runs its own
loop, and `model` becomes optional. The agent's `systemPrompt` is the exception: it
still shapes the external agent because OMA — lacking any ACP system-prompt field —
prepends it to the agent's first prompt (once per session), on top of seeding the
coordinator's routing as it does for every agent.

External backends have a text transport boundary. Their public Agent APIs accept
the existing string form, but reject structured `LLMMessage[]` / `ContentBlock[]`
arguments with `InvalidMessageError` before spawning a process or opening an ACP
session. This avoids silently dropping image blocks or caller-owned history.
`beforeRun.prompt` remains supported; changing `beforeRun.messages` is rejected
for the same reason. `AgentConfig.history` does not seed a process or ACP
session; it restores messages only for LLM-backed `prompt()` conversations. See
[Structured Agent Input](structured-input.md).

For `process`, OMA starts a fresh subprocess per run. Use `input: 'stdin'` for
commands that read a prompt from stdin, `input: 'argument'` when the command
expects the prompt as the final argument, and `input: 'none'` for fixed adapters
that derive their work from files or environment.

### ACP permissions

ACP agents ask the client to approve sensitive tool calls (editing a file, running a
command). Because OMA runs agents autonomously inside a DAG, the default is
`'auto-approve'` (it picks the least-privilege `allow_once` when offered, otherwise
`allow_always`). Tighten it as needed:

```typescript
backend: {
  kind: 'acp',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  // Reject everything…
  permission: 'reject',
  // …or decide per request.
  permission: (req) => req.kind !== 'delete' && !req.title.includes('rm -rf'),
}
```

The callback receives a minimal, SDK-agnostic `{ title, kind, optionKinds }` and returns
`true` to approve / `false` to reject.

> **Security.** Unlike OMA's filesystem-tool sandbox, external backends access
> `cwd` directly — they are local subprocesses with your permissions. Scope `cwd`
> to a project you trust the backend with. ACP backends can use `permission` to
> gate protocol permission prompts; process backends do not have protocol-level
> permission prompts, so constrain the configured command, args, env, and cwd.
> `egressPolicy` governs enforceable framework-owned LLM requests only; it does
> not constrain network calls made by process or ACP children. See the
> [egress enforcement matrix](egress-policy.md#enforcement-matrix).

## How it works

Both built-in backends implement the same `AgentBackend` interface (`run` +
`stream`) that `AgentRunner` already implements. The pool, scheduler, task queue,
shared memory, and budget aggregation can therefore treat an external agent like
an LLM agent, with no special cases.

### Process backend

The `process` backend starts a fresh subprocess for each run. It joins the
configured `systemPrompt` and user prompt, passes the result to the command, and
maps process outcomes as follows:

| Process outcome | Maps to |
|-----------------|---------|
| stdout + exit `0` | success; stdout becomes `result.output` |
| stderr + exit `0` | success; stderr is ignored unless the process writes it into stdout |
| exit code / signal | task failure; stderr is redacted and included in the error output |
| caller abort | cancellation; the child process is killed |
| no token signal | `tokenUsage` is `{0, 0}` |

Use this backend for simple local CLIs, scripts, or adapters that do not need a
long-lived agent protocol.

### ACP backend

OMA takes the ACP **client** role. On the first run for an agent it spawns the
subprocess, frames its stdio as newline-delimited JSON-RPC, `initialize`s, and opens a
`session/new` in `cwd`. Each `agent.run(prompt)` then sends one `session/prompt` turn
and drains `session/update` notifications into a normal agent result:

| ACP update / stop | Maps to |
|-------------------|---------|
| `agent_message_chunk` (text) | streamed `text` deltas + the result's `output` |
| `tool_call` / `tool_call_update` | entries in `result.toolCalls` |
| `usage_update` (`used`) | `result.tokenUsage` (see caveat) |
| stop `end_turn` | success |
| stop `max_tokens` / `max_turn_requests` | success with `budgetExceeded` (stopped early) |
| stop `refusal` | task failure (cascades to dependents) |
| stop `cancelled` | returns partial output (from an abort) |

### ACP token accounting caveat

ACP reports a single **context-token** figure (`usage_update.used` — "tokens
currently in context"), not an input/output split, and it is *cumulative* across a
session, not a per-turn delta. Because OMA reuses one session across an agent's
turns, it records each turn's usage as the **increment** since the previous reading
and stores it as `tokenUsage.input_tokens` (with `output_tokens: 0`) — so summing
across turns telescopes to the latest figure instead of double-counting. That total
aggregates into the run and honors `maxTokenBudget`. An agent that emits no
`usage_update` reports `{0, 0}` and is therefore **not** budget-gated — size the
budget on LLM agents, or bound the ACP agent with its own `--max-*` flags.

On a Hybrid `runTeam()` Single short circuit, semantic-profiler usage is charged
before the external backend starts. The backend's reported usage is then added
at the run boundary, so an ACP usage delta can exhaust the remaining run budget.
The process backend continues to contribute `{0, 0}` because it has no token
signal.

## Control boundary

An external agent is a first-class team member at the orchestration layer and
an opaque subprocess below it. The split is structural rather than a policy
choice: when `AgentConfig.backend` is set, the agent resolves to the external
backend and never constructs an `AgentRunner`, and the runner is where the tool
registry, the tool executor, the filesystem sandbox, the context strategy, and
the per-turn journal emission all live. Everything the orchestrator does around
a task still happens; everything the runner does inside one does not.

**Still applies.** These are enforced above the backend and are
backend-agnostic:

| Control | Where it acts |
|---|---|
| Task DAG placement, dependency ordering, and failure cascade to dependents | Task queue and scheduler; a failed external task skips its dependents like any other |
| `onPlanReady`, `onApproval`, and `onTaskDispatch` gates | Orchestration level, so the assignee's backend kind is irrelevant to them. `onTaskDispatch` in particular runs immediately before dispatch and before the backend is resolved, so rejecting it means the subprocess is never spawned |
| Token budget | The backend's reported usage aggregates into the run and is checked against `maxTokenBudget`. Read the [accounting caveat](#acp-token-accounting-caveat) first: an ACP agent that emits no `usage_update`, and every process-backend agent, contributes `{0, 0}` and is therefore not budget-gated in practice |
| Shared memory | The orchestrator writes the completed task's output to shared memory under `task:<id>:result` after the task finishes |
| Run and task journal events | `run/start`, `run/end`, `plan/set`, `task/status`, `memory/set`, `approval/request`, `approval/decision`, and `checkpoint/saved` are emitted by the orchestrator and task-execution layers |
| Abort propagation | `RunOptions.abortSignal` reaches both backends. The process backend kills the child's process tree. The ACP backend sends `session/cancel` and relies on the agent to stop, so cancellation there is cooperative and the subprocess stays alive for the next turn |
| Process stderr redaction | A non-zero exit or signal builds its error message through the shared credential redactor, so stderr is scrubbed before it reaches the task result |

**Does not apply.** None of these reach an external backend, and no
configuration makes them:

| Control | Why not |
|---|---|
| `onToolCall` per-call gate | The gate is evaluated by the tool executor inside `AgentRunner`. An external agent's tool calls never pass through it. ACP `tool_call` updates still populate `result.toolCalls`, but that is reporting, not a gate |
| Filesystem sandbox | `AgentConfig.cwd` scopes the built-in filesystem tools through that same runner. A backend's `cwd` is a plain working directory the subprocess reads and writes directly, with your process's permissions |
| `egressPolicy` | Scoped to framework-owned LLM requests. External backends and tool code are outside it by design, and the child owns its own network behavior. See the [egress enforcement matrix](egress-policy.md#enforcement-matrix) |
| Tool-level journal events | `turn/start`, `turn/end`, `user/message`, `assistant/message`, `llm/request`, `tool/call`, `tool/result`, and `context/replace` are emitted only by the runner. Neither backend reads the journal recorder it is handed, so a journaled run records that an external task ran, not what happened inside it |
| Mid-task checkpoints | Neither backend calls the runner checkpoint hook, so an external task checkpoints at task boundaries only. A `suspend` tool decision fails closed there; see [durable approvals](durable-approvals.md#explicit-limits) |

**ACP permissions default to auto-approve.** `permission` defaults to
`'auto-approve'`, so unless the application sets it, every permission prompt
the agent raises is answered yes. OMA picks the least-privilege option offered
(`allow_once` before `allow_always`), which bounds the blast radius of one
decision but does not change the default answer. `'reject'` or a callback is
the only way to make a permission prompt a real gate. The process backend has
no protocol-level permission prompts at all, so the configured `command`,
`args`, `env`, and `cwd` are the entire control surface.

## Programmatic API

Most users only touch `backend`. To construct a backend directly, import from the
matching subpath:

```typescript
import { createAcpBackend } from '@open-multi-agent/core/acp'
import { createProcessBackend } from '@open-multi-agent/core/process'

const processBackend = createProcessBackend({ command: 'node', args: ['agent.js'] })
const processResult = await processBackend.run([{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }])

const backend = createAcpBackend({ command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] })
const result = await backend.run([{ role: 'user', content: [{ type: 'text', text: 'refactor foo.ts' }] }])
await backend.dispose() // close the connection and kill the subprocess
```

## v1 scope

What this release does **not** do yet (open an issue with a real use case to pull any
of these forward):

- **Client role only.** OMA drives external agents; it does not expose OMA agents *as*
  an ACP agent to editors.
- **No `fs/*` proxying.** The agent does its own filesystem access within `cwd`; OMA
  does not yet proxy ACP file operations through its sandbox. Agents that require the
  client to serve files are not supported.
- **Process backend is stateless.** It starts one subprocess per run and maps stdout
  to output. Use ACP or a custom backend when you need sessions, structured tool
  events, or protocol-level permission prompts.
- **No cost-based budgets.** Budgeting is token-based; `usage_update.cost` is ignored.
- **ACP subprocess lifetime.** An orchestrated ACP agent's subprocess lives until the
  process exits (there is no per-agent disposal hook in `runTeam` / `runTasks`).
  Use the programmatic API + `dispose()` when you need explicit teardown.
