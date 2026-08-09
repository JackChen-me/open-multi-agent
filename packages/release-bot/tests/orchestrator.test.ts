import { describe, expect, it } from 'vitest'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
} from '@open-multi-agent/core'
import type { CommandRunner } from '../src/command.js'
import { generateReleaseDecision } from '../src/orchestrator.js'
import type { ReleaseEvidence } from '../src/schema.js'

const evidence: ReleaseEvidence = {
  schemaVersion: 1,
  generatedAt: '2026-08-10T00:00:00.000Z',
  baseTag: 'v1.14.0',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  versions: { core: '1.14.0', otel: '0.1.1', createOmaApp: '0.7.0' },
  commits: [{ sha: 'b'.repeat(40), subject: 'feat(core): add recovery', body: '' }],
  changedFiles: [{ path: 'packages/core/src/recovery.ts', additions: 10, deletions: 0 }],
  changelogUnreleased: '',
  workspaceChanges: { core: true, otel: false, createOmaApp: false, docs: false, workflows: false },
}

const neverRunner: CommandRunner = {
  run: async () => { throw new Error('read-only tools were not expected in this scripted test') },
}

describe('OMA release orchestration', () => {
  it('runs independent analysis before bounded planning and review', async () => {
    const adapter = new ReleaseScriptAdapter()
    const run = await generateReleaseDecision({
      repoRoot: '/tmp/unused-release-bot-test',
      runner: neverRunner,
      evidence,
      adapter,
      releaseDate: '2026-08-10',
      requireEvidenceToolCalls: false,
    })

    expect(run.decision.status).toBe('release')
    if (run.decision.status !== 'release') throw new Error('expected release')
    expect(run.decision.plan.nextVersions).toEqual({
      core: '1.15.0',
      otel: '0.1.1',
      createOmaApp: '0.8.0',
    })
    expect(adapter.roles.slice(0, 2).sort()).toEqual(['change-analyst', 'compatibility-auditor'])
    expect(adapter.roles[2]).toBe('release-planner')
    expect(adapter.roles[3]).toBe('release-reviewer')
    expect(adapter.plannerMessages).toContain('Durable recovery is additive.')
    expect(adapter.reviewerMessages).toContain('Release durable recovery.')
    expect(adapter.toolSets).toHaveLength(4)
    for (const tools of adapter.toolSets) {
      expect(tools).toEqual([
        'get_release_evidence',
        'read_changed_diff',
        'read_release_contract',
      ])
    }
    expect(run.tokenUsage).toEqual({ input_tokens: 40, output_tokens: 20 })
  })

  it('fails closed when agents skip required immutable evidence tools', async () => {
    await expect(generateReleaseDecision({
      repoRoot: '/tmp/unused-release-bot-test',
      runner: neverRunner,
      evidence,
      adapter: new ReleaseScriptAdapter(),
      releaseDate: '2026-08-10',
    })).rejects.toThrow(/did not call required evidence tool/)
  })
})

class ReleaseScriptAdapter implements LLMAdapter {
  readonly name = 'scripted-release-test'
  readonly roles: string[] = []
  readonly toolSets: string[][] = []
  plannerMessages = ''
  reviewerMessages = ''
  private sequence = 0

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = identifyRole(options.systemPrompt ?? '')
    this.roles.push(role)
    this.toolSets.push((options.tools ?? []).map(tool => tool.name))
    const messageText = JSON.stringify(messages)
    if (role === 'release-planner') this.plannerMessages = messageText
    if (role === 'release-reviewer') this.reviewerMessages = messageText
    const output = responseFor(role)
    this.sequence += 1
    return {
      id: `scripted-${this.sequence}`,
      content: [{ type: 'text', text: JSON.stringify(output) }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    const response = await this.chat(messages, options)
    yield { type: 'done', data: response }
  }
}

function identifyRole(systemPrompt: string): string {
  if (systemPrompt.includes('change analyst')) return 'change-analyst'
  if (systemPrompt.includes('compatibility auditor')) return 'compatibility-auditor'
  if (systemPrompt.includes('release planner')) return 'release-planner'
  if (systemPrompt.includes('final release reviewer')) return 'release-reviewer'
  throw new Error(`unknown scripted role: ${systemPrompt.slice(0, 100)}`)
}

function responseFor(role: string): unknown {
  switch (role) {
    case 'change-analyst':
      return {
        releaseRecommended: true,
        recommendedCoreBump: 'minor',
        recommendedCreateOmaAppBump: 'minor',
        recommendedOtelBump: 'none',
        changelog: sections(['Durable recovery is additive.']),
        rationale: ['The public capability is user-visible.'],
      }
    case 'compatibility-auditor':
      return {
        risk: 'low',
        breaking: false,
        recommendedCoreBump: 'minor',
        issues: [],
        migrationNotes: [],
        rationale: ['No existing input or export is narrowed.'],
      }
    case 'release-planner':
      return {
        decision: 'release',
        coreBump: 'minor',
        createOmaAppBump: 'minor',
        otelBump: 'none',
        summary: 'Release durable recovery.',
        changelog: sections(['Durable recovery resumes interrupted turns.']),
        risks: [],
        rationale: ['Both independent reports support an additive release.'],
      }
    case 'release-reviewer':
      return {
        verdict: 'approve',
        issues: [],
        rationale: ['Release durable recovery matches the dependency evidence.'],
      }
    default:
      throw new Error(`unsupported role ${role}`)
  }
}

function sections(added: string[]): Record<string, string[]> {
  return {
    breakingChanges: [],
    added,
    changed: [],
    fixed: [],
    security: [],
    compatibility: [],
  }
}
