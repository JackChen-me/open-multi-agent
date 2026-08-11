# OMA Maintainer Bot

## Product boundary

OMA Maintainer Bot is a repository-local, evidence-first path from a narrowly
authorized GitHub issue to a structured Draft PR proposal. It is not a general
coding agent. In activation v1,
[`maintainer-bot.yml`](../.github/workflows/maintainer-bot.yml) is the thin
GitHub Actions control layer and `@open-multi-agent/maintainer-host` owns event
validation, durable claims, credential isolation, status, and deterministic
Draft PR writes. `@open-multi-agent/maintainer-bot` remains the real OMA
execution kernel.

The local engine never creates a branch, commits, pushes, comments, labels,
opens a pull request, marks one ready, approves, merges, closes an issue,
publishes, tags, releases, or deploys. Its strongest successful output is
`DRAFT_PR_PROPOSAL_READY`. Only a separate credential-holding host may create a
Draft PR, after calling the deterministic safe-output revalidation boundary.
The host may then acknowledge the result as `DRAFT_PR_CREATED`; that state is
never inferred from a proposal.

The workflow handles only an `issues.labeled` delivery whose exact label is
`agent-ready`. It never scans or develops all open issues, does not use
`pull_request_target`, and does not depend on a maintainer's local computer or
a long-running server.

## GitHub Actions activation flow

1. A pinned `actions/create-github-app-token` commit requests a short-lived
   installation token for the current repository only. Before checkout or
   model work, deterministic preflight verifies operator enablement, token
   viewer, App ID/client ID/slug, installation ID, bot user ID, and exact
   single-repository scope. The verified App then publishes or updates one BOT
   status comment with `STARTED`, Actions run URL/ID, and a freshly resolved
   base SHA. If App preflight cannot run, the limited repository token may
   publish one explicitly non-authoritative bootstrap failure notice; it can
   never create a durable claim, branch, push, or PR. If an earlier App-owned
   durable comment exists, the bootstrap notice is a temporary second comment
   so configuration failure is never silent; the next verified App run removes
   it before updating the authoritative App comment.
2. GitHub serializes runs by repository and Issue number. The job uses a
   GitHub-hosted ephemeral runner, a 45-minute timeout, pinned Node/npm
   versions, and workflow-level `contents: read` plus `issues: write`. The
   dedicated App token separately requests `actions: read`, `contents: write`,
   `issues: write`, `metadata: read`, and `pull-requests: write`.
3. The host refetches repository, Issue, labels, material comments, timeline,
   actor permission, current default-branch SHA, verified App identity,
   existing BOT state, branch, and PR metadata. It performs admission before a
   model call or repository edit.
4. A separate child receives `DEEPSEEK_API_KEY` plus a small non-secret
   environment. It receives no GitHub, npm, Actions runtime, App, SSH, or other
   write credential.
5. If OMA reaches `DRAFT_PR_PROPOSAL_READY`, a new deterministic host process
   refetches all authorization facts and calls `revalidateDraftPrSafeOutput()`
   against the actual worktree before any branch, commit, push, or PR call.
6. The writer stages exactly the reviewed files, rejects extra/untracked/
   deleted/renamed/symlinked/out-of-scope content and unsafe local Git hook,
   proxy, credential, include, filter, or URL-rewrite configuration. Writer Git
   processes disable hooks plus global/system credential configuration, use a
   deterministic branch and canonical HTTPS destination, and create at most one
   Draft PR. Every App-authenticated terminal path updates the authoritative
   status comment and Actions summary; only an App-preflight failure uses the
   temporary non-authoritative bootstrap notice described above.

GitHub only triggers an `issues` workflow when its workflow file exists on the
default branch. Activation v1 deliberately leaves organization and repository
default workflow permissions at read-only and leaves “Allow GitHub Actions to
create and approve pull requests” disabled. The Draft PR is created by the
dedicated GitHub App, not `GITHUB_TOKEN`. GitHub documents that events emitted
by `GITHUB_TOKEN` normally do not create a new workflow run, while events from
a GitHub App installation token can trigger workflows; therefore an App-created
Draft PR starts the repository's ordinary `pull_request` CI without enabling
the broad Actions PR setting. See GitHub's
[workflow trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[`GITHUB_TOKEN` security reference](https://docs.github.com/en/actions/concepts/security/github_token),
and [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

## Fixed execution flow

1. Deterministic admission computes the material issue revision and enforces
   Definition of Ready, manual-only classes, write-authorized `agent-ready`
   evidence, exact revision, and exact base SHA.
2. The deterministic context builder verifies a clean isolated worktree at the
   fixed base SHA and writes a versioned, hash-bound context manifest.
3. One explicit OMA `runTasks()` task performs schema-bound, read-only triage.
   The deterministic host starts no planner or implementer unless triage says
   `proceed`, reports no uncertainty or manual-risk blocker, and exactly echoes
   the authorized issue revision and acceptance criteria.
4. Only after that host check, a second explicit OMA `runTasks()` DAG executes
   read-only repository planning followed by a schema-bound implementation
   proposal. A rejected triage therefore spends no planner/implementer tokens
   and cannot reach an edit capability.
5. The host applies compare-and-swap full-content edits through the restricted
   edit capability. The model has no filesystem or shell tool.
6. The host runs every preregistered validation command as argv with
   `shell: false` and a credential-stripped environment.
7. A new OMA team and agent perform fresh-context review using only confirmed
   requirements, acceptance criteria, the final diff, validation evidence,
   bounded current-file snapshots, and relevant context. Implementer reasoning
   and conversation history are not passed to the reviewer.
8. A rejected but bounded and repairable result may run at most two repair
   loops. Repairs use `currentFiles[].contentHash` from the fresh review bundle
   for compare-and-swap, then repeat deterministic validation and fresh review.
9. Deterministic TypeScript emits a Draft PR proposal only when context is
   sufficient, every validation passes without truncation, every acceptance
   criterion passes fresh review, all paths remain in scope, and each proposed
   `afterHash` still equals the content reviewed after validation.

All model outputs use Zod schemas. A single OMA structured-output correction is
still available inside a role; task retries are disabled. Cumulative token,
configured price-based cost, wall-clock, edit-size, diff-size, context-size,
and repair-loop limits fail closed.

## Admission and state

The structured states are:

- `READY_CANDIDATE`, `NEEDS_CLARIFICATION`, `MANUAL_ONLY`, `BLOCKED`
- `AGENT_READY`, `RUNNING`
- `DRAFT_PR_PROPOSAL_READY`, `DRAFT_PR_CREATED`
- `NEEDS_HUMAN`, `FAILED`

`DRAFT_PR_PROPOSAL_READY` is intentionally separate from
`DRAFT_PR_CREATED`. The latter requires a matching host acknowledgment and
proposal hash.

Definition of Ready requires a clear problem, current and expected behavior,
verifiable acceptance criteria, target workspace and paths, explicit
out-of-scope behavior, no unresolved product or architecture decision, no
active PR/run/blocker, and fixed issue revision/base SHA. Bugs additionally
require deterministic reproduction steps or a constructible failing-test
procedure. Bounded docs, test, and single-workspace refactor tasks do not need
traditional reproduction steps when current/expected behavior, acceptance,
scope, and deterministic validation are explicit.

Architecture design, major public API changes, breaking changes, broad
cross-workspace refactors, security, permissions, privacy, licenses, CI,
release/publication, dependency upgrades without fixed compatibility targets,
trackers/discussions/questions, and work without deterministic validation are
`MANUAL_ONLY`. `riskFlags` are structured control-plane evidence reviewed by
the maintainer before granting `agent-ready`; a model may suggest risk but
cannot issue or renew authorization.

The issue revision hashes material issue fields, comments, confirmed scope,
acceptance criteria, linked work, and blockers. Editing that material after
authorization makes the authorization stale. A run key hashes repository,
issue number, issue revision, and base SHA. The base SHA is included so a
maintainer can deliberately reauthorize the same issue content against a newer
base without receiving a false duplicate.

`policyVersion` does not enter the run key because it is not itself a
maintainer authorization fact. A policy change does not silently authorize a
rerun. The control plane must revalidate the issue and issue a new
revision/base authorization when a rerun is intended; the proposal and final
safe-output gate still require the exact policy and prompt versions.

### Cross-run authority, crash, and stale semantics

`FileRunStateStore` is authoritative only inside one live engine/writer handoff.
Because GitHub-hosted runners are ephemeral, `$RUNNER_TEMP` is never the
cross-run authority. Activation v1 instead uses one status comment owned by
the precisely verified dedicated App bot, containing a bounded
machine-readable claim ledger, Actions run status, and deterministic branch/PR
metadata. The token viewer and REST actor ID/login/type must match the verified
App bot. GraphQL author/editor actors must independently match that Bot's
database ID and type; their login may use GitHub's App slug form or the REST
`[bot]` form, and email-created comments are rejected. Ordinary users and
`github-actions[bot]` markers are ignored as durable authority. The ledger
retains prior
runKeys when a later revision becomes visible and fails closed at 64 claims
instead of silently dropping idempotency history.

GitHub concurrency prevents two workflow jobs from editing the same Issue at
once. A repeated terminal runKey is a duplicate and does not invoke the model,
push, or create another PR. A lost `RUNNING` claim becomes `NEEDS_HUMAN`; the
fallback preserves its revision/runKey and automatic model-conversation resume
is forbidden. Recovery means inspecting the Actions run, ensuring the prior
work is not active, selecting a clean base or material Issue revision, removing
and reapplying authorization deliberately, and starting from a fresh model
conversation. Local checkpoints are not recovery authority.

OMA reasoning content, conversation history, telemetry, and checkpoints are
execution artifacts, not long-term repository memory and not the
cross-process authority for issue/run state.

## Context manifest and trust

Every actual model run has a persisted manifest with policy/prompt version,
issue and acceptance criteria, issue revision, base SHA, workspace map
(including the root package identity when declared),
root-to-target `AGENTS.md` chain, contribution rules, package and TypeScript
configuration, relevant docs/README/source/tests/fixtures/examples,
TypeScript/JavaScript relative-import relationships, bounded relevant Git
history and linked evidence, validation commands, and source-level SHA-256
provenance.

System policy is highest priority. Repository policies are identified
separately. Issue text, comments, commit messages, ordinary repository files,
diffs, and external material are all untrusted evidence, never instructions.
Missing target files, unresolved conflict markers, a moved base, a dirty
worktree, symlinks, required truncation/omission, byte/file limits, protected
paths, or other evidence conflicts set context sufficiency to false and route
the run to `NEEDS_HUMAN` before model edits.

`config.allowedPaths` is only the deployment-level maximum. The manifest also
records `approvedEditScopes` derived from the maintainer-authorized
`issue.targetPaths`, including whether each target is a file or directory.
Planner files, initial edits, repairs, the restricted editor, and the final
diff must pass both boundaries. A file target authorizes exactly that file; a
directory target authorizes paths below that directory.

## Tool, credential, and validation boundary

Triage, planner, and reviewer roles receive only immutable read-only evidence
tools and must read their assigned evidence at least once. Repeated reads remain
read-only but consume budget. Triage uncertainty and manual-risk arrays contain
only unresolved blockers; a safe case uses empty arrays rather than reassuring
text. The implementer also receives no write tool: it returns bounded
full-content edits with expected hashes, and deterministic host code applies
them. Every role explicitly denies built-in `bash`, file-write/edit,
delegation, and search tools. OMA `bash` is not treated as a sandbox.

The model process refuses to start when known GitHub/npm write credentials,
including credential names with host-specific prefixes, are present. Launch
the custom engine with `DEEPSEEK_API_KEY` only. In particular,
`MAINTAINER_BOT_APP_TOKEN` and the App private key never enter model or
validation environments. Validation
subprocesses receive an environment with token/key/secret/password/cookie and
credential-like variables removed. Secret values are never written to model
context, artifacts, or command output intentionally; output redaction remains
best effort.

Validation commands come only from trusted configuration. Issue or model text
cannot choose an executable, argv, cwd, or timeout. All registered commands
run, results and skipped checks are recorded, and failed or truncated evidence
blocks proposal eligibility. The current-file repair snapshots are non-symlink
regular files, path checked, per-file bounded, and capped at 180 KB total.

DeepSeek inference is remote. The minimum relevant public-repository context —
Issue text and material comments, selected repository files/history, planned
diffs, validation evidence, and fresh-review bundle — is sent to the configured
DeepSeek API. GitHub credentials, npm credentials, Actions runtime credentials,
local private paths, and model reasoning content are not intentionally sent or
published. Do not grant `agent-ready` to an Issue or repository context that
contains material that must not cross this provider boundary.

## CLI and artifacts

Build first, then use one of three commands:

```bash
node packages/maintainer-bot/dist/cli.js admit \
  --request request.json

node packages/maintainer-bot/dist/cli.js dry-run \
  --request request.json \
  --config packages/maintainer-bot/config/config.example.json

DEEPSEEK_API_KEY=... node packages/maintainer-bot/dist/cli.js run \
  --request request.json \
  --config config.json \
  --state-dir /outside/repository/state \
  --artifact-dir /outside/repository/artifacts \
  --run-id host-event-id
```

State and artifact directories must stay outside the isolated repository;
otherwise their files would correctly fail the clean-diff gate. A full run
persists `<runKey>.context.json` and, only after every gate passes,
`<runKey>.draft-pr-proposal.json`. The proposal includes issue/revision/base,
acceptance criteria, files and reasons, all validation commands/results,
skipped checks, model/prompt/policy versions, risks, fresh review, context hash,
and its own proposal hash.

`config.example.json` is a read-only fixture/canary configuration. Its
`packages/maintainer-bot` allowlist is not a production capability boundary.
The production host builds effective edit scope as trusted
`production-policy.json` allowlist intersected with the write-authorized
Issue revision's exact `targetPaths`, minus protected/manual-only paths.

`config.example.json` contains an explicit model-pricing snapshot solely for
cost-limit arithmetic. Operators must refresh those configured rates from the
current provider contract; the engine does not claim they remain current.

## gh-aw contract and actual v1 host

[`config/gh-aw-adapter.example.json`](../packages/maintainer-bot/config/gh-aw-adapter.example.json)
is a repository-owned future custom-engine contract, not an invented gh-aw workflow
schema. It keeps trigger/permission assertions, credential isolation, engine
command, immutable pin policy, host revalidation fields, and prohibited
actions auditable and replaceable. The example deliberately contains
`REQUIRED_IMMUTABLE_COMMIT_SHA`; `ghAwAdapterDefinitionSchema` rejects it until
an operator replaces it with a reviewed 40-character commit SHA.

Activation v1 does not depend on an unverified gh-aw workflow schema. The
runnable path is the repository-owned GitHub Actions workflow plus
`@open-multi-agent/maintainer-host`; the adapter contract remains available for
a later host replacement.

Before a credential-holding host creates a Draft PR, it must call
`revalidateDraftPrSafeOutput()` with the exact repository root and command
runner that will be used for the host action. The public gate first rechecks
current agent-ready authorization, issue revision/base, manifest and proposal
hashes, path scope, validation set/results, policy/prompt versions, reviewer
approval of every authorized criterion, and the matching authoritative
`DRAFT_PR_PROPOSAL_READY` run record. It then checks the actual worktree: `HEAD`
must equal the proposal base SHA, the complete changed-path set must exactly
equal `proposal.changedFiles`, and every current regular file SHA-256 must equal
its reviewed `afterHash`. Extra untracked files, deletions, renames, protected
or out-of-scope changes, changed `HEAD`, or content drift fail closed. The gate
performs no network request. Draft PR creation remains a separate deterministic
host action, and no authorization here extends to Ready, approval, merge,
close, release, publish, tag, or deploy.

The adapter boundary and schemas are locally tested. This MVP does not deep
fork gh-aw and has not been run end-to-end against a live gh-aw version.

## Status and operations

The Issue's authoritative App-owned BOT comment and Actions job summary use
these public states. The temporary repository-token bootstrap comment can only
report pre-model `NEEDS_HUMAN`; it is not part of the durable state machine.

- `STARTED`: the label delivery is visible and deterministic checks are starting.
- `RUNNING`: fixed revision/base, permission, DoR, scope, duplicate, and App identity/installation checks passed; the isolated engine is running.
- `NEEDS_CLARIFICATION`: the strict Issue template or Definition of Ready is incomplete or conflicting.
- `MANUAL_ONLY`: policy classifies the work as architecture, security, permissions, privacy, license, CI/release, broad API/refactor, uncontrolled dependency, or otherwise human-only.
- `NEEDS_HUMAN`: stale/crashed state, drift, App configuration/identity, conflicting branch/PR, or safety gate requires intervention.
- `FAILED`: infrastructure or engine failure produced no eligible Draft PR.
- `DRAFT_PR_CREATED`: exactly one open Draft PR exists; human review remains required.

To configure activation without exposing credential values:

1. Create a dedicated Maintainer Bot GitHub App. Install it on
   `open-multi-agent/open-multi-agent` only. Grant repository permissions
   **Actions: read**, **Contents: read and write**, **Issues: read and write**,
   **Metadata: read**, and **Pull requests: read and write**. No organization
   permission, webhook, event subscription, workflow-write permission, review,
   administration, or members permission is required by v1. Do not silently
   reuse the Release Bot App: its identity and permission contract are separate.
2. Store one App private key as the repository Actions secret
   `OMA_MAINTAINER_BOT_APP_PRIVATE_KEY`. Configure these repository Actions
   variables from the installed App's public metadata:
   `OMA_MAINTAINER_BOT_APP_ID`, `OMA_MAINTAINER_BOT_APP_CLIENT_ID`,
   `OMA_MAINTAINER_BOT_APP_SLUG`,
   `OMA_MAINTAINER_BOT_APP_INSTALLATION_ID`, and
   `OMA_MAINTAINER_BOT_APP_BOT_USER_ID`. The host verifies every value against
   the minted token and GitHub before a model call and again before a write.
3. Add or rotate the repository Actions secret `DEEPSEEK_API_KEY`. Never put
   either secret value in an Issue, variable, workflow file, log, artifact,
   proposal, status comment, or PR body.
4. Only after the App installation, permissions, variables, and both secrets
   are reviewed, set `OMA_MAINTAINER_BOT_APP_WRITER_ENABLED` to exact `true`.
   Missing configuration, private-key/token mint failure, an uninstalled or
   under-permissioned App, identity drift, or broader repository scope stops
   before model execution and publishes a public-safe `NEEDS_HUMAN` bootstrap
   result where the limited repository token can do so.
5. Keep **Settings → Actions → General → Workflow permissions** at read and
   keep “Allow GitHub Actions to create and approve pull requests” disabled at
   both organization and repository levels. Do not configure a PAT fallback.

The former `OMA_MAINTAINER_BOT_PR_CREATION_ENABLED` variable described a
`GITHUB_TOKEN` repository-setting attestation. It is obsolete and ignored in
App-writer mode; do not set it to `true` to simulate App readiness. An operator
may remove the stale variable separately after reviewing this migration.

The pinned token action requests only the listed repository permissions and,
because neither `owner` nor `repositories` is supplied, scopes the token to the
current repository. The host additionally rejects a token that reports access
to any other repository. Installation tokens expire after one hour; the job is
bounded to 45 minutes and the action revokes its token during job cleanup. See
the reviewed [token action contract](https://github.com/actions/create-github-app-token)
and GitHub's [installation token API](https://docs.github.com/en/rest/apps/installations).

At the implementation audit on 2026-08-11, the repository API reported
`default_workflow_permissions: read` and
`can_approve_pull_request_reviews: false` at both organization and repository
scope. Those settings are the intended App-writer configuration and were not
changed. App credentials, App variables, installation, and permissions were
not created or modified by implementation work.

To disable the bot, disable the workflow in GitHub Actions for an immediate
operational stop, set `OMA_MAINTAINER_BOT_APP_WRITER_ENABLED` to `false`, or
merge a trusted policy change setting `enabled` to `false`. A disabled/missing
App contract never runs the model or writer. For DeepSeek key rotation, verify
no run is active, replace `DEEPSEEK_API_KEY`, and revoke the old provider key.
For App key rotation, add a new private key to the same App, replace
`OMA_MAINTAINER_BOT_APP_PRIVATE_KEY`, verify a separately authorized run, then
delete the old App key. Do not log or download keys into the repository. Runs
never persist either key in state or artifacts.

The trusted pre-PR validation registry remains mandatory even though the
App-created Draft PR triggers ordinary `pull_request` CI. Operators must inspect
the actual PR checks; the bot never approves or merges based on CI alone.

## Verification and first live canary

Unit/integration tests use a mocked GitHub client and scripted OMA adapters and
need no key. The synthetic #488-style path proves that
`packages/create-oma-app/tests/runtime.test.ts` becomes an exact one-file scope,
runs both `OMA_MODEL=ambient-model` and unset focused tests, and receives the
trusted create-oma-app lint/test/template checks. Default tests make no GitHub
write and no live provider call.

A first live canary is a separate, explicitly authorized operation:

1. Confirm Issue #488 is open and `agent-ready` is absent; inspect its material
   revision rather than reusing an old authorization.
2. Configure/verify the DeepSeek secret, dedicated App installation and minimum
   permissions, App private-key secret, exact identity variables, and writer
   enablement variable. Confirm default workflow permissions remain read-only
   and the Actions create/approve setting remains disabled.
3. Verify the workflow exists on `main`, its action/runtime pins and production
   policy are reviewed, and no conflicting BOT branch/PR/run exists.
4. Reapply `agent-ready` once with a write/maintain/admin actor and observe
   STARTED/RUNNING plus run URL, ID, revision, and base SHA.
5. Verify only `packages/create-oma-app/tests/runtime.test.ts` changed, every
   registered validation passed without truncation, and exactly one Draft PR
   was created and linked.
6. Repeating the same authorization must reuse the terminal runKey/PR and must
   not create a second branch, push, or PR.
7. Confirm no Ready, approval, merge, close, release, publish, tag, or deploy
   action occurred.

Do not perform these steps during ordinary local implementation or testing.
