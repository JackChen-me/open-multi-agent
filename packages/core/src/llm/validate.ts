/**
 * @fileoverview Entry-point validation for public and adapter message lists.
 *
 * `LLMMessage.content` is typed as `ContentBlock[]`, but JS callers, deserialized
 * history, or custom integrations can break that contract at runtime. Without a
 * guard a non-array `content` fails deep in provider-specific conversion with a
 * cryptic `TypeError: <x>.content.some is not a function`.
 *
 * {@link assertValidMessages} is called by public structured Agent inputs and
 * at every adapter's `chat()`/`stream()` entry so a broken contract surfaces as
 * a clear {@link InvalidMessageError} at the boundary instead.
 */

import type { LLMMessage } from '../types.js'
import { InvalidMessageError } from '../errors.js'

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Assert that `messages` satisfies the {@link LLMMessage}[] contract every
 * adapter relies on: an array of `{ role, content }` objects whose `content` is
 * an array of content blocks (objects carrying a string `type`). Throws
 * {@link InvalidMessageError} naming the offending index on the first violation.
 *
 * Intentionally narrow: it validates only the array/shape invariants that
 * otherwise crash opaquely during conversion, not `role` or block-internal
 * fields. It rejects invalid input rather than coercing it, so the caller's bug
 * stays visible instead of being silently reshaped.
 */
export function assertValidMessages(messages: readonly LLMMessage[]): void {
  if (!Array.isArray(messages)) {
    throw new InvalidMessageError(`messages must be an array, got ${describeType(messages)}`)
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as unknown
    if (msg === null || typeof msg !== 'object') {
      throw new InvalidMessageError(`messages[${i}] must be an object, got ${describeType(msg)}`)
    }

    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) {
      throw new InvalidMessageError(
        `messages[${i}].content must be a ContentBlock[], got ${describeType(content)}`,
      )
    }

    for (let j = 0; j < content.length; j++) {
      const block = content[j] as unknown
      if (
        block === null ||
        typeof block !== 'object' ||
        typeof (block as { type?: unknown }).type !== 'string'
      ) {
        throw new InvalidMessageError(
          `messages[${i}].content[${j}] must be a content block with a string "type"`,
        )
      }
    }
  }
}
