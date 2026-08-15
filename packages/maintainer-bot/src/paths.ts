import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { ApprovedEditScope } from './schema.js'

export function normalizeRepoPath(input: string): string {
  if (input.includes('\\')) throw new Error(`Repository path must use forward slashes: ${input}`)
  if (isAbsolute(input)) throw new Error(`Repository path must be relative: ${input}`)
  const normalized = posix.normalize(input.trim().replace(/^\.\//, ''))
  if (
    normalized.length === 0
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('\0')
  ) {
    throw new Error(`Unsafe repository path: ${input}`)
  }
  return normalized
}

export function pathWithin(path: string, boundary: string): boolean {
  const normalizedPath = normalizeRepoPath(path)
  const normalizedBoundary = normalizeRepoPath(boundary)
  return normalizedPath === normalizedBoundary || normalizedPath.startsWith(`${normalizedBoundary}/`)
}

export function assertPathPolicy(
  path: string,
  allowedPaths: readonly string[],
  protectedPaths: readonly string[],
): string {
  const normalized = normalizeRepoPath(path)
  if (!allowedPaths.some(allowed => pathWithin(normalized, allowed))) {
    throw new Error(`Path is outside the configured allowlist: ${normalized}`)
  }
  if (protectedPaths.some(protectedPath => pathWithin(normalized, protectedPath))) {
    throw new Error(`Path is protected from maintainer-bot writes: ${normalized}`)
  }
  return normalized
}

export function assertApprovedEditPath(
  path: string,
  approvedScopes: readonly ApprovedEditScope[],
): string {
  const normalized = normalizeRepoPath(path)
  const approved = approvedScopes.some(scope => {
    const scopePath = normalizeRepoPath(scope.path)
    return scope.kind === 'file'
      ? normalized === scopePath
      : pathWithin(normalized, scopePath)
  })
  if (!approved) throw new Error(`Path is outside the maintainer-approved issue scope: ${normalized}`)
  return normalized
}

export function resolveInside(root: string, path: string): string {
  const normalized = normalizeRepoPath(path)
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, normalized)
  const rel = relative(absoluteRoot, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes repository root: ${path}`)
  }
  return absolute
}
