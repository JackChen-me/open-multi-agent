/**
 * Built-in file-write tool.
 *
 * Creates or overwrites a file with the supplied content.  Parent directories
 * are created automatically (equivalent to `mkdir -p`).
 */

import { mkdir, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import { defineTool } from '../framework.js'
import { resolvePathWithinCwd } from './path-safety.js'

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const fileWriteTool = defineTool({
  name: 'file_write',
  consequential: true,
  description:
    'Write content to a file, creating it (and any missing parent directories) if it ' +
    'does not already exist, or overwriting it if it does. ' +
    'Prefer this tool for creating new files; use file_edit for targeted in-place edits ' +
    'of existing files.',

  inputSchema: z.object({
    path: z
      .string()
      .describe(
        'Absolute path to the file to write. ' +
          'The path must be absolute (starting with /).',
      ),
    content: z.string().describe('The full content to write to the file.'),
  }),

  execute: async (input, context) => {
    const safePath = await resolvePathWithinCwd(input.path, context, { ensureRoot: true })
    if (!safePath.ok) {
      return { data: safePath.error, isError: true }
    }

    // Determine whether the file already exists so we can report create vs update.
    let existed = false
    try {
      await stat(safePath.path)
      existed = true
    } catch {
      // File does not exist — will be created.
    }

    // Ensure parent directory hierarchy exists.
    const parentDir = dirname(safePath.path)
    try {
      await mkdir(parentDir, { recursive: true })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error creating directories.'
      return {
        data: `Failed to create parent directory "${parentDir}": ${message}`,
        isError: true,
      }
    }

    // Write the file.
    try {
      await writeFile(safePath.path, input.content, 'utf8')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error writing file.'
      return {
        data: `Failed to write file "${safePath.path}": ${message}`,
        isError: true,
      }
    }

    const lineCount = input.content.split('\n').length
    const byteCount = Buffer.byteLength(input.content, 'utf8')
    const action = existed ? 'Updated' : 'Created'

    return {
      data:
        `${action} "${safePath.path}" ` +
        `(${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteCount} bytes).`,
      isError: false,
    }
  },
})
