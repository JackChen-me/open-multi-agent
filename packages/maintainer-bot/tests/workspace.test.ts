import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/hash.js'
import { applyRestrictedEdits } from '../src/workspace.js'
import { testConfig } from './helpers.js'

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-workspace-'))
  await mkdir(join(root, 'packages/demo/src'), { recursive: true })
  await writeFile(join(root, 'packages/demo/src/greeting.ts'), 'export const greeting = "."\n')
  return root
}

describe('restricted compare-and-swap edits', () => {
  it('updates an allowed file only when its expected hash matches', async () => {
    const root = await fixtureRoot()
    const before = await readFile(join(root, 'packages/demo/src/greeting.ts'))
    await chmod(join(root, 'packages/demo/src/greeting.ts'), 0o755)
    const edits = await applyRestrictedEdits({
      repoRoot: root,
      config: testConfig(),
      approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' }],
      implementation: {
        summary: 'Fix greeting punctuation.',
        assumptions: [],
        risks: [],
        edits: [{
          path: 'packages/demo/src/greeting.ts',
          expectedHash: sha256(before),
          content: 'export const greeting = "!"\n',
          reason: 'Match the accepted output.',
        }],
      },
    })
    expect(edits[0]).toMatchObject({ created: false, beforeHash: sha256(before) })
    expect(await readFile(join(root, 'packages/demo/src/greeting.ts'), 'utf8')).toContain('"!"')
  })

  it('supports a bounded new file under an existing allowed directory', async () => {
    const root = await fixtureRoot()
    const result = await applyRestrictedEdits({
      repoRoot: root,
      config: testConfig(),
      approvedEditScopes: [{ path: 'packages/demo/src', kind: 'directory' }],
      implementation: {
        summary: 'Add a focused test.', assumptions: [], risks: [],
        edits: [{
          path: 'packages/demo/src/greeting.test.ts',
          expectedHash: null,
          content: 'export const expected = "!"\n',
          reason: 'Cover the acceptance criterion.',
        }],
      },
    })
    expect(result[0]?.created).toBe(true)
  })

  it('rejects protected, out-of-scope, stale, and symlink edits', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await writeFile(join(root, '.github/workflows/ci.yml'), 'name: CI\n')
    await symlink(join(root, 'packages/demo/src/greeting.ts'), join(root, 'packages/demo/src/link.ts'))
    const base = { summary: 'Unsafe.', assumptions: [], risks: [] }
    await expect(applyRestrictedEdits({
      repoRoot: root,
      config: testConfig({ allowedPaths: ['packages/demo', '.github'] }),
      approvedEditScopes: [{ path: '.github/workflows/ci.yml', kind: 'file' }],
      implementation: { ...base, edits: [{
        path: '.github/workflows/ci.yml', expectedHash: sha256('name: CI\n'), content: 'x', reason: 'Unsafe.',
      }] },
    })).rejects.toThrow(/protected/)
    await expect(applyRestrictedEdits({
      repoRoot: root,
      config: testConfig(),
      approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' }],
      implementation: { ...base, edits: [{
        path: 'README.md', expectedHash: null, content: 'x', reason: 'Outside.',
      }] },
    })).rejects.toThrow(/allowlist/)
    await expect(applyRestrictedEdits({
      repoRoot: root,
      config: testConfig(),
      approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' }],
      implementation: { ...base, edits: [{
        path: 'packages/demo/src/greeting.ts', expectedHash: '0'.repeat(64), content: 'x', reason: 'Stale.',
      }] },
    })).rejects.toThrow(/hash mismatch/)
    await expect(applyRestrictedEdits({
      repoRoot: root,
      config: testConfig(),
      approvedEditScopes: [{ path: 'packages/demo/src/link.ts', kind: 'file' }],
      implementation: { ...base, edits: [{
        path: 'packages/demo/src/link.ts', expectedHash: null, content: 'x', reason: 'Symlink.',
      }] },
    })).rejects.toThrow(/non-symlink/)
  })

  it('does not write during a dry-run', async () => {
    const root = await fixtureRoot()
    const path = join(root, 'packages/demo/src/greeting.ts')
    const before = await readFile(path)
    await applyRestrictedEdits({
      repoRoot: root,
      config: testConfig(),
      approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' }],
      dryRun: true,
      implementation: {
        summary: 'Preview.', assumptions: [], risks: [],
        edits: [{ path: 'packages/demo/src/greeting.ts', expectedHash: sha256(before), content: 'changed\n', reason: 'Preview.' }],
      },
    })
    expect(await readFile(path)).toEqual(before)
  })
})
