import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chatOpts, collectEvents, textMsg, toolDef } from './helpers/llm-fixtures.js'
import type { LLMResponse, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock AzureOpenAI constructor (must be hoisted for Vitest)
// ---------------------------------------------------------------------------
const AzureOpenAIMock = vi.hoisted(() => vi.fn())
const createCompletionMock = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  AzureOpenAI: AzureOpenAIMock,
}))

import { AzureOpenAIAdapter } from '../src/llm/azure-openai.js'
import { createAdapter } from '../src/llm/adapter.js'

function makeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Hello',
        tool_calls: undefined,
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  }
}

async function* makeChunks(chunks: Array<Record<string, unknown>>) {
  for (const chunk of chunks) yield chunk
}

function textChunk(text: string, finish_reason: string | null = null, usage: Record<string, number> | null = null) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      delta: { content: text },
      finish_reason,
    }],
    usage,
  }
}

function toolCallChunk(
  index: number,
  id: string | undefined,
  name: string | undefined,
  args: string,
  finish_reason: string | null = null,
) {
  return {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          id,
          function: {
            name,
            arguments: args,
          },
        }],
      },
      finish_reason,
    }],
    usage: null,
  }
}

// ---------------------------------------------------------------------------
// AzureOpenAIAdapter tests
// ---------------------------------------------------------------------------

describe('AzureOpenAIAdapter', () => {
  beforeEach(() => {
    AzureOpenAIMock.mockClear()
    createCompletionMock.mockReset()
    AzureOpenAIMock.mockImplementation(() => ({
      chat: {
        completions: {
          create: createCompletionMock,
        },
      },
    }))
  })

  it('has name "azure-openai"', () => {
    const adapter = new AzureOpenAIAdapter()
    expect(adapter.name).toBe('azure-openai')
  })

  it('injects a guarded fetch and suppresses OPENAI_BASE_URL under policy', async () => {
    new AzureOpenAIAdapter(
      'test-key',
      'https://resource.openai.azure.com',
      undefined,
      {
        mode: 'allowlist',
        allowedOrigins: ['https://resource.openai.azure.com'],
      },
    )
    const init = AzureOpenAIMock.mock.calls.at(-1)?.[0] as {
      baseURL?: string | null
      fetch?: typeof globalThis.fetch
    }

    expect(init.baseURL).toBeNull()
    expect(init.fetch).toEqual(expect.any(Function))
    await expect(init.fetch!('https://other.example/v1')).rejects.toMatchObject({
      code: 'EGRESS_POLICY_DENIED',
      origin: 'https://other.example',
    })
  })

  it('uses AZURE_OPENAI_API_KEY by default', () => {
    const originalKey = process.env['AZURE_OPENAI_API_KEY']
    const originalEndpoint = process.env['AZURE_OPENAI_ENDPOINT']
    process.env['AZURE_OPENAI_API_KEY'] = 'azure-test-key-123'
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://test.openai.azure.com'

    try {
      new AzureOpenAIAdapter()
      expect(AzureOpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'azure-test-key-123',
          endpoint: 'https://test.openai.azure.com',
        })
      )
    } finally {
      if (originalKey === undefined) {
        delete process.env['AZURE_OPENAI_API_KEY']
      } else {
        process.env['AZURE_OPENAI_API_KEY'] = originalKey
      }
      if (originalEndpoint === undefined) {
        delete process.env['AZURE_OPENAI_ENDPOINT']
      } else {
        process.env['AZURE_OPENAI_ENDPOINT'] = originalEndpoint
      }
    }
  })

  it('uses AZURE_OPENAI_ENDPOINT by default', () => {
    const originalEndpoint = process.env['AZURE_OPENAI_ENDPOINT']
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://my-resource.openai.azure.com'

    try {
      new AzureOpenAIAdapter('some-key')
      expect(AzureOpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'some-key',
          endpoint: 'https://my-resource.openai.azure.com',
        })
      )
    } finally {
      if (originalEndpoint === undefined) {
        delete process.env['AZURE_OPENAI_ENDPOINT']
      } else {
        process.env['AZURE_OPENAI_ENDPOINT'] = originalEndpoint
      }
    }
  })

  it('uses default API version when not set', () => {
    new AzureOpenAIAdapter('some-key', 'https://test.openai.azure.com')
    expect(AzureOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'some-key',
        endpoint: 'https://test.openai.azure.com',
        apiVersion: '2024-10-21',
      })
    )
  })

  it('uses AZURE_OPENAI_API_VERSION env var when set', () => {
    const originalVersion = process.env['AZURE_OPENAI_API_VERSION']
    process.env['AZURE_OPENAI_API_VERSION'] = '2024-03-01-preview'

    try {
      new AzureOpenAIAdapter('some-key', 'https://test.openai.azure.com')
      expect(AzureOpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'some-key',
          endpoint: 'https://test.openai.azure.com',
          apiVersion: '2024-03-01-preview',
        })
      )
    } finally {
      if (originalVersion === undefined) {
        delete process.env['AZURE_OPENAI_API_VERSION']
      } else {
        process.env['AZURE_OPENAI_API_VERSION'] = originalVersion
      }
    }
  })

  it('allows overriding apiKey, endpoint, and apiVersion', () => {
    new AzureOpenAIAdapter(
      'custom-key',
      'https://custom.openai.azure.com',
      '2024-04-01-preview'
    )
    expect(AzureOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'custom-key',
        endpoint: 'https://custom.openai.azure.com',
        apiVersion: '2024-04-01-preview',
      })
    )
  })

  it('createAdapter("azure-openai") returns AzureOpenAIAdapter instance', async () => {
    const adapter = await createAdapter('azure-openai')
    expect(adapter).toBeInstanceOf(AzureOpenAIAdapter)
  })

  it('chat() calls SDK with expected parameters', async () => {
    createCompletionMock.mockResolvedValue(makeCompletion())
    const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')
    const tool = toolDef('search', 'Search')

    const result = await adapter.chat(
      [textMsg('user', 'Hi')],
      chatOpts({
        model: 'my-deployment',
        tools: [tool],
        temperature: 0.3,
      }),
    )

    const callArgs = createCompletionMock.mock.calls[0][0]
    expect(callArgs).toMatchObject({
      model: 'my-deployment',
      stream: false,
      max_tokens: 1024,
      temperature: 0.3,
    })
    expect(callArgs.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search',
        parameters: tool.inputSchema,
      },
    })
    expect(result).toEqual({
      id: 'chatcmpl-123',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'gpt-4o',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  })

  it('chat() maps native tool_calls to tool_use blocks', async () => {
    createCompletionMock.mockResolvedValue(makeCompletion({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }))
    const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

    const result = await adapter.chat(
      [textMsg('user', 'Hi')],
      chatOpts({ model: 'my-deployment', tools: [toolDef('search')] }),
    )

    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { q: 'test' },
    })
    expect(result.stop_reason).toBe('tool_use')
  })

  it('chat() uses AZURE_OPENAI_DEPLOYMENT when model is blank', async () => {
    const originalDeployment = process.env['AZURE_OPENAI_DEPLOYMENT']
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'env-deployment'
    createCompletionMock.mockResolvedValue({
      id: 'cmpl-1',
      model: 'gpt-4',
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'ok' },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })

    try {
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')
      await adapter.chat([], { model: '   ' })

      expect(createCompletionMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'env-deployment', stream: false }),
        expect.any(Object),
      )
    } finally {
      if (originalDeployment === undefined) {
        delete process.env['AZURE_OPENAI_DEPLOYMENT']
      } else {
        process.env['AZURE_OPENAI_DEPLOYMENT'] = originalDeployment
      }
    }
  })

  it('chat() throws when both model and AZURE_OPENAI_DEPLOYMENT are blank', async () => {
    const originalDeployment = process.env['AZURE_OPENAI_DEPLOYMENT']
    delete process.env['AZURE_OPENAI_DEPLOYMENT']
    const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

    try {
      await expect(adapter.chat([], { model: ' ' })).rejects.toThrow(
        'Azure OpenAI deployment is required',
      )
      expect(createCompletionMock).not.toHaveBeenCalled()
    } finally {
      if (originalDeployment !== undefined) {
        process.env['AZURE_OPENAI_DEPLOYMENT'] = originalDeployment
      }
    }
  })

  it('stream() sends stream options and emits done usage', async () => {
    createCompletionMock.mockResolvedValue(makeChunks([
      textChunk('Hi', 'stop'),
      { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]))
    const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

    const events = await collectEvents(
      adapter.stream([textMsg('user', 'Hi')], chatOpts({ model: 'my-deployment' })),
    )

    const callArgs = createCompletionMock.mock.calls[0][0]
    expect(callArgs.stream).toBe(true)
    expect(callArgs.stream_options).toEqual({ include_usage: true })

    const done = events.find(e => e.type === 'done')
    const response = done?.data as LLMResponse
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 2 })
    expect(response.model).toBe('gpt-4o')
  })

  it('stream() accumulates tool call deltas and emits tool_use', async () => {
    createCompletionMock.mockResolvedValue(makeChunks([
      toolCallChunk(0, 'call_1', 'search', '{"q":'),
      toolCallChunk(0, undefined, undefined, '"test"}', 'tool_calls'),
      { id: 'chatcmpl-123', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]))
    const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

    const events = await collectEvents(
      adapter.stream([textMsg('user', 'Hi')], chatOpts({ model: 'my-deployment' })),
    )

    const toolEvents = events.filter(e => e.type === 'tool_use')
    expect(toolEvents).toHaveLength(1)
    expect(toolEvents[0]?.data as ToolUseBlock).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { q: 'test' },
    })
  })

  it('stream() yields error event when iterator throws', async () => {
    createCompletionMock.mockResolvedValue(
      (async function* () {
        throw new Error('Stream exploded')
      })(),
    )
    const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

    const events = await collectEvents(
      adapter.stream([textMsg('user', 'Hi')], chatOpts({ model: 'my-deployment' })),
    )

    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect((errorEvents[0]?.data as Error).message).toBe('Stream exploded')
  })

  // =========================================================================
  // reasoning_effort forwarding (RFC #200 follow-up)
  // =========================================================================

  describe('reasoning_effort forwarding', () => {
    it('forwards thinking.effort as reasoning_effort on chat()', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ model: 'my-deployment', thinking: { enabled: true, effort: 'low' } }),
      )

      expect(createCompletionMock.mock.calls[0][0].reasoning_effort).toBe('low')
    })

    it('forwards thinking.effort as reasoning_effort on stream()', async () => {
      createCompletionMock.mockResolvedValue(makeChunks([
        textChunk('ok', 'stop'),
        { id: 'c', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]))
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ model: 'my-deployment', thinking: { enabled: true, effort: 'high' } }),
        ),
      )

      expect(createCompletionMock.mock.calls[0][0].reasoning_effort).toBe('high')
    })

    it('passes through newer effort values via extraBody (e.g. gpt-5 "minimal")', async () => {
      // See openai-adapter.test.ts for the rationale — values outside the
      // framework union go via extraBody.
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ model: 'my-deployment', extraBody: { reasoning_effort: 'minimal' } }),
      )

      expect(createCompletionMock.mock.calls[0][0].reasoning_effort).toBe('minimal')
    })

    it('ignores the DeepSeek-only max effort', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({
          model: 'my-deployment',
          thinking: { enabled: true, effort: 'max' },
        }),
      )

      expect(createCompletionMock.mock.calls[0][0].reasoning_effort).toBeUndefined()
    })

    it('omits reasoning_effort when thinking is absent or effort is unset', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat([textMsg('user', 'Hi')], chatOpts({ model: 'my-deployment' }))
      expect(createCompletionMock.mock.calls[0][0].reasoning_effort).toBeUndefined()

      createCompletionMock.mockResolvedValue(makeCompletion())
      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ model: 'my-deployment', thinking: { enabled: true, budgetTokens: 2048 } }),
      )
      expect(createCompletionMock.mock.calls[1][0].reasoning_effort).toBeUndefined()
    })
  })

  // =========================================================================
  // Sampling-param parity with OpenAIAdapter
  // =========================================================================

  describe('sampling-param parity', () => {
    it('forwards the OpenAI-cloud-compatible sampling params and extraBody', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({
          model: 'my-deployment',
          frequencyPenalty: 0.5,
          presencePenalty: 0.4,
          topP: 0.9,
          parallelToolCalls: false,
          extraBody: { logit_bias: { '50256': -100 } },
        }),
      )

      const sent = createCompletionMock.mock.calls[0][0]
      expect(sent.frequency_penalty).toBe(0.5)
      expect(sent.presence_penalty).toBe(0.4)
      expect(sent.top_p).toBe(0.9)
      expect(sent.parallel_tool_calls).toBe(false)
      expect(sent.logit_bias).toEqual({ '50256': -100 })
    })

    it('does NOT forward vLLM-only top_k / min_p (Azure runs MS-hosted OpenAI models)', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ model: 'my-deployment', topK: 40, minP: 0.05 }),
      )

      const sent = createCompletionMock.mock.calls[0][0]
      expect(sent.top_k).toBeUndefined()
      expect(sent.min_p).toBeUndefined()
    })

    it('extraBody overrides sampling params (field-ordering contract)', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({
          model: 'my-deployment',
          temperature: 0.2,
          extraBody: { temperature: 0.9 },
        }),
      )

      expect(createCompletionMock.mock.calls[0][0].temperature).toBe(0.9)
    })

    it('extraBody cannot override structural fields (model/messages/tools/stream)', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion())
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({
          model: 'my-deployment',
          extraBody: { model: 'spoofed-deployment', stream: true } as Record<string, unknown>,
        }),
      )

      const sent = createCompletionMock.mock.calls[0][0]
      expect(sent.model).toBe('my-deployment')
      expect(sent.stream).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Phase 1 of #223 — provenance stamping on extracted ReasoningBlocks
  // ---------------------------------------------------------------------------

  describe('reasoning provenance (#223 Phase 1)', () => {
    it('stamps provenance: "azure-openai" on extracted ReasoningBlocks in chat()', async () => {
      createCompletionMock.mockResolvedValue(makeCompletion({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Answer.',
            reasoning_content: 'plan first',
            tool_calls: undefined,
          },
          finish_reason: 'stop',
        }],
      }))
      const adapter = new AzureOpenAIAdapter('k', 'https://test.openai.azure.com')

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts({ model: 'my-deployment' }))

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: 'plan first',
        provenance: 'azure-openai',
      })
    })
  })
})
