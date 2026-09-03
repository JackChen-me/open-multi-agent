<!--
Title this PR as a conventional commit, for example `fix(core): reject empty tool names`.
A squash merge can take the title as the commit subject, and the release process reads
those subjects, so a `feat`/`fix`/`!` marker on the title carries through to the changelog.

Contribution guide:
https://github.com/open-multi-agent/open-multi-agent/blob/main/.github/CONTRIBUTING.md
-->

## Summary

<!-- What changed? Focus on behavior and outcomes rather than implementation details. -->

## Motivation

<!-- Why is this change needed? Link to an issue if applicable: Fixes #123 -->

## Scope and impact

<!--
Name the affected workspace(s) or areas, including docs and examples, CI, or release.
Call out public API or behavior changes, compatibility or migration impact,
security or privacy considerations, and intentional non-goals. Write "None"
where a category does not apply.
-->

## Validation

<!--
List the checks you actually ran and their results. Explain anything relevant
that was not run. Common checks include:
- npm run lint
- npm test
- npm run build
- npm run test:scaffold (for create-oma-app scaffolding or template changes)

Scope a check to one workspace when that is faster, for example
`npm test -w @open-multi-agent/core`. The full list of commands is in
https://github.com/open-multi-agent/open-multi-agent/blob/main/.github/CONTRIBUTING.md#running-tests
-->

## Checklist

- [ ] Tests were added or updated for changed behavior, or a rationale is provided
- [ ] User-facing documentation and examples were updated, or this is not applicable
- [ ] Compatibility, breaking changes, and migration requirements are documented, or this is not applicable
- [ ] Dependency changes are justified and preserve the [package ownership boundaries](https://github.com/open-multi-agent/open-multi-agent/blob/main/.github/CONTRIBUTING.md#code-style)
- [ ] A relevant issue is linked when one exists
