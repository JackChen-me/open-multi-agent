# OMA Release Bot

This private workspace dogfoods `@open-multi-agent/core` to prepare OMA releases.
It is repository-local automation, not a published npm package.

## Responsibility boundary

The bot deliberately separates judgment from authority:

1. An explicit `runTasks()` DAG runs two independent DeepSeek V4 Flash reviews
   in parallel: change classification and compatibility analysis.
2. A planner produces a bounded structured proposal. It can choose only
   `none`, `patch`, `minor`, or `major` for each package and concise changelog
   entries.
3. An independent reviewer approves or rejects that proposal.
4. Deterministic TypeScript calculates versions, updates the known manifests
   and template pins, regenerates the lockfile, runs validation, and creates a
   ready pull request.
5. A maintainer reviews and merges the PR. Only then can the deterministic
   publish workflow run after `CI` succeeds on the exact merged release commit.

Every role thinks at DeepSeek's `max` effort and shares one 64,000-token
output ceiling. Reasoning and the answer are billed against that same ceiling,
so it is sized for both: a ceiling that only fits the answer leaves a role
emitting reasoning and no JSON, which surfaces as a schema failure rather than
as the truncation it is. The evidence roles have five turns and the planner and
reviewer three. Every DAG task has `maxRetries: 0`, so a failed role is not
silently rerun as a whole new analysis (OMA's one in-run structured-output
correction still applies). The complete planning DAG has a thirty-minute
wall-clock deadline.

Repository diffs are untrusted evidence. The analyst and compatibility auditor
receive only three custom read-only tools: immutable release evidence, a
deterministic risk-ranked and size-bounded review bundle, and the release
contract. The model cannot supply repository paths to the bundle. The planner
and reviewer consume the immutable summary and structured dependency reports
without repository tools. No agent receives `bash`, filesystem write tools,
GitHub credentials, npm credentials, or publication tools.

Concrete package versions remain deterministic. In particular, every core
release increments `create-oma-app`; when no scaffolder files changed since the
last core tag, the bot forces a patch bump because the only release change is
the exact core template pin. A model-proposed larger scaffolder bump is used
only when the scaffolder workspace itself changed. This normalization happens
before the independent reviewer receives the proposal.

## Commands

Run from the repository root after building the workspace:

```bash
npm run build -w @open-multi-agent/release-bot

# Read-only: calls DeepSeek and prints the structured result.
DEEPSEEK_API_KEY=... node packages/release-bot/dist/cli.js plan

# Mutating: intended for release-bot.yml with a GitHub App token.
node packages/release-bot/dist/cli.js prepare-pr

# Consequential: intended only for publish.yml with npm trusted publishing.
node packages/release-bot/dist/cli.js publish
```

`prepare-pr` validates the complete repository before it commits or pushes. It
refuses a dirty worktree, an advanced HEAD, unexpected file changes, duplicate
release PRs, and conflicting remote release branches.

`publish` is idempotent at package boundaries. It checks the public registry
before each package, publishes in the fixed `core` → `otel` →
`create-oma-app` order, waits for registry visibility, then creates the
lightweight core tag and GitHub Release. A rerun resumes missing stages. A tag
that exists before every expected package is visible fails closed.

## Activation

The workflows are inert until maintainers configure the GitHub App, DeepSeek
secret, `npm-release` environment, and npm trusted publishers described in
[`.github/RELEASING.md`](../../.github/RELEASING.md). No long-lived npm token is
supported.

The GitHub App is intentional. [GitHub documents](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)
that pull requests or releases created with the repository `GITHUB_TOKEN` do
not trigger downstream workflows normally; an installation token lets PR CI
and `release-smoke.yml` start without a second manual workflow approval.
