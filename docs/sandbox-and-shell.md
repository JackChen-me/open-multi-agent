# Sandbox and shell execution

This page answers two questions that are easy to conflate: **where can a granted
tool touch the filesystem**, and **where does a granted `bash` command actually
run**. They have different answers. The built-in filesystem tools are contained
by a per-agent working directory; `bash` is not contained by anything OMA owns,
and its execution target is a replaceable seam rather than a boundary.

Granting the tools themselves is a separate layer, covered in
[tool configuration](tool-configuration.md).

## What the sandbox covers

Built-in filesystem tools (`file_read`, `file_write`, `file_edit`, `grep`,
`glob`) resolve every path inside the agent's working directory. `bash` does
not.

| Surface | Contained by `cwd` / `defaultCwd`? |
|---|---|
| `file_read`, `file_write`, `file_edit`, `grep`, `glob` | Yes. Paths must be absolute and resolve inside the root, symlinks included. |
| `bash` | No. The tool takes a `cwd` argument straight from the model and runs `bash -c` with the host process's permissions. |
| Custom tools | No. Tool code is application-owned and runs in-process. |
| `process` and ACP backends | No. They own their own `cwd` and execution; see [external agents](external-agents.md). |

This is the repository-level invariant: **filesystem tools are sandboxed;
`bash` is not.** Once an agent has a shell, any `cd /etc`, absolute path, or
subshell trivially escapes a per-tool path check, so the sandbox is best
understood as **path containment for built-in filesystem tools**, not a
security boundary against arbitrary command execution.

If full path containment matters, drop `bash` via `disallowedTools: ['bash']`
(or omit it from your `tools` allowlist) and rely on the filesystem tools.
Process-level isolation (containers, seatbelt, firejail) is the right tool for
an actually-untrusted shell.

## Filesystem working directory

Built-in filesystem tools are sandboxed to a per-agent working directory. Paths
must be absolute and resolve inside that directory; symlinks are resolved
before the check so they cannot escape the configured root. The resolved,
symlink-free path is what reaches the `fs` API, which closes the window where a
symlink inside the candidate path could be swapped after the check.

A relative path is rejected outright, and a path that resolves outside the root
returns an error `ToolResult` naming the root and the configuration fields that
widen or disable it. Either way the tool implementation is not reached.

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

**Resolution order.** `AgentConfig.cwd` (if set) → `OrchestratorConfig.defaultCwd` (if set) → `<process.cwd()>/.agent-workspace`. Pass `null` at either level to disable the sandbox for that scope. An explicit `cwd: null` on an agent wins over a configured `defaultCwd`.

**Auto-creation.** The sandbox root is `mkdir -p`'d on first write, so callers do not need to pre-create `.agent-workspace` (or any custom path). Only `file_write` creates it; the other filesystem tools report a missing root as an error instead of creating it silently.

The default `LocalShellExecutor` runs `bash` in its own process group on POSIX,
so timeouts and abort signals kill any backgrounded children rather than
letting them outlive the parent. Custom executors own equivalent cleanup in
their execution environment.

## Shell executors

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
on POSIX, and kills the process tree on timeout or abort. The allowlist admits
only `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TEMP`, `TERM`,
`TMP`, `TMPDIR`, and `USER`, and a credential-shaped name is dropped even when
it is on that list, so a command does not inherit the parent process's provider
keys by default. `LocalShellExecutor` executes with the
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

## Related pages

- [Tool configuration](tool-configuration.md) for grants, presets, and the
  per-call `onToolCall` gate that decides whether a specific command runs.
- [LLM egress policy](egress-policy.md#enforcement-matrix) for why `bash` and
  custom tools stay outside `egressPolicy`.
- [Self-hosting and data residency](self-hosting.md) for the runtime footprint
  and where state lands on disk.
- [External agents](external-agents.md) for process and ACP backends, which
  replace the runner tool loop entirely.
