import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool, type ToolDefinition } from '@open-multi-agent/core'
import { z } from 'zod'
import type { CommandRunner } from './command.js'
import {
  DEFAULT_RELEASE_REVIEW_TARGET_LIMIT,
  selectReleaseReviewTargets,
} from './evidence.js'
import {
  releaseEvidenceSchema,
  type ReleaseEvidence,
} from './schema.js'

const reviewBundleResultSchema = z.object({
  baseSha: z.string(),
  headSha: z.string(),
  selectedPathCount: z.number().int().nonnegative(),
  omittedPathCount: z.number().int().nonnegative(),
  targets: z.array(z.object({
    path: z.string(),
    risk: z.enum(['critical', 'high', 'medium', 'low']),
    reasons: z.array(z.string()),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    diff: z.string(),
    truncated: z.boolean(),
  })),
  selectionLimited: z.boolean(),
  diffsTruncated: z.boolean(),
})

const contractResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
})

export interface ReleaseEvidenceToolsOptions {
  readonly repoRoot: string
  readonly runner: CommandRunner
  readonly evidence: ReleaseEvidence
  readonly maxReviewTargets?: number
  readonly maxReviewBundleChars?: number
  readonly maxReviewDiffCharsPerFile?: number
  readonly maxContractChars?: number
}

export function createReleaseEvidenceTools(
  options: ReleaseEvidenceToolsOptions,
// ToolDefinition defaults its result payload to string for backwards
// compatibility; this bot intentionally exercises rich structured results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): readonly ToolDefinition<any, any>[] {
  const reviewTargets = selectReleaseReviewTargets(
    options.evidence,
    options.maxReviewTargets ?? DEFAULT_RELEASE_REVIEW_TARGET_LIMIT,
  )
  const maxReviewBundleChars = positiveInteger(
    options.maxReviewBundleChars ?? 60_000,
    'maxReviewBundleChars',
  )
  const maxReviewDiffCharsPerFile = positiveInteger(
    options.maxReviewDiffCharsPerFile ?? 10_000,
    'maxReviewDiffCharsPerFile',
  )
  const maxContractChars = positiveInteger(options.maxContractChars ?? 40_000, 'maxContractChars')

  const getReleaseEvidence = defineTool({
    name: 'get_release_evidence',
    description: 'Return immutable release evidence collected from the latest core tag through the current HEAD.',
    inputSchema: z.object({}).strict(),
    outputSchema: releaseEvidenceSchema,
    maxOutputChars: 120_000,
    execute: async () => ({
      data: options.evidence,
      modelOutput: JSON.stringify(options.evidence),
    }),
  })

  const readReleaseReviewBundle = defineTool({
    name: 'read_release_review_bundle',
    description: 'Read one deterministic, risk-ranked, size-bounded bundle of base-to-HEAD diffs. The bot selects the paths; model-supplied repository paths are not accepted. Unselected paths remain listed in the full evidence metadata.',
    inputSchema: z.object({}).strict(),
    outputSchema: reviewBundleResultSchema,
    maxOutputChars: maxReviewBundleChars + 20_000,
    execute: async () => {
      const rawDiffs: string[] = []
      for (const target of reviewTargets) {
        const result = await options.runner.run(
          'git',
          [
            'diff',
            '--no-ext-diff',
            '--unified=5',
            `${options.evidence.baseSha}..${options.evidence.headSha}`,
            '--',
            target.path,
          ],
          { cwd: options.repoRoot },
        )
        rawDiffs.push(result.stdout)
      }
      const allocations = allocateDiffCharacters(
        rawDiffs.map(diff => diff.length),
        maxReviewBundleChars,
        maxReviewDiffCharsPerFile,
      )
      let anyDiffTruncated = false
      const targets = reviewTargets.map((target, index) => {
        const bounded = truncateText(
          rawDiffs[index] ?? '',
          allocations[index] ?? 0,
          '\n[diff truncated]',
        )
        anyDiffTruncated ||= bounded.truncated
        return { ...target, diff: bounded.text, truncated: bounded.truncated }
      })
      const omittedPathCount = Math.max(0, options.evidence.changedFiles.length - reviewTargets.length)
      const data = {
        baseSha: options.evidence.baseSha,
        headSha: options.evidence.headSha,
        selectedPathCount: reviewTargets.length,
        omittedPathCount,
        targets,
        selectionLimited: omittedPathCount > 0,
        diffsTruncated: anyDiffTruncated,
      }
      return { data, modelOutput: JSON.stringify(data) }
    },
  })

  const readReleaseContract = defineTool({
    name: 'read_release_contract',
    description: 'Read the repository release contract from .github/RELEASING.md.',
    inputSchema: z.object({}).strict(),
    outputSchema: contractResultSchema,
    maxOutputChars: maxContractChars + 1_000,
    execute: async () => {
      const path = '.github/RELEASING.md'
      const absolute = await resolveExistingPath(options.repoRoot, path)
      const content = await readFile(absolute, 'utf8')
      const truncated = content.length > maxContractChars
      const data = {
        path,
        content: truncated ? `${content.slice(0, maxContractChars)}\n[contract truncated]` : content,
        truncated,
      }
      return { data, modelOutput: JSON.stringify(data) }
    },
  })

  return [getReleaseEvidence, readReleaseReviewBundle, readReleaseContract]
}

function allocateDiffCharacters(
  lengths: readonly number[],
  totalLimit: number,
  perFileLimit: number,
): readonly number[] {
  if (lengths.length === 0) return []
  const baseline = Math.min(perFileLimit, 3_000, Math.floor(totalLimit / lengths.length))
  const allocations = lengths.map(length => Math.min(length, baseline))
  let remaining = totalLimit - allocations.reduce((total, value) => total + value, 0)

  for (let index = 0; index < lengths.length && remaining > 0; index += 1) {
    const current = allocations[index] ?? 0
    const capacity = Math.min(lengths[index] ?? 0, perFileLimit) - current
    if (capacity <= 0) continue
    const extra = Math.min(capacity, remaining)
    allocations[index] = current + extra
    remaining -= extra
  }
  return allocations
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

function truncateText(
  value: string,
  maxChars: number,
  marker: string,
): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  if (maxChars <= 0) return { text: '', truncated: true }
  if (maxChars <= marker.length) return { text: marker.slice(0, maxChars), truncated: true }
  return {
    text: `${value.slice(0, maxChars - marker.length)}${marker}`,
    truncated: true,
  }
}

async function resolveExistingPath(repoRoot: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error('Release evidence paths must be repository-relative.')
  const root = await realpath(repoRoot)
  const target = await realpath(resolve(join(root, path)))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Resolved path is outside the repository root.')
  }
  return target
}
