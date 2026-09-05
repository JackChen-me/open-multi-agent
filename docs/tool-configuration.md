# Tool configuration

Agents can be configured with fine-grained tool access control using presets, allowlists, and denylists.

Two subsystems that used to live on this page now have their own:
[sandbox and shell execution](sandbox-and-shell.md) and
[MCP tools](mcp.md).

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

`consequential` is optional and defaults to `false`. Exactly three built-ins
are marked consequential: `bash`, `file_write`, and `file_edit`. The read-only
filesystem tools (`file_read`, `grep`, `glob`) are not, and neither is
`delegate_to_agent`, even though it is part of the grant set the check scans on
`runTeam()` / `runTasks()` paths: a delegated run is classified by the tools the
target agent itself holds. Custom and MCP tools remain benign unless their
registered `ToolDefinition` explicitly opts in through the `consequential` field
on `defineTool()`.

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

- **`bash` is not sandboxed.** Granting it gives the agent arbitrary shell on the host (see [sandbox and shell execution](sandbox-and-shell.md)). Only the filesystem tools are path-contained.
- **Tool output flows to your model provider.** Every tool result is appended to the conversation and sent to the configured LLM on the next turn. Anything a tool reads — file contents, command output, fetched pages — leaves your process and reaches the provider. Grant read access deliberately.

**Custom / runtime tools are exempt from the grant requirement** — registering them _is_ the grant. Tools passed via `customTools` or `agent.addTool()` are always available (they still respect `disallowedTools`); see [_Custom tools_](#custom-tools). **`delegate_to_agent`** (team orchestration handoff) follows the default-deny rule like any other built-in: grant it with `tools: ['delegate_to_agent']` on each agent you want to be able to delegate, and see [_Delegation with `delegate_to_agent`_](#delegation-with-delegate_to_agent) for the extra registration rule that applies to it.

### Restoring the previous "all tools" behavior

Before default-deny, an agent with no tool config received every registered built-in — including the unsandboxed `bash`. To restore that convenience in one line, set `defaultToolPreset` on the orchestrator:

```typescript
const orchestrator = new OpenMultiAgent({
  defaultToolPreset: 'full', // agents with no tools/toolPreset get the full preset
})
```

`defaultToolPreset` is a **fallback**: it applies only to agents that declare neither `tools` nor `toolPreset`. Per-agent config always overrides it, and it never widens an agent that already declares a grant. It is not applied to the internal coordinator, the final-synthesis pass, or the consensus proposer / judge agents (`runConsensus` and the per-task `verify` hook), which run from their own configs; grant tools to those per agent.

## Tool presets

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

## Advanced filtering

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

## Delegation with `delegate_to_agent`

`delegate_to_agent` is the built-in that lets one agent hand a sub-task to
another roster agent and get that agent's final text back as a tool result. It
follows the default-deny rule like every other built-in, and it has one extra
condition on top: it is only *registered* during orchestration.

**Registration.** `registerBuiltInTools()` adds it only when called with
`{ includeDelegateTool: true }`. The orchestrator passes that flag when it
builds `runTeam()` / `runTasks()` pool workers and the ephemeral agent a
delegation itself spawns. `runAgent()` and the `runTeam()` simple-goal short
circuit build their agent without the flag. An unregistered tool can never be
granted either, so a model call to `delegate_to_agent` on those paths comes back
as the same `"is not granted to this agent"` error result as any other
ungranted built-in.

**Grant.** Registration is still not a grant. Give it to each agent that should
be able to delegate:

```typescript
const team = {
  name: 'research',
  agents: [
    {
      name: 'lead',
      model: 'claude-sonnet-4-6',
      tools: ['delegate_to_agent'],
    },
    {
      name: 'analyst',
      model: 'claude-sonnet-4-6',
      toolPreset: 'readonly',
    },
  ],
}
```

The target agent does **not** need `delegate_to_agent`; it needs whatever tools
its sub-task requires. Granting it to the target only lets that agent delegate
onward in turn.

**Refusals are values, not throws.** Every rejection below returns a
`ToolResult` with `isError: true` and an explanatory message, so the model can
pick a different target or stop:

| Condition | Refused because |
|---|---|
| No orchestrated team context | `runDelegatedAgent` is absent, for example in a standalone `Agent` or `runAgent()` run. |
| `target_agent` equals the caller | Self-delegation. |
| `target_agent` is not in the team roster | Unknown target; the message lists the roster. |
| The target already appears in the delegation chain | Cycle, for example `alice -> bob -> alice`. |
| Current depth has reached `maxDelegationDepth` | Depth ceiling. |
| The agent pool has no free run slot | A nested run would block on the concurrency semaphore. |

**Depth.** `OrchestratorConfig.maxDelegationDepth` bounds the chain and
defaults to `3`. Depth is counted per nested delegated run: the task's own agent
starts at `0`, so the default admits at most three nested runs beneath it. There
is no per-agent or per-run override; the orchestrator value applies to the whole
run. Delegation is refused once `depth >= maxDelegationDepth`.

```typescript
const orchestrator = new OpenMultiAgent({
  maxDelegationDepth: 1, // a task agent may delegate once; that agent may not
})
```

**Budget.** A delegated run's `tokenUsage` comes back on
`ToolResult.metadata.tokenUsage` and is added to the calling runner's running
total, so `maxTokenBudget` and cost tracking stay accurate across a delegation
chain rather than only counting the parent's own turns.

**Audit.** When the team has shared memory enabled, the delegated output is
also written under `<caller>/delegation:<target>:<suffix>` with the caller,
target, and success recorded as metadata. That write is best-effort: a store
failure does not fail the tool. See [shared memory](shared-memory.md).

**Isolation.** The target runs in a fresh conversation for that prompt only,
built from its own `AgentConfig`, so it inherits neither the caller's transcript
nor the caller's `credentials` bag.

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

The hook is **opt-in and off by default**. It runs once per tool invocation, after Zod input validation and before the tool implementation, and returns a decision. [Hooks and callbacks](hooks-and-callbacks.md#ontoolcall) places it among the other function-typed fields:

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

> **Not a security boundary.** A gate that returns `deny` still relies on cooperating code; it is a coordination layer, not containment. `bash` remains un-sandboxed (see [sandbox and shell execution](sandbox-and-shell.md#what-the-sandbox-covers)). For an actually-untrusted shell, use process-level isolation (a container / VM / seccomp); the gate is for *policy*, not *isolation*.

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

## Shell executors

The granted `bash` built-in runs commands through a `ShellExecutor`, which
defaults to `LocalShellExecutor` on the host. Set
`OrchestratorConfig.defaultShellExecutor`, or `AgentConfig.shellExecutor` for
one agent, to send an already-granted command somewhere else. The executor
changes only where a command runs: it does not grant `bash`, and it does not
bypass `disallowedTools` or the `onToolCall` gate.

The `ShellExecutor` contract, the `start()` / `dispose()` lifecycle under
overlapping runs, and the host-versus-remote filesystem divergence are in
[sandbox and shell execution](sandbox-and-shell.md#shell-executors).

## Filesystem working directory

Built-in filesystem tools (`file_read`, `file_write`, `file_edit`, `grep`,
`glob`) are sandboxed to a per-agent working directory. Paths must be absolute
and resolve inside it, symlinks included. `AgentConfig.cwd` overrides
`OrchestratorConfig.defaultCwd`, which itself defaults to
`<process.cwd()>/.agent-workspace`; `null` at either level disables the sandbox
for that scope.

**`bash` is not sandboxed.** Once an agent has a shell, any absolute path or
`cd` escapes a per-tool path check, so the sandbox is path containment for the
filesystem built-ins rather than a boundary against arbitrary command
execution. The three typical configurations, the resolution order, and the full
statement of that invariant are in
[sandbox and shell execution](sandbox-and-shell.md#filesystem-working-directory).

## Custom tools

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

Both routes mark the tool as *runtime-added* in the registry, which is what
exempts it from the name-based grant. Registering the same definition with a
plain `ToolRegistry.register(tool)` instead keeps it under default-deny, so its
name must then appear in `tools`.

`customTools` is read when OMA builds the agent, which covers `runAgent()`,
`runTeam()`, and `runTasks()`. A hand-constructed
`new Agent(config, registry, executor)` uses the registry you pass it and does
not read `customTools`; register the tool on that registry, or call
`agent.addTool()`, instead.

### Tool primitives

The orchestrator builds each agent's registry and executor for you. The same
primitives are exported from the package root for applications that wire an
`Agent` by hand or build their own tool plumbing.

- **`defineTool(config)`** returns a `ToolDefinition`. Required: `name`,
  `description`, `inputSchema` (a Zod schema), and
  `execute(input, context) => Promise<ToolResult>`. Optional: `consequential`,
  `outputSchema` (validates `ToolResult.data` on non-error results),
  `llmInputSchema` (a hand-written JSON Schema that replaces Zod conversion for
  the model-facing definition), and `maxOutputChars`. Omitted optional fields
  are left off the returned object rather than set to `undefined`.
- **`ToolRegistry`** holds the named tools. `register(tool, { runtimeAdded })`
  throws on a duplicate name rather than overwriting; `get`, `has`, `list` /
  `getAll`, and `unregister` / `deregister` round it out. `toToolDefs()`
  produces the model-facing definitions the runner sends to an adapter, and
  `toRuntimeToolDefs()` returns only the runtime-added subset, which is how
  grant resolution knows which tools skip the allowlist.
- **`zodToJsonSchema(schema)`** performs that Zod to JSON Schema conversion.
  `toToolDefs()` calls it whenever a tool has no `llmInputSchema`. Zod types it
  does not model fall back to `{}`, which is still valid JSON Schema; supply
  `llmInputSchema` when a schema needs to reach the model exactly as written.
- **`ToolExecutor(registry, options)`** runs the calls: Zod input validation,
  then the `onToolCall` gate, then `execute`, then `outputSchema` validation and
  truncation. `maxConcurrency` defaults to `4` for batched calls, and
  `maxToolOutputChars` sets the agent-level truncation default. It never
  rejects: an unknown tool name, a validation failure, and a thrown tool error
  all come back as a `ToolResult` with `isError: true`.

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

## Tool output control

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

Truncation keeps roughly the first 70% and last 30% of the budget and replaces
the middle with a `[...truncated N characters...]` marker. The marker counts
against the budget, so the result never exceeds the limit. It applies only to a
string `data` with no explicit `modelOutput`; a rich payload and non-string
application data are left alone. The same helper is exported as
`truncateToolOutput(data, maxChars)` for callers trimming text before it
reaches a tool result.

**Post-consumption compression.** Once the agent has acted on a tool result, compress older copies in the transcript so they stop costing input tokens on every subsequent turn. Error results are never compressed.

```typescript
const agent: AgentConfig = {
  // ...
  compressToolResults: true,                 // default threshold: 500 chars
  // or: compressToolResults: { minChars: 2_000 }
}
```

## MCP tools (Model Context Protocol)

`connectMCPTools()` from `@open-multi-agent/core/mcp` starts a stdio MCP server
and converts every tool it exposes into an ordinary `ToolDefinition`.
Registering those definitions is not a grant: their names still have to appear
in `AgentConfig.tools` unless they are passed through `customTools`.
`@modelcontextprotocol/sdk` is an optional peer dependency loaded on first use,
and `egressPolicy` does not reach inside the MCP child process.

Options and defaults, name prefixing, input validation, result mapping, error
handling, and the runnable examples are in [MCP tools](mcp.md).
