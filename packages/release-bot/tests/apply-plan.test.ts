import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyReleasePlan,
  buildReleasePrBody,
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
