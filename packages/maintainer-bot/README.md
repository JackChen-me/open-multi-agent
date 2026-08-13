# OMA Maintainer Bot

This private workspace is an evidence-first `agent-ready` Issue → Draft PR
**proposal** bot for this repository. It dogfoods `OpenMultiAgent.runTasks()`
with DeepSeek V4 Flash, but it is deliberately not a general coding agent and
contains no GitHub writer.

The runnable GitHub Actions control layer and deterministic writer live in the
separate private [`@open-multi-agent/maintainer-host`](../maintainer-host/README.md)
workspace. Keeping that boundary separate ensures the model process never
receives GitHub/npm/Actions write credentials. Production Draft PR writes use
a separately verified, repository-scoped GitHub App installation token; the
engine neither receives that token nor decides App identity, permissions, or
write authorization.

The behavior, operations, and threat boundary are documented in
[`docs/maintainer-bot.md`](../../docs/maintainer-bot.md). The final production
backend split and rollback contract are in
[`docs/maintainer-bot-architecture.md`](../../docs/maintainer-bot-architecture.md).

## Read-only fixture

From a clean isolated worktree after building the workspace:

```bash
npm run build -w @open-multi-agent/maintainer-bot
node packages/maintainer-bot/dist/cli.js dry-run \
  --request packages/maintainer-bot/fixtures/ready-doc-issue.json \
  --config packages/maintainer-bot/config/config.example.json
```

The fixture resolves `$HEAD` and `$ISSUE_REVISION` locally, evaluates the
admission gate, and builds the versioned context manifest. It performs no model
call, state write, repository edit, validation command, or GitHub action.
Its `allowedPaths` value is a fixture/canary boundary, not the production edit
policy. Production scope is generated from the trusted host policy intersected
with the exact target paths authorized by a write-authorized label event.

## Tests

```bash
npm run lint -w @open-multi-agent/maintainer-bot
npm run test -w @open-multi-agent/maintainer-bot
npm run build -w @open-multi-agent/maintainer-bot
```

Unit and integration tests use scripted adapters and require no API key.
