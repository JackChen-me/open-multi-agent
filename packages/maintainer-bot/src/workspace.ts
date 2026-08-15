import { lstat, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { sha256 } from './hash.js'
import { assertApprovedEditPath, assertPathPolicy, resolveInside } from './paths.js'
import type {
  ApprovedEditScope,
  EditOperation,
  ImplementationOutput,
  MaintainerConfig,
} from './schema.js'

export interface AppliedEdit {
  readonly path: string
  readonly reason: string
  readonly beforeHash: string | null
  readonly afterHash: string
  readonly bytes: number
  readonly created: boolean
}

export interface ApplyRestrictedEditsOptions {
  readonly repoRoot: string
  readonly implementation: ImplementationOutput
  readonly config: MaintainerConfig
  readonly approvedEditScopes: readonly ApprovedEditScope[]
  readonly dryRun?: boolean
}

export async function applyRestrictedEdits(
  options: ApplyRestrictedEditsOptions,
): Promise<AppliedEdit[]> {
  if (options.implementation.assumptions.length > 0) {
    throw new Error('Implementation contains unresolved assumptions; maintainer-bot fails closed.')
  }
  const edits = options.implementation.edits
  if (edits.length > options.config.edits.maxFiles) {
    throw new Error(`Edit plan exceeds maxFiles (${options.config.edits.maxFiles}).`)
  }
  const uniquePaths = new Set<string>()
  let totalBytes = 0
  const prepared: Array<{
    edit: EditOperation
    path: string
    absolute: string
    parent: string
    content: Buffer
    beforeHash: string | null
    created: boolean
    mode: number
    originalContent: Buffer | null
  }> = []
  const root = await realpath(options.repoRoot)

  for (const edit of edits) {
    const path = assertPathPolicy(edit.path, options.config.allowedPaths, options.config.protectedPaths)
    assertApprovedEditPath(path, options.approvedEditScopes)
    if (uniquePaths.has(path)) throw new Error(`Edit plan contains duplicate path: ${path}`)
    uniquePaths.add(path)
    const content = Buffer.from(edit.content, 'utf8')
    if (content.byteLength > options.config.edits.maxBytesPerFile) {
      throw new Error(`Edit exceeds maxBytesPerFile: ${path}`)
    }
    totalBytes += content.byteLength
    if (totalBytes > options.config.edits.maxTotalBytes) {
      throw new Error(`Edit plan exceeds maxTotalBytes (${options.config.edits.maxTotalBytes}).`)
    }

    const absolute = resolveInside(root, path)
    const parent = dirname(absolute)
    await assertSafeParent(root, parent)
    const existing = await readExistingRegularFile(absolute)
    const beforeHash = existing === null ? null : sha256(existing.content)
    if (edit.expectedHash !== beforeHash) {
      throw new Error(
        `Expected hash mismatch for ${path}: edit is stale or attempted to overwrite an unacknowledged file.`,
      )
    }
    prepared.push({
      edit,
      path,
      absolute,
      parent,
      content,
      beforeHash,
      created: existing === null,
      mode: existing?.mode ?? 0o644,
      originalContent: existing?.content ?? null,
    })
  }

  if (options.dryRun === true) {
    return prepared.map(item => ({
      path: item.path,
      reason: item.edit.reason,
      beforeHash: item.beforeHash,
      afterHash: sha256(item.content),
      bytes: item.content.byteLength,
      created: item.created,
    }))
  }

  const staged: Array<{ temporary: string; destination: string }> = []
  const committed: typeof prepared = []
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!
      const temporary = `${item.absolute}.oma-maintainer-${process.pid}-${index}.tmp`
      const handle = await open(temporary, 'wx', item.mode)
      try {
        await handle.writeFile(item.content)
      } finally {
        await handle.close()
      }
      staged.push({ temporary, destination: item.absolute })
    }
    for (let index = 0; index < staged.length; index += 1) {
      const item = staged[index]!
      await rename(item.temporary, item.destination)
      committed.push(prepared[index]!)
    }
  } catch (error) {
    await Promise.all(staged.map(item => safeUnlink(item.temporary)))
    for (const item of committed.reverse()) {
      if (item.originalContent === null) await safeUnlink(item.absolute)
      else await writeFile(item.absolute, item.originalContent, { mode: item.mode })
    }
    throw error
  }

  return prepared.map(item => ({
    path: item.path,
    reason: item.edit.reason,
    beforeHash: item.beforeHash,
    afterHash: sha256(item.content),
    bytes: item.content.byteLength,
    created: item.created,
  }))
}

async function assertSafeParent(root: string, parent: string): Promise<void> {
  let actual: string
  try {
    const stat = await lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('edit parent must be an existing non-symlink directory')
    }
    actual = await realpath(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('edit parent directory must already exist in the isolated worktree')
    }
    throw error
  }
  const rel = relative(root, actual)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('edit parent escapes repository root')
}

async function readExistingRegularFile(path: string): Promise<{ content: Buffer; mode: number } | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('edit target must be a regular non-symlink file')
    }
    return { content: await readFile(path), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
