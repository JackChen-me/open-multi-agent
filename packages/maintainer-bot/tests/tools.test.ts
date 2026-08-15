import { describe, expect, it } from 'vitest'
import { hashJson, sha256 } from '../src/hash.js'
import {
  createAdmissionEvidenceTool,
  createContextEvidenceTools,
  MODEL_OUTPUT_LIMITS,
} from '../src/tools.js'
import { contextManifestSchema, type ContextManifest, type ContextSource } from '../src/schema.js'
import { authorizedRequest, testConfig } from './helpers.js'

describe('bounded immutable evidence tools', () => {
  it('keeps a near-900KB manifest out of every single model-visible result', async () => {
    const large = largeManifest()
    expect(large.sources.reduce((sum, source) => sum + source.byteLength, 0)).toBeGreaterThan(850_000)

    const admission = await execute(createAdmissionEvidenceTool(large), {})
    expect(modelText(admission)).not.toContain('LARGE_SOURCE_SENTINEL')
    expect(modelText(admission).length).toBeLessThanOrEqual(MODEL_OUTPUT_LIMITS.admissionEvidenceChars)

    const tools = createContextEvidenceTools(large)
    const listed = await execute(tools.find(tool => tool.name === 'list_context_sources')!, { offset: 0, limit: 50 })
    expect(modelText(listed)).not.toContain('LARGE_SOURCE_SENTINEL')
    expect(modelText(listed).length).toBeLessThanOrEqual(MODEL_OUTPUT_LIMITS.sourceListChars)

    const searched = await execute(tools.find(tool => tool.name === 'search_context')!, {
      query: 'LARGE_SOURCE_SENTINEL', maxMatches: 20,
    })
    expect(modelText(searched).length).toBeLessThanOrEqual(MODEL_OUTPUT_LIMITS.searchResultChars)

    const page = await execute(tools.find(tool => tool.name === 'read_context_source')!, {
      sourceId: 'large-a', offset: 0, limit: 10_000,
    })
    expect(modelText(page).length).toBeLessThanOrEqual(MODEL_OUTPUT_LIMITS.sourcePageChars)
    expect(modelText(page).length).toBeLessThan(JSON.stringify(large).length / 20)
  })

  it('keeps #491-shaped triage source-free while selective tools expose target, exports, and barrels', async () => {
    const manifest = issue491Manifest()
    const admission = await execute(createAdmissionEvidenceTool(manifest), {})
    const admissionText = modelText(admission)
    expect(admissionText).toContain('Complete core subpath barrel smoke coverage')
    expect(admissionText).not.toContain('SOURCE_CODE_SENTINEL')
    expect(admissionText).not.toContain('PACKAGE_EXPORTS_SENTINEL')

    const tools = createContextEvidenceTools(manifest)
    const search = tools.find(tool => tool.name === 'search_context')!
    const searched = await execute(search, { query: 'observability', maxMatches: 20 })
    const searchText = modelText(searched)
    expect(searchText).toContain('packages/core/tests/subpath-exports.test.ts')
    expect(searchText).toContain('packages/core/package.json')

    const read = tools.find(tool => tool.name === 'read_context_source')!
    for (const sourceId of ['target-test', 'package-exports', 'observability-barrel', 'process-barrel']) {
      const page = await execute(read, { sourceId, offset: 0, limit: 8_000 })
      expect(modelText(page)).toContain(sourceId)
    }
  })
})

function largeManifest(): ContextManifest {
  const request = authorizedRequest()
  const issue = JSON.stringify({
    issue: request.issue,
    confirmedAcceptanceCriteria: request.issue.acceptanceCriteria,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
  })
  const sources = [
    source('system-policy', 'system-policy', 'maintainer-bot://system-policy/v1', 'System policy.', 'system-policy'),
    source('issue', 'issue', `${request.issue.repository}#${request.issue.number}`, issue),
    source('large-a', 'repository-file', 'packages/demo/tests/large-a.test.ts', `LARGE_SOURCE_SENTINEL\n${'a'.repeat(429_000)}`),
    source('large-b', 'repository-file', 'packages/demo/src/large-b.ts', `LARGE_SOURCE_SENTINEL\n${'b'.repeat(429_000)}`),
  ]
  const partial = {
    schemaVersion: 1 as const,
    policyVersion: 'policy-v1',
    promptVersion: 'prompt-v1',
    generatedAt: '2026-08-11T00:00:00Z',
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
    targetWorkspaces: request.issue.targetWorkspaces,
    targetPaths: request.issue.targetPaths,
    allowedPaths: ['packages/demo'],
    approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' as const }],
    protectedPaths: ['.git'],
    validationCommands: testConfig().validationCommands,
    sources,
    retrieval: {
      method: 'deterministic-file-tree-import-history-v1' as const,
      selectedFiles: sources.filter(item => item.kind === 'repository-file').map(item => item.locator),
      omittedCandidateCount: 0,
      importRelations: [],
    },
    sufficiency: { sufficient: true, errors: [], warnings: [] },
  }
  return contextManifestSchema.parse({ ...partial, manifestHash: hashJson(partial) })
}

function issue491Manifest(): ContextManifest {
  const request = authorizedRequest({
    number: 491,
    title: 'Complete core subpath barrel smoke coverage',
    problem: 'Four executable subpath barrels are missing focused smoke coverage.',
    currentBehavior: 'The focused test does not import observability, observability/file, acp, or process.',
    expectedBehavior: 'Every executable non-root subpath has a representative runtime assertion.',
    acceptanceCriteria: [
      'Add focused cases for observability, observability/file, acp, and process.',
      'Keep existing cases and pass the focused test.',
    ],
    targetWorkspaces: ['@open-multi-agent/core'],
    targetPaths: ['packages/core/tests/subpath-exports.test.ts'],
    outOfScope: ['Do not change package exports, source barrels, or public APIs.'],
  })
  const issue = JSON.stringify({
    issue: request.issue,
    confirmedAcceptanceCriteria: request.issue.acceptanceCriteria,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
  })
  const sources = [
    source('system-policy', 'system-policy', 'maintainer-bot://system-policy/v1', 'System policy.', 'system-policy'),
    source('issue', 'issue', `${request.issue.repository}#491`, issue),
    source('target-test', 'repository-file', 'packages/core/tests/subpath-exports.test.ts', 'SOURCE_CODE_SENTINEL observability import assertions'),
    source('package-exports', 'repository-file', 'packages/core/package.json', 'PACKAGE_EXPORTS_SENTINEL exports observability observability/file acp process'),
    source('observability-barrel', 'repository-file', 'packages/core/src/observability/index.ts', 'SOURCE_CODE_SENTINEL export RunStore'),
    source('process-barrel', 'repository-file', 'packages/core/src/process.ts', 'SOURCE_CODE_SENTINEL export ProcessBackend'),
  ]
  const partial = {
    schemaVersion: 1 as const,
    policyVersion: 'policy-v1',
    promptVersion: 'prompt-v1',
    generatedAt: '2026-08-11T00:00:00Z',
    repository: request.issue.repository,
    issueNumber: request.issue.number,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
    targetWorkspaces: request.issue.targetWorkspaces,
    targetPaths: request.issue.targetPaths,
    allowedPaths: ['packages/core/tests'],
    approvedEditScopes: [{ path: 'packages/core/tests/subpath-exports.test.ts', kind: 'file' as const }],
    protectedPaths: ['.git', '.github/workflows'],
    validationCommands: testConfig().validationCommands,
    sources,
    retrieval: {
      method: 'deterministic-file-tree-import-history-v1' as const,
      selectedFiles: sources.filter(item => item.kind === 'repository-file').map(item => item.locator),
      omittedCandidateCount: 0,
      importRelations: [],
    },
    sufficiency: { sufficient: true, errors: [], warnings: [] },
  }
  return contextManifestSchema.parse({ ...partial, manifestHash: hashJson(partial) })
}

function source(
  id: string,
  kind: ContextSource['kind'],
  locator: string,
  content: string,
  trust: ContextSource['trust'] = 'untrusted-evidence',
): ContextSource {
  return {
    id, kind, locator, trust, priority: 90, content,
    contentHash: sha256(content),
    byteLength: Buffer.byteLength(content),
    originalByteLength: Buffer.byteLength(content),
    truncated: false,
  }
}

async function execute(tool: ReturnType<typeof createAdmissionEvidenceTool>, input: unknown) {
  return tool.execute(input, { agent: { name: 'test', description: 'test' } })
}

function modelText(result: { modelOutput?: unknown }): string {
  expect(typeof result.modelOutput).toBe('string')
  return result.modelOutput as string
}
