# Releasing

This repository publishes three packages from one npm workspaces root. A fourth
private workspace, `@open-multi-agent/release-bot`, prepares and executes the
repository-specific workflow but is never published. This file records what
ships, in what order, and what CI proves at each stage. The day-to-day
contribution flow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## What ships

| Package | Version track | Tagged | Published |
|---|---|---|---|
| `@open-multi-agent/core` | The trunk. Git tags and GitHub Releases track this version. | `vX.Y.Z` | Every release |
| `@open-multi-agent/otel` | Independent. Depends on core through a semver range, so a core release does not force a republish. | No tag | Only when it changes |
| `create-oma-app` | Independent. Its templates pin core exactly, so it ships alongside every core release. | No tag | Every core release |

The root `package.json` is `private` and is never published. Each published
package sets `publishConfig.access` to `public`, so no extra access flag is
needed at publish time.

## Release bot and authority boundary

[`packages/release-bot`](../packages/release-bot/README.md) uses OMA itself to
prepare a release. Its fixed `runTasks()` graph runs change analysis and
compatibility review in parallel, then a planner and an independent reviewer.
All four agents use DeepSeek V4 Flash. Only the two evidence roles receive
narrow, read-only tools: immutable evidence, the release contract, and one
deterministic risk-ranked, size-bounded diff bundle whose paths are selected by
code rather than the model. The planner and reviewer consume the immutable
summary and structured dependency reports. Model output is restricted to
version bump classes and changelog prose; deterministic code owns concrete
versions, the allowed file set, template pins, validation, Git/GitHub
mutations, package order, registry checks, tags, and GitHub Releases.

Each DAG task has one task-level attempt; malformed structured output may use
OMA's single in-run correction, but the whole role is not restarted. Per-role
turn and output budgets bound model work, and the complete planning DAG aborts
after thirty minutes. When core changes but `packages/create-oma-app` does not,
deterministic policy maps core's bump to a create-oma-app bump by breaking
nature: a core major bumps create-oma-app minor (its 0.x minor position carries
the "breaking" signal), and any non-breaking core bump bumps create-oma-app
patch. The planner's scaffolder bump class is authoritative only when that
workspace has merged changes of its own; normalization occurs before
independent review.

The weekly workflow creates a **ready** release PR automatically. A maintainer
reviews and merges it manually. Merge is the release approval, but it is not a
model tool approval: publication happens in a separate deterministic workflow
only after `CI` succeeds on the exact merged release commit.

Repository content is treated as untrusted evidence. Agents never receive
`bash`, write tools, GitHub credentials, npm credentials, or publish tools. A
rejected or invalid structured plan fails closed without creating a branch.

### One-time activation

The workflows require all of the following external configuration:

1. Install a repository-scoped GitHub App with **Contents: read/write** and
   **Pull requests: read/write**. Set its client ID as the repository variable
   `RELEASE_BOT_APP_CLIENT_ID` and private key as the secret
   `RELEASE_BOT_APP_PRIVATE_KEY`.
2. Add `DEEPSEEK_API_KEY` as a repository Actions secret.
3. Create a GitHub environment named `npm-release`. Environment reviewers are
   optional; merging the release PR is already the required human approval.
4. For each of the three npm packages, configure a GitHub Actions trusted
   publisher for organization `open-multi-agent`, repository
   `open-multi-agent`, workflow filename `publish.yml`, environment
   `npm-release`, and the `npm publish` action.

The GitHub App token is required rather than the repository `GITHUB_TOKEN` so
the automatically created PR starts normal CI and the published GitHub Release
starts `release-smoke.yml`. npm publication uses short-lived OIDC credentials;
there is no `NPM_TOKEN`. Trusted publishing currently requires a GitHub-hosted
runner, Node 22.14 or newer, npm 11.5.1 or newer, and `id-token: write`.

## Versioning and tags

- Only core is tagged. Tags are `vX.Y.Z` matching the core version, lightweight
  rather than annotated, pointing at the release commit.
- `@open-multi-agent/otel` and `create-oma-app` carry their own version numbers
  and are not tagged.
- [`CHANGELOG.md`](../CHANGELOG.md) is a single root file keyed by core version,
  with an `## Unreleased` section at the top.

## What earns a changelog entry

[`CHANGELOG.md`](../CHANGELOG.md) documents what a consumer of the published
packages experiences. The test is mechanical: an entry is warranted when the
change reaches a consumer through the public API surface, runtime behavior, or
a file that ships in an npm tarball. Each package's `files` field is the
authority on what ships; for `@open-multi-agent/core` that is `dist`,
`README.md`, and `LICENSE`.

Warranted:

- a public export added, removed, renamed, or changed in signature
- runtime behavior an unchanged caller can observe
- content in a shipped file, including `README.md` and the JSDoc that `dist`
  carries into the published `.d.ts` files

Not warranted:

- `@open-multi-agent/release-bot`, which is private and never published
- the release process and repository automation
- examples, fixtures, tests, CI configuration, and tsconfig files, none of
  which ship
- a defect introduced and fixed between two releases, because no published
  version ever carried it

A comment-only diff changes a shipped file only when that comment reaches
`dist`. Documentation under `docs/` does not ship; describe a provider or
runtime behavior it documents only when that behavior is itself part of the
release.

When a change is genuinely ambiguous, leave it out. The release PR diff carries
every commit regardless, so a maintainer still sees it.

## Breaking changes

Decide whether a release contains one before the release commit, not while
writing release notes. A change is breaking when it can stop working for a
caller who did nothing but upgrade:

- the `engines` floor rises
- a published direct dependency crosses a major version
- input that an earlier release accepted is now rejected
- a public export is removed, renamed, or has its signature narrowed

A conventional-commits `!` marker on a merged commit signals that one landed,
but it is not a substitute for the steps below, because nothing carries it
through to a reader of the release.

When a release contains a breaking change:

- [`CHANGELOG.md`](../CHANGELOG.md) opens that version with a
  `### Breaking changes` section above `### Added`, naming what breaks and what
  the caller has to do.
- The GitHub Release repeats it as its first section, not as a note near the
  end.
- Weigh the version number against how far the change reaches. 1.14.0 raised the
  `engines` floor to Node 20 and moved `openai` from v4 to v6 while shipping as
  a minor, so every `^1.x` caller on Node 18 received it automatically. npm
  treats an `engines` mismatch as an `EBADENGINE` warning rather than an install
  failure, which means those projects install successfully and fail later at run
  time.

## The release commit

Version bumps land on `main` through a normal pull request before anything is
published. A release commit contains:

- the version bump in `packages/core/package.json`
- the version bump in `packages/otel/package.json`, when otel is part of this
  release
- the version bump in `packages/create-oma-app/package.json`
- the new core version pinned in every create-oma-app template manifest:
  - `packages/create-oma-app/templates/demo/package.json`
  - `packages/create-oma-app/templates/pr-review/package.json`
  - `packages/create-oma-app/templates/security/package.json`
  - `packages/create-oma-app/template/package.json`, the shared base
- the `CHANGELOG.md` entry, moved out of `## Unreleased`
- the regenerated `package-lock.json`

The three package manifests are what users receive, and their package versions
remain independent as described above. The `package` job in `ci.yml` asserts
that every `templates/*/package.json` overlay pins the current core version; it
does not require the otel or create-oma-app package version to equal core. The
base template manifest is not covered by that assertion and is not user-facing
either, because every overlay ships its own `package.json` that overwrites the
base copy at scaffold time. Keep it in sync anyway so local tooling and the base
layer do not disagree with the release, but a stale pin there does not reach a
generated project. See
[`packages/create-oma-app/AGENTS.md`](../packages/create-oma-app/AGENTS.md) for
the full set of template traps.

## Order

1. **Prepare a release PR.** `release-bot.yml` runs each Friday at 10:23 UTC
   (18:23 Asia/Taipei) and is also manually dispatchable. It exits successfully
   without calling a model when a release PR is already open, no commits exist
   after the latest core tag, or `packages/core` did not change. Otherwise it
   plans the release,
   updates the known manifests, pins, changelog, and lockfile, runs root lint,
   test, and build validation, pushes a `release-bot/core-vX.Y.Z` branch, and
   opens a ready PR.
2. **Review and merge the release commit into `main`.** Branch protection and
   the normal PR CI remain authoritative. Never merge a release proposal merely
   because its model reviewer approved it.
3. **Wait for `CI` on the exact merged release commit.** A successful `CI`
   workflow run on `main` triggers `publish.yml`, which reads the `version`
   field of the core and create-oma-app manifests at that commit and at its
   first parent and stops before the publish job unless both moved. The
   publisher then re-derives the same fact and refuses a commit whose versions
   did not increment, so later unrelated commits cannot accidentally publish.
   Reading the version rather than asking whether those manifests changed at
   all is what keeps an ordinary dependency or metadata edit from starting a
   job that mints a write-scoped token and then fails closed.
4. **Publish to npm in order: `core`, then `otel` when its declared version is
   not already live, then `create-oma-app`.** The publisher checks the public
   registry before every action and waits for each new version to resolve
   before continuing. Rerunning the exact release commit resumes a partial
   publication rather than attempting to republish an immutable npm version.
5. **Tag the release commit `vX.Y.Z` and push the tag.** The lightweight tag is
   still created only after every expected package is visible. An existing tag
   must point to the exact release commit, and a tag with missing packages is a
   hard failure.
6. **Publish the GitHub Release last.** The GitHub App event triggers
   `release-smoke.yml`, which resolves the real registry bytes. An existing
   matching Release is treated as an idempotent resume.

For recovery, manually dispatch `publish.yml` with the exact merged release
commit SHA. The workflow verifies that the SHA is reachable from `main` and has
an already successful `CI` run; it does not accept a branch name, failed CI, or
an arbitrary working tree.

## Release notes are not a copy of the changelog

The two are rendered under different rules. [`CHANGELOG.md`](../CHANGELOG.md) is
hard-wrapped at 80 columns, which is correct for a repository file because GitHub
joins a single newline into a space there. A release body is rendered with GFM
hard line breaks, where every newline becomes a `<br>`, so pasted wrapped text
turns into a column of lines that look truncated at 80 characters.

Unwrap each paragraph and list item onto a single line before publishing, and
check the draft first:

```bash
jq -Rs '{text: ., mode: "gfm"}' < notes.md | gh api /markdown --input - | grep -c '<br>'
```

That endpoint matches what the release page renders. A correct release body
returns `0`.

The published body is the version's changelog section followed by three sections
the changelog does not carry. `## Packages` names every workspace version and
says which ones were not republished. `## Thanks` credits contributors from
outside the project, resolved from the commits between the previous release tag
and the release commit, with the maintainer's own commits and bot commits
excluded. Each contributor is credited by GitHub login: a noreply address
carries it, and any other address is resolved by asking GitHub which account
claims the commit, falling back to the commit's display name when no account
does. `## Install` is copy-pasteable. All three are derived from the release
commit and its own manifests, so no model output reaches them.

## What CI proves

### Before merge

`ci.yml` runs on every push and pull request targeting `main`.

- **`package`** builds every workspace, then:
  - imports each core entry point, runs the CLI help, and exercises the
    evaluation gate on both its pass and fail paths
  - asserts the core, otel, and create-oma-app tarballs ship exactly the
    expected files
  - packs core, installs it, and smoke-tests the installed `oma` bin
  - asserts `templates/*/package.json` pin the current core version, and
    typechecks the template against core
  - resolves the lowest core version allowed by otel's dependency range, packs
    it from npm, and installs the real core and otel tarballs into clean
    consumers
- **`scaffold-e2e`** runs `npm run test:scaffold`: pack, scaffold, install, and
  run, all from local tarballs.
- **`lint`**, **`test`** across Node 20/22/24, and **`coverage`** cover the rest.

Running `npm pack --dry-run` inside a package locally mirrors the tarball
assertion CI performs.

### After the GitHub Release

`release-smoke.yml` triggers on `release: published` and runs two independent
jobs against the real registry.

**`npx-scaffold`** proves the published bytes work from a user's point of view:

- `npx create-oma-app@latest <project> --template pr-review --provider cloud`
- the generated `package.json` pins `@open-multi-agent/core` at exactly the
  release tag without its leading `v`
- `npm install` resolves that same core version
- `npm run demo` succeeds with no API key set, driving the real scheduler and
  report generation from scripted responses
- `reports/` contains Markdown, JSON, and HTML output carrying the expected
  demo-mode markers

The whole chain retries up to three times with a delay, so a stale npm cache or
CDN propagation lag becomes a retry rather than a failure.

**`otel-consumer`** covers `@open-multi-agent/otel`, which has no tag of its own
and would otherwise get no post-publish coverage:

- reads the otel version from `packages/otel/package.json` at the release commit,
  since the release tag only names the core version
- installs that otel version together with the released core and pinned
  OpenTelemetry packages into a clean consumer
- asserts the resolved core is the released one, which catches a core release
  that has outgrown otel's dependency range (npm would quietly resolve an older
  core rather than fail the install)
- emits a span record through `createOtelTraceSink` and asserts it reaches an
  `InMemorySpanExporter`

When otel did not change in a given release, its version is already live from an
earlier one and this job still proves the pairing holds against the new core.

**This is a post-publish alarm, not a gate.** The release is already out when
either job runs. A red run means the published bytes are broken and a fix
release is needed; it does not block anything.
