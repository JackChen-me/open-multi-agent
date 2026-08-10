/**
 * TencentDB-Agent-Memory (TDAM) Memory Store
 *
 * A {@link MemoryStore} implementation that pairs the team's shared memory
 * with TencentDB-Agent-Memory's Hermes Gateway — an HTTP sidecar in front of
 * TDAM's layered memory pipeline (L0 raw conversations → L1 atomic facts →
 * L2 scenes → L3 persona, SQLite + sqlite-vec, BM25 + vector hybrid search).
 *
 * The Gateway is a distillation pipeline, not a key-value database: it has no
 * endpoint that reads a stored value back by key (`/search/*` and `/recall`
 * return formatted text, not raw records). So this store keeps exact KV
 * semantics in a local in-process map and treats TDAM as the durable
 * long-term layer:
 *
 *   - `get` / `list` / `delete` / `clear` — served from the local map, so the
 *     orchestrator's shared-memory plumbing (task-result injection, summaries)
 *     behaves exactly like the default {@link InMemoryStore}.
 *   - `set` — writes the local map **and** captures the entry into TDAM via
 *     `POST /capture`. TDAM's background pipeline distills captured turns
 *     into searchable long-term memories.
 *   - `recall` / `searchMemories` / `searchConversations` / `endSession` —
 *     TDAM-specific helpers for pulling long-term memory back into a new run
 *     and for flushing extraction at the end of one.
 *
 * Within a single run the local map is the source of truth; across runs the
 * distilled TDAM memories are what persist.
 *
 * Run:
 *   npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts
 *
 * Prerequisites:
 *   - TDAM Hermes Gateway running at http://127.0.0.1:8420 (see README.md)
 *   - TDAI_GATEWAY_API_KEY env var if the Gateway has Bearer auth enabled
 *
 * Verified against TencentDB-Agent-Memory v0.3.6
 * (`@tencentdb-agent-memory/memory-tencentdb@0.3.6`, gateway schema from
 * `src/gateway/types.ts`).
 */

import type { MemoryEntry, MemoryStore } from '../../../packages/core/src/types.js'

// ---------------------------------------------------------------------------
// Gateway wire types (mirror src/gateway/types.ts @ v0.3.6)
// ---------------------------------------------------------------------------

export interface TdamHealth {
  status: 'ok' | 'degraded'
  version: string
  uptime: number
  stores: { vectorStore: boolean; embeddingService: boolean }
}

interface CaptureResponse {
  l0_recorded: number
  scheduler_notified: boolean
}

export interface TdamRecallResult {
  /** Pre-formatted context block, designed for system-prompt injection. */
  context: string
  strategy?: string
  memory_count?: number
}

export interface TdamMemorySearchResult {
  /** Pre-formatted text of matching L1 memories (not raw records). */
  results: string
  total: number
  strategy: string
}

export interface TdamConversationSearchResult {
  /** Pre-formatted text of matching L0 conversation turns. */
  results: string
  total: number
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TdamStoreOptions {
  /** Hermes Gateway URL. Defaults to `http://127.0.0.1:8420`. */
  baseUrl?: string
  /**
   * Bearer token, required only when the Gateway sets `TDAI_GATEWAY_API_KEY`.
   * Falls back to the same `TDAI_GATEWAY_API_KEY` env var so one variable can
   * configure both ends. When empty, no Authorization header is sent (the
   * Gateway's open default).
   */
  apiKey?: string
  /**
   * TDAM session key. All captures from this store land in one Gateway
   * session; `endSession()` flushes exactly this session's extraction.
   */
  sessionKey?: string
  /** Timeout for capture/recall/search calls. Defaults to 60s. */
  requestTimeoutMs?: number
  /**
   * Timeout for `endSession()`. The Gateway drains L1 extraction (real LLM
   * calls) before responding, so this is generous by default: 300s.
   */
  flushTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// TdamMemoryStore
// ---------------------------------------------------------------------------

export class TdamMemoryStore implements MemoryStore {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly sessionKey: string
  private readonly requestTimeoutMs: number
  private readonly flushTimeoutMs: number

  private readonly entries = new Map<string, MemoryEntry>()
  private captureAttempted = 0
  private captureSucceeded = 0
  private l0Recorded = 0

  constructor(options: TdamStoreOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8420').replace(/\/+$/, '')
    this.apiKey = options.apiKey ?? process.env.TDAI_GATEWAY_API_KEY ?? ''
    this.sessionKey = options.sessionKey ?? 'oma-shared-memory'
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
    this.flushTimeoutMs = options.flushTimeoutMs ?? 300_000
  }

  // ---------------------------------------------------------------------------
  // MemoryStore interface
  // ---------------------------------------------------------------------------

  /**
   * Store the value locally and capture it into TDAM as a conversation turn.
   *
   * The capture is phrased as a user/assistant exchange because that is the
   * Gateway's input unit (`user_content` + `assistant_content`). The value —
   * typically a task result written by the orchestrator — goes in the **user**
   * slot, spoken by the agent: TDAM's L1 extractor is user-centric by design
   * (it distills persona / episodic / instruction memories about the user and
   * explicitly ignores assistant output), so results reported user-side are
   * what become long-term memories.
   *
   * A Gateway failure degrades to local-only storage with a console warning;
   * it never fails the team run.
   */
  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    this.storeLocal(key, value, metadata)
    await this.capture(key, value, metadata)
  }

  /** Like {@link set}, with the turn-count expiry kept on the local entry. */
  async setWithExpiry(
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.storeLocal(key, value, metadata, expiresAtTurn)
    await this.capture(key, value, metadata)
  }

  /** Exact read-back from the local map (the Gateway has no KV read API). */
  async get(key: string): Promise<MemoryEntry | null> {
    return this.entries.get(key) ?? null
  }

  /** All entries written during this run, in insertion order. */
  async list(): Promise<MemoryEntry[]> {
    return [...this.entries.values()]
  }

  /**
   * Remove the local entry. Already-captured turns stay in TDAM — the
   * Gateway exposes no delete endpoint, and TDAM treats captured history
   * as the raw material for its memory pipeline.
   */
  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  /** Clear the local map. TDAM keeps its captured history (see {@link delete}). */
  async clear(): Promise<void> {
    this.entries.clear()
  }

  // ---------------------------------------------------------------------------
  // TDAM-specific operations
  // ---------------------------------------------------------------------------

  /** `GET /health` — never requires auth. Throws when the Gateway is down. */
  async health(): Promise<TdamHealth> {
    const res = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!res.ok) throw new Error(`TDAM /health failed (${res.status})`)
    return (await res.json()) as TdamHealth
  }

  /**
   * `POST /recall` — fetch long-term context for a query, scoped to this
   * store's session key. The returned `context` is pre-formatted for direct
   * injection into an agent system prompt; it is empty when TDAM has no
   * relevant memories yet (e.g. on the very first run).
   */
  async recall(query: string): Promise<TdamRecallResult> {
    return await this.post<TdamRecallResult>('/recall', {
      query,
      session_key: this.sessionKey,
    })
  }

  /** `POST /search/memories` — hybrid search over distilled L1 memories. */
  async searchMemories(query: string, limit = 5): Promise<TdamMemorySearchResult> {
    return await this.post<TdamMemorySearchResult>('/search/memories', { query, limit })
  }

  /** `POST /search/conversations` — search raw L0 conversation history. */
  async searchConversations(query: string, limit = 5): Promise<TdamConversationSearchResult> {
    return await this.post<TdamConversationSearchResult>('/search/conversations', {
      query,
      limit,
      session_key: this.sessionKey,
    })
  }

  /**
   * `POST /session/end` — wait for this session's pending L1 extraction to
   * drain (real LLM calls), then resolve.
   *
   * Caveat (TDAM v0.3.6): captures arriving over the Gateway's HTTP API are
   * scheduled by **conversation count** (`memory.pipeline.everyNConversations`,
   * default 5, with warm-up) or by a 600s idle timer — `/session/end` drains
   * extraction already in flight but does not force extraction of turns below
   * the count threshold. Run the Gateway with `everyNConversations: 1` (see
   * README) to extract every capture immediately; then this call reliably
   * means "all captures are distilled and searchable".
   */
  async endSession(): Promise<void> {
    await this.post<{ flushed: boolean }>(
      '/session/end',
      { session_key: this.sessionKey },
      this.flushTimeoutMs,
    )
  }

  /** Capture accounting for observability (printed by the example). */
  get captureStats(): { attempted: number; succeeded: number; l0Recorded: number } {
    return {
      attempted: this.captureAttempted,
      succeeded: this.captureSucceeded,
      l0Recorded: this.l0Recorded,
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private storeLocal(
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
    expiresAtTurn?: number,
  ): void {
    this.entries.set(key, {
      key,
      value,
      metadata,
      createdAt: new Date(),
      ...(expiresAtTurn !== undefined ? { expiresAtTurn } : {}),
    })
  }

  private async capture(
    key: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const agent = typeof metadata?.agent === 'string' ? metadata.agent : 'unknown-agent'
    this.captureAttempted++
    try {
      const res = await this.post<CaptureResponse>('/capture', {
        user_content:
          `I'm "${agent}" from the open-multi-agent team. ` +
          `Reporting my completed work:\n\n${value}`,
        assistant_content: `Noted. I've recorded ${agent}'s results in the team's long-term memory.`,
        session_key: this.sessionKey,
      })
      this.captureSucceeded++
      this.l0Recorded += res.l0_recorded
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[tdam-store] capture failed for "${key}" (local copy kept): ${msg}`)
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>')
      throw new Error(`TDAM ${path} failed (${res.status}): ${text}`)
    }
    return (await res.json()) as T
  }
}
