import type { LLMMessage } from '../types.js'
import { toolResultContentSize } from '../tool/result.js'

/**
 * Estimate token count using a lightweight character heuristic.
 * This intentionally avoids model-specific tokenizer dependencies.
 */
export function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        chars += block.text.length
      } else if (block.type === 'reasoning') {
        chars += block.text.length
      } else if (block.type === 'tool_result') {
        chars += toolResultContentSize(block.content)
      } else if (block.type === 'tool_use') {
        chars += JSON.stringify(block.input).length
      } else if (block.type === 'image') {
        // Account for non-text payloads with a small fixed cost.
        chars += 64
      } else if (block.type === 'video') {
        // Deliberately not the fixed cost images get. An inline video runs to
        // tens of megabytes, and charging it 64 characters leaves the context
        // strategies blind to the payload that dominates every request: they
        // would never compact the one block worth compacting. Sized the same
        // way `toolResultContentSize` sizes rich tool-result media.
        chars += block.source.type === 'base64'
          ? block.source.data.length
          : block.source.url.length
        chars += block.source.media_type.length + 32
      }
    }
  }

  // Conservative English heuristic: ~4 chars per token.
  return Math.ceil(chars / 4)
}
