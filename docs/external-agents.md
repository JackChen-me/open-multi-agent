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
