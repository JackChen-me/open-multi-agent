import { copyFile, readFile, realpath, rm, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { NodeCommandRunner } from '@open-multi-agent/maintainer-bot'
import {
  collectCandidateStatus,
  renderCandidateDiffSnapshot,
} from './candidate-gate.js'

export interface ValidationWorkspace {
  readonly containerRoot: string
  readonly repoRoot: string
  readonly dependencyRoot: string
  readonly resolverHostsPath: string
  readonly resolverNsswitchPath: string
  readonly baseSha: string
  readonly changedPaths: readonly string[]
  readonly candidateDiff: string
}

export const VALIDATION_HOSTS = '127.0.0.1 localhost\n'
export const VALIDATION_NSSWITCH = 'hosts: files\n'

export async function createValidationWorkspace(options: {
  readonly sourceRepoRoot: string
  readonly baseSha: string
  readonly changedPaths: readonly string[]
  readonly candidateDiff: string
  readonly maxFileBytes: number
  readonly parentDir?: string
}): Promise<ValidationWorkspace> {
  const sourceRepoRoot = await realpath(resolve(options.sourceRepoRoot))
  const parentDir = await realpath(resolve(options.parentDir ?? tmpdir()))
  const containerRoot = await mkdtemp(join(parentDir, 'oma-validation-workspace-'))
  const repoRoot = join(containerRoot, 'repo')
  const patchPath = join(containerRoot, 'candidate.patch')
  const resolverRoot = join(containerRoot, 'etc')
  const resolverHostsPath = join(resolverRoot, 'hosts')
  const resolverNsswitchPath = join(resolverRoot, 'nsswitch.conf')
  const commandRunner = new NodeCommandRunner()
  const gitEnvironment = validationGitEnvironment(containerRoot)
  try {
    const sourceSnapshot = await collectCandidateStatus({
      repoRoot: sourceRepoRoot,
      expectedPaths: options.changedPaths,
      ignoreUnapprovedUntrackedFiles: true,
    })
    await mkdir(join(containerRoot, 'home'), { mode: 0o700 })
    await mkdir(resolverRoot, { mode: 0o700 })
    await writeFile(resolverHostsPath, VALIDATION_HOSTS, { mode: 0o600 })
    await writeFile(resolverNsswitchPath, VALIDATION_NSSWITCH, { mode: 0o600 })
    await commandRunner.run('git', [
      'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', sourceRepoRoot, repoRoot,
    ], { env: gitEnvironment })
    await commandRunner.run('git', ['remote', 'remove', 'origin'], { cwd: repoRoot, env: gitEnvironment })
    await commandRunner.run('git', ['checkout', '--quiet', '--detach', options.baseSha], { cwd: repoRoot, env: gitEnvironment })
    await assertHead(commandRunner, repoRoot, gitEnvironment, options.baseSha)
    await assertCleanStatus(commandRunner, repoRoot, gitEnvironment)

    if (options.candidateDiff.length > 0) {
      await writeFile(patchPath, options.candidateDiff, { mode: 0o600 })
      await commandRunner.run('git', ['apply', '--check', '--binary', '--whitespace=nowarn', '--', patchPath], {
        cwd: repoRoot,
        env: gitEnvironment,
      })
      await commandRunner.run('git', ['apply', '--binary', '--whitespace=nowarn', '--', patchPath], {
        cwd: repoRoot,
        env: gitEnvironment,
      })
    }
    for (const path of sourceSnapshot.newPaths) {
      const sourcePath = resolveWorkspacePath(sourceRepoRoot, path)
      const destinationPath = resolveWorkspacePath(repoRoot, path)
      const [sourceInfo, destinationInfo] = await Promise.all([
        lstat(sourcePath),
        lstat(destinationPath),
      ])
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()
        || !destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
        throw new Error('New-file candidate must remain a regular non-symlink file.')
      }
      // The v1 review diff format cannot encode a missing final newline. Copy
      // the already-gated source bytes, then verify both their hash and the
      // frozen diff before any validation command can start.
      await copyFile(sourcePath, destinationPath)
    }
    await mkdir(join(repoRoot, 'node_modules'))
    const dependencyRoot = await realpath(resolve(sourceRepoRoot, 'node_modules'))
    const workspace = {
      containerRoot,
      repoRoot,
      dependencyRoot,
      resolverHostsPath,
      resolverNsswitchPath,
      baseSha: options.baseSha,
      changedPaths: [...options.changedPaths].sort(),
      candidateDiff: options.candidateDiff,
    }
    await assertValidationWorkspaceCandidate(workspace, options.maxFileBytes)
    return workspace
  } catch (error) {
    await rm(containerRoot, { recursive: true, force: true })
    throw error
  }
}

export async function assertValidationWorkspaceCandidate(
  workspace: ValidationWorkspace,
  maxFileBytes: number,
): Promise<void> {
  const commandRunner = new NodeCommandRunner()
  const gitEnvironment = validationGitEnvironment(workspace.containerRoot)
  await assertResolverIntegrity(workspace)
  await assertHead(commandRunner, workspace.repoRoot, gitEnvironment, workspace.baseSha)
  // A raw '--untracked-files=no' would hide approved new-file candidates.
  // Collect all status entries, then ignore only unapproved disposable output.
  const snapshot = await collectCandidateStatus({
    repoRoot: workspace.repoRoot,
    expectedPaths: workspace.changedPaths,
    ignoreUnapprovedUntrackedFiles: true,
    environment: gitEnvironment,
  })
  const statusPaths = snapshot.paths
  if (JSON.stringify(statusPaths) !== JSON.stringify([...workspace.changedPaths].sort())) {
    throw new Error('Disposable validation workspace path set differs from the frozen candidate.')
  }
  for (const path of statusPaths) {
    const info = await lstat(resolveWorkspacePath(workspace.repoRoot, path))
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Disposable validation workspace candidate contains a changed non-regular file.')
    }
    if (info.size > maxFileBytes) {
      throw new Error('Disposable validation workspace candidate contains an oversized changed file.')
    }
  }
  const diff = await renderCandidateDiffSnapshot({
    repoRoot: workspace.repoRoot,
    snapshot,
    environment: gitEnvironment,
  })
  if (diff !== workspace.candidateDiff) {
    throw new Error('Disposable validation workspace patch differs from the frozen candidate.')
  }
}

async function assertResolverIntegrity(workspace: ValidationWorkspace): Promise<void> {
  for (const [path, expected] of [
    [workspace.resolverHostsPath, VALIDATION_HOSTS],
    [workspace.resolverNsswitchPath, VALIDATION_NSSWITCH],
  ] as const) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Validation resolver configuration must be a regular file.')
    }
    if (await readFile(path, 'utf8') !== expected) {
      throw new Error('Validation resolver configuration changed.')
    }
  }
}

export async function cleanupValidationWorkspace(workspace: ValidationWorkspace): Promise<void> {
  await rm(workspace.containerRoot, { recursive: true, force: true })
}

async function assertHead(
  commandRunner: NodeCommandRunner,
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
  expectedHead: string,
): Promise<void> {
  const head = (await commandRunner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env: environment })).stdout.trim()
  if (head !== expectedHead) throw new Error('Disposable validation workspace HEAD differs from the pinned base SHA.')
}

async function assertCleanStatus(
  commandRunner: NodeCommandRunner,
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const status = await commandRunner.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repoRoot,
    env: environment,
  })
  if (status.stdout.length > 0) throw new Error('Disposable validation workspace base is not clean.')
}

function resolveWorkspacePath(repoRoot: string, path: string): string {
  const resolved = resolve(repoRoot, path)
  const relation = relative(repoRoot, resolved)
  if (relation === '..' || relation.startsWith(`..${sep}`) || relation.startsWith(sep)) {
    throw new Error('Disposable validation workspace path escapes the snapshot.')
  }
  return resolved
}

function validationGitEnvironment(containerRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: join(containerRoot, 'home'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}
