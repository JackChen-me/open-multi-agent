import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyReleasePlan,
  buildReleasePrBody,
  buildReleasePrTitle,
  composeReleaseBody,
  insertReleaseEntry,
  renderReleaseNotes,
} from '../src/apply-plan.js'
import type { ReleasePlan } from '../src/schema.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const plan: ReleasePlan = {
  schemaVersion: 1,
  baseTag: 'v1.14.0',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  releaseDate: '2026-08-10',
  currentVersions: { core: '1.14.0', otel: '0.1.1', createOmaApp: '0.7.0' },
  nextVersions: { core: '1.15.0', otel: '0.1.1', createOmaApp: '0.8.0' },
  bumps: { core: 'minor', otel: null, createOmaApp: 'minor' },
  summary: 'Release durable recovery and structured tool results.',
  changelog: {
    breakingChanges: [],
    added: ['Durable recovery resumes interrupted agent turns without rerunning already committed tool results.'],
    changed: [],
    fixed: ['Structured tool results preserve validated application-owned data.'],
    security: [],
    compatibility: ['Existing checkpoint snapshots remain readable.'],
  },
  risks: [],
  rationale: ['Merged features are additive and user-visible.'],
  review: { verdict: 'approve', issues: [], rationale: ['Evidence and package selection agree.'] },
}

describe('release plan materialization', () => {
  it('updates only known manifests, exact template pins, and changelog', async () => {
    const root = await createFixture()
    const changed = await applyReleasePlan(root, plan)

    expect(new Set(changed)).toEqual(new Set([
      'packages/core/package.json',
      'packages/create-oma-app/package.json',
      'packages/create-oma-app/template/package.json',
      'packages/create-oma-app/templates/demo/package.json',
      'packages/create-oma-app/templates/pr-review/package.json',
      'packages/create-oma-app/templates/security/package.json',
      'CHANGELOG.md',
    ]))
    expect(await version(root, 'packages/core/package.json')).toBe('1.15.0')
    expect(await version(root, 'packages/otel/package.json')).toBe('0.1.1')
    expect(await version(root, 'packages/create-oma-app/package.json')).toBe('0.8.0')

    for (const path of [
      'packages/create-oma-app/template/package.json',
      'packages/create-oma-app/templates/demo/package.json',
      'packages/create-oma-app/templates/pr-review/package.json',
      'packages/create-oma-app/templates/security/package.json',
    ]) {
      const manifest = JSON.parse(await readFile(join(root, path), 'utf8')) as {
        dependencies: Record<string, string>
      }
      expect(manifest.dependencies['@open-multi-agent/core']).toBe('1.15.0')
    }

    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain('## Unreleased\n\n## 1.15.0 - 2026-08-10')
    expect(changelog).toContain('### Added')
    expect(changelog).not.toContain('Existing manually curated note.')
    expect(changelog).toContain('## 1.14.0 - 2026-08-01')
    expect(Math.max(...changelog.split('\n').map(line => line.length))).toBeLessThanOrEqual(80)
  })

  it('bumps the otel version constant alongside package.json when otel releases', async () => {
    const root = await createFixture()
    const otelPlan: ReleasePlan = {
      ...plan,
      nextVersions: { ...plan.nextVersions, otel: '0.1.2' },
      bumps: { ...plan.bumps, otel: 'patch' },
    }
    const changed = await applyReleasePlan(root, otelPlan)

    expect(changed).toContain('packages/otel/src/version.ts')
    expect(await version(root, 'packages/otel/package.json')).toBe('0.1.2')
    const versionTs = await readFile(join(root, 'packages/otel/src/version.ts'), 'utf8')
    expect(versionTs).toContain("export const PACKAGE_VERSION = '0.1.2'")
  })

  it('does not duplicate Unreleased content into the new release section', () => {
    const changelog = insertReleaseEntry(
      '# Changelog\n\n## Unreleased\n\n### Added\n\n- Handwritten leftover.\n\n## 1.14.0 - 2026-08-01\n\nOld.\n',
      plan,
    )
    expect(changelog).not.toContain('Handwritten leftover.')
    expect((changelog.match(/### Added/g) ?? []).length).toBe(1)
  })

  it('unwraps hard-wrapped changelog prose for GitHub Release rendering', () => {
    const changelog = insertReleaseEntry(
      '# Changelog\n\n## Unreleased\n\n## 1.14.0 - 2026-08-01\n\nOld.\n',
      plan,
    )
    const notes = renderReleaseNotes(changelog, '1.15.0')
    expect(notes).toContain('- Durable recovery resumes interrupted agent turns without rerunning already committed tool results.')
    expect(notes).not.toMatch(/results\.\n\s+without/)
  })

  it('renders the model and deterministic authority boundary in the PR body', () => {
    const body = buildReleasePrBody(plan)
    expect(body).toContain('explicit four-task DAG')
    expect(body).toContain('Version calculation, template pins')
    expect(body).toContain('Merging this PR is the human release approval')
  })

  it('titles a two-package release with core and the scaffolder', () => {
    expect(buildReleasePrTitle(plan)).toBe('chore: release core v1.15.0 and create-oma-app v0.8.0')
  })

  it('names otel in the title when otel is part of the release', () => {
    // v1.18.0 published otel 0.1.3 under a title that named two packages,
    // because the title hard-coded them while the body's table did not.
    const otelPlan: ReleasePlan = {
      ...plan,
      nextVersions: { ...plan.nextVersions, otel: '0.1.2' },
      bumps: { ...plan.bumps, otel: 'patch' },
    }

    expect(buildReleasePrTitle(otelPlan))
      .toBe('chore: release core v1.15.0, otel v0.1.2, and create-oma-app v0.8.0')
  })

  it('keeps the prefix prepareReleasePr matches on in both shapes', () => {
    const otelPlan: ReleasePlan = { ...plan, bumps: { ...plan.bumps, otel: 'patch' } }
    const prefix = /^chore: release core v\d+\.\d+\.\d+\b/i

    expect(buildReleasePrTitle(plan)).toMatch(prefix)
    expect(buildReleasePrTitle(otelPlan)).toMatch(prefix)
  })
})

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-release-plan-'))
  temporaryRoots.push(root)
  await writeJson(root, 'packages/core/package.json', { name: '@open-multi-agent/core', version: '1.14.0' })
  await writeJson(root, 'packages/otel/package.json', { name: '@open-multi-agent/otel', version: '0.1.1' })
  await writeText(root, 'packages/otel/src/version.ts', "export const PACKAGE_VERSION = '0.1.1'\n")
  await writeJson(root, 'packages/create-oma-app/package.json', { name: 'create-oma-app', version: '0.7.0' })
  for (const path of [
    'packages/create-oma-app/template/package.json',
    'packages/create-oma-app/templates/demo/package.json',
    'packages/create-oma-app/templates/pr-review/package.json',
    'packages/create-oma-app/templates/security/package.json',
  ]) {
    await writeJson(root, path, {
      private: true,
      dependencies: { '@open-multi-agent/core': '1.14.0' },
    })
  }
  await writeText(root, 'CHANGELOG.md', `# Changelog

## Unreleased

### Changed

- Existing manually curated note.

## 1.14.0 - 2026-08-01

- Old release.
`)
  return root
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await writeText(root, path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, value)
}

async function version(root: string, path: string): Promise<string> {
  return (JSON.parse(await readFile(join(root, path), 'utf8')) as { version: string }).version
}

describe('published release body', () => {
  const packages = [
    { name: '@open-multi-agent/core', version: '1.15.0', changed: true },
    { name: '@open-multi-agent/otel', version: '0.1.1', changed: false },
    { name: 'create-oma-app', version: '0.8.0', changed: true },
  ]

  it('states what shipped, what did not, and how to install it', () => {
    const body = composeReleaseBody({ notes: '### Added\n\n- Something.', coreVersion: '1.15.0', packages })

    expect(body).toContain('### Added')
    expect(body).toContain('- `@open-multi-agent/core`: `1.15.0`')
    expect(body).toContain('- `@open-multi-agent/otel`: remains at `0.1.1` and is not republished')
    expect(body).toContain('- `create-oma-app`: `0.8.0`; generated starters pin core `1.15.0`')
    expect(body).toContain('npm i @open-multi-agent/core@1.15.0')
  })

  it('keeps every line unwrapped so GFM hard breaks add no line breaks', () => {
    // A release body renders with GFM hard line breaks, where a wrapped
    // paragraph becomes a column of <br>-separated fragments.
    const body = composeReleaseBody({ notes: '### Added\n\n- Something.', coreVersion: '1.15.0', packages })
    const continuations = body
      .split('\n')
      .filter(line => line.length > 0 && /^\s+\S/.test(line))

    expect(continuations).toEqual([])
  })

  it('@-mentions a contributor whose name is a confirmed GitHub login', () => {
    const body = composeReleaseBody({
      notes: '### Added\n\n- Something.',
      coreVersion: '1.15.0',
      packages,
      contributors: [{ name: 'green3sf', isLogin: true, contributions: ['add a verify loop (#541)'] }],
    })

    expect(body).toContain('- @green3sf: add a verify loop (#541)')
  })

  it('leaves a display-name fallback unmentioned so it cannot notify a stranger', () => {
    // v1.17.0 credited `s4kura` for #549 when the author was `Iams4kura`. An
    // unresolved display name is not a handle, and this body is published
    // without anyone reviewing it, so it must never become an @-mention.
    const body = composeReleaseBody({
      notes: '### Added\n\n- Something.',
      coreVersion: '1.15.0',
      packages,
      contributors: [{ name: 'Ada Lovelace', isLogin: false, contributions: ['tighten a guard (#12)'] }],
    })

    expect(body).toContain('- Ada Lovelace: tighten a guard (#12)')
    expect(body).not.toContain('@Ada Lovelace')
  })

  it('refuses a package set that does not carry core', () => {
    expect(() => composeReleaseBody({
      notes: '### Added',
      coreVersion: '1.15.0',
      packages: packages.filter(item => item.name !== '@open-multi-agent/core'),
    })).toThrow(/missing the @open-multi-agent\/core package summary/)
  })

  it('refuses a core version that disagrees with the rendered notes', () => {
    expect(() => composeReleaseBody({
      notes: '### Added',
      coreVersion: '1.15.1',
      packages,
    })).toThrow(/does not match the rendered notes/)
  })
})
