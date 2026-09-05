# Framework-owned LLM egress policy

`egressPolicy` restricts network requests that OMA can identify and guard
before a built-in LLM adapter opens them. It is an application configuration
control, not a process sandbox or host firewall.

Omitting the policy preserves existing behavior. Once a policy is configured,
OMA fails closed on a built-in adapter surface only when this document says the
surface is enforced.

## Configuration and precedence

The same `EgressPolicy` type is accepted by `OpenMultiAgent`, `AgentConfig`, and
the options for each top-level run:

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

const oma = new OpenMultiAgent({
  egressPolicy: {
    mode: 'allowlist',
    allowedOrigins: [
      'https://api.anthropic.com',
      'http://localhost:11434',
    ],
  },
})

const result = await oma.runAgent(
  {
    name: 'local',
    model: 'llama3.1',
    provider: 'openai',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',
  },
  'Summarize this text.',
  { egressPolicy: { mode: 'offline' } },
)
```

Orchestrator, run, and agent policies are intersected. Omitted scopes do not
change the result; a more specific scope can narrow access but cannot widen a
parent scope. An empty intersection denies every framework-owned LLM origin.
The same effective policy reaches workers, the coordinator, synthesis,
delegated agents, model-route fallbacks, consensus agents, and the built-in LLM
semantic profiler.

The modes are:

- `offline`: allow only URL hostnames `localhost`, `*.localhost`, IPv4
  `127.0.0.0/8`, and IPv6 `::1`. Private LAN, link-local, and arbitrary names
  that happen to resolve to loopback are not allowed.
- `allowlist`: allow only the listed HTTP(S) origins. Entries are normalized
  with standard URL origin semantics and must not include credentials, a path,
  a query string, or a fragment. A non-default port is part of the origin.

The provider request may include any path under an allowed origin. Every
guarded fetch uses `redirect: 'error'`, so a permitted endpoint cannot silently
redirect a credential-bearing SDK request to another origin.

For built-in provider target selection, `AgentConfig.baseURL` takes precedence
over `OpenMultiAgent.defaultBaseURL`; the effective explicit value then takes
precedence over the provider endpoint environment variable, which takes
precedence over the built-in default. Relevant endpoint variables are
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AZURE_OPENAI_ENDPOINT`,
`MINIMAX_BASE_URL`, `MIMO_BASE_URL`, and `HUNYUAN_BASE_URL`. Copilot uses fixed
origins and ignores `baseURL`. Azure OpenAI requires an explicit/default
endpoint or `AZURE_OPENAI_ENDPOINT` when a policy is active.

## Enforcement matrix

| Surface | Behavior while `egressPolicy` is configured |
|---|---|
| Anthropic, OpenAI, Azure OpenAI, DeepSeek, Doubao, Grok, Hunyuan, MiniMax, MiMo, and Qiniu built-in adapters | Enforced. OMA resolves and checks the effective provider origin before loading the optional SDK, injects a guarded fetch transport, checks every request again, and rejects redirects. |
| Gemini built-in adapter | Unsupported and fail-closed before import or connection. The current Google GenAI SDK path uses module-global fetch and exposes no per-client transport hook to this adapter. |
| AWS Bedrock built-in adapter | Unsupported and fail-closed before import or connection. The current adapter cannot bound all request and AWS credential-provider endpoints, including identity/metadata paths. |
| AI SDK bridge or another custom `LLMAdapter` | Unsupported and fail-closed before adapter invocation. The model object does not expose a reliable target and transport contract to OMA. This also applies when a custom adapter is supplied to the built-in semantic profiler or coordinator. |
| GitHub Copilot auth and API | Enforced. A pre-supplied GitHub token requires `https://api.github.com` and `https://api.githubcopilot.com`. Interactive device login additionally requires `https://github.com`. OMA checks all required origins before the first auth request and guards both token exchange and model API fetches. |
| Custom `TaskProfiler`, execution router, hooks, and other application callbacks | Not covered. They are application-owned in-process code. |
| MCP stdio child | Not covered. OMA starts the configured child and exchanges stdio messages; it cannot constrain connections opened inside the MCP server. See [MCP tools](mcp.md#egress-and-process-boundaries). |
| `process` and ACP backends | Not covered. OMA starts a child process and uses stdio; the child owns its network behavior. ACP permission callbacks are not a network sandbox. |
| Built-in `bash` tool | Not covered. The shell process can use its host permissions and network stack. |
| Custom tools, including tools that call `fetch` | Not covered. Tool code and its clients are supplied by the application. |
| `@open-multi-agent/otel` and application-owned trace/OTel exporters | Not covered. OMA invokes the supplied tracer, provider, sink, or exporter; the application owns its transport and lifecycle. |

Any adapter instance supplied through `AgentConfig.adapter` is a custom adapter
for this policy, even if the application constructed it from an OMA adapter
class. Select an enforceable built-in provider through `provider` and `baseURL`
so OMA owns construction and can inject the guarded transport.

The MCP, backend, shell, and custom-tool rows stay outside the policy even when
they are launched by a policy-configured agent. Use process/container network
namespaces, an egress proxy, or an OS firewall when those surfaces must be
contained. Do not treat `offline` as evidence that the whole Node.js process or
its descendants are offline.

## Errors and audit behavior

Invalid policy shapes and allowlist entries throw `EgressPolicyError` with
`code: 'INVALID_EGRESS_POLICY'`; invalid entries are never ignored. Direct
`createAdapter()` calls reject with the same error class. During an agent LLM
run, denial or an unsupported adapter follows the existing LLM-failure path:
the agent result is unsuccessful with `status.code: 'rejected'`,
`errorInfo.kind: 'validation'`, and a non-retryable stable code. It is not
converted into a tool `ToolResult`.

The remaining stable codes are:

| Code | Meaning |
|---|---|
| `EGRESS_POLICY_DENIED` | A concrete resolved origin is outside the effective policy. |
| `EGRESS_POLICY_TARGET_UNRESOLVED` | The built-in adapter needs an endpoint that configuration and environment did not provide. |
| `EGRESS_POLICY_UNSUPPORTED` | OMA cannot truthfully enforce the selected adapter transport surface. |

Existing team/task failure and dependency-cascade behavior remains unchanged.
No policy outcome is retried because another attempt cannot widen policy.

## Security boundary

The guard evaluates the configured/request URL before the fetch implementation
runs. It is not DNS resolution pinning, proxy enforcement, socket interception,
or protection against a compromised provider SDK. An allowed hostname can
resolve according to the process's DNS environment. For a hard containment
boundary, pair this declarative audit control with infrastructure-level egress
enforcement.
