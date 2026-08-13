import { lstat, readFile } from 'node:fs/promises'
import {
  canonicalGitDiffArgs,
  NodeCommandRunner,
  parseChangedPaths,
  resolveInside,
  sha256,
} from '@open-multi-agent/maintainer-bot'
import type { MaintainerRuntimeValidationContract } from './artifacts.js'

export interface CandidateStatusSnapshot {
  readonly paths: readonly string[]
  readonly trackedPaths: readonly string[]
  readonly newPaths: readonly string[]
}

export async function assertApprovedCandidate(
  repoRoot: string,
  contract: MaintainerRuntimeValidationContract,
  options: { readonly ignoreUnapprovedUntrackedFiles?: boolean } = {},
): Promise<void> {
  const runner = new NodeCommandRunner()
  const [head, snapshot] = await Promise.all([
    runner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    collectCandidateStatus({
      repoRoot,
      expectedPaths: contract.changedFiles.map(file => file.path),
      ignoreUnapprovedUntrackedFiles: options.ignoreUnapprovedUntrackedFiles,
    }),
  ])
  if (head.stdout.trim() !== contract.baseSha) {
    throw new Error('Production validation source checkout differs from the pinned base SHA.')
  }
  const actualPaths = snapshot.paths
  const expectedPaths = contract.changedFiles.map(file => file.path).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Production validation source path set differs from the approved candidate.')
  }
  for (const file of contract.changedFiles) {
    const absolute = resolveInside(repoRoot, file.path)
    const info = await lstat(absolute)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Production validation candidate contains a non-regular file.')
    }
    if (sha256(await readFile(absolute)) !== file.contentHash) {
      throw new Error('Production validation source content differs from the approved candidate.')
    }
  }
  for (const path of snapshot.newPaths) {
    const info = await lstat(resolveInside(repoRoot, path))
    if ((info.mode & 0o111) !== 0) {
      throw new Error('Production validation new-file candidate must have canonical Git mode 100644.')
    }
  }
  const actualDiff = await renderCandidateDiffSnapshot({ repoRoot, snapshot })
  if (actualDiff !== contract.candidateDiff) {
    throw new Error('Production validation source patch differs from the approved candidate.')
  }
}

export async function collectCandidateStatus(options: {
  readonly repoRoot: string
  readonly expectedPaths: readonly string[]
  readonly ignoreUnapprovedUntrackedFiles?: boolean
  readonly environment?: NodeJS.ProcessEnv
}): Promise<CandidateStatusSnapshot> {
  const runner = new NodeCommandRunner()
  const status = await runner.run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: options.repoRoot, env: options.environment },
  )
  const lines = status.stdout.split('\n').filter(line => line.length > 0)
  const trackedLines = lines.filter(line => !line.startsWith('?? '))
  const untrackedLines = lines.filter(line => line.startsWith('?? '))
  for (const line of trackedLines) {
    if (line.length < 4 || /[DRCTU?]/.test(line.slice(0, 2))) {
      throw new Error('Candidate contains a forbidden Git status.')
    }
  }
  const trackedPaths = parseStatusLines(trackedLines)
  const allNewPaths = parseStatusLines(untrackedLines)
  const expected = new Set(options.expectedPaths)
  const newPaths = options.ignoreUnapprovedUntrackedFiles === true
    ? allNewPaths.filter(path => expected.has(path))
    : allNewPaths
  return {
    paths: [...new Set([...trackedPaths, ...newPaths])].sort(),
    trackedPaths,
    newPaths,
  }
}

export async function renderCandidateDiffSnapshot(options: {
  readonly repoRoot: string
  readonly snapshot: CandidateStatusSnapshot
  readonly environment?: NodeJS.ProcessEnv
}): Promise<string> {
  const runner = new NodeCommandRunner()
  const newPaths = new Set(options.snapshot.newPaths)
  let diff = ''
  for (const path of options.snapshot.paths) {
    const isNew = newPaths.has(path)
    const result = await runner.run(
      'git',
      isNew
        ? canonicalNoIndexDiffArgs(path)
        : canonicalGitDiffArgs({ paths: [path] }),
      {
        cwd: options.repoRoot,
        env: options.environment,
        allowFailure: isNew,
      },
    )
    if (isNew && result.exitCode !== 1) {
      throw new Error('Could not render the production validation new-file candidate.')
    }
    diff += result.stdout
  }
  return diff
}

function parseStatusLines(lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : parseChangedPaths(`${lines.join('\n')}\n`)
}

function canonicalNoIndexDiffArgs(path: string): string[] {
  const args = canonicalGitDiffArgs({ paths: ['/dev/null', path] })
  const separator = args.indexOf('--')
  return [...args.slice(0, separator), '--no-index', ...args.slice(separator)]
}
