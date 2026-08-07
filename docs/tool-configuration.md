# Tool Configuration

Agents can be configured with fine-grained tool access control using presets, allowlists, and denylists.

## Declared governance roles in `runTeam()`

Tool and credential boundaries are often tied to named agents. When a goal must actually pass through specific roster roles, declare the topology structurally on the `runTeam()` call:

```typescript
const result = await orchestrator.runTeam(team, 'Review this change before release.', {
  governanceIntent: 'required',
  requiredRoles: ['reviewer', 'security'],
  requiredOrder: ['reviewer', 'security'],
})

if (result.governanceConclusion !== 'satisfied') {
  throw new Error('Required governance was not satisfied by the executed topology.')
}
```

For both `required` and `preferred`, OMA skips coordinator decomposition and the simple-goal single-agent short circuit. It creates one task for every `requiredRoles` entry, keeps each task assigned to that roster agent, and uses `requiredOrder` to create dependency edges. Each task receives the original goal unchanged; the agent's `systemPrompt`, tools, and credentials define the role. Downstream tasks receive prerequisite outputs through dependency-scoped memory.

The goal text is not inspected to choose this topology. The same declaration therefore produces the same roles and dependency order for English, Chinese, or any other language. Every `requiredRoles` name must exist in the team roster, and `requiredOrder`, when present, must be a permutation of those roles. Invalid declarations throw before any agent runs.

When `planOnly: true` is combined with `governanceIntent: 'required'` or
`'preferred'`, `planOnly` wins: OMA validates and returns the declared role DAG
with every task pending, but runs neither the coordinator nor task agents. The
result reports `governanceConclusion: 'not-applicable'` until that plan is
executed, for example through `runFromPlan()`.

Use `governanceIntent: 'none'` to opt into automatic `runTeam()` routing
explicitly. Omitting `governanceIntent` does the same. This route is
deterministic by default and makes no semantic profile call. Hybrid semantic
routing is opt-in: set `executionRouting: { strategy: 'hybrid' }` to let a
deterministic Single candidate be upgraded after one semantic profile call. See
[execution routing](execution-routing.md).

After execution, required declarations are checked against the execution
receipt. The `governanceConclusion` value is `satisfied`, `unsatisfied`, or
`not-applicable`. `required` is the only enforced intent;
`preferred`, `none`, and an omitted intent return `not-applicable`. An
`unsatisfied` conclusion means that a required role, dependency path/order, or
independent review fact was not observed. It does not rewrite `result.success`,
which keeps its existing runtime-error meaning, so governance-sensitive callers
must check `governanceConclusion` explicitly.

The gate reads only the structured execution topology produced by
`buildExecutionReceipt()`. Agent answer text cannot prove that another role ran
or that an independent review occurred, even if it contains reviewer names,
approval labels, or audit markers.

### Explicit modes and budget conflicts

`runTeam()` resolves execution policy in this order:

1. An application `mode` (`single` or `team`).
2. A declared `governanceIntent` topology or `preferredUnderBudget` policy.
3. A custom [Execution Router](execution-routing.md) for automatic routing.
4. The built-in `DeterministicRouter`.
5. The semantic Profiler and deterministic policy, only for a default/fallback
   Single candidate.

`single` always uses the existing best-agent path. `team` forces the
coordinator-generated team path and bypasses the simple-goal short circuit.
`runAgent()` and `runTasks()` remain explicit choices in their own right.
Selecting `mode` declares a topology preference, not governance intent, so it
does not bypass consequential confirmation when `governanceIntent` is omitted.
Routers follow the same boundary: they choose execution topology but do not
declare governance or override structured role requirements. A TaskProfile is
also inferred routing evidence only. If inferred side-effect or isolation needs
intersect with actual consequential grants or multiple caller-declared
`AgentConfig.permissionBoundary` values, OMA raises
`ROUTING_DECLARATION_REQUIRED` before any model or tool execution.

An application may select a mode that overrides a required floor, but that
decision is never reported as a clean governance success:

```typescript
const result = await orchestrator.runTeam(team, goal, {
  mode: 'single',
  governanceIntent: 'required',
  requiredRoles: ['reviewer', 'security'],
  requiredOrder: ['reviewer', 'security'],
})

// The Single result is still returned, and runtime success keeps its existing meaning.
result.governanceConclusion // 'unsatisfied'
result.governanceReason     // 'overridden'
result.flags                // includes 'governance-overridden'
```

This is the "floor may be explicitly overridden, but never silently" rule.
The structured declaration is still validated before execution, even when an
explicit mode displaces its topology.

Token and cost ceilings can be set on the orchestrator or on one `runTeam()` /
`runTasks()` call. A per-run value cannot widen the orchestrator ceiling; the
lower value wins. This lets an application declare the governance floor and
budget ceiling together without introducing another budget subsystem:

```typescript
const result = await orchestrator.runTeam(team, goal, {
  governanceIntent: 'required',
  requiredRoles: ['reviewer', 'security'],
  requiredOrder: ['reviewer', 'security'],
  maxTokenBudget: 12_000,
  maxCostBudget: 0.25, // requires orchestrator estimateCost
})
```

If a required run exhausts that ceiling before every required role/order fact
is observed, the existing budget stop remains in force and the result reports
`governanceConclusion: 'unsatisfied'` with `governanceReason: 'budget'`.
`result.success` is not repurposed as a governance field; budget exhaustion
continues to use the existing `budget_exhausted` runtime status.

For a soft preference, the application can predeclare that a ceiling should
win without turning the missed review into a governance violation:

```typescript
const result = await orchestrator.runTeam(team, goal, {
  governanceIntent: 'preferred',
  requiredRoles: ['reviewer', 'security'],
  preferredUnderBudget: 'degrade',
  maxTokenBudget: 4_000,
})

// Executes the Single path and discloses why independent review was skipped.
result.governanceConclusion // 'not-applicable'
result.flags                // includes 'review-skipped-due-to-budget'
```

`preferredUnderBudget` defaults to `attempt`, which preserves the pre-existing
preferred-role behavior. `degrade` applies only when an effective token or cost
ceiling exists and no explicit `mode` already won. It is an application policy,
not a model-cost prediction: OMA intentionally does not estimate whether a plan
will fit before it runs. Normal ceiling enforcement remains reactive at model
turn and task boundaries.

## Consequential tools on undeclared runs

Tool authors can declare that granting a tool permits real side effects:

```typescript
const rotateSecret = defineTool({
  name: 'rotate_secret',
  description: 'Rotate an application secret.',
  inputSchema: z.object({ service: z.string() }),
  consequential: true,
  execute: async ({ service }) => rotateServiceSecret(service),
})
```

`consequential` is optional and defaults to `false`. The built-in `bash`,
`file_write`, and `file_edit` tools are marked consequential; read-only
filesystem tools are not. Custom and MCP tools remain benign unless their
registered `ToolDefinition` explicitly opts in.

For `runAgent()` and an automatic `runTeam()` call that omits
`governanceIntent`, OMA checks the final grant set after preset, allowlist,
denylist, custom-tool, and default-preset resolution. If at least one granted
tool is consequential, the result carries the additive machine-readable flag:

```typescript
if (result.flags?.includes('consequential-no-independence')) {
  // The run had consequential capability without a governance declaration.
}

const receipt = buildExecutionReceipt(result)
// The same flag is copied to receipt.flags.
```

This classification uses **tool grants only**. OMA never scans the goal,
prompt, model output, tool arguments, or words such as `password`, `refund`,
`security`, or `production` to infer consequences. A goal containing those
words but exposing only benign tools is not flagged. Conversely, a granted
consequential tool is flagged even when the goal sounds harmless.

Declared `required`, `preferred`, and `none` `runTeam()` calls do not enter this
fallback. Neither do explicit `runTasks()` DAGs or `runFromPlan()` replays;
those calls already have application-supplied structure. The fallback never
changes the execution topology or upgrades a run to independent governance.

### Opt-in confirmation

Confirmation is off by default. Set `requireConsequentialConfirmation: true`
to guard consequential calls on the undeclared runs above:

```typescript
const orchestrator = new OpenMultiAgent({
  requireConsequentialConfirmation: true,
  onToolCall: async (context) => {
    if (context.consequential !== true) return { action: 'allow' }
    return (await app.confirm(context))
      ? { action: 'allow' }
      : { action: 'deny', reason: 'User rejected the action.' }
  },
})
```

The guard composes with the existing per-call `onToolCall` gateway, after input
validation and before `execute`. An `allow` continues; a `deny` returns an error
`ToolResult` without calling the tool. Inside a checkpointed task, `suspend` can persist the exact invocation
for an out-of-process decision and later `restore()`; see
[durable approvals](durable-approvals.md). For a dynamically planned
`runTeam()`, an approved `onPlanReady` callback can supply the approval when no
per-call gate is configured. If neither approval path exists, the tool is not
executed and the result returns `confirmationRequired: true` with
`status.code === 'rejected'`. The application can then re-run with an
`onToolCall` decision, or reject the action. The
`consequential-no-independence` flag remains present whether confirmation is
disabled, approved, pending, or rejected.

## Built-in tools are opt-in (default-deny)

Built-in tools — `bash` and the filesystem tools (`file_read`, `file_write`, `file_edit`, `grep`, `glob`) — are **default-deny**. An agent receives a built-in tool only when it is granted explicitly via `tools` (an allowlist of names) or `toolPreset`. An agent that sets **neither** resolves to **zero** built-in tools:

```typescript
// No tools / toolPreset → this agent cannot run bash or touch the filesystem.
const llmOnly: AgentConfig = { name: 'writer', model: 'claude-sonnet-4-6' }

// Opt in explicitly.
const coder: AgentConfig = {
  name: 'coder',
  model: 'claude-sonnet-4-6',
  tools: ['file_read', 'file_write', 'bash'],
}
```

This holds uniformly across `runAgent`, `runTeam` / `runTasks`, the `runTeam` simple-goal short-circuit, and a standalone `Agent`. Calling `registerBuiltInTools()` makes tools _available to grant_ — it does not grant them; the agent still needs `tools` / `toolPreset`. If the model emits a call to a registered-but-ungranted tool (a confused model, or text steered by prompt injection), the runner returns a clear `"not granted"` error instead of executing it.

**Two things stay true once a tool is granted — design around them:**

- **`bash` is not sandboxed.** Granting it gives the agent arbitrary shell on the host (see [_Filesystem Working Directory_](#filesystem-working-directory) below). Only the filesystem tools are path-contained.
- **Tool output flows to your model provider.** Every tool result is appended to the conversation and sent to the configured LLM on the next turn. Anything a tool reads — file contents, command output, fetched pages — leaves your process and reaches the provider. Grant read access deliberately.

**Custom / runtime tools are exempt from the grant requirement** — registering them _is_ the grant. Tools passed via `customTools` or `agent.addTool()` are always available (they still respect `disallowedTools`); see [_Custom Tools_](#custom-tools). **`delegate_to_agent`** (team orchestration handoff) follows the default-deny rule like any other built-in: grant it with `tools: ['delegate_to_agent']` on each agent you want to be able to delegate.

### Restoring the previous "all tools" behavior

Before default-deny, an agent with no tool config received every registered built-in — including the unsandboxed `bash`. To restore that convenience in one line, set `defaultToolPreset` on the orchestrator:

```typescript
const orchestrator = new OpenMultiAgent({
  defaultToolPreset: 'full', // agents with no tools/toolPreset get the full preset
})
```

`defaultToolPreset` is a **fallback**: it applies only to agents that declare neither `tools` nor `toolPreset`. Per-agent config always overrides it, and it never widens an agent that already declares a grant. It is not applied to the internal coordinator, the final-synthesis pass, or the consensus proposer / judge agents (`runConsensus` and the per-task `verify` hook), which run from their own configs; grant tools to those per agent.

## Tool Presets

Predefined tool sets for common use cases:

```typescript
const readonlyAgent: AgentConfig = {
  name: 'reader',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readonly',  // file_read, grep, glob
}

const readwriteAgent: AgentConfig = {
  name: 'editor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',  // file_read, file_write, file_edit, grep, glob
}

const fullAgent: AgentConfig = {
  name: 'executor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'full',  // file_read, file_write, file_edit, grep, glob, bash
}
```

## Advanced Filtering

Combine presets with allowlists and denylists for precise control:

```typescript
const customAgent: AgentConfig = {
  name: 'custom',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',        // Start with: file_read, file_write, file_edit, grep, glob
  tools: ['file_read', 'grep'],   // Allowlist: intersect with preset = file_read, grep
  disallowedTools: ['grep'],      // Denylist: subtract = file_read only
}
```

**Resolution order:** default-deny (no preset _and_ no allowlist ⇒ zero built-in tools) → preset → allowlist → denylist → framework safety rails. Custom / runtime tools bypass the grant step (registration is the grant) but still honor the denylist.

## Capability-aware agent selection

`AgentConfig` can carry four optional, caller-declared selection signals:
`description` (a one-sentence role summary), `capabilities` (tags), `costTier`,
and `latencyClass`. Omitted fields stay unknown; OMA does not guess defaults
from the model, agent name, or system prompt.

Tasks supplied to `runTasks()` can declare hard requirements:

```typescript
const tasks: RunTaskSpec[] = [{
  title: 'Patch the parser',
  description: 'Implement and test the parser fix.',
  requires: {
    requiredTools: ['file_read', 'file_edit'],
    requiredCapabilities: ['typescript'],
    requiredBackend: 'llm',
    requiredProvider: 'anthropic',
  },
}]
```

The unified `AgentSelector` applies hard filters first, then ranks eligible
agents by declared capability affinity before falling back to the existing
multilingual keyword signal. `requiredTools` is checked against the exact
definitions returned by the same resolved-grant path used by execution.
Backend and provider checks use their structured configuration fields.
`requiredCapabilities` uses only the caller-declared tags.

Neither permissions nor capabilities are ever inferred from `systemPrompt` or
other prose. When no candidate satisfies the hard requirements, the selector
returns `NO_ELIGIBLE_AGENT`. Team and explicit-task execution validate the
complete plan before dispatch and fail with `INVALID_TASK_REQUIREMENTS`; no
scheduling strategy may fall back to an ineligible agent.

## Per-call gating with `onToolCall`

The layers above answer **"which tools are reachable?"** by operating on tool _names_. The `onToolCall` gate answers a different question one layer down: **"should _this specific invocation_ run right now?"** `bash` is a single allowed name that covers `ls -la` and `rm -rf /` equally; the gate inspects the actual arguments and can veto individual calls.

The hook is **opt-in and off by default**. It runs once per tool invocation, after Zod input validation and before the tool implementation, and returns a decision:

```typescript
import type { ToolCallContext, ToolCallDecision } from '@open-multi-agent/core'

const orchestrator = new OpenMultiAgent({
  // Orchestrator-level default, inherited by any agent that sets no gate of its own.
  onToolCall: async (ctx: ToolCallContext): Promise<ToolCallDecision> => {
    // ctx: { toolName, input (post-validation), agentName, consequential?, runId?, taskId?, toolCallId? }
    if (ctx.toolName !== 'bash') return { action: 'allow' }
    if (/^\s*rm\b/.test(String(ctx.input.command))) {
      return { action: 'deny', reason: 'rm is blocked' }
    }
    return { action: 'allow' }
  },
})
```

Key semantics:

- **`deny` returns a structured error `ToolResult`; it never throws.** The model sees the `reason` as a normal tool error and can adapt (try a safer command, ask the user, stop) rather than crashing the run. A gate that throws or returns an invalid decision is turned into an error result too (fail closed).
- **`suspend` is durable and returns control.** In a checkpointed built-in LLM task, `{ action: 'suspend' }` saves the exact invocation and returns a top-level `suspended` result. Record a decision with `decideApproval()`, then call `restore()`. Without a resumable checkpoint and atomic store, the call fails closed and the tool does not run. See [durable approvals](durable-approvals.md).
- **Inline human-in-the-loop still works.** `await` your own CLI prompt, Slack button, or web dialog, then return `allow` or `deny` in the same callback lifetime. The framework prescribes no review channel.
- **Agent overrides orchestrator.** `AgentConfig.onToolCall` beats `OrchestratorConfig.onToolCall` for that agent, so a team can set a default policy while one specialist tightens or relaxes it. A standalone `new Agent({ ..., onToolCall })` wires the gate straight into its executor.
- **Runs after the name-based grant.** Default-deny / allowlist / denylist resolution runs **first**; a tool that is not granted is refused before the gate is reached, so the gate only ever sees calls to already-reachable tools. Custom tools and MCP tools route through the same executor, so they are gated too.
- **The model-issued call ID is stable across recovery.** `toolCallId` identifies
  this invocation. If an uncommitted call must run again after checkpoint
  restore, it keeps the same ID; a committed result is replayed without running
  the gate or tool again. See [checkpoint recovery](checkpoint.md#mid-task-tool-recovery).
- **Orthogonal to task dispatch approval.** `OrchestratorConfig.onApproval` gates legacy task rounds and `onTaskDispatch` gates one ready task before dispatch; `onToolCall` gates a single tool invocation during execution. They operate at different layers and compose. The two task-level approval modes are mutually exclusive with each other.
- **Observability.** When a gate runs, the `tool_call` trace event carries `gated: true`, `gateAction: 'allow' | 'deny' | 'suspend'`, and an optional redacted `gateReason`. Durable decisions come from the approval ledger and may be summarized in an execution receipt; telemetry is not their source of truth.

> **Not a security boundary.** A gate that returns `deny` still relies on cooperating code; it is a coordination layer, not containment. `bash` remains un-sandboxed (see the callout below). For an actually-untrusted shell, use process-level isolation (a container / VM / seccomp); the gate is for *policy*, not *isolation*.

### Shell risk classifier

Writing regex tables by hand is tedious, so an optional, dependency-free classifier ships behind a subpath export. It scores a bash command as `safe | review | high`; you decide what each level means:

```typescript
import { classifyBashCommand } from '@open-multi-agent/core/classifiers'

const orchestrator = new OpenMultiAgent({
  onToolCall: async (ctx) => {
    if (ctx.toolName !== 'bash') return { action: 'allow' }
    const risk = classifyBashCommand(String(ctx.input.command))
    if (risk.level === 'safe') return { action: 'allow' }
    if (risk.level === 'high') return { action: 'deny', reason: risk.reason }
    // 'review' → ask a human
    return (await myUi.confirm(ctx, risk)) ? { action: 'allow' } : { action: 'deny', reason: risk.reason }
  },
})
```

- **`safe`**: read-only inspection (`ls`, `cat`, `pwd`, `grep`/`rg` with a path, `git status|log|diff|show`, ...).
- **`review`**: context-heavy or ambiguous: `ls -R`, `find /` / `find ~` without `-maxdepth`, `grep -r` / `rg -r` without a scoped path, `tree`, `du`, and any unrecognised command (default: "don't run blind").
- **`high`**: destructive / sensitive: `rm`, `sudo`, `curl ... | bash`, `dd`, `mkfs`, `chmod 777`/`-R`, `git push --force`, `npm publish`, writes to system paths.

Compound commands are segmented on shell separators (`&&`, `||`, `;`, `|`, substitutions) and the **highest** risk found wins, so a safe prefix cannot smuggle a destructive suffix (`ls && rm -rf /` becomes `high`). Quoted spans are stripped first, so `echo "rm -rf /"` stays `safe`.

The classifier is a **shallow heuristic, not a parser**; it can be fooled by obfuscation (variable indirection, base64-decode-then-exec, exotic quoting). It is convenience only: extend the tables, wrap it, or replace it entirely. See [`examples/patterns/risk-gated-bash.ts`](../packages/core/examples/patterns/risk-gated-bash.ts) for an end-to-end demo.

## Shell Executors

The granted `bash` built-in delegates command execution through a
`ShellExecutor`. With no executor configured, OMA uses `LocalShellExecutor`,
which preserves the existing `bash -c` behavior on the host:

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'
import type { AgentConfig } from '@open-multi-agent/core'
import type { ShellExecutor } from '@open-multi-agent/core/shell'

declare const sharedRemoteExecutor: ShellExecutor
declare const specialistExecutor: ShellExecutor

const orchestrator = new OpenMultiAgent({
  // Inherited by agents that do not set shellExecutor.
  defaultShellExecutor: sharedRemoteExecutor,
})

const agent: AgentConfig = {
  name: 'builder',
  model: 'claude-sonnet-4-6',
  tools: ['bash'],
  // Per-agent value wins over the orchestrator default.
  shellExecutor: specialistExecutor,
}
```

The executor changes **where an already-granted command runs**. It does not
grant `bash` or bypass `disallowedTools`; command execution still happens only
after `onToolCall` allows it. The existing default-deny and per-call gate rules
are unchanged. The tool wrapper also keeps the model-facing behavior uniform
across executors: input validation, the 30-second default timeout,
stdout/stderr formatting, output redaction, and
`isError` on a nonzero exit code.

The public type contract is available from `@open-multi-agent/core/shell` and
has no runtime imports:

```typescript
interface ShellExecutor {
  start?(): Promise<void>
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult>
  dispose?(): Promise<void>
}
```

`ShellExecOptions` contains `cwd`, `timeoutMs`, and `abortSignal`.
`ShellExecResult` contains `stdout`, `stderr`, and `exitCode`. Executors must
use exit code `124` for timeout, `130` for abort, and `127` when the process or
remote command could not be started. The tool wrapper adds a short deadline
backstop so an executor that ignores timeout or abort cannot stall the tool
loop indefinitely, but implementations still own prompt cancellation and
termination of the process, job, or remote session they control.

### Lifecycle and concurrent use

One executor instance represents one reusable session:

- OMA calls `start()` lazily, immediately before the first allowed `bash`
  execution in a run. A granted tool that is never called (or is denied by
  `onToolCall`) creates no session. Later shell calls in that run reuse it.
- OMA always attempts `dispose()` when the run succeeds, fails, is aborted, or
  a streaming consumer stops early. If `start()` partially allocates resources
  and then rejects, OMA attempts `dispose()` too.
- If overlapping runs share the same executor instance (as agents inheriting
  one `defaultShellExecutor` do), OMA reference-counts them: one `start()`, then
  one `dispose()` after the final run finishes. `exec()` may be called
  concurrently, including when one model turn requests multiple shell calls.
  An executor that cannot run commands concurrently must serialize internally;
  use distinct per-agent instances when each agent needs its own session.
- A process crash cannot execute JavaScript cleanup. Remote adapters should
  also configure a provider-side TTL, lease expiry, or out-of-band reaper for
  crash recovery.

These lifecycle calls belong to Agent/Orchestrator runs. If application code
invokes the low-level exported `bashTool.execute()` directly, that caller owns
`start()` / `dispose()` around its tool calls.

`LocalShellExecutor` is stateless. It keeps the existing safe environment
allowlist, captures stdout/stderr, runs the command in a separate process group
on POSIX, and kills the process tree on timeout or abort. It executes with the
host Node.js process's permissions: **it is not a sandbox or security
boundary**. A custom executor is only as isolated as the environment and
adapter implementation behind it; OMA does not ship Docker, VM, or hosted
sandbox adapters in core.

### Host and remote filesystems diverge

> **A remote shell executor does not move the built-in filesystem tools.**
> `file_read`, `file_write`, `file_edit`, `grep`, and `glob` still operate on
> the host inside `AgentConfig.cwd` / `defaultCwd`. The `cwd` passed to `bash`
> is interpreted inside the executor's environment. For example, `file_write`
> may create `report.md` in the host `.agent-workspace`, while a following
> remote `bash` call to `wc -l report.md` sees no such file. Unless the
> application provides its own synchronization layer, do not co-grant the
> host filesystem tools to a remote-shell agent, or explicitly design around
> the two separate filesystems.

Shell executors apply only inside the normal LLM runner tool loop. Process and
ACP agent backends replace that loop and continue to manage their own command
execution and `cwd`; `shellExecutor` does not affect them.

## Filesystem Working Directory

Built-in filesystem tools (`file_read`, `file_write`, `file_edit`, `grep`, `glob`) are sandboxed to a per-agent working directory. Paths must be absolute and resolve inside that directory; symlinks are resolved before the check so they cannot escape the configured root.

> **`bash` is not sandboxed.** Once an agent has a shell, any `cd /etc`, absolute path, or subshell trivially escapes a per-tool path check. The sandbox is therefore best understood as **path containment for built-in filesystem tools**, not a security boundary against arbitrary command execution. If full path containment matters, drop `bash` via `disallowedTools: ['bash']` (or omit it from your `tools` allowlist) and rely on the filesystem tools. Process-level isolation (containers, seatbelt, firejail) is the right tool for an actually-untrusted shell.

### Three typical configurations

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

// 1. Default — sandbox rooted at `<cwd>/.agent-workspace`.
//    The directory is auto-created on first write. Agents cannot read or
//    write outside that subdirectory, which keeps source files, `.env`,
//    `.git/`, and `node_modules` off-limits even when the host launched
//    from the repo root.
const defaultOrchestrator = new OpenMultiAgent()

// 2. Widen the sandbox to the entire current working directory.
//    Useful when the agent is a coding assistant operating on the user's
//    project (the host already established trust by launching there).
const wideOrchestrator = new OpenMultiAgent({
  defaultCwd: process.cwd(),
})

// 3. Disable the sandbox entirely (relative and absolute paths anywhere).
const unrestrictedOrchestrator = new OpenMultiAgent({
  defaultCwd: null,
})
```

### Custom sandbox root

```typescript
const orchestrator = new OpenMultiAgent({
  defaultCwd: '/var/run/my-agent-workspace', // any absolute path
})

const agent: AgentConfig = {
  name: 'editor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',
  cwd: '/var/run/my-agent-workspace/packages/app', // optional per-agent override
}
```

**Resolution order.** `AgentConfig.cwd` (if set) → `OrchestratorConfig.defaultCwd` (if set) → `<process.cwd()>/.agent-workspace`. Pass `null` at either level to disable the sandbox for that scope.

**Auto-creation.** The sandbox root is `mkdir -p`'d on first write, so callers do not need to pre-create `.agent-workspace` (or any custom path).

The default `LocalShellExecutor` runs `bash` in its own process group on POSIX,
so timeouts and abort signals kill any backgrounded children rather than
letting them outlive the parent. Custom executors own equivalent cleanup in
their execution environment.

## Custom Tools

Two ways to give an agent a tool that is not in the built-in set.

**Inject at config time** via `customTools` on `AgentConfig`. Good when the orchestrator wires up tools centrally. Tools defined here bypass preset/allowlist filtering but still respect `disallowedTools`.

```typescript
import { defineTool } from '@open-multi-agent/core'
import { z } from 'zod'

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Look up current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ data: await fetchWeather(city) }),
})

const agent: AgentConfig = {
  name: 'assistant',
  model: 'claude-sonnet-4-6',
  customTools: [weatherTool],
}
```

**Register at runtime** via `agent.addTool(tool)`. Tools added this way are always available, regardless of filtering.

## Per-agent tool credentials

A tool's `execute` closure often captures a secret — an API token, a service key. If several agents share that tool, they all wield the same secret at full scope: a compromised or misbehaving subagent inherits every credential the coordinator holds. To scope secrets per agent, set a `credentials` bag on `AgentConfig` and read it from `ToolUseContext` inside the tool, instead of closing over a module-level secret.

```typescript
const search = defineTool({
  name: 'web_search',
  description: 'Search the web.',
  inputSchema: z.object({ query: z.string() }),
  // Reads the calling agent's scoped key, not a shared module secret.
  execute: async ({ query }, ctx) => ({
    data: await callSearchApi(query, ctx.credentials?.SEARCH_API_KEY),
  }),
})

const team = {
  name: 'research',
  agents: [
    {
      name: 'researcher',
      model: 'claude-sonnet-4-6',
      customTools: [search],
      credentials: { SEARCH_API_KEY: process.env.RESEARCHER_SEARCH_KEY! },
    },
    {
      name: 'publisher',
      model: 'claude-sonnet-4-6',
      customTools: [cms], // a CMS tool defined like `search` above
      credentials: { CMS_TOKEN: process.env.PUBLISHER_CMS_TOKEN! },
    },
  ],
}
```

The bag is **per agent and never merged**: `researcher` sees only `SEARCH_API_KEY`, `publisher` sees only `CMS_TOKEN`, and neither the coordinator nor a delegated subagent inherits another agent's bag. An agent with no `credentials` set gets `ctx.credentials === undefined`.

This is a **scoping convenience, not an isolation boundary**. Tool code runs in-process and can still read `process.env` or any module-level variable; `credentials` just gives you a first-class place to hand each agent only the secrets it needs. (You can already approximate this by giving each agent its own `customTools` instance with a scoped closure — the `credentials` bag makes it explicit and keeps the secret out of the closure.) Values are treated as secrets: the `credentials` key is auto-redacted from traces and dashboards.

## Tool Output Control

Long tool outputs can blow up conversation size and cost. The following
validation and context controls compose with the rich-result contract.

**Validation (optional).** Add `outputSchema` to catch malformed tool results before they are forwarded:

> **Note — two different `outputSchema` fields.** The one on `defineTool()` /
> `ToolDefinition` (shown below) validates a single **tool's** `ToolResult.data`
> — string tools use `ZodSchema<string>`, while tools with application-owned
> object data can use the corresponding object schema. The `outputSchema` on
> [`AgentConfig`](../packages/core/examples/patterns/structured-output.ts)
> is different: it validates the **agent's final answer** as parsed JSON
> against an arbitrary Zod schema (see _Structured output_ in `packages/core/examples/`).
> Different scopes — pick the one that matches the layer you're working at.

```typescript
const jsonTool = defineTool({
  name: 'json_tool',
  description: 'Return JSON payload as string.',
  inputSchema: z.object({}),
  outputSchema: z.string().refine((value) => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }, 'Output must be valid JSON'),
  execute: async () => ({ data: '{"ok": true}' }),
})
```

### Rich image and file results

`ToolResult` separates the value your application keeps from the content sent
back to the model:

```typescript
const renderChart = defineTool({
  name: 'render_chart',
  description: 'Render a chart and return a preview.',
  inputSchema: z.object({ metric: z.string() }),
  outputSchema: z.object({ chartId: z.string(), storageKey: z.string() }),
  execute: async ({ metric }) => ({
    // Application-owned value: available to onToolResult; not serialized into
    // the model conversation.
    data: { chartId: 'chart-42', storageKey: `artifacts/${metric}.png` },

    // Model-visible value: validated and copied before it enters the transcript.
    modelOutput: [
      { type: 'text', text: `Preview for ${metric}` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: pngBytes.toString('base64'),
        },
      },
      {
        type: 'file',
        filename: 'report.pdf',
        source: {
          type: 'url',
          media_type: 'application/pdf',
          url: signedReportUrl,
        },
      },
    ],
  }),
})
```

Existing `{ data: 'plain text' }` tools are unchanged: when `modelOutput` is
omitted, the string in `data` follows the existing `maxOutputChars` behavior
and is sent to the model. A non-string `data` value requires `modelOutput`; OMA
never guesses a JSON serialization. Invalid content becomes a normal text error
`ToolResult` (`isError: true`) so the tool loop keeps its existing error
behavior. Error results remain text-only.

`modelOutput` is either a string or a non-empty array of `text`, `image`, and
`file` parts. Media sources are either raw base64 bytes (not a `data:` URL) or
an absolute HTTP(S) reference and must include a MIME type without parameters.
File parts also require a display filename. OMA defensively copies nested
content at the tool boundary and again before callbacks can affect the model
transcript; `data` remains application-owned and is not cloned.

Provider conversion is faithful or explicit—media is never silently dropped:

| Adapter family | Mapping | Deterministic local rejection |
|---|---|---|
| OpenAI Chat Completions, Azure OpenAI, Copilot, and built-in OpenAI-compatible adapters | Text stays in the `tool` message; attachments follow in a `user` message. Images accept inline data or URLs; files accept inline data. | File URL references. |
| Anthropic | Images stay in `tool_result`; PDF files are adjacent document blocks. Inline data and URLs are accepted for those mapped types. | Unsupported image MIME types and non-PDF files. |
| Gemini | Media maps to `functionResponse.parts` as `inlineData` or `fileData`. | No additional protocol-level rejection after shared validation. |
| Bedrock Converse | Inline images and supported document formats map to native tool-result blocks. | URL media, unknown image MIME types, and unmapped document MIME types. |
| `AISdkAdapter` | Media maps to AI SDK `file-data` or `file-url` content. | No additional protocol-level rejection after shared validation. |

These are wire-format mappings, not a promise that every model behind an
adapter accepts every mapped part. A selected model or OpenAI-compatible
endpoint can still reject otherwise valid content; that provider error
propagates instead of falling back to a text placeholder. Known unmappable
parts throw the terminal `UnsupportedToolResultContentError` before the SDK
request. Use a text-only `modelOutput` yourself when that is the desired
fallback.

Choose inline data versus references deliberately:

- Inline base64 is self-contained, but it expands request bodies and is stored
  in `AgentRunResult.messages` and task checkpoints. OMA does not impose a
  framework byte cap; provider request and media limits still apply.
- HTTP(S) references keep the transcript smaller, but the provider must be able
  to fetch them. Treat signed URLs, query tokens, filenames, and referenced
  content as data disclosed to the model provider.
- `maxOutputChars` preserves its legacy meaning for implicit string results.
  It does not rewrite explicit rich `modelOutput`; bound or resize rich payloads
  in the tool before returning them.
- Context summary paths replace old media with textual placeholders;
  `compressToolResults` and `compact` can replace consumed rich results with a
  marker. The newest result stays intact.
- Stream `tool_result` events, result messages, `onToolResult`, and progress
  result payloads can expose the full rich content to application handlers.
  Legacy tool-call traces and `ToolCallRecord.output` use a redacted text/media
  summary that omits inline bytes and reference URLs. Online scorers receive the
  normal run result, while stored evaluation payloads continue to follow the
  configured evaluation payload policy.

Task checkpoints JSON-serialize model-visible rich content in completed
`AgentRunResult.messages`, so restored task results preserve it. Checkpoint
stores are not covered by trace redaction; wrap the store with `RedactingStore`
when that tradeoff is appropriate. Mid-task recovery remains task-grained: an
interrupted in-flight tool call still re-runs as described in
[`checkpoint.md`](checkpoint.md#limitations).

Current boundaries: the native rich contract does not include audio, local
filesystem paths, automatic uploads, resizing, malware scanning, URL fetching,
or MIME sniffing. Process and ACP backends own their execution and do not use
the runner's tool loop. Adapter tests validate local wire conversion without
contacting provider APIs; verify the exact provider/model combination you plan
to operate before relying on media support in production.

See the runnable [`rich-tool-results` example](../packages/core/examples/patterns/rich-tool-results.ts).

**Truncation.** Cap an individual tool result to a head + tail excerpt with a marker in between:

```typescript
const agent: AgentConfig = {
  // ...
  maxToolOutputChars: 10_000, // applies to every tool this agent runs
}

// Per-tool override (takes priority over AgentConfig.maxToolOutputChars):
const bigQueryTool = defineTool({
  // ...
  maxOutputChars: 50_000,
})
```

**Post-consumption compression.** Once the agent has acted on a tool result, compress older copies in the transcript so they stop costing input tokens on every subsequent turn. Error results are never compressed.

```typescript
const agent: AgentConfig = {
  // ...
  compressToolResults: true,                 // default threshold: 500 chars
  // or: compressToolResults: { minChars: 2_000 }
}
```

## MCP Tools (Model Context Protocol)

`open-multi-agent` can connect to stdio MCP servers and expose their tools directly to agents.

```typescript
import { connectMCPTools } from '@open-multi-agent/core/mcp'

const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['--no-install', '@modelcontextprotocol/server-github'],
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  },
  namePrefix: 'github',
})

// Register each MCP tool in your ToolRegistry, then include their names in AgentConfig.tools
// Don't forget cleanup when done
await disconnect()
```

Notes:
- `@modelcontextprotocol/sdk` is an optional peer dependency, only needed when using MCP.
- Current transport support is stdio.
- MCP input validation is delegated to the MCP server (`inputSchema` is `z.any()`).
- MCP text output keeps its existing string behavior. Successful MCP `image`,
  embedded blob resource, and HTTP(S) `resource_link` blocks also receive a
  rich `modelOutput`; errors, audio, malformed media, and non-HTTP resource
  links retain an explicit text representation.
- Prefer locally installed or pinned MCP server binaries and pass only the environment variables that server needs. Avoid spreading `process.env` into MCP subprocesses.

See [`integrations/mcp-github`](../packages/core/examples/integrations/mcp-github.ts) for a full runnable setup.
