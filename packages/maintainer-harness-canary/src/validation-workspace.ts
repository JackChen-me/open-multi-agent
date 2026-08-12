import { readFile, readdir, readlink, realpath, rm, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import {
  NodeCommandRunner,
  canonicalJson,
  sha256,
} from '@open-multi-agent/maintainer-bot'

export interface ValidationWorkspace {
  readonly containerRoot: string
  readonly repoRoot: string
  readonly dependencyRoot: string
  readonly baseSha: string
  readonly changedPaths: readonly string[]
  readonly candidateDiff: string
  readonly manifest: readonly WorkspaceManifestEntry[]
}

interface WorkspaceManifestEntry {
  readonly path: string
  readonly type: 'directory' | 'file' | 'symlink'
  readonly size?: number
  readonly hash?: string
  readonly target?: string
}

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
  const commandRunner = new NodeCommandRunner()
  const gitEnvironment = validationGitEnvironment(containerRoot)
  try {
    await mkdir(join(containerRoot, 'home'), { mode: 0o700 })
    await commandRunner.run('git', [
      'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', sourceRepoRoot, repoRoot,
    ], { env: gitEnvironment })
    await commandRunner.run('git', ['remote', 'remove', 'origin'], { cwd: repoRoot, env: gitEnvironment })
    await commandRunner.run('git', ['checkout', '--quiet', '--detach', options.baseSha], { cwd: repoRoot, env: gitEnvironment })
    await assertHead(commandRunner, repoRoot, gitEnvironment, options.baseSha)
    await assertCleanStatus(commandRunner, repoRoot, gitEnvironment)

    if (options.candidateDiff.length > 0) {
      await writeFile(patchPath, options.candidateDiff, { mode: 0o600 })
      await commandRunner.run('git', ['apply', '--binary', '--whitespace=nowarn', '--', patchPath], {
        cwd: repoRoot,
        env: gitEnvironment,
      })
    }
    await mkdir(join(repoRoot, 'node_modules'))
    const dependencyRoot = await realpath(resolve(sourceRepoRoot, 'node_modules'))
    const workspace = {
      containerRoot,
      repoRoot,
      dependencyRoot,
      baseSha: options.baseSha,
      changedPaths: [...options.changedPaths].sort(),
      candidateDiff: options.candidateDiff,
      manifest: await buildWorkspaceManifest(repoRoot),
    }
    await assertValidationWorkspaceIntegrity(workspace, options.maxFileBytes)
    return workspace
  } catch (error) {
    await rm(containerRoot, { recursive: true, force: true })
    throw error
  }
}

export async function assertValidationWorkspaceIntegrity(
  workspace: ValidationWorkspace,
  maxFileBytes: number,
): Promise<void> {
  const commandRunner = new NodeCommandRunner()
  const gitEnvironment = validationGitEnvironment(workspace.containerRoot)
  await assertHead(commandRunner, workspace.repoRoot, gitEnvironment, workspace.baseSha)
  const status = await commandRunner.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: workspace.repoRoot,
    env: gitEnvironment,
  })
  const statusPaths = parseSnapshotStatus(status.stdout)
  if (canonicalJson(statusPaths) !== canonicalJson([...workspace.changedPaths].sort())) {
    throw new Error('Validation changed the disposable workspace path set.')
  }
  for (const path of statusPaths) {
    const info = await lstat(resolveWorkspacePath(workspace.repoRoot, path))
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Disposable validation workspace contains a changed non-regular file.')
    }
    if (info.size > maxFileBytes) {
      throw new Error('Disposable validation workspace contains an oversized changed file.')
    }
  }
  const diff = statusPaths.length === 0
    ? ''
    : (await commandRunner.run('git', [
        'diff', '--binary', '--no-ext-diff', '--no-color', '--', ...statusPaths,
      ], { cwd: workspace.repoRoot, env: gitEnvironment })).stdout
  if (diff !== workspace.candidateDiff) {
    throw new Error('Validation changed the disposable workspace candidate patch.')
  }
  const manifest = await buildWorkspaceManifest(workspace.repoRoot)
  if (canonicalJson(manifest) !== canonicalJson(workspace.manifest)) {
    throw new Error('Validation left filesystem changes in the disposable workspace.')
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

function parseSnapshotStatus(value: string): string[] {
  const fields = value.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || field.length === 0) continue
    if (field.length < 4 || field[2] !== ' ') throw new Error('Malformed disposable workspace Git status.')
    const status = field.slice(0, 2)
    if (/[DRCTU?]/.test(status)) throw new Error('Validation left a forbidden disposable workspace status.')
    if (status.includes('R') || status.includes('C')) index += 1
    paths.push(field.slice(3))
  }
  return [...new Set(paths)].sort()
}

async function buildWorkspaceManifest(repoRoot: string): Promise<WorkspaceManifestEntry[]> {
  const entries: WorkspaceManifestEntry[] = []
  await walk(repoRoot, '')
  return entries.sort((left, right) => left.path.localeCompare(right.path))

  async function walk(root: string, relativeRoot: string): Promise<void> {
    const children = await readdir(root, { withFileTypes: true })
    for (const child of children) {
      if (relativeRoot.length === 0 && (child.name === '.git' || child.name === 'node_modules')) continue
      const childRelative = relativeRoot.length === 0 ? child.name : `${relativeRoot}/${child.name}`
      const childPath = join(root, child.name)
      const info = await lstat(childPath)
      if (info.isSymbolicLink()) {
        entries.push({ path: childRelative, type: 'symlink', target: await readlink(childPath) })
      } else if (info.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory' })
        await walk(childPath, childRelative)
      } else if (info.isFile()) {
        entries.push({
          path: childRelative,
          type: 'file',
          size: info.size,
          hash: sha256(await readFile(childPath)),
        })
      } else {
        throw new Error('Disposable validation workspace contains a special filesystem entry.')
      }
    }
  }
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
