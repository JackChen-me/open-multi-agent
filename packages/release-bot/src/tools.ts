import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool, type ToolDefinition } from '@open-multi-agent/core'
import { z } from 'zod'
import type { CommandRunner } from './command.js'
import {
  releaseEvidenceSchema,
  type ReleaseEvidence,
} from './schema.js'

const diffResultSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
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
  readonly maxDiffChars?: number
  readonly maxContractChars?: number
}

export function createReleaseEvidenceTools(
  options: ReleaseEvidenceToolsOptions,
// ToolDefinition defaults its result payload to string for backwards
// compatibility; this bot intentionally exercises rich structured results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): readonly ToolDefinition<any, any>[] {
  const changedPaths = new Set(options.evidence.changedFiles.map(file => file.path))
  const maxDiffChars = options.maxDiffChars ?? 50_000
  const maxContractChars = options.maxContractChars ?? 40_000

  const getReleaseEvidence = defineTool({
    name: 'get_release_evidence',
    description: 'Return immutable release evidence collected from the latest core tag through the current HEAD.',
    inputSchema: z.object({}),
    outputSchema: releaseEvidenceSchema,
    maxOutputChars: 120_000,
    execute: async () => ({
      data: options.evidence,
      modelOutput: JSON.stringify(options.evidence),
    }),
  })

  const readChangedDiff = defineTool({
    name: 'read_changed_diff',
    description: 'Read the exact base-to-HEAD Git diff for one changed repository path. Only paths listed by get_release_evidence are accepted.',
    inputSchema: z.object({ path: z.string().min(1).max(500) }),
    outputSchema: diffResultSchema,
    maxOutputChars: maxDiffChars + 1_000,
    execute: async ({ path }) => {
      if (!changedPaths.has(path)) {
        const data = { path, diff: 'Path is not in the release evidence.', truncated: false }
        return { data, modelOutput: JSON.stringify(data), isError: true }
      }
      const result = await options.runner.run(
        'git',
        ['diff', '--no-ext-diff', '--unified=5', `${options.evidence.baseSha}..${options.evidence.headSha}`, '--', path],
        { cwd: options.repoRoot },
      )
      const truncated = result.stdout.length > maxDiffChars
      const data = {
        path,
        diff: truncated ? `${result.stdout.slice(0, maxDiffChars)}\n[diff truncated]` : result.stdout,
        truncated,
      }
      return { data, modelOutput: JSON.stringify(data) }
    },
  })

  const readReleaseContract = defineTool({
    name: 'read_release_contract',
    description: 'Read the repository release contract from .github/RELEASING.md.',
    inputSchema: z.object({}),
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

  return [getReleaseEvidence, readChangedDiff, readReleaseContract]
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
