/**
 * Built-in file-edit tool.
 *
 * Performs a targeted string replacement inside an existing file.
 * The uniqueness invariant (one match unless replace_all is set) prevents the
 * common class of bugs where a generic pattern matches the wrong occurrence.
 */

import { readFile, writeFile } from 'fs/promises'
import { z } from 'zod'
import { defineTool } from '../framework.js'
import { resolvePathWithinCwd } from './path-safety.js'

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const fileEditTool = defineTool({
  name: 'file_edit',
  consequential: true,
  description:
    'Edit a file by replacing a specific string with new content. ' +
    'The `old_string` must appear verbatim in the file. ' +
    'By default the tool errors if `old_string` appears more than once — ' +
    'use `replace_all: true` to replace every occurrence. ' +
    'Use file_write when you need to create a new file or rewrite it entirely.',

  inputSchema: z.object({
    path: z
      .string()
      .describe('Absolute path to the file to edit.'),
    old_string: z
      .string()
      .describe(
        'The exact string to find and replace. ' +
          'Must match character-for-character including whitespace and newlines.',
      ),
    new_string: z
      .string()
      .describe('The replacement string that will be inserted in place of `old_string`.'),
    replace_all: z
      .boolean()
      .optional()
      .describe(
        'When true, replace every occurrence of `old_string` instead of requiring it ' +
          'to be unique. Defaults to false.',
      ),
  }),

  execute: async (input, context) => {
    const safePath = await resolvePathWithinCwd(input.path, context)
    if (!safePath.ok) {
      return { data: safePath.error, isError: true }
    }

    // Read the existing file.
    let original: string
    try {
      const buffer = await readFile(safePath.path)
      original = buffer.toString('utf8')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error reading file.'
      return {
        data: `Could not read "${safePath.path}": ${message}`,
        isError: true,
      }
    }

    const occurrences = countOccurrences(original, input.old_string)

    if (occurrences === 0) {
      return {
        data:
          `The string to replace was not found in "${safePath.path}".\n` +
          'Make sure `old_string` matches the file contents exactly, ' +
          'including indentation and line endings.',
        isError: true,
      }
    }

    const replaceAll = input.replace_all ?? false

    if (occurrences > 1 && !replaceAll) {
      return {
        data:
          `\`old_string\` appears ${occurrences} times in "${safePath.path}". ` +
          'Provide a more specific string to uniquely identify the section you want ' +
          'to replace, or set `replace_all: true` to replace every occurrence.',
        isError: true,
      }
    }

    // Perform the replacement.
    const updated = replaceAll
      ? replaceAllOccurrences(original, input.old_string, input.new_string)
      : original.replace(input.old_string, input.new_string)

    // Persist the result.
    try {
      await writeFile(safePath.path, updated, 'utf8')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error writing file.'
      return {
        data: `Failed to write "${safePath.path}": ${message}`,
        isError: true,
      }
    }

    const replacedCount = replaceAll ? occurrences : 1
    return {
      data:
        `Replaced ${replacedCount} occurrence${replacedCount === 1 ? '' : 's'} ` +
        `in "${safePath.path}".`,
      isError: false,
    }
  },
})

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many times `needle` appears in `haystack`.
 * Uses a plain loop to avoid constructing a potentially large regex from
 * untrusted input.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/**
 * Replace all occurrences of `needle` in `haystack` with `replacement`
 * without using a regex (avoids regex-special-character escaping issues).
 */
function replaceAllOccurrences(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  if (needle.length === 0) return haystack
  const parts: string[] = []
  let pos = 0
  let next: number
  while ((next = haystack.indexOf(needle, pos)) !== -1) {
    parts.push(haystack.slice(pos, next))
    parts.push(replacement)
    pos = next + needle.length
  }
  parts.push(haystack.slice(pos))
  return parts.join('')
}
