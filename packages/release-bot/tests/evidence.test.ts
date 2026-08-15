import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCommandRunner } from '../src/command.js'
import { collectReleaseEvidence } from '../src/evidence.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('release evidence collection', () => {
  it('anchors evidence to the latest stable core tag and exact HEAD', async () => {
    const root = await createRepository()
    const runner = new NodeCommandRunner()
    const evidence = await collectReleaseEvidence(root, runner, '2026-08-10T00:00:00.000Z')

    expect(evidence.baseTag).toBe('v1.14.0')
    expect(evidence.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(evidence.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(evidence.headSha).not.toBe(evidence.baseSha)
    expect(evidence.versions).toEqual({ core: '1.14.0', otel: '0.1.1', createOmaApp: '0.7.0' })
    expect(evidence.commits).toHaveLength(1)
    expect(evidence.commits[0]).toMatchObject({
      subject: 'feat(core): resume interrupted turns',
      body: 'Adds stable tool call replay.',
    })
    expect(evidence.changedFiles).toContainEqual({
      path: 'packages/core/src/recovery.ts',
      additions: 1,
      deletions: 0,
    })
    expect(evidence.workspaceChanges).toEqual({
      core: true,
      otel: false,
      createOmaApp: false,
      docs: true,
      workflows: false,
    })
  })
})

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-release-evidence-'))
  roots.push(root)
  const runner = new NodeCommandRunner()
  await runner.run('git', ['init'], { cwd: root })
  await runner.run('git', ['config', 'user.name', 'OMA Test'], { cwd: root })
  await runner.run('git', ['config', 'user.email', 'oma-test@example.com'], { cwd: root })

  await writeJson(root, 'packages/core/package.json', { name: '@open-multi-agent/core', version: '1.14.0' })
  await writeJson(root, 'packages/otel/package.json', { name: '@open-multi-agent/otel', version: '0.1.1' })
  await writeJson(root, 'packages/create-oma-app/package.json', { name: 'create-oma-app', version: '0.7.0' })
  await writeText(root, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## 1.14.0 - 2026-08-01\n\n- Initial.\n')
  await runner.run('git', ['add', '.'], { cwd: root })
  await runner.run('git', ['commit', '-m', 'chore: baseline'], { cwd: root })
  await runner.run('git', ['tag', 'v1.14.0'], { cwd: root })

  await writeText(root, 'packages/core/src/recovery.ts', 'export const recovery = true\n')
  await writeText(root, 'docs/checkpoint.md', 'Recovery is resumable.\n')
  await runner.run('git', ['add', '.'], { cwd: root })
  await runner.run('git', ['commit', '-m', 'feat(core): resume interrupted turns', '-m', 'Adds stable tool call replay.'], { cwd: root })
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
