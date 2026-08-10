# Releasing

This repository publishes three packages from one npm workspaces root. This file
records what ships, in what order, and what CI proves at each stage. The
day-to-day contribution flow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## What ships

| Package | Version track | Tagged | Published |
|---|---|---|---|
| `@open-multi-agent/core` | The trunk. Git tags and GitHub Releases track this version. | `vX.Y.Z` | Every release |
| `@open-multi-agent/otel` | Independent. Depends on core through a semver range, so a core release does not force a republish. | No tag | Only when it changes |
| `create-oma-app` | Independent. Its templates pin core exactly, so it ships alongside every core release. | No tag | Every core release |

The root `package.json` is `private` and is never published. Each published
package sets `publishConfig.access` to `public`, so no extra access flag is
needed at publish time.

## Versioning and tags

- Only core is tagged. Tags are `vX.Y.Z` matching the core version, lightweight
  rather than annotated, pointing at the release commit.
- `@open-multi-agent/otel` and `create-oma-app` carry their own version numbers
  and are not tagged.
- [`CHANGELOG.md`](../CHANGELOG.md) is a single root file keyed by core version,
  with an `## Unreleased` section at the top.

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

Publishing is manual. No workflow in `.github/workflows/` publishes to npm, and
none is triggered by pushing a tag.

1. **Land the release commit on `main`** through a pull request, with CI green.
   Everything below is cut from that commit.
2. **Publish to npm in order: `core`, then `otel` when it is part of this
   release, then `create-oma-app`.** create-oma-app pins core exactly, so core
   has to resolve from the registry before a freshly scaffolded project can
   install. otel depends on core through a normal dependency, so it also needs
   core live first.
3. **Tag the release commit `vX.Y.Z` and push the tag.** The tag comes after
   publishing on purpose: an npm version can never be republished, while an
   unpushed tag costs nothing to redo, so a publish that goes wrong leaves no
   tag pointing at a version that is not on the registry. Note that
   `git push --follow-tags` skips lightweight tags, so push the tag explicitly.
4. **Publish the GitHub Release last**, after every package for that version is
   live on npm. Publishing it triggers `release-smoke.yml`, which resolves the
   published packages from the real registry. Releasing before they are live
   makes that run fail.

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
