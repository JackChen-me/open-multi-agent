import { createHash } from 'node:crypto'
import { defineTool, type ToolDefinition } from '@open-multi-agent/core'
import { z } from 'zod'
import type { ContextManifest } from './schema.js'
import type { ReviewBundle } from './review-bundle.js'

export const MODEL_OUTPUT_LIMITS = {
  admissionEvidenceChars: 48_000,
  sourceListChars: 24_000,
  searchResultChars: 16_000,
  sourcePageChars: 12_000,
  cumulativeReadChars: 72_000,
  reviewSummaryChars: 48_000,
} as const

type AnyTool = ToolDefinition<any, any>

interface EvidenceSource {
  readonly id: string
  readonly locator: string
  readonly kind: string
  readonly trust: string
  readonly contentHash: string
  readonly byteLength: number
  readonly originalByteLength: number
  readonly truncated: boolean
  readonly content: string
}

export function createAdmissionEvidenceTool(manifest: ContextManifest): AnyTool {
  const issueSource = manifest.sources.find(source => source.kind === 'issue')
  if (issueSource === undefined) throw new Error('Context manifest is missing immutable issue evidence.')
  const issueEnvelope = parseObject(issueSource.content, 'issue evidence')
  const issue = parseObject(issueEnvelope['issue'], 'issue record')
  const policy = manifest.sources.find(source => source.kind === 'system-policy')
  const evidence = {
    schemaVersion: 1,
    manifestHash: manifest.manifestHash,
    policyVersion: manifest.policyVersion,
    promptVersion: manifest.promptVersion,
    systemPolicy: policy?.content ?? 'System policy is unavailable; fail closed.',
    issue: selectKeys(issue, [
      'repository', 'number', 'title', 'kind', 'problem', 'reproductionSteps', 'currentBehavior',
      'expectedBehavior', 'acceptanceCriteria', 'targetWorkspaces', 'targetPaths', 'outOfScope',
      'openDecisions', 'riskFlags', 'linkedPullRequests', 'blockers',
    ]),
    issueRevision: manifest.issueRevision,
    baseSha: manifest.baseSha,
    targetPaths: manifest.targetPaths,
    allowedPaths: manifest.allowedPaths,
    approvedEditScopes: manifest.approvedEditScopes,
    protectedPaths: manifest.protectedPaths,
    validationCommandIds: manifest.validationCommands.map(command => command.id),
    sufficiency: manifest.sufficiency,
    provenance: {
      sourceId: issueSource.id,
      locator: issueSource.locator,
      contentHash: issueSource.contentHash,
      trust: issueSource.trust,
      truncated: issueSource.truncated,
    },
  }
  const modelOutput = boundedJson(evidence, MODEL_OUTPUT_LIMITS.admissionEvidenceChars, 'Admission evidence')
  return defineTool({
    name: 'read_admission_evidence',
    description: 'Read compact immutable issue, authorization, policy, scope, sufficiency, and risk evidence. It never contains repository source files.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.unknown(),
    maxOutputChars: MODEL_OUTPUT_LIMITS.admissionEvidenceChars,
    execute: async () => ({ data: evidence, modelOutput }),
  })
}

export function createContextEvidenceTools(manifest: ContextManifest): AnyTool[] {
  return createEvidenceTools('context', manifest.manifestHash, manifest.sources)
}

export function createReviewEvidenceTools(bundle: ReviewBundle): AnyTool[] {
  const sources: EvidenceSource[] = [
    evidenceSource('review:diff', 'review://final-diff', 'final-diff', 'untrusted-evidence', bundle.diff, bundle.diffHash),
    ...bundle.currentFiles.map(file => evidenceSource(
      `review:file:${file.path}`,
      file.path,
      'current-file',
      'untrusted-evidence',
      file.content,
      file.contentHash,
    )),
    ...bundle.validationResults.map(result => {
      const content = JSON.stringify(result)
      return evidenceSource(
        `review:validation:${result.id}`,
        `validation://${result.id}`,
        'validation-result',
        'untrusted-evidence',
        content,
      )
    }),
    ...bundle.relevantContext.map(source => ({ ...source })),
  ]
  const summary = {
    schemaVersion: 1,
    repository: bundle.repository,
    issueNumber: bundle.issueNumber,
    issueRevision: bundle.issueRevision,
    baseSha: bundle.baseSha,
    requirements: bundle.requirements,
    changedPaths: bundle.changedPaths,
    currentFiles: bundle.currentFiles.map(file => ({
      path: file.path,
      contentHash: file.contentHash,
      byteLength: file.byteLength,
    })),
    diffHash: bundle.diffHash,
    diffChars: bundle.diff.length,
    validationResults: bundle.validationResults.map(result => ({
      id: result.id,
      command: result.command,
      success: result.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
    })),
    contextManifestHash: bundle.contextManifestHash,
    evidenceSources: sources.map(sourceMetadata),
  }
  const modelOutput = boundedJson(summary, MODEL_OUTPUT_LIMITS.reviewSummaryChars, 'Review summary')
  return [
    defineTool({
      name: 'read_final_review_summary',
      description: 'Read bounded fresh-review requirements, hashes, changed paths, validation status, and evidence source metadata. Implementer reasoning is absent.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      maxOutputChars: MODEL_OUTPUT_LIMITS.reviewSummaryChars,
      execute: async () => ({ data: summary, modelOutput }),
    }),
    ...createEvidenceTools('review', bundle.contextManifestHash, sources),
  ]
}

function createEvidenceTools(
  namespace: 'context' | 'review',
  manifestHash: string,
  sources: readonly EvidenceSource[],
): AnyTool[] {
  const prefix = namespace === 'context' ? 'context' : 'review'
  const sourceMap = new Map(sources.map(source => [source.id, source]))
  let cumulativeReadChars = 0
  const charge = (output: string) => {
    if (cumulativeReadChars + output.length > MODEL_OUTPUT_LIMITS.cumulativeReadChars) {
      throw new Error(`${prefix} evidence cumulative model-output limit exceeded.`)
    }
    cumulativeReadChars += output.length
  }
  return [
    defineTool({
      name: `list_${prefix}_sources`,
      description: `List immutable ${prefix} evidence metadata without source content.`,
      inputSchema: z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(30),
      }).strict(),
      outputSchema: z.unknown(),
      maxOutputChars: MODEL_OUTPUT_LIMITS.sourceListChars,
      execute: async ({ offset, limit }) => {
        const pageOffset = offset ?? 0
        const pageLimit = limit ?? 30
        const page = sources.slice(pageOffset, pageOffset + pageLimit)
        const data = {
          manifestHash,
          offset: pageOffset,
          count: page.length,
          total: sources.length,
          nextOffset: pageOffset + page.length < sources.length ? pageOffset + page.length : null,
          sources: page.map(sourceMetadata),
        }
        const modelOutput = boundedJson(data, MODEL_OUTPUT_LIMITS.sourceListChars, `${prefix} source list`)
        charge(modelOutput)
        return { data, modelOutput }
      },
    }),
    defineTool({
      name: `search_${prefix}`,
      description: `Search only the captured immutable ${prefix} evidence. Results are bounded snippets with source hashes and offsets; no live filesystem or network is accessed.`,
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        sourceIds: z.array(z.string().min(1)).max(30).optional(),
        maxMatches: z.number().int().min(1).max(20).default(10),
      }).strict(),
      outputSchema: z.unknown(),
      maxOutputChars: MODEL_OUTPUT_LIMITS.searchResultChars,
      execute: async ({ query, sourceIds, maxMatches }) => {
        const matchLimit = maxMatches ?? 10
        const selected = sourceIds === undefined
          ? sources
          : sourceIds.map(id => sourceMap.get(id)).filter((source): source is EvidenceSource => source !== undefined)
        const matches: Array<Record<string, unknown>> = []
        const needle = query.toLocaleLowerCase('en-US')
        for (const source of selected) {
          let from = 0
          const haystack = source.content.toLocaleLowerCase('en-US')
          while (matches.length < matchLimit) {
            const offset = haystack.indexOf(needle, from)
            if (offset < 0) break
            const start = Math.max(0, offset - 240)
            const end = Math.min(source.content.length, offset + query.length + 240)
            matches.push({
              sourceId: source.id,
              locator: source.locator,
              contentHash: source.contentHash,
              offset,
              snippetStart: start,
              snippet: source.content.slice(start, end),
            })
            from = offset + Math.max(1, query.length)
          }
          if (matches.length >= matchLimit) break
        }
        const data = { manifestHash, query, matchCount: matches.length, matches }
        const modelOutput = boundedJson(data, MODEL_OUTPUT_LIMITS.searchResultChars, `${prefix} search result`)
        charge(modelOutput)
        return { data, modelOutput }
      },
    }),
    defineTool({
      name: `read_${prefix}_source`,
      description: `Read one page from a captured immutable ${prefix} source by ID. Each response and cumulative reads are strictly bounded and hash-bound.`,
      inputSchema: z.object({
        sourceId: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(10_000).default(8_000),
      }).strict(),
      outputSchema: z.unknown(),
      maxOutputChars: MODEL_OUTPUT_LIMITS.sourcePageChars,
      execute: async ({ sourceId, offset, limit }) => {
        const pageOffset = offset ?? 0
        const pageLimit = limit ?? 8_000
        const source = sourceMap.get(sourceId)
        if (source === undefined) throw new Error(`Unknown immutable ${prefix} source ID: ${sourceId}`)
        if (pageOffset > source.content.length) throw new Error(`${prefix} source offset exceeds content length.`)
        const content = source.content.slice(pageOffset, pageOffset + pageLimit)
        const data = {
          manifestHash,
          source: sourceMetadata(source),
          offset: pageOffset,
          content,
          nextOffset: pageOffset + content.length < source.content.length ? pageOffset + content.length : null,
        }
        const modelOutput = boundedJson(data, MODEL_OUTPUT_LIMITS.sourcePageChars, `${prefix} source page`)
        charge(modelOutput)
        return { data, modelOutput }
      },
    }),
  ]
}

function sourceMetadata(source: EvidenceSource) {
  return {
    id: source.id,
    locator: source.locator,
    kind: source.kind,
    trust: source.trust,
    contentHash: source.contentHash,
    byteLength: source.byteLength,
    originalByteLength: source.originalByteLength,
    truncated: source.truncated,
  }
}

function evidenceSource(
  id: string,
  locator: string,
  kind: string,
  trust: string,
  content: string,
  contentHash?: string,
): EvidenceSource {
  const byteLength = Buffer.byteLength(content)
  return {
    id,
    locator,
    kind,
    trust,
    contentHash: contentHash ?? sha256Text(content),
    byteLength,
    originalByteLength: byteLength,
    truncated: false,
    content,
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function boundedJson(value: unknown, limit: number, label: string): string {
  const output = JSON.stringify(value)
  if (output.length > limit) throw new Error(`${label} exceeds deterministic ${limit}-character model-output limit.`)
  return output
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Immutable ${label} is not an object.`)
  }
  return parsed as Record<string, unknown>
}

function selectKeys(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => key in value ? [[key, value[key]]] : []))
}
