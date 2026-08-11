# OMA Maintainer Host

This private workspace is the deterministic GitHub Actions activation and
Draft PR writer for `@open-multi-agent/maintainer-bot`. The OMA engine remains
credential-free with respect to GitHub and npm; this host launches it in a
separate allowlisted environment. A dedicated Maintainer Bot GitHub App
installation token is available only to deterministic App preflight/status,
prepare, finalize, and writer processes. The repository `GITHUB_TOKEN` is
limited to read-only checkout plus a non-authoritative pre-model failure
notice; it is never a branch, push, or pull-request credential.

The GitHub-native activation entry point is
[`.github/workflows/maintainer-bot.yml`](../../.github/workflows/maintainer-bot.yml).
It handles only an exact `issues.labeled` / `agent-ready` event, checks out the
fixed default-branch SHA without persisted credentials, runs the OMA engine in
a secret-minimized child, and invokes the writer only after final safe-output
revalidation. The host never marks a PR ready, approves, merges, closes,
releases, publishes, tags, or deploys.

Eligible production runs require
`OMA_MAINTAINER_BOT_APP_WRITER_ENABLED=true`, a complete expected App identity
contract, and a successfully minted repository-scoped installation token.
The host verifies the token viewer, App ID/client ID/slug, installation ID, bot
user ID, and exact single-repository scope before model execution and again
before writing. Missing or mismatched configuration fails closed. This design
does not enable or depend on the organization/repository “Allow GitHub Actions
to create and approve pull requests” setting.

The production policy is
[`config/production-policy.json`](config/production-policy.json). It is not an
Issue-controlled config and is separate from the maintainer-bot fixture
configuration. Operational behavior and activation steps are documented in
[`docs/maintainer-bot.md`](../../docs/maintainer-bot.md).

All host tests use a fake GitHub implementation and scripted OMA adapter. They
perform no network write and require neither `GITHUB_TOKEN` nor
`DEEPSEEK_API_KEY`.

```bash
npm run lint -w @open-multi-agent/maintainer-host
npm run test -w @open-multi-agent/maintainer-host
npm run build -w @open-multi-agent/maintainer-host
```
