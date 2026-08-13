# Maintainer Bot production architecture

## Decision

The production `agent-ready` path has one control plane, one coding engine per
run, and one credential-holding writer. It is intentionally not a general
autonomous-maintenance platform.

| Plane | Owner | Responsibilities | Must not do |
|---|---|---|---|
| Control and write plane | deterministic `@open-multi-agent/maintainer-host` | exact label/event admission, App identity and repository-scope verification, durable claim/idempotency, concurrency, base/revision pinning, target-path authority, status, final safe-output revalidation, branch/commit/push, and at most one Draft PR | model reasoning, repository coding, approval, merge, release, or publication |
| Orchestration plane | OMA in `@open-multi-agent/maintainer-bot` | admitted task sequencing, global timeout and budgets, coding-worker dispatch, deterministic validation boundary, fresh independent review, state/artifact handoff, and bounded diagnostics | hold GitHub/npm/SSH credentials, grant authorization, or create a PR |
| Coding execution plane | Claude Code with DeepSeek inside `@open-multi-agent/maintainer-runtime` | dynamically read the checked-out repository, edit only the exact authorized paths, and return bounded completion evidence as the OMA coding worker | GitHub lifecycle actions, network tools, shell, delegation, commits, branches, pushes, validation claims, or credentials other than its provider key |
| Validation plane | deterministic `@open-multi-agent/maintainer-runtime` | enforce the frozen-candidate contract, rebuild base plus the exact patch in a fresh disposable snapshot for each preregistered argv, and run it only through fixed fail-closed Bubblewrap; bind reviewed diff and file hashes to the proposal | share writable validation state between commands, run Claude-path validation on the host checkout, fall back when sandbox setup fails, or let the model choose commands |
| Decision plane | human maintainer | review ordinary PR CI and the Draft PR, then decide whether to merge | delegate merge authority to the bot |

The GitHub App installation token is present only in typed host start, claim,
finalize, and recovery processes. The engine receives the provider credential through an
inherited descriptor, then runs in an allowlisted environment without GitHub,
Actions runtime, npm, SSH, App, or other write credentials. Claude Code receives
only the provider credential and a minimal runtime environment; its Bash,
network, delegation, MCP, and out-of-scope edit capabilities remain denied.

## Production run

1. The existing `issues.labeled` workflow and host re-fetch the Issue and
   repository facts, verify `agent-ready`, App identity, authorization revision,
   pinned base, policy, duplicate claims, concurrency, and target paths.
2. The host resolves exactly one `executionBackend` from the trusted repository
   production policy and includes it in the immutable engine configuration.
3. OMA runs read-only admission triage. A rejection cannot reach either coding
   engine.
4. For `claude-code`, OMA schedules the Claude process backend as the coding
   task. Maintainer Runtime owns the restricted CLI/settings/environment and
   stream-json parser also exercised by the canary; it is not a second repository context,
   editor, or tool loop.
5. Deterministic code inspects the actual worktree and rejects deletion, rename,
   symlink, size, protected-path, or target-scope violations before writing a
   bounded validation contract. Maintainer Runtime rebuilds the pinned
   base plus that exact patch in a fresh disposable clone for each trusted
   command and runs that command through fixed `/usr/bin/bwrap`. The clone is
   discarded before the next command, so caches and build output cannot cross
   command boundaries; sandbox, resolver, snapshot, scope, output, or tracked
   candidate-integrity failure has no host fallback and produces no proposal.
6. OMA gives an independent reviewer only confirmed requirements, the final
   bounded diff/current files, and deterministic validation evidence. It does
   not receive the coding transcript.
7. Only an approved, fully validated, hash-bound proposal reaches the existing
   App writer, which re-fetches authorization and revalidates the actual
   worktree before creating at most one Draft PR.

The built-in generic process backend remains the OMA scheduling primitive, but
is not by itself the security boundary: it merges the parent environment, has
no protocol-level permission gate, and reports no token usage. The thin
repository-specific adapter supplies the already-canary-tested credential
scrubbing, Claude permissions, sandbox settings, turn/wall-clock/output limits,
and terminal stream parser. ACP is not used because the current production
path has no validated Claude ACP integration and ACP permission defaults would
not reproduce the proven canary contract.

Token usage and configured price-based cost are recorded for OMA LLM calls such
as triage and fresh review (and the legacy-only planner/implementer/repair
calls), but do not stop this internal workflow. The compatibility policy fields
`maxTokenBudget` and `maxCostUsd` are not production enforcement boundaries.
The generic process backend currently reports zero token usage for the Claude
coding worker; zero is an unknown/not-reported value, not evidence that Claude
used no tokens or incurred no provider cost. Claude coding is instead bounded
by pinned max turns, wall clock, process output, changed-path/file, file-size,
and diff-size limits. A future exact Claude usage meter would require a separate
trusted contract and is not inferred in this integration.

## Migration and rollback

`packages/maintainer-host/config/production-policy.json` contains the single
mutually exclusive selector:

- `"executionBackend": "legacy"` keeps the existing custom
  context/planner/implementer/repair engine as a migration-only rollback.
- `"executionBackend": "claude-code"` selects the OMA-scheduled Claude coding
  worker and independent OMA review path.

There is no second workflow variable or per-step fallback. The selected value
is resolved before admission and is immutable for that run. A Claude failure
fails the run closed; it never falls through to the legacy engine. Conversely,
a legacy run never invokes Claude. The durable run claim, deterministic branch,
and existing-PR checks remain shared, so retrying or changing the selector
cannot create a second concurrent engine, branch, or PR for the same authorized
run key. Existing-PR reuse also requires the App-owned status ledger's recorded
head SHA to equal the PR's current head; branch drift fails closed.

The legacy engine is frozen: do not add repository-reading, planning, editing,
or repair capability to it. Keep it only until the supervised Claude beta has
sufficient evidence and a separate removal decision is approved. Rollback is a
reviewed repository policy change back to `legacy`, followed by ordinary CI;
never switch backend inside an already claimed run.

## Threat model and failure posture

The design assumes Issue text, comments, repository files, diffs, CLI output,
and model output may be malicious. It also assumes a model may attempt scope
expansion, credential discovery, network egress, persistence, excessive output,
or lifecycle writes; a workflow may be retried; the base or Issue may move; and
a process may crash between claim and finalization.

Controls are layered: exact authenticated admission and GitHub-native durable
claims; one backend enum; credential-separated processes; Claude tool and
sandbox denies; pinned base/turn/timeout/output limits; pre-validation path and
file checks; trusted argv-only validation; fresh independent review; final
worktree/hash revalidation; and a GitHub App writer that creates Draft PRs only.
Failures return a bounded, redacted, actionable stage/reason and create no PR.
Lost `RUNNING` claims remain human-recovery cases rather than automatic resume.

The workflow control plane is compiled TypeScript, not inline Actions
JavaScript. It intentionally uses two App-authenticated phases: `start`
verifies the event snapshot, App identity, and workflow/default/local SHA
identity and writes a hash-bound, non-durable `STARTED` artifact; only after
runtime installation and sandbox preflight does `prepare` verify that artifact
and establish the durable claim. This preserves the rule that a runner setup
failure cannot manufacture a stale `RUNNING` claim. A typed repository-token
fallback can publish only a non-authoritative `FAILED` bootstrap notice, while
typed App recovery preserves a prior terminal claim or fails an interrupted
active claim closed.

## Supervised beta activation

The checked-in production policy selects `claude-code` for the supervised beta.
Rollback requires a separately reviewed change of the same selector to
`legacy`; there is no runtime fallback. This policy activation does not change
any Secret, repository variable, permission, label, Issue, or Actions setting.
Local scripted tests are not live model or canary evidence.
