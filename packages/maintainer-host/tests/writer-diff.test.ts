import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { NodeCommandRunner, canonicalGitDiffArgs, sha256 } from '@open-multi-agent/maintainer-bot'
import { assertFrozenCandidateDiff } from '../src/writer.js'

const exec = promisify(execFile)

describe('writer exact candidate binding with real Git', () => {
  it('accepts the same canonical new-file bytes at source, staged index, and committed tree', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'oma-writer-new-file-'))
    await exec('git', ['init', '--quiet'], { cwd: repoRoot })
    await exec('git', ['config', 'user.name', 'OMA test'], { cwd: repoRoot })
    await exec('git', ['config', 'user.email', 'oma-test@example.com'], { cwd: repoRoot })
    await writeFile(join(repoRoot, 'base.txt'), 'base\n')
    await exec('git', ['add', 'base.txt'], { cwd: repoRoot })
    await exec('git', ['commit', '--quiet', '-m', 'base'], { cwd: repoRoot })
    const { stdout: baseOutput } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    const baseSha = baseOutput.trim()
    await writeFile(join(repoRoot, 'new.txt'), 'hello\n')

    const noIndexArgs = canonicalNoIndexDiffArgs('new.txt')
    const source = await new NodeCommandRunner().run('git', noIndexArgs, {
      cwd: repoRoot,
      allowFailure: true,
    })
    expect(source.exitCode).toBe(1)
    const expectedHash = sha256(source.stdout)

    await exec('git', ['add', 'new.txt'], { cwd: repoRoot })
    await expect(assertFrozenCandidateDiff({
      runner: new NodeCommandRunner(), repoRoot, paths: ['new.txt'], mode: 'cached',
      expectedHash, driftMessage: 'staged drift',
    })).resolves.toBeUndefined()

    await exec('git', ['commit', '--quiet', '-m', 'new'], { cwd: repoRoot })
    await expect(assertFrozenCandidateDiff({
      runner: new NodeCommandRunner(), repoRoot, paths: ['new.txt'], mode: 'committed', baseSha,
      expectedHash, driftMessage: 'committed drift',
    })).resolves.toBeUndefined()
  })
})

function canonicalNoIndexDiffArgs(path: string): string[] {
  const args = canonicalGitDiffArgs({ paths: ['/dev/null', path] })
  const separator = args.indexOf('--')
  return [...args.slice(0, separator), '--no-index', ...args.slice(separator)]
}
