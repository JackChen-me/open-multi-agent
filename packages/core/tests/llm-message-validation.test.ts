import { describe, it, expect, vi, beforeEach } from 'vitest'
import { textMsg, chatOpts, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMMessage } from '../src/types.js'
import { assertValidMessages } from '../src/llm/validate.js'
import { InvalidMessageError } from '../src/errors.js'

// ---------------------------------------------------------------------------
// Mock the SDKs. The adapters instantiate a client in their constructor, but
// the guard fires on the first line of chat()/stream() — before any SDK call —
// so the mocked methods are never reached in these tests.
// ---------------------------------------------------------------------------

vi.mock('openai', () => {
  const OpenAIMock = vi.fn(() => ({ chat: { completions: { create: vi.fn() } } }))
  return { default: OpenAIMock, OpenAI: OpenAIMock }
})

vi.mock('@anthropic-ai/sdk', () => {
  const AnthropicMock = vi.fn(() => ({ messages: { create: vi.fn(), stream: vi.fn() } }))
  return { default: AnthropicMock, Anthropic: AnthropicMock }
})

import { OpenAIAdapter } from '../src/llm/openai.js'
import { AnthropicAdapter } from '../src/llm/anthropic.js'

// The reported crash: content is a raw string instead of a ContentBlock[].
const stringContent = [{ role: 'user', content: 'oops' }] as unknown as LLMMessage[]

// ---------------------------------------------------------------------------
// Unit: the shared guard
// ---------------------------------------------------------------------------

describe('assertValidMessages', () => {
  it('accepts valid message shapes', () => {
    expect(() => assertValidMessages([textMsg('user', 'hi')])).not.toThrow()
    expect(() => assertValidMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: '1', name: 'x', input: {} }] },
    ] as LLMMessage[])).not.toThrow()
    // An empty content array is a valid ContentBlock[] — the guard must not over-reject.
    expect(() => assertValidMessages([{ role: 'user', content: [] }] as LLMMessage[])).not.toThrow()
  })

  it('accepts valid rich tool-result content', () => {
    expect(() => assertValidMessages([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [
          { type: 'text', text: 'preview' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
          },
        ],
      }],
    }])).not.toThrow()
  })

  it('rejects malformed rich tool-result content before provider conversion', () => {
    const invalid = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [{
          type: 'file',
          filename: 'report.pdf',
          source: { type: 'url', media_type: 'application/pdf', url: 'file:///tmp/report.pdf' },
        }],
      }],
    }] as unknown as LLMMessage[]

    expect(() => assertValidMessages(invalid)).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(invalid)).toThrow(/must use HTTP or HTTPS/)
  })

  it('accepts both video source shapes', () => {
    expect(() => assertValidMessages([{
      role: 'user',
      content: [
        {
          type: 'video',
          source: { type: 'url', media_type: 'video/mp4', url: 'https://example.com/clip.mp4' },
        },
        {
          type: 'video',
          source: { type: 'base64', media_type: 'video/mp4', data: 'dmlkZW8=' },
        },
      ],
    }])).not.toThrow()
  })

  it('rejects a video url the provider would dereference off HTTP(S)', () => {
    // A `url` video source is fetched by the provider, not by OMA, so an
    // unchecked scheme would hand the provider whatever the caller supplied.
    const invalid = [{
      role: 'user',
      content: [{
        type: 'video',
        source: { type: 'url', media_type: 'video/mp4', url: 'file:///etc/passwd' },
      }],
    }] as unknown as LLMMessage[]

    expect(() => assertValidMessages(invalid)).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(invalid)).toThrow(/must use HTTP or HTTPS/)
  })

  it('rejects a provider-private video reference scheme', () => {
    const invalid = [{
      role: 'user',
      content: [{
        type: 'video',
        source: { type: 'url', media_type: 'video/mp4', url: 'mm_file://abc123' },
      }],
    }] as unknown as LLMMessage[]

    expect(() => assertValidMessages(invalid)).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(invalid)).toThrow(/must be an absolute HTTP\(S\) URL/)
  })

  it('rejects a video media type that would corrupt the data URL', () => {
    const invalid = [{
      role: 'user',
      content: [{
        type: 'video',
        source: { type: 'base64', media_type: 'video/mp4,evil', data: 'dmlkZW8=' },
      }],
    }] as unknown as LLMMessage[]

    expect(() => assertValidMessages(invalid)).toThrow(/MIME type without parameters/)
  })

  it('rejects non-canonical base64 video bytes', () => {
    const invalid = [{
      role: 'user',
      content: [{
        type: 'video',
        source: { type: 'base64', media_type: 'video/mp4', data: 'not base64!' },
      }],
    }] as unknown as LLMMessage[]

    expect(() => assertValidMessages(invalid)).toThrow(/must contain raw base64 data/)
  })

  it('requires error tool results to remain text-only', () => {
    const invalid = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        is_error: true,
        content: [{ type: 'text', text: 'failed' }],
      }],
    }] as unknown as LLMMessage[]

    expect(() => assertValidMessages(invalid)).toThrow(/must be a string for an error tool result/)
  })

  it('rejects a non-array messages list', () => {
    expect(() => assertValidMessages('nope' as unknown as LLMMessage[])).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(null as unknown as LLMMessage[])).toThrow(/messages must be an array, got null/)
  })

  it('rejects a non-object message', () => {
    expect(() => assertValidMessages(['x'] as unknown as LLMMessage[])).toThrow(/messages\[0\] must be an object, got string/)
  })

  it('rejects string content and names the offending index', () => {
    expect(() => assertValidMessages(stringContent)).toThrow(InvalidMessageError)
    expect(() => assertValidMessages(
      [textMsg('user', 'ok'), { role: 'user', content: 'oops' }] as unknown as LLMMessage[],
    )).toThrow(/messages\[1\]\.content must be a ContentBlock\[\], got string/)
  })

  it('rejects null or object content', () => {
    expect(() => assertValidMessages([{ role: 'user', content: null }] as unknown as LLMMessage[])).toThrow(/content must be a ContentBlock\[\], got null/)
    expect(() => assertValidMessages([{ role: 'user', content: {} }] as unknown as LLMMessage[])).toThrow(/content must be a ContentBlock\[\], got object/)
  })

  it('rejects a content block without a string type', () => {
    expect(() => assertValidMessages([{ role: 'user', content: [null] }] as unknown as LLMMessage[]))
      .toThrow(/messages\[0\]\.content\[0\] must be a content block with a string "type"/)
    expect(() => assertValidMessages([{ role: 'user', content: [{ text: 'no type' }] }] as unknown as LLMMessage[]))
      .toThrow(InvalidMessageError)
  })
})

// ---------------------------------------------------------------------------
// Wiring: the guard is invoked at each adapter entry (openai-common family +
// independent family), for both chat() and stream().
// ---------------------------------------------------------------------------

describe('adapter entry validation', () => {
  let openai: OpenAIAdapter
  let anthropic: AnthropicAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    openai = new OpenAIAdapter('test-key')
    anthropic = new AnthropicAdapter('test-key')
  })

  it('OpenAI chat() rejects string content', async () => {
    await expect(openai.chat(stringContent, chatOpts())).rejects.toThrow(InvalidMessageError)
  })

  it('OpenAI stream() rejects string content on iteration', async () => {
    await expect(collectEvents(openai.stream(stringContent, chatOpts()))).rejects.toThrow(InvalidMessageError)
  })

  it('Anthropic chat() rejects string content', async () => {
    await expect(anthropic.chat(stringContent, chatOpts())).rejects.toThrow(InvalidMessageError)
  })

  it('Anthropic stream() rejects string content on iteration', async () => {
    await expect(collectEvents(anthropic.stream(stringContent, chatOpts()))).rejects.toThrow(InvalidMessageError)
  })
})
