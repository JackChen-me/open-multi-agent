import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/command.js'
import type { ReleaseEvidence } from '../src/schema.js'
import { createReleaseEvidenceTools } from '../src/tools.js'

const evidence: ReleaseEvidence = {
  schemaVersion: 1,
  generatedAt: '2026-08-10T00:00:00.000Z',
  baseTag: 'v1.14.0',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  versions: { core: '1.14.0', otel: '0.1.1', createOmaApp: '0.7.0' },
  commits: [],
  changedFiles: [{ path: 'packages/core/src/index.ts', additions: 1, deletions: 0 }],
  changelogUnreleased: '',
  workspaceChanges: { core: true, otel: false, createOmaApp: false, docs: false, workflows: false },
}

const neverRunner: CommandRunner = {
  run: async () => { throw new Error('runner must not be called') },
}

describe('release evidence tools', () => {
  it('provides explicit model-visible serialization for rich result data', async () => {
    const tools = createReleaseEvidenceTools({
      repoRoot: '/tmp/unused',
      runner: neverRunner,
      evidence,
    })
    const tool = tools.find(candidate => candidate.name === 'get_release_evidence')
    if (!tool) throw new Error('missing evidence tool')
    const result = await tool.execute({}, {} as never)
    expect(result.data).toEqual(evidence)
    expect(JSON.parse(String(result.modelOutput))).toEqual(evidence)
  })

  it('rejects diff access outside the immutable changed-path allowlist', async () => {
    const tools = createReleaseEvidenceTools({
      repoRoot: '/tmp/unused',
      runner: neverRunner,
      evidence,
    })
    const tool = tools.find(candidate => candidate.name === 'read_changed_diff')
    if (!tool) throw new Error('missing diff tool')
    const result = await tool.execute({ path: '.env' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.modelOutput)).toContain('not in the release evidence')
  })
})
