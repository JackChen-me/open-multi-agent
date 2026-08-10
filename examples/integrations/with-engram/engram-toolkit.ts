/**
 * Engram Toolkit
 *
 * Registers four Engram tools with a {@link ToolRegistry} so any agent can
 * commit facts, query shared memory, audit conflict resolutions, and override
 * auto-resolutions.
 *
 * Run:
 *   npx tsx examples/integrations/with-engram/research-team.ts
 *
 * Prerequisites:
 *   - Engram server running at http://localhost:7474 (or custom baseUrl)
 *   - ENGRAM_INVITE_KEY env var (or passed via constructor)
 */

import { z } from 'zod'
import { defineTool, ToolRegistry } from '../../../packages/core/src/index.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EngramToolkitOptions {
  /** Engram server URL. Defaults to `http://localhost:7474`. */
  baseUrl?: string
  /** Workspace invite key. Falls back to `ENGRAM_INVITE_KEY` env var. */
  inviteKey?: string
}

// ---------------------------------------------------------------------------
// EngramToolkit
// ---------------------------------------------------------------------------

export class EngramToolkit {
  private readonly baseUrl: string
  private readonly inviteKey: string

  constructor(options: EngramToolkitOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:7474').replace(/\/+$/, '')
    this.inviteKey = options.inviteKey ?? process.env.ENGRAM_INVITE_KEY ?? ''
  }

  /**
   * Register all four Engram tools with the given registry.
   */
  registerAll(registry: ToolRegistry): void {
    for (const tool of this.getTools()) {
      registry.register(tool)
    }
  }

  /**
   * Returns all four Engram tool definitions as an array.
   * Use this with `AgentConfig.customTools` so the orchestrator's per-agent
   * registry picks them up automatically (instead of a shared outer registry
   * that `runTeam` / `buildPool` never sees).
   */
  getTools() {
    return [this.commitTool(), this.queryTool(), this.conflictsTool(), this.resolveTool()]
  }

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  private commitTool() {
    return defineTool({
      name: 'engram_commit',
      description:
        'Commit a verified fact to Engram shared team memory. ' +
        'Use this to record discoveries, decisions, or corrections that other agents should see.',
      inputSchema: z.object({
        content: z.string().describe('The fact to commit'),
        scope: z.string().describe('Context scope (e.g. "research", "architecture")'),
        confidence: z.number().min(0).max(1).describe('Confidence level 0-1'),
        operation: z
          .enum(['add', 'update', 'delete', 'none'])
          .optional()
          .describe('Memory operation. Use "update" when correcting a prior fact. Default: add.'),
        fact_type: z
          .enum(['observation', 'decision', 'constraint', 'warning', 'inference'])
          .optional()
          .describe('Category of the fact'),
        agent_id: z.string().optional().describe('Identifier of the committing agent'),
        ttl_days: z.number().optional().describe('Auto-expire after N days'),
      }),
      execute: async (input) => {
        const res = await fetch(`${this.baseUrl}/api/commit`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(input),
        })
        const data = await res.text()
        return { data, isError: !res.ok }
      },
    })
  }

  private queryTool() {
    return defineTool({
      name: 'engram_query',
      description:
        'Query Engram shared memory for facts about a topic. ' +
        'Call this before starting any task to see what the team already knows.',
      inputSchema: z.object({
        topic: z.string().describe('What to search for'),
        scope: z.string().optional().describe('Filter by scope'),
        limit: z.number().optional().describe('Max results (default 10)'),
        fact_type: z
          .enum(['observation', 'decision', 'constraint', 'warning', 'inference'])
          .optional()
          .describe('Filter by fact type'),
      }),
      execute: async (input) => {
        const res = await fetch(`${this.baseUrl}/api/query`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(input),
        })
        const data = await res.text()
        return { data, isError: !res.ok }
      },
    })
  }

  private conflictsTool() {
    return defineTool({
      name: 'engram_conflicts',
      description:
        'List conflicts between facts in Engram shared memory. ' +
        'Conflicts are auto-resolved by Claude (with ANTHROPIC_API_KEY) or heuristic — ' +
        'this tool is for auditing resolutions, not triggering them.',
      inputSchema: z.object({
        scope: z.string().optional().describe('Filter by scope'),
        status: z
          .enum(['open', 'resolved', 'dismissed'])
          .optional()
          .describe('Filter by status (default: open)'),
      }),
      execute: async (input) => {
        const params = new URLSearchParams()
        if (input.scope) params.set('scope', input.scope)
        if (input.status) params.set('status', input.status)
        const qs = params.toString()
        const url = `${this.baseUrl}/api/conflicts${qs ? `?${qs}` : ''}`

        const res = await fetch(url, { headers: this.headers() })
        const data = await res.text()
        return { data, isError: !res.ok }
      },
    })
  }

  private resolveTool() {
    return defineTool({
      name: 'engram_resolve',
      description:
        'Override an auto-resolution for a conflict between facts. ' +
        'Use this when the automatic resolution was incorrect and you need to pick a different winner or merge.',
      inputSchema: z.object({
        conflict_id: z.string().describe('ID of the conflict to resolve'),
        resolution_type: z
          .enum(['winner', 'merge', 'dismissed'])
          .describe('How to resolve: pick a winner, merge both, or dismiss'),
        resolution: z.string().describe('Explanation of the resolution'),
        winning_claim_id: z
          .string()
          .optional()
          .describe('fact_id of the correct fact (required for winner type)'),
      }),
      execute: async (input) => {
        const res = await fetch(`${this.baseUrl}/api/resolve`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(input),
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
    return {
      Authorization: `Bearer ${this.inviteKey}`,
      'Content-Type': 'application/json',
    }
  }
}
