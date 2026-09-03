import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/utils/tokens.js'
import type { LLMMessage } from '../src/types.js'

describe('estimateTokens', () => {
  it('counts retained reasoning text', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'x'.repeat(400) }],
      },
    ]

    expect(estimateTokens(messages)).toBe(100)
  })

  it('sizes an inline video by its payload, not by the image fixed cost', () => {
    // The fixed 64-character charge images get would hide a multi-megabyte
    // video from every context strategy that keys off this estimate.
    const data = 'A'.repeat(400_000)
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [{
          type: 'video',
          source: { type: 'base64', media_type: 'video/mp4', data },
        }],
      },
    ]

    const image: LLMMessage[] = [
      {
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data },
        }],
      },
    ]

    expect(estimateTokens(messages)).toBe(Math.ceil((400_000 + 'video/mp4'.length + 32) / 4))
    expect(estimateTokens(messages)).toBeGreaterThan(estimateTokens(image) * 1000)
  })

  it('sizes a video url source by the reference rather than the fetched bytes', () => {
    const url = `https://example.com/${'a'.repeat(80)}.mp4`
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [{
          type: 'video',
          source: { type: 'url', media_type: 'video/mp4', url },
        }],
      },
    ]

    expect(estimateTokens(messages)).toBe(Math.ceil((url.length + 'video/mp4'.length + 32) / 4))
  })
})
