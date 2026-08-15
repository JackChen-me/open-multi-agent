import { lstat, readFile, realpath } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { z } from 'zod'
import { canonicalGitDiffArgs, type CommandRunner } from './command.js'
import { sha256 } from './hash.js'
import {
  assertApprovedEditPath,
  assertPathPolicy,
  normalizeRepoPath,
  resolveInside,
} from './paths.js'
import {
  contextSourceSchema,
  validationResultSchema,
  type ContextManifest,
  type ControlPlaneRequest,
  type MaintainerConfig,
  type ValidationResult,
} from './schema.js'

export const reviewBundleSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  issueRevision: z.string().regex(/^[0-9a-f]{64}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  requirements: z.object({
    problem: z.string(),
    currentBehavior: z.string(),
    expectedBehavior: z.string(),
    acceptanceCriteria: z.array(z.string()),
    outOfScope: z.array(z.string()),
  }),
  changedPaths: z.array(z.string()),
  currentFiles: z.array(z.object({
    path: z.string(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    content: z.string(),
    byteLength: z.number().int().nonnegative(),
  })),
  diff: z.string(),
  diffHash: z.string().regex(/^[0-9a-f]{64}$/),
  validationResults: z.array(validationResultSchema),
  relevantContext: z.array(contextSourceSchema),
  contextManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
})

export type ReviewBundle = z.infer<typeof reviewBundleSchema>

export interface CollectReviewBundleOptions {
  readonly repoRoot: string
  readonly request: ControlPlaneRequest
  readonly config: MaintainerConfig
  readonly manifest: ContextManifest
  readonly validationResults: readonly ValidationResult[]
  readonly runner: CommandRunner
  readonly maxDiffChars?: number
}

export async function collectReviewBundle(
  options: CollectReviewBundleOptions,
): Promise<ReviewBundle> {
  const status = await options.runner.run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: options.repoRoot },
  )
  const changedPaths = parseChangedPaths(status.stdout)
  if (changedPaths.length === 0) throw new Error('Implementation produced no repository diff.')
  for (const path of changedPaths) {
    assertPathPolicy(path, options.config.allowedPaths, options.config.protectedPaths)
    assertApprovedEditPath(path, options.manifest.approvedEditScopes)
  }
  const currentFiles = await collectCurrentFileSnapshots(options.repoRoot, changedPaths, options.config)

  const tracked = await options.runner.run(
    'git',
    canonicalGitDiffArgs({
      baseSha: options.request.baseSha,
      paths: options.manifest.approvedEditScopes.map(scope => normalizeRepoPath(scope.path)),
    }),
    { cwd: options.repoRoot, maxOutputChars: (options.maxDiffChars ?? 300_000) + 1 },
  )
  let diff = tracked.stdout
  if (diff.includes('[output truncated]')) {
    throw new Error('Final diff command output was truncated before review.')
  }
  for (const path of changedPaths.filter(path => statusLineForPath(status.stdout, path)?.startsWith('??'))) {
    const content = await readFile(resolveInside(options.repoRoot, path), 'utf8')
    diff += renderNewFileDiff(path, content)
  }
  const maxDiffChars = options.maxDiffChars ?? 300_000
  if (diff.length > maxDiffChars) {
    throw new Error(`Final diff exceeds reviewer limit (${maxDiffChars} characters).`)
  }

  const relevantContext = options.manifest.sources.filter(source =>
    source.kind === 'system-policy'
    || source.kind === 'repository-policy'
    || source.kind === 'issue'
    || changedPaths.some(path => source.locator === path),
  )
  const bundle = reviewBundleSchema.parse({
    schemaVersion: 1,
    repository: options.request.issue.repository,
    issueNumber: options.request.issue.number,
    issueRevision: options.manifest.issueRevision,
    baseSha: options.request.baseSha,
    requirements: {
      problem: options.request.issue.problem,
      currentBehavior: options.request.issue.currentBehavior,
      expectedBehavior: options.request.issue.expectedBehavior,
      acceptanceCriteria: options.request.issue.acceptanceCriteria,
      outOfScope: options.request.issue.outOfScope,
    },
    changedPaths,
    currentFiles,
    diff,
    diffHash: sha256(diff),
    validationResults: options.validationResults,
    relevantContext,
    contextManifestHash: options.manifest.manifestHash,
  })
  if (JSON.stringify(bundle).length > 550_000) {
    throw new Error('Fresh reviewer bundle exceeds its deterministic evidence limit.')
  }
  return bundle
}

export async function collectCurrentFileSnapshots(
  repoRoot: string,
  paths: readonly string[],
  config: MaintainerConfig,
): Promise<Array<{ path: string; contentHash: string; content: string; byteLength: number }>> {
  const root = await realpath(repoRoot)
  const snapshots: Array<{ path: string; contentHash: string; content: string; byteLength: number }> = []
  let totalBytes = 0
  const maxTotalBytes = Math.min(config.edits.maxTotalBytes, 180_000)
  for (const path of paths) {
    const absolute = resolveInside(root, path)
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Current review snapshot is not a regular non-symlink file: ${path}`)
    }
    const actual = await realpath(absolute)
    const rel = relative(root, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`Current review snapshot escapes repository root: ${path}`)
    }
    const bytes = await readFile(actual)
    if (bytes.byteLength > config.edits.maxBytesPerFile) {
      throw new Error(`Current review snapshot exceeds maxBytesPerFile: ${path}`)
    }
    totalBytes += bytes.byteLength
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Current review snapshots exceed the deterministic ${maxTotalBytes}-byte limit.`)
    }
    const content = bytes.toString('utf8')
    snapshots.push({ path, contentHash: sha256(bytes), content, byteLength: bytes.byteLength })
  }
  return snapshots
}

export function parseChangedPaths(output: string): string[] {
  const paths = new Set<string>()
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue
    if (line.length < 4) throw new Error(`Unexpected git status line: ${line}`)
    const raw = line.slice(3)
    if (raw.includes(' -> ')) throw new Error('Renames are outside the maintainer-bot MVP edit capability.')
    if (line.slice(0, 2).includes('D')) throw new Error('Deletions are outside the maintainer-bot MVP edit capability.')
    paths.add(normalizeRepoPath(unquoteGitPath(raw)))
  }
  return [...paths].sort()
}

function statusLineForPath(output: string, path: string): string | undefined {
  return output.split('\n').find(line => line.length >= 4 && unquoteGitPath(line.slice(3)) === path)
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  try {
    return JSON.parse(value) as string
  } catch {
    throw new Error(`Could not parse quoted git path: ${value}`)
  }
}

function renderNewFileDiff(path: string, content: string): string {
  const lines = content.split('\n')
  const normalized = content.endsWith('\n') ? lines.slice(0, -1) : lines
  return `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${normalized.length} @@\n${normalized.map(line => `+${line}`).join('\n')}\n`
}
