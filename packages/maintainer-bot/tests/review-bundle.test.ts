import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { canonicalGitDiffArgs } from '../src/command.js'
import { hashJson, sha256 } from '../src/hash.js'
import { collectReviewBundle } from '../src/review-bundle.js'
import { contextManifestSchema } from '../src/schema.js'
import { authorizedRequest, ScriptedCommandRunner, testConfig } from './helpers.js'

function manifest() {
  const request = authorizedRequest()
  const policy = '# Root policy\n'
  const sources = [{
    id: 'policy', kind: 'repository-policy' as const, locator: 'AGENTS.md',
    trust: 'repository-policy' as const, priority: 100, content: policy,
    contentHash: sha256(policy), byteLength: Buffer.byteLength(policy),
    originalByteLength: Buffer.byteLength(policy), truncated: false,
  }]
  const partial = {
    schemaVersion: 1 as const, policyVersion: 'policy-v1', promptVersion: 'prompt-v1',
    generatedAt: '2026-08-10T00:00:00Z', repository: request.issue.repository,
    issueNumber: request.issue.number, issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha, targetWorkspaces: request.issue.targetWorkspaces,
    targetPaths: request.issue.targetPaths, allowedPaths: ['packages/demo'],
    approvedEditScopes: [{ path: 'packages/demo', kind: 'directory' as const }], protectedPaths: ['.git'],
    validationCommands: testConfig().validationCommands, sources,
    retrieval: { method: 'deterministic-file-tree-import-history-v1' as const, selectedFiles: [], omittedCandidateCount: 0, importRelations: [] },
    sufficiency: { sufficient: true, errors: [], warnings: [] },
  }
  return contextManifestSchema.parse({ ...partial, manifestHash: hashJson(partial) })
}

const validation = [{ id: 'fixture-test', command: 'npm test', success: true, exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }]

describe('fresh reviewer evidence bundle', () => {
  it('collects tracked and untracked final changes with exact hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-review-bundle-'))
    await mkdir(join(root, 'packages/demo/src'), { recursive: true })
    await writeFile(join(root, 'packages/demo/src/greeting.ts'), 'new\n')
    await writeFile(join(root, 'packages/demo/src/new.ts'), 'export const added = true\n')
    const runner = new ScriptedCommandRunner((_command, args) => {
      if (args[0] === 'status') return { stdout: ' M packages/demo/src/greeting.ts\n?? packages/demo/src/new.ts\n', stderr: '', exitCode: 0 }
      if (args[0] === 'diff') return { stdout: 'diff --git a/greeting.ts b/greeting.ts\n-old\n+new\n', stderr: '', exitCode: 0 }
      throw new Error('unexpected command')
    })
    const bundle = await collectReviewBundle({
      repoRoot: root,
      request: authorizedRequest(),
      config: testConfig(),
      manifest: manifest(),
      validationResults: validation,
      runner,
    })
    expect(bundle.changedPaths).toEqual([
      'packages/demo/src/greeting.ts',
      'packages/demo/src/new.ts',
    ])
    expect(bundle.diff).toContain('new file mode 100644')
    expect(bundle.diffHash).toBe(sha256(bundle.diff))
    expect(bundle.currentFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'packages/demo/src/new.ts', contentHash: sha256('export const added = true\n') }),
    ]))
    expect(bundle.relevantContext.map(source => source.locator)).toContain('AGENTS.md')
    expect(runner.calls.find(call => call.args[0] === 'diff')?.args).toEqual(canonicalGitDiffArgs({
      baseSha: authorizedRequest().baseSha,
      paths: ['packages/demo'],
    }))
  })

  it('rejects unexpected protected changes before review', async () => {
    const runner = new ScriptedCommandRunner((_command, args) => {
      if (args[0] === 'status') return { stdout: ' M .github/workflows/ci.yml\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    await expect(collectReviewBundle({
      repoRoot: '/tmp/repository',
      request: authorizedRequest(),
      config: testConfig({ allowedPaths: ['packages/demo', '.github'] }),
      manifest: manifest(),
      validationResults: validation,
      runner,
    })).rejects.toThrow(/protected/)
  })

  it('rejects a final diff outside the issue-approved file even within config allowlist', async () => {
    const scopedManifest = {
      ...manifest(),
      approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' as const }],
    }
    const runner = new ScriptedCommandRunner((_command, args) => {
      if (args[0] === 'status') return { stdout: ' M packages/demo/src/helper.ts\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    await expect(collectReviewBundle({
      repoRoot: '/tmp/repository',
      request: authorizedRequest(),
      config: testConfig(),
      manifest: scopedManifest,
      validationResults: validation,
      runner,
    })).rejects.toThrow(/maintainer-approved issue scope/)
  })
})
