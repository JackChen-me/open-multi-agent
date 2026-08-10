import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/command.js'
import { selectReleaseReviewTargets } from '../src/evidence.js'
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

  it('selects a deterministic, cross-surface risk-ranked review set', () => {
    const reviewEvidence: ReleaseEvidence = {
      ...evidence,
      changedFiles: [
        { path: 'packages/core/tests/large.test.ts', additions: 10_000, deletions: 0 },
        { path: 'docs/guide.md', additions: 500, deletions: 0 },
        { path: 'packages/release-bot/src/publisher.ts', additions: 5, deletions: 1 },
        { path: 'packages/core/src/index.ts', additions: 1, deletions: 0 },
      ],
    }

    expect(selectReleaseReviewTargets(reviewEvidence, 2).map(target => target.path)).toEqual([
      'packages/core/src/index.ts',
      'packages/release-bot/src/publisher.ts',
    ])
  })

  it('builds one bounded bundle from bot-selected changed paths only', async () => {
    const reviewEvidence: ReleaseEvidence = {
      ...evidence,
      changedFiles: [
        { path: 'packages/core/tests/large.test.ts', additions: 10_000, deletions: 0 },
        { path: 'docs/guide.md', additions: 500, deletions: 0 },
        { path: 'packages/release-bot/src/publisher.ts', additions: 5, deletions: 1 },
        { path: 'packages/core/src/index.ts', additions: 1, deletions: 0 },
      ],
    }
    const requestedPaths: string[] = []
    const runner: CommandRunner = {
      run: async (_command, args = []) => {
        const path = args.at(-1) ?? ''
        requestedPaths.push(path)
        return { stdout: `diff for ${path} ${'x'.repeat(100)}`, stderr: '', exitCode: 0 }
      },
    }
    const tools = createReleaseEvidenceTools({
      repoRoot: '/tmp/unused',
      runner,
      evidence: reviewEvidence,
      maxReviewTargets: 2,
      maxReviewBundleChars: 25,
      maxReviewDiffCharsPerFile: 20,
    })
    const tool = tools.find(candidate => candidate.name === 'read_release_review_bundle')
    if (!tool) throw new Error('missing review bundle tool')
    expect(tool.inputSchema.safeParse({ path: '.env' }).success).toBe(false)

    const result = await tool.execute({}, {} as never)
    const data = result.data as {
      selectedPathCount: number
      omittedPathCount: number
      targets: Array<{ path: string; diff: string; truncated: boolean }>
      selectionLimited: boolean
      diffsTruncated: boolean
    }
    expect(requestedPaths).toEqual([
      'packages/core/src/index.ts',
      'packages/release-bot/src/publisher.ts',
    ])
    expect(data.selectedPathCount).toBe(2)
    expect(data.omittedPathCount).toBe(2)
    expect(data.targets.reduce((total, target) => total + target.diff.length, 0)).toBeLessThanOrEqual(25)
    expect(data.targets.every(target => target.truncated)).toBe(true)
    expect(data.selectionLimited).toBe(true)
    expect(data.diffsTruncated).toBe(true)
  })
})
