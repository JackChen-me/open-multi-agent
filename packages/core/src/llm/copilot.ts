/**
 * @fileoverview GitHub Copilot adapter implementing {@link LLMAdapter}.
 *
 * Uses the OpenAI-compatible Copilot Chat Completions endpoint at
 * `https://api.githubcopilot.com`. Authentication requires a GitHub token
 * which is exchanged for a short-lived Copilot session token via the
 * internal token endpoint.
 *
 * API key resolution order:
 *   1. `apiKey` constructor argument
 *   2. `GITHUB_COPILOT_TOKEN` environment variable
 *   3. `GITHUB_TOKEN` environment variable
 *   4. Interactive OAuth2 device flow (prompts the user to sign in)
 *
 * @example
 * ```ts
 * import { CopilotAdapter } from './copilot.js'
 *
 * const adapter = new CopilotAdapter()          // uses GITHUB_COPILOT_TOKEN, falling back to GITHUB_TOKEN
 * const response = await adapter.chat(messages, {
 *   model: 'claude-sonnet-4',
 *   maxTokens: 4096,
 * })
 * ```
 */

import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
} from 'openai/resources/chat/completions/index.js'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from '../types.js'

import {
  toOpenAITool,
  fromOpenAICompletion,
  normalizeFinishReason,
  buildOpenAIMessageList,
  toOpenAISdkReasoningEffort,
} from './openai-common.js'
import { assertValidMessages } from './validate.js'

// ---------------------------------------------------------------------------
// Copilot auth — OAuth2 device flow + token exchange
// ---------------------------------------------------------------------------

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const DEVICE_CODE_URL   = 'https://github.com/login/device/code'
const POLL_URL          = 'https://github.com/login/oauth/access_token'
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

const COPILOT_HEADERS: Record<string, string> = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.100.0',
  'Editor-Plugin-Version': 'copilot-chat/0.42.2',
}

interface CopilotTokenResponse {
  token: string
  expires_at: number
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

interface PollResponse {
  access_token?: string
  error?: string
  error_description?: string
}

/**
 * Callback invoked when the OAuth2 device flow needs the user to authorize.
 * Receives the verification URI and user code. If not provided, defaults to
 * printing them to stdout.
 */
export type DeviceCodeCallback = (verificationUri: string, userCode: string) => void

const defaultDeviceCodeCallback: DeviceCodeCallback = (uri, code) => {
  console.log(`\n┌─────────────────────────────────────────────┐`)
  console.log(`│  GitHub Copilot — Sign in                    │`)
  console.log(`│                                              │`)
  console.log(`│  Open:  ${uri.padEnd(35)}│`)
  console.log(`│  Code:  ${code.padEnd(35)}│`)
  console.log(`└─────────────────────────────────────────────┘\n`)
}

/**
 * Start the GitHub OAuth2 device code flow with the Copilot client ID.
 *
 * Calls `onDeviceCode` with the verification URI and user code, then polls
 * until the user completes authorization. Returns a GitHub OAuth token
 * scoped for Copilot access.
 */
async function deviceCodeLogin(onDeviceCode: DeviceCodeCallback): Promise<string> {
  // Step 1: Request a device code
  const codeRes = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ client_id: COPILOT_CLIENT_ID, scope: 'copilot' }),
  })

  if (!codeRes.ok) {
    const body = await codeRes.text().catch(() => '')
    throw new Error(`Device code request failed (${codeRes.status}): ${body}`)
  }

  const codeData = (await codeRes.json()) as DeviceCodeResponse

  // Step 2: Prompt the user via callback
  onDeviceCode(codeData.verification_uri, codeData.user_code)

  // Step 3: Poll for the user to complete auth
  const interval = (codeData.interval || 5) * 1000
  const deadline = Date.now() + codeData.expires_in * 1000

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))

    const pollRes = await fetch(POLL_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: codeData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    const pollData = (await pollRes.json()) as PollResponse

    if (pollData.access_token) {
      console.log('✓ Authenticated with GitHub Copilot\n')
      return pollData.access_token
    }

    if (pollData.error === 'authorization_pending') continue
    if (pollData.error === 'slow_down') {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      continue
    }

    throw new Error(
      `OAuth device flow failed: ${pollData.error} — ${pollData.error_description ?? ''}`,
    )
  }

  throw new Error('Device code expired. Please try again.')
}

/**
 * Exchange a GitHub OAuth token (from the Copilot device flow) for a
 * short-lived Copilot session token.
 *
 * Note: the token exchange endpoint does NOT require the Copilot-specific
 * headers (Editor-Version etc.) — only the chat completions endpoint does.
 */
async function fetchCopilotToken(githubToken: string): Promise<CopilotTokenResponse> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.28.0',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Copilot token exchange failed (${res.status}): ${body || res.statusText}`,
    )
  }

  return (await res.json()) as CopilotTokenResponse
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/** Options for the {@link CopilotAdapter} constructor. */
export interface CopilotAdapterOptions {
  /** GitHub OAuth token already scoped for Copilot. Falls back to env vars. */
  apiKey?: string
  /**
   * Callback invoked when the OAuth2 device flow needs user action.
   * Defaults to printing the verification URI and user code to stdout.
   */
  onDeviceCode?: DeviceCodeCallback
}

/**
 * LLM adapter backed by the GitHub Copilot Chat Completions API.
 *
 * Authentication options (tried in order):
 *   1. `apiKey` constructor arg — a GitHub OAuth token already scoped for Copilot
 *   2. `GITHUB_COPILOT_TOKEN` env var
 *   3. `GITHUB_TOKEN` env var
 *   4. Interactive OAuth2 device flow
 *
 * The GitHub token is exchanged for a short-lived Copilot session token, which
 * is cached and auto-refreshed.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 * Concurrent token refreshes are serialised via an internal mutex.
 */
export class CopilotAdapter implements LLMAdapter {
  readonly name = 'copilot'

  readonly capabilities = {
    // GitHub Copilot proxies OpenAI Chat Completions; no reasoning input
    // is accepted. Falls back via shared helper in Phase 2.
    echoesReasoning: 'never' as const,
  }

  #githubToken: string | null
  #cachedToken: string | null = null
  #tokenExpiresAt = 0
  #refreshPromise: Promise<string> | null = null
  readonly #onDeviceCode: DeviceCodeCallback

  constructor(apiKeyOrOptions?: string | CopilotAdapterOptions) {
    const opts = typeof apiKeyOrOptions === 'string'
      ? { apiKey: apiKeyOrOptions }
      : apiKeyOrOptions ?? {}

    this.#githubToken = opts.apiKey
      ?? process.env['GITHUB_COPILOT_TOKEN']
      ?? process.env['GITHUB_TOKEN']
      ?? null
    this.#onDeviceCode = opts.onDeviceCode ?? defaultDeviceCodeCallback
  }

  /**
   * Return a valid Copilot session token, refreshing if necessary.
   * If no GitHub token is available, triggers the interactive device flow.
   * Concurrent calls share a single in-flight refresh to avoid races.
   */
  async #getSessionToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    if (this.#cachedToken && this.#tokenExpiresAt - 60 > now) {
      return this.#cachedToken
    }

    // If another call is already refreshing, piggyback on that promise
    if (this.#refreshPromise) {
      return this.#refreshPromise
    }

    this.#refreshPromise = this.#doRefresh()
    try {
      return await this.#refreshPromise
    } finally {
      this.#refreshPromise = null
    }
  }

  async #doRefresh(): Promise<string> {
    if (!this.#githubToken) {
      this.#githubToken = await deviceCodeLogin(this.#onDeviceCode)
    }

    const resp = await fetchCopilotToken(this.#githubToken)
    this.#cachedToken = resp.token
    this.#tokenExpiresAt = resp.expires_at
    return resp.token
  }

  /** Build a short-lived OpenAI client pointed at the Copilot endpoint. */
  async #createClient(): Promise<OpenAI> {
    const sessionToken = await this.#getSessionToken()
    return new OpenAI({
      apiKey: sessionToken,
      baseURL: 'https://api.githubcopilot.com',
      defaultHeaders: COPILOT_HEADERS,
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    assertValidMessages(messages)
    const client = await this.#createClient()
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt, { preserveReasoningAsText: options.preserveReasoningAsText, compressReasoningText: options.compressReasoningText })

    const completion = await client.chat.completions.create(
      {
        // Narrow surface: Copilot's chat/completions API isn't publicly
        // documented, so forward only fields seen in reverse-engineered
        // request examples plus the SDK-typed `reasoning_effort`.
        model: options.model,
        messages: openAIMessages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        reasoning_effort: toOpenAISdkReasoningEffort(options.thinking?.effort),
        tools: options.tools ? options.tools.map(toOpenAITool) : undefined,
        stream: false,
      },
      {
        signal: options.abortSignal,
      },
    )

    const toolNames = options.tools?.map(t => t.name)
    return fromOpenAICompletion(completion, toolNames, this.name)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    assertValidMessages(messages)
    const client = await this.#createClient()
    const openAIMessages = buildOpenAIMessageList(messages, options.systemPrompt, { preserveReasoningAsText: options.preserveReasoningAsText, compressReasoningText: options.compressReasoningText })

    const streamResponse = await client.chat.completions.create(
      {
        // See chat() above for the rationale behind the narrow field set.
        model: options.model,
        messages: openAIMessages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        reasoning_effort: toOpenAISdkReasoningEffort(options.thinking?.effort),
        tools: options.tools ? options.tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        signal: options.abortSignal,
      },
    )

    let completionId = ''
    let completionModel = ''
    let finalFinishReason: string = 'stop'
    let inputTokens = 0
    let outputTokens = 0
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >()
    let fullText = ''

    try {
      for await (const chunk of streamResponse) {
        completionId = chunk.id
        completionModel = chunk.model

        if (chunk.usage !== null && chunk.usage !== undefined) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }

        const choice: ChatCompletionChunk.Choice | undefined = chunk.choices?.[0]
        if (choice === undefined) continue

        const delta = choice.delta

        if (delta.content !== null && delta.content !== undefined) {
          fullText += delta.content
          const textEvent: StreamEvent = { type: 'text', data: delta.content }
          yield textEvent
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          const idx = toolCallDelta.index

          if (!toolCallBuffers.has(idx)) {
            toolCallBuffers.set(idx, {
              id: toolCallDelta.id ?? '',
              name: toolCallDelta.function?.name ?? '',
              argsJson: '',
            })
          }

          const buf = toolCallBuffers.get(idx)
          if (buf !== undefined) {
            if (toolCallDelta.id) buf.id = toolCallDelta.id
            if (toolCallDelta.function?.name) buf.name = toolCallDelta.function.name
            if (toolCallDelta.function?.arguments) {
              buf.argsJson += toolCallDelta.function.arguments
            }
          }
        }

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finalFinishReason = choice.finish_reason
        }
      }

      const finalToolUseBlocks: ToolUseBlock[] = []
      for (const buf of toolCallBuffers.values()) {
        let parsedInput: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(buf.argsJson)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedInput = parsed as Record<string, unknown>
          }
        } catch {
          // Malformed JSON — surface as empty object.
        }

        const toolUseBlock: ToolUseBlock = {
          type: 'tool_use',
          id: buf.id,
          name: buf.name,
          input: parsedInput,
        }
        finalToolUseBlocks.push(toolUseBlock)
        const toolUseEvent: StreamEvent = { type: 'tool_use', data: toolUseBlock }
        yield toolUseEvent
      }

      const doneContent: ContentBlock[] = []
      if (fullText.length > 0) {
        const textBlock: TextBlock = { type: 'text', text: fullText }
        doneContent.push(textBlock)
      }
      doneContent.push(...finalToolUseBlocks)

      const finalResponse: LLMResponse = {
        id: completionId,
        content: doneContent,
        model: completionModel,
        stop_reason: normalizeFinishReason(finalFinishReason),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }

      const doneEvent: StreamEvent = { type: 'done', data: finalResponse }
      yield doneEvent
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const errorEvent: StreamEvent = { type: 'error', data: error }
      yield errorEvent
    }
  }
}

// ---------------------------------------------------------------------------
// Premium request multipliers
// ---------------------------------------------------------------------------

/**
 * Model metadata used for display names, context windows, and premium request
 * multiplier lookup.
 */
export interface CopilotModelInfo {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
}

/**
 * Return the premium-request multiplier for a Copilot model.
 *
 * Copilot doesn't charge per-token — instead each request costs
 * `multiplier × 1 premium request` from the user's monthly allowance.
 * A multiplier of 0 means the model is included at no premium cost.
 *
 * Based on https://docs.github.com/en/copilot/reference/ai-models/supported-models#model-multipliers
 */
export function getCopilotMultiplier(modelId: string): number {
  const id = modelId.toLowerCase()

  // 0x — included models
  if (id.includes('gpt-4.1'))   return 0
  if (id.includes('gpt-4o'))    return 0
  if (id.includes('gpt-5-mini') || id.includes('gpt-5 mini')) return 0
  if (id.includes('raptor'))    return 0
  if (id.includes('goldeneye')) return 0

  // 0.25x
  if (id.includes('grok'))      return 0.25

  // 0.33x
  if (id.includes('claude-haiku'))                             return 0.33
  if (id.includes('gemini-3-flash') || id.includes('gemini-3.0-flash')) return 0.33
  if (id.includes('gpt-5.1-codex-mini'))                      return 0.33
  if (id.includes('gpt-5.4-mini') || id.includes('gpt-5.4 mini')) return 0.33

  // 1x — standard premium
  if (id.includes('claude-sonnet'))  return 1
  if (id.includes('gemini-2.5-pro')) return 1
  if (id.includes('gemini-3-pro') || id.includes('gemini-3.0-pro')) return 1
  if (id.includes('gemini-3.1-pro')) return 1
  if (id.includes('gpt-5.1'))       return 1
  if (id.includes('gpt-5.2'))       return 1
  if (id.includes('gpt-5.3'))       return 1
  if (id.includes('gpt-5.4'))       return 1

  // 30x — fast opus
  if (id.includes('claude-opus') && id.includes('fast')) return 30

  // 3x — opus
  if (id.includes('claude-opus'))    return 3

  return 1
}

/**
 * Human-readable string describing the premium-request cost for a model.
 *
 * Examples: `"included (0×)"`, `"1× premium request"`, `"0.33× premium request"`
 */
export function formatCopilotMultiplier(multiplier: number): string {
  if (multiplier === 0) return 'included (0×)'
  if (Number.isInteger(multiplier)) return `${multiplier}× premium request`
  return `${multiplier}× premium request`
}

/** Known model metadata for Copilot-available models. */
export const COPILOT_MODELS: readonly CopilotModelInfo[] = [
  { id: 'gpt-4.1',             name: 'GPT-4.1',                  contextWindow: 128_000  },
  { id: 'gpt-4o',              name: 'GPT-4o',                   contextWindow: 128_000  },
  { id: 'gpt-5-mini',          name: 'GPT-5 mini',               contextWindow: 200_000  },
  { id: 'gpt-5.1',             name: 'GPT-5.1',                  contextWindow: 200_000  },
  { id: 'gpt-5.1-codex',       name: 'GPT-5.1-Codex',            contextWindow: 200_000  },
  { id: 'gpt-5.1-codex-mini',  name: 'GPT-5.1-Codex-Mini',       contextWindow: 200_000  },
  { id: 'gpt-5.1-codex-max',   name: 'GPT-5.1-Codex-Max',        contextWindow: 200_000  },
  { id: 'gpt-5.2',             name: 'GPT-5.2',                  contextWindow: 200_000  },
  { id: 'gpt-5.2-codex',       name: 'GPT-5.2-Codex',            contextWindow: 200_000  },
  { id: 'gpt-5.3-codex',       name: 'GPT-5.3-Codex',            contextWindow: 200_000  },
  { id: 'gpt-5.4',             name: 'GPT-5.4',                  contextWindow: 200_000  },
  { id: 'gpt-5.4-mini',        name: 'GPT-5.4 mini',             contextWindow: 200_000  },
  { id: 'claude-haiku-4.5',    name: 'Claude Haiku 4.5',          contextWindow: 200_000  },
  { id: 'claude-opus-4.5',     name: 'Claude Opus 4.5',           contextWindow: 200_000  },
  { id: 'claude-opus-4.6',     name: 'Claude Opus 4.6',           contextWindow: 200_000  },
  { id: 'claude-opus-4.6-fast', name: 'Claude Opus 4.6 (fast)',   contextWindow: 200_000  },
  { id: 'claude-sonnet-4',     name: 'Claude Sonnet 4',           contextWindow: 200_000  },
  { id: 'claude-sonnet-4.5',   name: 'Claude Sonnet 4.5',         contextWindow: 200_000  },
  { id: 'claude-sonnet-4.6',   name: 'Claude Sonnet 4.6',         contextWindow: 200_000  },
  { id: 'gemini-2.5-pro',      name: 'Gemini 2.5 Pro',            contextWindow: 1_000_000 },
  { id: 'gemini-3-flash',      name: 'Gemini 3 Flash',            contextWindow: 1_000_000 },
  { id: 'gemini-3-pro',        name: 'Gemini 3 Pro',              contextWindow: 1_000_000 },
  { id: 'gemini-3.1-pro',      name: 'Gemini 3.1 Pro',            contextWindow: 1_000_000 },
  { id: 'grok-code-fast-1',    name: 'Grok Code Fast 1',          contextWindow: 128_000  },
  { id: 'raptor-mini',         name: 'Raptor mini',               contextWindow: 128_000  },
  { id: 'goldeneye',           name: 'Goldeneye',                 contextWindow: 128_000  },
] as const
