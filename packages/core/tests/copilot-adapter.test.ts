import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { textMsg, chatOpts, toolDef, collectEvents } from './helpers/llm-fixtures.js'
import type { LLMResponse, StreamEvent, ToolUseBlock } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock OpenAI SDK (Copilot uses it under the hood)
// ---------------------------------------------------------------------------

const mockCreate = vi.hoisted(() => vi.fn())
const OpenAIMock = vi.hoisted(() =>
  vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
)

vi.mock('openai', () => ({
  default: OpenAIMock,
  OpenAI: OpenAIMock,
}))

// ---------------------------------------------------------------------------
// Mock global fetch for token management
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

function mockFetchForToken(sessionToken = 'cop_session_abc', expiresAt?: number) {
  const exp = expiresAt ?? Math.floor(Date.now() / 1000) + 3600
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ token: sessionToken, expires_at: exp }),
    text: () => Promise.resolve(''),
  })
}

import { CopilotAdapter, getCopilotMultiplier, formatCopilotMultiplier } from '../src/llm/copilot.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-cop',
    model: 'claude-sonnet-4',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hello from Copilot', tool_calls: undefined },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 8, completion_tokens: 4 },
    ...overrides,
  }
}

async function* makeChunks(chunks: Array<Record<string, unknown>>) {
  for (const chunk of chunks) yield chunk
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CopilotAdapter', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    vi.clearAllMocks()
    savedEnv = {
      GITHUB_COPILOT_TOKEN: process.env['GITHUB_COPILOT_TOKEN'],
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
    }
    delete process.env['GITHUB_COPILOT_TOKEN']
    delete process.env['GITHUB_TOKEN']
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  // =========================================================================
  // Constructor & token resolution
  // =========================================================================

  describe('constructor', () => {
    it('accepts string apiKey as first argument', () => {
      const adapter = new CopilotAdapter('gh_token_123')
      expect(adapter.name).toBe('copilot')
    })

    it('accepts options object with apiKey', () => {
      const adapter = new CopilotAdapter({ apiKey: 'gh_token_456' })
      expect(adapter.name).toBe('copilot')
    })

    it('falls back to GITHUB_COPILOT_TOKEN env var', () => {
      process.env['GITHUB_COPILOT_TOKEN'] = 'env_copilot_token'
      const adapter = new CopilotAdapter()
      expect(adapter.name).toBe('copilot')
    })

    it('falls back to GITHUB_TOKEN env var', () => {
      process.env['GITHUB_TOKEN'] = 'env_gh_token'
      const adapter = new CopilotAdapter()
      expect(adapter.name).toBe('copilot')
    })
  })

  describe('egress policy', () => {
    it('checks every required origin before opening the first auth connection', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const adapter = new CopilotAdapter({
        apiKey: 'gh_token',
        egressPolicy: {
          mode: 'allowlist',
          allowedOrigins: ['https://api.githubcopilot.com'],
        },
      })

      await expect(adapter.chat([textMsg('user', 'Hi')], chatOpts())).rejects.toMatchObject({
        code: 'EGRESS_POLICY_DENIED',
        origin: 'https://api.github.com',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(OpenAIMock).not.toHaveBeenCalled()
    })

    it('guards the token exchange and Copilot API transport when both origins are allowed', async () => {
      const fetchMock = mockFetchForToken('session_guarded')
      globalThis.fetch = fetchMock
      mockCreate.mockResolvedValue(makeCompletion())
      const adapter = new CopilotAdapter({
        apiKey: 'gh_token',
        egressPolicy: {
          mode: 'allowlist',
          allowedOrigins: [
            'https://api.github.com',
            'https://api.githubcopilot.com',
          ],
        },
      })

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/copilot_internal/v2/token',
        expect.objectContaining({ redirect: 'error' }),
      )
      expect(OpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'https://api.githubcopilot.com',
        fetch: expect.any(Function),
      }))
    })
  })

  // =========================================================================
  // Token management
  // =========================================================================

  describe('token management', () => {
    it('uses the device flow when no GitHub token is available', async () => {
      vi.useFakeTimers()
      const onDeviceCode = vi.fn()
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            device_code: 'device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 600,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'oauth_token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            token: 'session_from_device_flow',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          text: () => Promise.resolve(''),
        })

      const adapter = new CopilotAdapter({ onDeviceCode })
      mockCreate.mockResolvedValue(makeCompletion())

      const responsePromise = adapter.chat([textMsg('user', 'Hi')], chatOpts())
      await vi.runAllTimersAsync()
      await responsePromise

      expect(onDeviceCode).toHaveBeenCalledWith(
        'https://github.com/login/device',
        'ABCD-EFGH',
      )
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        3,
        'https://api.github.com/copilot_internal/v2/token',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token oauth_token',
          }),
        }),
      )
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'session_from_device_flow',
        }),
      )

      vi.useRealTimers()
    })

    it('exchanges GitHub token for Copilot session token', async () => {
      const fetchMock = mockFetchForToken('session_xyz')
      globalThis.fetch = fetchMock
      const adapter = new CopilotAdapter('gh_token')
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      // fetch was called to exchange token
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/copilot_internal/v2/token',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'token gh_token',
          }),
        }),
      )

      // OpenAI client was created with session token
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'session_xyz',
          baseURL: 'https://api.githubcopilot.com',
        }),
      )
    })

    it('caches session token and reuses on second call', async () => {
      const fetchMock = mockFetchForToken()
      globalThis.fetch = fetchMock
      const adapter = new CopilotAdapter('gh_token')
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      await adapter.chat([textMsg('user', 'Hi again')], chatOpts())

      // fetch should only be called once (cached)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('refreshes token when near expiry (within 60s)', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      // First call: token expires in 30 seconds (within 60s grace)
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            token: `session_${callCount}`,
            expires_at: callCount === 1 ? nowSec + 30 : nowSec + 3600,
          }),
          text: () => Promise.resolve(''),
        })
      })

      const adapter = new CopilotAdapter('gh_token')
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      // Token is within 60s of expiry, should refresh
      await adapter.chat([textMsg('user', 'Hi again')], chatOpts())

      expect(callCount).toBe(2)
    })

    it('concurrent requests share a single refresh promise', async () => {
      let resolveToken: ((v: unknown) => void) | undefined
      const slowFetch = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveToken = resolve
        })
      })
      globalThis.fetch = slowFetch

      const adapter = new CopilotAdapter('gh_token')
      mockCreate.mockResolvedValue(makeCompletion())

      // Fire two concurrent requests
      const p1 = adapter.chat([textMsg('user', 'A')], chatOpts())
      const p2 = adapter.chat([textMsg('user', 'B')], chatOpts())

      // Resolve the single in-flight fetch
      resolveToken!({
        ok: true,
        json: () => Promise.resolve({
          token: 'shared_session',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
        text: () => Promise.resolve(''),
      })

      await Promise.all([p1, p2])

      // fetch was called only once (mutex prevented double refresh)
      expect(slowFetch).toHaveBeenCalledTimes(1)
    })

    it('throws on failed token exchange', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
        statusText: 'Unauthorized',
      })

      const adapter = new CopilotAdapter('bad_token')
      mockCreate.mockResolvedValue(makeCompletion())

      await expect(
        adapter.chat([textMsg('user', 'Hi')], chatOpts()),
      ).rejects.toThrow('Copilot token exchange failed')
    })
  })

  // =========================================================================
  // chat()
  // =========================================================================

  describe('chat()', () => {
    let adapter: CopilotAdapter

    beforeEach(() => {
      globalThis.fetch = mockFetchForToken()
      adapter = new CopilotAdapter('gh_token')
    })

    it('creates OpenAI client with Copilot-specific headers and baseURL', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.githubcopilot.com',
          defaultHeaders: expect.objectContaining({
            'Copilot-Integration-Id': 'vscode-chat',
            'Editor-Version': 'vscode/1.100.0',
          }),
        }),
      )
    })

    it('returns LLMResponse from completion', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result).toEqual({
        id: 'chatcmpl-cop',
        content: [{ type: 'text', text: 'Hello from Copilot' }],
        model: 'claude-sonnet-4',
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
      })
    })

    it('passes tools and temperature through', async () => {
      mockCreate.mockResolvedValue(makeCompletion())
      const tool = toolDef('search')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ tools: [tool], temperature: 0.5 }),
      )

      const callArgs = mockCreate.mock.calls[0][0]
      expect(callArgs.tools[0].function.name).toBe('search')
      expect(callArgs.temperature).toBe(0.5)
      expect(callArgs.stream).toBe(false)
    })
  })

  // =========================================================================
  // stream()
  // =========================================================================

  describe('stream()', () => {
    let adapter: CopilotAdapter

    beforeEach(() => {
      globalThis.fetch = mockFetchForToken()
      adapter = new CopilotAdapter('gh_token')
    })

    it('yields text and done events', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        { id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }], usage: null },
        { id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
        { id: 'c1', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      expect(events.filter(e => e.type === 'text')).toEqual([
        { type: 'text', data: 'Hi' },
      ])
      const done = events.find(e => e.type === 'done')
      expect((done!.data as LLMResponse).usage).toEqual({ input_tokens: 5, output_tokens: 2 })
    })

    it('yields tool_use events from streamed tool calls', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        {
          id: 'c1', model: 'gpt-4o',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }] }, finish_reason: null }],
          usage: null,
        },
        { id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: null },
        { id: 'c1', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      expect((toolEvents[0].data as ToolUseBlock).name).toBe('search')
    })

    it('yields error event on failure', async () => {
      mockCreate.mockResolvedValue(
        (async function* () { throw new Error('Copilot down') })(),
      )

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      expect(events.filter(e => e.type === 'error')).toHaveLength(1)
    })

    it('handles malformed streamed tool arguments JSON', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        {
          id: 'c1', model: 'gpt-4o',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }],
          usage: null,
        },
        { id: 'c1', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]))

      const events = await collectEvents(adapter.stream([textMsg('user', 'Hi')], chatOpts()))

      const toolEvents = events.filter(e => e.type === 'tool_use')
      expect(toolEvents).toHaveLength(1)
      expect((toolEvents[0].data as ToolUseBlock).input).toEqual({})
    })
  })

  // =========================================================================
  // reasoning_effort forwarding (RFC #200 follow-up)
  // =========================================================================

  describe('reasoning_effort forwarding', () => {
    let adapter: CopilotAdapter

    beforeEach(() => {
      globalThis.fetch = mockFetchForToken()
      adapter = new CopilotAdapter('gh_token')
    })

    it('forwards thinking.effort as reasoning_effort on chat()', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, effort: 'low' } }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('low')
    })

    it('forwards thinking.effort as reasoning_effort on stream()', async () => {
      mockCreate.mockResolvedValue(makeChunks([
        { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]))

      await collectEvents(
        adapter.stream(
          [textMsg('user', 'Hi')],
          chatOpts({ thinking: { enabled: true, effort: 'high' } }),
        ),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('high')
    })

    it('ignores the DeepSeek-only max effort', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, effort: 'max' } }),
      )

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()
    })

    it('omits reasoning_effort when thinking is absent or effort is unset', async () => {
      mockCreate.mockResolvedValue(makeCompletion())
      await adapter.chat([textMsg('user', 'Hi')], chatOpts())
      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()

      mockCreate.mockResolvedValue(makeCompletion())
      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ thinking: { enabled: true, budgetTokens: 2048 } }),
      )
      expect(mockCreate.mock.calls[1][0].reasoning_effort).toBeUndefined()
    })
  })

  // =========================================================================
  // Conservative param surface (intentional non-forwarding)
  // =========================================================================

  describe('conservative param surface', () => {
    let adapter: CopilotAdapter

    beforeEach(() => {
      globalThis.fetch = mockFetchForToken()
      adapter = new CopilotAdapter('gh_token')
    })

    it('does NOT forward sampling params or extraBody that lack public Copilot spec coverage', async () => {
      mockCreate.mockResolvedValue(makeCompletion())

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({
          frequencyPenalty: 0.5,
          presencePenalty: 0.4,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          parallelToolCalls: false,
          extraBody: { logit_bias: { '50256': -100 } },
        }),
      )

      const sent = mockCreate.mock.calls[0][0]
      expect(sent.frequency_penalty).toBeUndefined()
      expect(sent.presence_penalty).toBeUndefined()
      expect(sent.top_p).toBeUndefined()
      expect(sent.top_k).toBeUndefined()
      expect(sent.min_p).toBeUndefined()
      expect(sent.parallel_tool_calls).toBeUndefined()
      expect(sent.logit_bias).toBeUndefined()
    })

    it('still forwards the documented param subset (temperature, max_tokens, tools)', async () => {
      mockCreate.mockResolvedValue(makeCompletion())
      const tool = toolDef('search')

      await adapter.chat(
        [textMsg('user', 'Hi')],
        chatOpts({ tools: [tool], temperature: 0.5, maxTokens: 2000 }),
      )

      const sent = mockCreate.mock.calls[0][0]
      expect(sent.temperature).toBe(0.5)
      expect(sent.max_tokens).toBe(2000)
      expect(sent.tools[0].function.name).toBe('search')
    })
  })

  // =========================================================================
  // getCopilotMultiplier()
  // =========================================================================

  describe('getCopilotMultiplier()', () => {
    it('returns 0 for included models', () => {
      expect(getCopilotMultiplier('gpt-4.1')).toBe(0)
      expect(getCopilotMultiplier('gpt-4o')).toBe(0)
      expect(getCopilotMultiplier('gpt-5-mini')).toBe(0)
    })

    it('returns 0.25 for grok models', () => {
      expect(getCopilotMultiplier('grok-code-fast-1')).toBe(0.25)
    })

    it('returns 0.33 for haiku, gemini-3-flash, etc.', () => {
      expect(getCopilotMultiplier('claude-haiku-4.5')).toBe(0.33)
      expect(getCopilotMultiplier('gemini-3-flash')).toBe(0.33)
    })

    it('returns 1 for sonnet, gemini-pro, gpt-5.x', () => {
      expect(getCopilotMultiplier('claude-sonnet-4')).toBe(1)
      expect(getCopilotMultiplier('gemini-2.5-pro')).toBe(1)
      expect(getCopilotMultiplier('gpt-5.1')).toBe(1)
    })

    it('returns 3 for claude-opus (non-fast)', () => {
      expect(getCopilotMultiplier('claude-opus-4.5')).toBe(3)
    })

    it('returns 30 for claude-opus fast', () => {
      expect(getCopilotMultiplier('claude-opus-4.6-fast')).toBe(30)
    })

    it('returns 1 for unknown models', () => {
      expect(getCopilotMultiplier('some-new-model')).toBe(1)
    })
  })

  // =========================================================================
  // formatCopilotMultiplier()
  // =========================================================================

  describe('formatCopilotMultiplier()', () => {
    it('returns "included (0\u00d7)" for 0', () => {
      expect(formatCopilotMultiplier(0)).toBe('included (0\u00d7)')
    })

    it('returns "1\u00d7 premium request" for 1', () => {
      expect(formatCopilotMultiplier(1)).toBe('1\u00d7 premium request')
    })

    it('returns "0.33\u00d7 premium request" for 0.33', () => {
      expect(formatCopilotMultiplier(0.33)).toBe('0.33\u00d7 premium request')
    })
  })

  // ---------------------------------------------------------------------------
  // Phase 1 of #223 \u2014 provenance stamping on extracted ReasoningBlocks
  // ---------------------------------------------------------------------------

  describe('reasoning provenance (#223 Phase 1)', () => {
    it('stamps provenance: "copilot" on extracted ReasoningBlocks in chat()', async () => {
      globalThis.fetch = mockFetchForToken()
      const adapter = new CopilotAdapter('gh_token')
      mockCreate.mockResolvedValue(makeCompletion({
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

      const result = await adapter.chat([textMsg('user', 'Hi')], chatOpts())

      expect(result.content[0]).toEqual({
        type: 'reasoning',
        text: 'plan first',
        provenance: 'copilot',
      })
    })
  })
})
