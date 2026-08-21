/**
 * Prompt extraction from the cookbook examples.
 *
 * The benchmark does not restate the examples' prompts. It reads them out of
 * the example source at load time, so a prompt cannot silently drift between
 * `packages/core/examples/` and what was actually measured. Every literal the
 * harness supplies itself (task descriptions, dependency wiring) is checked
 * against the same source by `assertLiteral()`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './config.mts'

const sourceCache = new Map<string, string>()

export function exampleSource(relativePath: string): string {
  const cached = sourceCache.get(relativePath)
  if (cached !== undefined) return cached
  const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
  sourceCache.set(relativePath, source)
  return source
}

/**
 * Read the `systemPrompt` template literal belonging to the agent config whose
 * `name` field is `agentName`.
 */
export function systemPromptOf(relativePath: string, agentName: string): string {
  const source = exampleSource(relativePath)
  const anchor = source.indexOf(`name: '${agentName}',`)
  if (anchor === -1) {
    throw new Error(`bench: no agent named "${agentName}" in ${relativePath}.`)
  }
  const promptKey = source.indexOf('systemPrompt: `', anchor)
  if (promptKey === -1) {
    throw new Error(`bench: agent "${agentName}" in ${relativePath} has no template-literal systemPrompt.`)
  }
  const start = promptKey + 'systemPrompt: `'.length
  const end = source.indexOf('`', start)
  if (end === -1) {
    throw new Error(`bench: unterminated systemPrompt for "${agentName}" in ${relativePath}.`)
  }
  const prompt = source.slice(start, end)
  if (prompt.includes('${')) {
    throw new Error(
      `bench: systemPrompt for "${agentName}" in ${relativePath} interpolates a value; `
      + 'the harness only supports static prompts.',
    )
  }
  return prompt
}

/**
 * Fail fast when a literal the harness reuses no longer exists in the example
 * it was taken from.
 */
export function assertLiteral(relativePath: string, literal: string): string {
  if (!exampleSource(relativePath).includes(literal)) {
    throw new Error(
      `bench: literal not found in ${relativePath}:\n  ${JSON.stringify(literal.slice(0, 120))}`,
    )
  }
  return literal
}

export function readFixture(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
}
