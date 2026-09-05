# MCP tools (Model Context Protocol)

This page answers what `connectMCPTools()` actually does: which options it
takes, how an MCP server's tools become `ToolDefinition` objects, how MCP
result blocks reach the model, and which OMA controls do and do not extend into
the MCP child process.

MCP tools are ordinary OMA tools once connected. Everything in
[tool configuration](tool-configuration.md) still applies to them: default-deny
grants, `disallowedTools`, the per-call `onToolCall` gate, output truncation,
and rich `modelOutput` handling.

## Connecting to a server

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

try {
  // Register each MCP tool in your ToolRegistry, then grant their names
  // through AgentConfig.tools.
} finally {
  await disconnect()
}
```

`connectMCPTools()` spawns the configured child, connects an MCP client over
stdio, pages through `tools/list` until the server stops returning a
`nextCursor`, and converts each descriptor into a `ToolDefinition`. If connect
or discovery throws, both the client and the transport are closed before the
error propagates, so a failed connection does not leak the child process.

The function is exported from the `@open-multi-agent/core/mcp` subpath, not
from the package root.

## Options

`ConnectMCPToolsConfig`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | `string` | required | Executable to spawn for the stdio server. |
| `args` | `string[]` | `[]` | Arguments passed to `command`. |
| `env` | `Record<string, string \| undefined>` | (transport default) | Environment handed to the child process. |
| `cwd` | `string` | (transport default) | Working directory for the child process. |
| `namePrefix` | `string` | none | Segment prepended to every discovered tool name. |
| `requestTimeoutMs` | `number` | `60000` | Timeout applied to connect, each `tools/list` page, and each `tools/call`. |
| `clientName` | `string` | `'open-multi-agent'` | Client name reported to the server. |
| `clientVersion` | `string` | `'0.0.0'` | Client version reported to the server. |

Returns `ConnectedMCPTools`:

```typescript
interface ConnectedMCPTools {
  tools: ToolDefinition[]
  disconnect: () => Promise<void>
}
```

`disconnect()` closes the MCP client, which tears down the stdio transport and
the child process. It is the only shutdown hook: OMA does not close the
connection when a run ends, because one connection is meant to serve many runs.
Call it from a `finally` block, as every example below does, so an aborted or
failing run still stops the child.

## Tool names

The framework tool name is `<namePrefix>_<mcpToolName>`, and every `/` in the
result is replaced with `_`. MCP and earlier examples used `prefix/name`, but
Anthropic and other providers reject `/` in tool names.

- `namePrefix: 'github'` plus the MCP tool `search_issues` yields
  `github_search_issues`.
- An omitted, empty, or whitespace-only `namePrefix` leaves the server's name
  unchanged apart from the `/` replacement.
- If two discovered tools normalize to the same name, `connectMCPTools()`
  throws before returning, naming the collision and both source names. It never
  silently drops one of them.

Prefixes matter beyond cosmetics: `ToolRegistry.register()` throws on a
duplicate name, so two servers exposing a `search` tool need distinct prefixes.

## Granting MCP tools to an agent

Registration is not a grant. MCP tools follow the same default-deny rule as the
built-ins, so their names must appear in `AgentConfig.tools`:

```typescript
import { Agent, ToolExecutor, ToolRegistry, registerBuiltInTools } from '@open-multi-agent/core'

const registry = new ToolRegistry()
registerBuiltInTools(registry)
for (const tool of tools) registry.register(tool)

const agent = new Agent(
  {
    name: 'github-agent',
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    tools: tools.map((tool) => tool.name), // the grant
  },
  registry,
  new ToolExecutor(registry),
)
```

The alternative is `AgentConfig.customTools`, which registers the tools as
runtime-added: registration is then the grant and no `tools` allowlist is
needed, though `disallowedTools` is still honored. That route applies when OMA
builds the agent, so use it with `runAgent()`, `runTeam()`, or `runTasks()`; a
hand-constructed `new Agent(config, registry, executor)` like the one above
takes its tools from the registry you pass and ignores `customTools`. Both
routes reach the same executor, so the `onToolCall` gate sees MCP calls either
way.

MCP tools are not marked `consequential`, so they do not by themselves raise
the `consequential-no-independence` flag or trigger
`requireConsequentialConfirmation`. Wrap an MCP tool in your own `defineTool()`
when a specific server operation should be treated as a real side effect.

## Input validation is delegated to the server

Each generated tool uses `inputSchema: z.any()`, so OMA performs no runtime
validation of MCP arguments. The server's JSON Schema from `tools/list` is
forwarded to the LLM unchanged through `llmInputSchema`; when a descriptor
carries no usable object schema, `{ type: 'object' }` is sent instead.

Two consequences worth designing around: a malformed argument object reaches
the server rather than being rejected locally, and the `onToolCall` gate
receives the raw arguments as-is because there is no parsed shape to narrow
them to.

## Result mapping

Every MCP call produces a text `data` value. Media additionally produces a rich
`modelOutput`; see
[rich image and file results](tool-configuration.md#rich-image-and-file-results)
for the contract those parts satisfy.

**Text (`data`).** Content blocks are serialized in order and joined with
newlines:

| MCP block | Text form |
|---|---|
| `text` | The text verbatim. |
| `image` | `[image <mimeType>; base64 length=<n>]`, using `image/*` when the server omits `mimeType`. |
| `audio` | `[audio <mimeType>; base64 length=<n>]`, using `audio/*` when the server omits `mimeType`. |
| `resource` with `text` | `[resource <uri>]` followed by the text. |
| `resource` with `blob` | `[resource <uri>; mimeType=<type>; blob base64 length=<n>]` |
| `resource_link` | `[resource_link name=<name> uri=<uri>]` plus the description when present. |
| Anything else | `[<type>]` followed by the block as pretty-printed JSON. |

A legacy `toolResult` field wins over `content` and is serialized as
pretty-printed JSON. When `content` yields no lines at all, OMA falls back to
`structuredContent`, and then to the whole response object.

**Model-visible parts (`modelOutput`).** A rich `modelOutput` is emitted only
when at least one block converts to media:

- `image` whose `mimeType` is a bare `type/subtype` (no parameters) becomes a
  base64 image part.
- `resource` with a `blob` becomes a `[resource <uri>]` text part plus a base64
  file part. The filename comes from the resource `name`, else the last segment
  of its `uri`, else `mcp-resource`.
- `resource_link` with an `http:` or `https:` `uri` becomes an optional
  description text part plus a URL file part.
- A missing or malformed MIME type on a blob or link falls back to
  `application/octet-stream`.

Audio, an image with an invalid MIME type, a non-HTTP `resource_link`, and any
future block type keep the text representation above. Nothing is silently
dropped.

When the legacy `toolResult` field is present alongside media, `modelOutput`
becomes the serialized `toolResult` text followed by the non-text media parts,
so the historical model-visible value is preserved.

## Errors

- A server result with `isError: true` produces `isError: true` on the
  `ToolResult`, and stays text-only: no `modelOutput` is attached even when the
  server included media. This preserves the framework's text-only error
  contract.
- A thrown or rejected `callTool` becomes
  `MCP tool "<name>" failed: <message>` with `isError: true`. The tool loop
  treats it as a normal tool error, so the model can react instead of the run
  crashing.
- The tool's `context.abortSignal` is forwarded to `callTool`, so an aborted
  run cancels an in-flight MCP request.

## Transport and dependency

- **stdio only.** `connectMCPTools()` constructs `StdioClientTransport`. HTTP
  and SSE MCP transports are not wired up.
- **`@modelcontextprotocol/sdk` is an optional peer dependency.** It is loaded
  through dynamic `import()` on the first `connectMCPTools()` call, so an
  installation that never uses MCP never resolves it. Install it yourself when
  you do.

## Egress and process boundaries

`egressPolicy` does not constrain connections opened inside the MCP child, by
`bash`, or by custom tools. OMA starts the configured child and exchanges stdio
messages; it cannot see or guard sockets the server opens. See the
[egress enforcement matrix](egress-policy.md#enforcement-matrix).

Two practices follow from that:

- Prefer locally installed or pinned MCP server binaries over resolving a
  package at launch time.
- Pass only the environment variables the server needs. Avoid spreading
  `process.env` into an MCP subprocess; that is how an unrelated provider API
  key ends up inside a third-party server.

When an MCP server must be network-contained, use a process or container
network namespace, an egress proxy, or an OS firewall. An agent configured with
`egressPolicy: { mode: 'offline' }` is not evidence that the MCP child is
offline.

## Examples

- [`integrations/mcp-github`](../packages/core/examples/integrations/mcp-github.ts):
  the minimal shape, a single server registered into a fresh `ToolRegistry` and
  granted by name.
- [`integrations/mcp-bilig-workpaper`](../packages/core/examples/integrations/mcp-bilig-workpaper.ts):
  a writable file-backed server, with the agent's filesystem sandbox `cwd`
  pointed at the same scratch directory the server operates on.
- [`integrations/mcp-open-design`](../packages/core/examples/integrations/mcp-open-design.ts):
  MCP tools looked up by their prefixed names and wrapped in a custom tool, so
  deterministic TypeScript drives an asynchronous job while `runTasks()` fans
  several of them out in parallel.
