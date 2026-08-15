import { describe, it, expect } from 'vitest'
import { fromOpenAICompletion } from '../src/llm/openai-common.js'
import { UnsupportedToolCallError } from '../src/errors.js'
import type { ChatCompletion } from 'openai/resources/chat/completions/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletion(overrides: {
  content?: string | null
  tool_calls?: ChatCompletion.Choice['message']['tool_calls']
  finish_reason?: string
}): ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Date.now(),
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: overrides.content ?? null,
          tool_calls: overrides.tool_calls,
          refusal: null,
        },
        finish_reason: (overrides.finish_reason ?? 'stop') as 'stop' | 'tool_calls',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  }
}

const TOOL_NAMES = ['bash', 'file_read', 'file_write']

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fromOpenAICompletion fallback extraction', () => {
  it('rejects custom OpenAI tool calls instead of dropping them', () => {
    const completion = makeCompletion({
      tool_calls: [{
        id: 'custom_1',
        type: 'custom',
        custom: { name: 'shell', input: 'echo unsafe' },
      }],
      finish_reason: 'tool_calls',
    })

    expect(() => fromOpenAICompletion(completion, TOOL_NAMES, 'openai'))
      .toThrow(UnsupportedToolCallError)
  })

  it('returns normal tool_calls when present (no fallback)', () => {
    const completion = makeCompletion({
      content: 'Let me run a command.',
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command": "ls"}',
          },
        },
      ],
      finish_reason: 'tool_calls',
    })

    const response = fromOpenAICompletion(completion, TOOL_NAMES)
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]!.type === 'tool_use' && toolBlocks[0]!.name).toBe('bash')
    expect(toolBlocks[0]!.type === 'tool_use' && toolBlocks[0]!.id).toBe('call_123')
    expect(response.stop_reason).toBe('tool_use')
  })

  it('extracts tool calls from text when tool_calls is absent', () => {
    const completion = makeCompletion({
      content: 'I will run this:\n{"name": "bash", "arguments": {"command": "pwd"}}',
      finish_reason: 'stop',
    })

    const response = fromOpenAICompletion(completion, TOOL_NAMES)
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]!.type === 'tool_use' && toolBlocks[0]!.name).toBe('bash')
    expect(toolBlocks[0]!.type === 'tool_use' && toolBlocks[0]!.input).toEqual({ command: 'pwd' })
    // stop_reason should be corrected to tool_use
    expect(response.stop_reason).toBe('tool_use')
  })

  it('does not fallback when knownToolNames is not provided', () => {
    const completion = makeCompletion({
      content: '{"name": "bash", "arguments": {"command": "ls"}}',
      finish_reason: 'stop',
    })

    const response = fromOpenAICompletion(completion)
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    expect(toolBlocks).toHaveLength(0)
    expect(response.stop_reason).toBe('end_turn')
  })

  it('does not fallback when knownToolNames is empty', () => {
    const completion = makeCompletion({
      content: '{"name": "bash", "arguments": {"command": "ls"}}',
      finish_reason: 'stop',
    })

    const response = fromOpenAICompletion(completion, [])
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    expect(toolBlocks).toHaveLength(0)
    expect(response.stop_reason).toBe('end_turn')
  })

  it('returns plain text when no tool calls found in text', () => {
    const completion = makeCompletion({
      content: 'Hello! How can I help you today?',
      finish_reason: 'stop',
    })

    const response = fromOpenAICompletion(completion, TOOL_NAMES)
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    expect(toolBlocks).toHaveLength(0)
    expect(response.stop_reason).toBe('end_turn')
  })

  it('preserves text block alongside extracted tool blocks', () => {
    const completion = makeCompletion({
      content: 'Let me check:\n{"name": "file_read", "arguments": {"path": "/tmp/x"}}',
      finish_reason: 'stop',
    })

    const response = fromOpenAICompletion(completion, TOOL_NAMES)
    const textBlocks = response.content.filter(b => b.type === 'text')
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    expect(textBlocks).toHaveLength(1)
    expect(toolBlocks).toHaveLength(1)
  })

  it('does not double-extract when native tool_calls already present', () => {
    // Text also contains a tool call JSON, but native tool_calls is populated.
    // The fallback should NOT run.
    const completion = makeCompletion({
      content: '{"name": "file_read", "arguments": {"path": "/tmp/y"}}',
      tool_calls: [
        {
          id: 'call_native',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command": "ls"}',
          },
        },
      ],
      finish_reason: 'tool_calls',
    })

    const response = fromOpenAICompletion(completion, TOOL_NAMES)
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    // Should only have the native one, not the text-extracted one
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]!.type === 'tool_use' && toolBlocks[0]!.id).toBe('call_native')
  })
})
