# examples/integrations/

OMA wired to external systems: MCP servers, observability backends, other
frameworks, app shells. Runnable starting points, not product docs.

Two categories live here.

**Reference integrations** demonstrate wiring against widely used protocols
or frameworks. The OMA team maintains these once merged, regardless of who
contributed them. Current:

- `mcp-github.ts`: MCP servers via `connectMCPTools()`.
- `mcp-open-design.ts`: batch fan-out over an MCP server's async, long-running
  jobs — N Open Design landing-page variants generated in parallel via
  `runTasks()`, each variant driven `create_project → start_run → poll get_run`
  to a terminal status by deterministic code.
- `external-agent-acp.ts`: external coding agents (Gemini CLI / Claude Code) as
  team members via the `acp` backend. See [docs/external-agents.md](../../../../docs/external-agents.md).
- `external-agent-process.ts`: deterministic local subprocesses as team members
  via the `process` backend.
- `trace-observability.ts`: the `onTrace` API.
- `observability-v2/`: no-network examples for batching/custom exporters,
  InMemory/File TraceStore, an application-owned OTel provider, and explicit
  CLI/server/serverless lifecycle handling. The original
  `trace-observability.ts` remains the legacy callback example.
- `with-vercel-ai-sdk/`: Next.js + AI SDK + `runTeam()`.
- `express-customer-support/`: Express REST API + `runTasks()`. Contributed
  by [@CodingBangboo](https://github.com/CodingBangboo) via #191.

**Vendor integrations** show OMA paired with a specific third-party
commercial product. They live under `with-<product>/` and stay credited to
the contributor. Current:

- `with-engram/`: Engram memory backend. Contributed by
  [@Agentscreator](https://github.com/Agentscreator) via #160.
- `with-tencentdb-memory/`: TencentDB-Agent-Memory long-term memory (L0→L3
  pipeline) via its Hermes Gateway sidecar.

## Submitting a reference integration

Open a PR following the conventions in [`examples/README.md`](../README.md).
For widely used protocols or frameworks, no prior discussion needed. For
niche ones, open a discussion first so we can confirm the wiring is worth
maintaining long-term.

## Submitting a vendor integration

One condition: the integration is reciprocal. Your product's repo or docs
should reference OMA as a supported integration. No payment involved, this
is a signal filter for who has actually shipped against OMA.

Flow:

1. Open a [discussion](https://github.com/open-multi-agent/open-multi-agent/discussions)
   with the link to OMA in your product's docs and a sketch of the example.
2. Wait for a maintainer reply confirming the example is in scope.
3. PR it. Follow the conventions in [`examples/README.md`](../README.md).

If your product doesn't reference OMA yet, open a discussion to get listed
in the [Built with OMA](../../../../README.md#built-with-oma) section.

The [Featured Partner program](../../../../docs/featured-partner.md) is separate
and paid, for prominent README placement. Eligibility is an active OMA
integration; reciprocal listing isn't required.

## Out of scope here

- Marketing copy for a third-party product.
- Examples gated behind paid-only APIs with no free or trial tier.
- Thin `connectMCPTools()` wrappers whose only difference from `mcp-github.ts`
  is the server name and prefix. Those belong in your own docs.
