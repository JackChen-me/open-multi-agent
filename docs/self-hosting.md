# Self-hosting and data residency

`@open-multi-agent/core` is a library, not a service. There is no OMA backend,
no account, and no hosted control plane: the framework runs entirely inside
your Node.js process, and everything it persists is written through a store you
supply. This page collects the facts a review needs in one place. Each claim is
about the framework itself; where your own configuration decides the answer,
that is said explicitly.

## Runtime footprint

Core's runtime dependencies are:

| Package | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic provider adapter |
| `openai` | OpenAI adapter and every OpenAI-compatible provider, including local servers |
| `zod` | Tool input schemas and structured output validation |

Everything else is a peer dependency and optional: the ACP SDK, the MCP SDK,
the Google GenAI SDK, the AWS Bedrock client, and the Vercel AI SDK. Each is
loaded through a dynamic `import()` at the moment a feature needs it, so an
install that never uses ACP never resolves the ACP SDK. Provider adapter
modules are dynamically imported too, so the two bundled provider SDKs load
only when an adapter that needs them is constructed.

The supported runtime is Node.js 20 or newer. OpenTelemetry lives in the
separate `@open-multi-agent/otel` package and is never pulled in by the core
import.

## What connects to the network

The framework opens outbound HTTP for one purpose: talking to the LLM endpoint
your configuration names. `AgentConfig.baseURL` and the provider environment
variables decide where that is. Point them at a local server and the framework
has no remaining reason to leave the machine. The one provider that reaches
past its own model API is GitHub Copilot, whose adapter also calls
`api.github.com` for a token and, for interactive device login, `github.com`.

There is **no telemetry, no analytics, no license check, no update check, and
no phone-home of any kind** in the package. "Telemetry" inside this codebase
means the local [observability](observability.md) subsystem: trace records that
go to a sink you construct and a store you own. Nothing is transmitted unless
you wire an exporter yourself, and the OpenTelemetry adapter that would do so
is a separate optional package with its own lifecycle.

Four things start subprocesses rather than connections, and each is something
you configured:

- **MCP servers** connect over stdio only. The MCP client uses
  `StdioClientTransport`, so a server is a child process on the same machine.
  There is no HTTP or SSE MCP transport in core.
- **`process` and `acp` backends** spawn the command you name. See
  [external agents](external-agents.md).
- **The `bash` tool** runs commands through a local shell.
- **Process-tree cleanup** shells out to `taskkill` on Windows to terminate a
  child's descendants.

Each of those children has your process's permissions and its own network
access. The framework starts them and exchanges bytes; it does not contain
them.

## Bounding LLM egress

`egressPolicy` narrows where a framework-owned LLM request may go. Two modes:

- `offline` permits only loopback origins: `localhost`, `*.localhost`,
  `127.0.0.0/8`, and `[::1]`.
- `allowlist` permits only the exact HTTP(S) origins you list.

Policies configured at the orchestrator, run, and agent levels are
intersected, so a narrower scope can tighten but never widen a broader one.
Enforcement means the origin is checked before the provider SDK loads, a
guarded fetch re-checks every request, and redirects are rejected. An adapter
OMA cannot enforce fails closed rather than proceeding unguarded.

**Read the scope statement carefully.** The policy covers LLM requests the
framework itself issues. It does not cover tool code, the `bash` tool, MCP
server internals, process and ACP children, application callbacks, or your own
trace exporters. `offline` is a statement about OMA's provider calls, not
evidence that the Node.js process and its descendants are offline. The full
per-surface table is the
[egress enforcement matrix](egress-policy.md#enforcement-matrix).

## Where state lives

Nothing is persisted anywhere you did not choose. Shared memory, checkpoints,
and durable approvals all go through the `MemoryStore` interface, and core
ships three implementations:

| Store | Durability | Notes |
|---|---|---|
| `InMemoryStore` | None; dies with the process | Process-local `compareAndSet` |
| `FileStore` | One JSON file, rewritten atomically per mutation | Single Node process at a time; no cross-process file lock |
| `RedactingStore` | Delegates to whatever it wraps | Scrubs values on write; deliberately exposes no `compareAndSet`, so it cannot back durable approvals. See [redaction](#redaction) |

**There is no bundled database store.** Redis, Postgres, and SQLite appear in
the source only as examples of what an application might implement behind
`MemoryStore`. Writing one is the supported path when you outgrow a file.

**Cross-process atomicity is not provided.** `FileStore.compareAndSet` is
atomic among callers sharing one `FileStore` instance, and that is the whole
guarantee. A cross-process reviewer should therefore decide only after the
suspended runner has exited, or the deployment needs a database-backed store
whose `compareAndSet` is atomic across all writers. This matters most for
[durable approvals](durable-approvals.md#store-requirements), where the
decision write is the correctness boundary.

Trace records and evaluation records have their own stores and the same shape
of choice: `InMemoryTraceStore` or `FileTraceStore`, `InMemoryEvalStore` or
`FileEvalStore`. Both file-backed variants are append-only local files.

## Filesystem scope

Built-in filesystem tools resolve every path, symlinks included, inside a
sandbox root. Unset, that root is `<process.cwd()>/.agent-workspace`, created
on first write. `OrchestratorConfig.defaultCwd` or `AgentConfig.cwd` moves it,
`process.cwd()` widens it to the whole project, and `null` disables it.

**The `bash` tool is not sandboxed.** It takes a `cwd` argument straight from
the model and runs the command through a shell with your process's
permissions. The sandbox root does not constrain it, and neither does the
per-call gate unless you configure one. Granting `bash` is granting shell
access to the host; see [tool configuration](tool-configuration.md) for the
grant model and the per-call `onToolCall` gate.

## Redaction

A shared credential redactor runs at several surfaces before content is
persisted or exported:

- trace attributes and the tool input/output an agent run records
- observability status messages and record processors
- task metadata
- `bash` tool output
- `process` backend stderr on a failed exit
- evaluation sampling and report payloads
- `RedactingStore` values, and `JsonlRunJournal` events when `redact` is set

Its built-in patterns are credential-shaped: key/secret/token/password-style
field names, `Authorization` and `Bearer` headers, PEM private key blocks, and
literal token formats such as `sk-`, `ghp_`, `AKIA`, and `xox`-prefixed keys.

**PII is not covered by default.** Emails, national IDs, account numbers, and
anything else domain-specific pass through unchanged unless you supply the
patterns yourself. The two surfaces that accept them are `RedactingStore` and
`JsonlRunJournal`, both through the `patterns` option (the underlying helper
calls the same list `extraPatterns`); the other surfaces above run the built-in
patterns only and take no caller additions. Redaction is also best-effort by
construction: it is a set of regular expressions over text, not a classifier.
Do not rely on it as the only control over what an agent may emit.

One boundary is easy to miss: telemetry redaction does not reach persisted run
state. Shared-memory writes and checkpoint saves store agent output verbatim
unless the store itself is wrapped in `RedactingStore`. See
[shared memory](shared-memory.md#redacting-persisted-secrets).

## Air-gapped deployment

Two pieces of configuration cover the framework's own behavior:

1. **An OpenAI-compatible endpoint.** Configure it as `provider: 'openai'` with
   a `baseURL` pointing at the server, plus a non-empty placeholder `apiKey`
   because the OpenAI SDK validates that the field is set even when the server
   ignores it. See
   [local model tool-calling](providers.md#local-model-tool-calling).
2. **An egress policy**, so a stale `baseURL` or an inherited environment
   variable fails closed instead of reaching a hosted provider. Use
   `{ mode: 'offline' }` when the endpoint is on the same host: it permits
   loopback only, and deliberately rejects private LAN addresses. A server
   elsewhere on the network needs `{ mode: 'allowlist', allowedOrigins:
   ['http://<host>:<port>'] }` instead, because `offline` would block it.

Everything else in the boundary is outside what the framework can enforce: an
MCP server that calls out, a `bash`-granted agent, an external backend whose
child has network access, or a trace exporter pointed off the machine. The
framework will not open a connection on its own, but it also cannot contain the
code it starts on your behalf. A network namespace, an egress proxy, or a host
firewall is the control that actually does.

## What is not provided

So that nothing here is read as more than it is, the framework does **not**
include:

- **Multi-tenancy.** There is no tenant concept. Isolating one customer's runs,
  stores, and workspaces from another's is an application concern.
- **RBAC or any authorization model.** No roles, no permissions, no policy
  engine. The tool grant model and `onToolCall` gate are per-agent
  configuration, not an identity system.
- **SSO or authentication.** OMA never authenticates anyone. A durable approval
  records the `reviewer.id` string you pass it and validates only that it is
  non-empty.
- **An approval UI or workflow.** The suspend/decide/resume API and the durable
  record exist; the reviewer-facing product does not. See
  [durable approvals](durable-approvals.md#what-the-framework-provides-and-what-you-build).
- **Tamper-evident audit.** The run journal has no hash chain, no signature,
  and no WORM storage. See
  [identity and integrity](run-journal.md#identity-and-integrity).
- **A database-backed store.** Only in-memory and single-file implementations
  ship. Anything with cross-process guarantees is yours to write.
- **Encryption at rest.** File-backed stores write plain JSON and
  newline-delimited JSON. Use disk or filesystem encryption appropriate to the
  data those files will hold.
