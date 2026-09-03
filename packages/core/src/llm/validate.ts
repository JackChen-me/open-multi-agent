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
import { copyMediaSource, copyToolResultContent } from '../tool/result.js'

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Assert that `messages` satisfies the shared shape every adapter relies on:
 * an array of `{ role, content }` objects whose `content` is an array of content
 * blocks. Rich `tool_result` content and `video` blocks receive full nested
 * validation because a malformed media source otherwise fails differently
 * across provider SDKs — or, for a `url` source, is handed to the provider to
 * dereference on our behalf. Both carry the same source shape and go through
 * the same {@link copyMediaSource} rules, so an absolute HTTP(S) reference or
 * canonical base64 is the only thing that reaches an adapter. Remaining block
 * internals stay the responsibility of their existing adapters. Invalid input
 * is rejected rather than coerced or silently reshaped.
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

      const record = block as Record<string, unknown>
      if (record['type'] === 'tool_result') {
        if (typeof record['tool_use_id'] !== 'string') {
          throw new InvalidMessageError(
            `messages[${i}].content[${j}].tool_use_id must be a string`,
          )
        }
        if (record['is_error'] !== undefined && typeof record['is_error'] !== 'boolean') {
          throw new InvalidMessageError(
            `messages[${i}].content[${j}].is_error must be a boolean when provided`,
          )
        }
        try {
          copyToolResultContent(
            record['content'],
            `messages[${i}].content[${j}].content`,
          )
        } catch (error) {
          throw new InvalidMessageError(error instanceof Error ? error.message : String(error))
        }
        if (record['is_error'] === true && typeof record['content'] !== 'string') {
          throw new InvalidMessageError(
            `messages[${i}].content[${j}].content must be a string for an error tool result`,
          )
        }
      }

      if (record['type'] === 'video') {
        try {
          copyMediaSource(record['source'], `messages[${i}].content[${j}].source`)
        } catch (error) {
          throw new InvalidMessageError(error instanceof Error ? error.message : String(error))
        }
      }
    }
  }
}
