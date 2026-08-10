/**
 * TencentDB-Agent-Memory (TDAM) Toolkit
 *
 * Registers two TDAM search tools so agents can query the team's long-term
 * memory on demand:
 *
 *   - `tdam_search_memories`      — distilled L1 facts (BM25 + vector hybrid)
 *   - `tdam_search_conversations` — raw L0 conversation history
 *
 * Automatic capture and recall are handled by {@link TdamMemoryStore}; these
 * tools cover the "agent decides mid-task that it needs to look something up"
 * path.
 *
 * Run:
 *   npx tsx examples/integrations/with-tencentdb-memory/team-with-memory.ts
 *
 * Prerequisites:
 *   - TDAM Hermes Gateway running at http://127.0.0.1:8420 (see README.md)
 *   - TDAI_GATEWAY_API_KEY env var if the Gateway has Bearer auth enabled
 *
 * Verified against TencentDB-Agent-Memory v0.3.6.
 */

import { z } from 'zod'
import { defineTool, ToolRegistry } from '../../../packages/core/src/index.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TdamToolkitOptions {
  /** Hermes Gateway URL. Defaults to `http://127.0.0.1:8420`. */
  baseUrl?: string
  /** Bearer token. Falls back to `TDAI_GATEWAY_API_KEY` env var. */
  apiKey?: string
}

// ---------------------------------------------------------------------------
// TdamToolkit
// ---------------------------------------------------------------------------

export class TdamToolkit {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(options: TdamToolkitOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8420').replace(/\/+$/, '')
    this.apiKey = options.apiKey ?? process.env.TDAI_GATEWAY_API_KEY ?? ''
  }

  /** Register both TDAM tools with the given registry. */
  registerAll(registry: ToolRegistry): void {
    for (const tool of this.getTools()) {
      registry.register(tool)
    }
  }

  /**
   * Returns both TDAM tool definitions as an array.
   * Use this with `AgentConfig.customTools` so the orchestrator's per-agent
   * registry picks them up automatically.
   */
  getTools() {
    return [this.searchMemoriesTool(), this.searchConversationsTool()]
  }

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  private searchMemoriesTool() {
    return defineTool({
      name: 'tdam_search_memories',
      description:
        'Search the team\'s long-term memory for distilled facts from previous ' +
        'sessions. Use this when you need background the current conversation ' +
        'does not contain — prior findings, decisions, or user preferences.',
      inputSchema: z.object({
        query: z.string().describe('What to search for'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      }),
      execute: async (input) => {
        const res = await fetch(`${this.baseUrl}/search/memories`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ query: input.query, limit: input.limit ?? 5 }),
          signal: AbortSignal.timeout(60_000),
        })
        const data = await res.text()
        return { data, isError: !res.ok }
      },
    })
  }

  private searchConversationsTool() {
    return defineTool({
      name: 'tdam_search_conversations',
      description:
        'Search the raw conversation history captured in long-term memory. ' +
        'Use this to quote or verify exactly what was said in a previous session.',
      inputSchema: z.object({
        query: z.string().describe('What to search for'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      }),
      execute: async (input) => {
        const res = await fetch(`${this.baseUrl}/search/conversations`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ query: input.query, limit: input.limit ?? 5 }),
          signal: AbortSignal.timeout(60_000),
        })
        const data = await res.text()
        return { data, isError: !res.ok }
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }
}
