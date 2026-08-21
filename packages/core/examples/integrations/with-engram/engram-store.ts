/**
 * Engram Memory Store
 *
 * A {@link MemoryStore} implementation backed by Engram's REST API.
 * Engram provides shared team memory for AI agents — facts committed by one
 * agent are visible to all others in the workspace.
 *
 * Run:
 *   npx tsx packages/core/examples/integrations/with-engram/research-team.ts
 *
 * Prerequisites:
 *   - Engram server running at http://localhost:7474 (or custom baseUrl)
 *   - ENGRAM_INVITE_KEY env var (or passed via constructor)
 */

import type { MemoryEntry, MemoryStore } from '../../../src/types.js'

// ---------------------------------------------------------------------------
// Engram fact shape (as returned by the API)
// ---------------------------------------------------------------------------

interface EngramFact {
  fact_id: string
  lineage_id: string
  content: string
  scope: string
  agent_id?: string
  committed_at: string
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EngramStoreOptions {
  /** Engram server URL. Defaults to `http://localhost:7474`. */
  baseUrl?: string
  /** Workspace invite key. Falls back to `ENGRAM_INVITE_KEY` env var. */
  inviteKey?: string
  /** Default confidence for commits. Defaults to `0.9`. */
  confidence?: number
}

// ---------------------------------------------------------------------------
// EngramMemoryStore
// ---------------------------------------------------------------------------

export class EngramMemoryStore implements MemoryStore {
  private readonly baseUrl: string
  private readonly inviteKey: string
  private readonly confidence: number

  constructor(options: EngramStoreOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:7474').replace(/\/+$/, '')
    this.inviteKey = options.inviteKey ?? process.env.ENGRAM_INVITE_KEY ?? ''
    this.confidence = options.confidence ?? 0.9
  }

  // ---------------------------------------------------------------------------
  // MemoryStore interface
  // ---------------------------------------------------------------------------

  /**
   * Store a value under `key` by committing a fact with `scope=key`.
   * Uses `operation: "update"` so repeated writes to the same key supersede
   * the previous value rather than creating duplicates.
   */
  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.post('/api/commit', {
      scope: key,
      content: value,
      confidence: this.confidence,
      agent_id: metadata?.agent ?? undefined,
      operation: 'update',
    })
  }

  /**
   * Retrieve the most recent fact for `key` (scope).
   * Returns `null` when no matching fact exists.
   */
  async get(key: string): Promise<MemoryEntry | null> {
    const url = `${this.baseUrl}/api/facts?scope=${encodeURIComponent(key)}&limit=1`
    const res = await fetch(url, { headers: this.headers() })

    if (!res.ok) return null

    const facts = (await res.json()) as EngramFact[]
    if (facts.length === 0) return null

    return this.toMemoryEntry(facts[0])
  }

  /**
   * List all facts in the workspace (up to 200).
   * Each fact is mapped to a {@link MemoryEntry} using `scope` as the key.
   */
  async list(): Promise<MemoryEntry[]> {
    const url = `${this.baseUrl}/api/facts?limit=200`
    const res = await fetch(url, { headers: this.headers() })

    if (!res.ok) return []

    const facts = (await res.json()) as EngramFact[]
    return facts.map((f) => this.toMemoryEntry(f))
  }

  /**
   * Retire the most recent fact for `key` (scope) by its lineage ID.
   *
   * Engram's `delete` operation requires `corrects_lineage` — it retires a
   * specific lineage rather than deleting by scope. We look up the latest
   * fact first to obtain its `lineage_id`, then issue the delete.
   *
   * No-op when no fact exists for the key.
   */
  async delete(key: string): Promise<void> {
    // Look up the latest fact to get its lineage_id.
    const entry = await this.getFact(key)
    if (!entry) return

    await this.post('/api/commit', {
      scope: key,
      content: `Retired by MemoryStore.delete("${key}")`,
      confidence: this.confidence,
      operation: 'delete',
      corrects_lineage: entry.lineage_id,
    })
  }

  /**
   * No-op. Engram preserves full audit history by design — bulk erasure is
   * not supported and would violate the append-only contract.
   */
  async clear(): Promise<void> {
    // Intentional no-op: Engram preserves audit history.
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.inviteKey}`,
      'Content-Type': 'application/json',
    }
  }

  /**
   * Fetch the most recent raw fact for a scope.
   * Used internally by `delete()` to obtain the `lineage_id`.
   */
  private async getFact(scope: string): Promise<EngramFact | null> {
    const url = `${this.baseUrl}/api/facts?scope=${encodeURIComponent(scope)}&limit=1`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) return null
    const facts = (await res.json()) as EngramFact[]
    return facts.length > 0 ? facts[0] : null
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>')
      throw new Error(`Engram ${path} failed (${res.status}): ${text}`)
    }
  }

  private toMemoryEntry(fact: EngramFact): MemoryEntry {
    return {
      key: fact.scope,
      value: fact.content,
      metadata: {
        fact_id: fact.fact_id,
        lineage_id: fact.lineage_id,
        agent_id: fact.agent_id,
      },
      createdAt: new Date(fact.committed_at),
    }
  }
}
