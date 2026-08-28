/**
 * @fileoverview Canonical content hashing for journal lineage.
 *
 * Lineage answers "which event produced this block?"; the hash answers "and
 * does that event still reproduce it byte for byte?". `JSON.stringify` alone
 * cannot: key order follows insertion order, so two structurally identical
 * blocks built by different code paths would hash differently. Sorting keys
 * recursively removes that difference while leaving array order — which is
 * semantic in content blocks — untouched.
 */

import { createHash } from 'node:crypto'
import type { ContentBlock } from '../types.js'

/** Serialize a JSON-safe value with object keys sorted at every depth. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`)
  return `{${entries.join(',')}}`
}

/**
 * sha256 hex of a content block's canonical JSON encoding.
 *
 * Exported because `verifyRun()` and lineage tests must compute the same digest
 * from a journal read cold off disk as the runner computed in process.
 */
export function canonicalContentHash(block: ContentBlock): string {
  return createHash('sha256').update(canonicalize(block)).digest('hex')
}

/** sha256 hex of any JSON-safe value, used for the request's config digests. */
export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
