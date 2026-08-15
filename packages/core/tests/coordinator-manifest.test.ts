import { describe, expect, it } from 'vitest'

import {
  COORDINATOR_ROLE_SUMMARY_MAX_CHARS,
  buildCoordinatorOutputFormatSection,
  buildCoordinatorRosterManifest,
  buildCoordinatorRosterSection,
  parseTaskSpecs,
} from '../src/orchestrator/coordinator.js'
import { buildRoutingContext } from '../src/orchestrator/execution-router.js'
import type { AgentConfig } from '../src/types.js'

describe('coordinator roster manifest', () => {
  it('uses explicit descriptions before bounded first-line prompt summaries', () => {
    const agents: AgentConfig[] = [
      {
        name: 'described',
        model: 'test-model',
        description: 'Explicit role description.',
        systemPrompt: 'SECRET_FULL_PROMPT_SHOULD_NOT_WIN\nmore secret text',
        capabilities: ['research'],
        tools: ['file_read'],
        costTier: 'low',
      },
      {
        name: 'fallback',
        model: 'test-model',
        systemPrompt: `${'首行角色'.repeat(80)}\nSECOND_SECRET_LINE`,
      },
    ]

    const manifest = buildCoordinatorRosterManifest(agents)

    expect(manifest[0]).toEqual({
      name: 'described',
      model: 'test-model',
      roleSummary: 'Explicit role description.',
      capabilities: ['research'],
      tools: ['file_read'],
      costTier: 'low',
    })
    expect(manifest[1]?.roleSummary?.length).toBeLessThanOrEqual(
      COORDINATOR_ROLE_SUMMARY_MAX_CHARS,
    )
    expect(JSON.stringify(manifest)).not.toContain('SECOND_SECRET_LINE')
    expect(JSON.stringify(manifest)).not.toContain('SECRET_FULL_PROMPT_SHOULD_NOT_WIN')
  })

  it('allowlists fields and keeps size independent of full system-prompt length', () => {
    const base: AgentConfig = {
      name: 'worker',
      model: 'test-model',
      systemPrompt: 'Role summary\nshort body',
      apiKey: 'sk-secret-value',
      credentials: { token: 'credential-secret-value' },
    }
    const shortSection = buildCoordinatorRosterSection([base])
    const longSection = buildCoordinatorRosterSection([{
      ...base,
      systemPrompt: `Role summary\n${'private body '.repeat(100_000)}`,
    }])

    expect(longSection.length).toBe(shortSection.length)
    expect(longSection).not.toContain('private body')
    expect(longSection).not.toContain('sk-secret-value')
    expect(longSection).not.toContain('credential-secret-value')
    expect(longSection).not.toContain('"apiKey"')
    expect(longSection).not.toContain('"credentials"')

    const tenAgentSection = buildCoordinatorRosterSection(
      Array.from({ length: 10 }, (_, index) => ({
        ...base,
        name: `worker-${index}`,
        systemPrompt: `Role summary\n${'private body '.repeat(100_000)}`,
      })),
    )
    expect(tenAgentSection.length).toBeLessThan(10 * 500)
  })

  it('keeps role summaries out of execution-router context', () => {
    const context = buildRoutingContext('Goal', [{
      name: 'worker',
      model: 'test-model',
      description: 'Explicit coordinator-only role summary.',
      capabilities: ['research'],
      costTier: 'low',
    }], 'fallback-model', {})

    expect(context.roster).toEqual([{
      name: 'worker',
      model: 'test-model',
      capabilities: ['research'],
      costTier: 'low',
    }])
    expect(JSON.stringify(context)).not.toContain('roleSummary')
    expect(JSON.stringify(context)).not.toContain('coordinator-only')
  })

  it('parses optional task requirements from coordinator JSON', () => {
    const specs = parseTaskSpecs(`\`\`\`json
      [{
        "title": "Patch",
        "description": "Patch the parser",
        "assignee": "editor",
        "requires": {
          "requiredTools": ["file_edit"],
          "requiredCapabilities": ["typescript"],
          "requiredBackend": "llm",
          "requiredProvider": "anthropic"
        }
      }]
    \`\`\``)

    expect(specs?.[0]?.requires).toEqual({
      requiredTools: ['file_edit'],
      requiredCapabilities: ['typescript'],
      requiredBackend: 'llm',
      requiredProvider: 'anthropic',
    })
  })

  it('guides assignee selection through manifest capability tags', () => {
    const section = buildCoordinatorOutputFormatSection()

    expect(section).toContain(
      'Prefer an agent whose manifest `capabilities` best match the task',
    )
    expect(section).toContain(
      'use `roleSummary` and `tools` only as secondary assignment signals',
    )
  })
})
