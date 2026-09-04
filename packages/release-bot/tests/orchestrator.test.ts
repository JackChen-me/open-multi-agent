import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
  ThinkingConfig,
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

const diffRunner: CommandRunner = {
  run: async () => ({
    stdout: 'diff --git a/packages/core/src/recovery.ts b/packages/core/src/recovery.ts\n+export const recovery = true\n',
    stderr: '',
    exitCode: 0,
  }),
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

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
      createOmaApp: '0.7.1',
    })
    expect(run.decision.plan.bumps.createOmaApp).toBe('patch')
    expect(run.proposal.createOmaAppBump).toBe('patch')
    expect(adapter.roles.slice(0, 2).sort()).toEqual(['change-analyst', 'compatibility-auditor'])
    expect(adapter.roles[2]).toBe('release-planner')
    expect(adapter.roles[3]).toBe('release-reviewer')
    expect(adapter.plannerMessages).toContain('Durable recovery is additive.')
    expect(adapter.reviewerMessages).toContain('Release durable recovery.')
    expect(adapter.reviewerMessages).toContain('\\"createOmaAppBump\\":\\"patch\\"')
    expect(adapter.reviewerMessages).toContain('currentVersions')
    expect(adapter.toolSets).toHaveLength(4)
    for (const tools of adapter.toolSets.slice(0, 2)) {
      expect(tools).toEqual([
        'get_release_evidence',
        'read_release_review_bundle',
        'read_release_contract',
      ])
    }
    expect(adapter.toolSets.slice(2)).toEqual([[], []])
    // One budget for every role: reasoning and the answer are billed against
    // the same ceiling, so a per-role figure sized for the answer starves the
    // answer whenever reasoning grows.
    expect(adapter.maxTokensByRole).toEqual(new Map([
      ['change-analyst', 64_000],
      ['compatibility-auditor', 64_000],
      ['release-planner', 64_000],
      ['release-reviewer', 64_000],
    ]))
    expect(adapter.thinkingByRole).toEqual(new Map([
      ['change-analyst', { enabled: true, effort: 'max' }],
      ['compatibility-auditor', { enabled: true, effort: 'max' }],
      ['release-planner', { enabled: true, effort: 'max' }],
      ['release-reviewer', { enabled: true, effort: 'max' }],
    ]))
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

  it('accepts analysis only after each evidence role calls all three tools once', async () => {
    const run = await generateReleaseDecision({
      repoRoot,
      runner: diffRunner,
      evidence,
      adapter: new EvidenceToolScriptAdapter(),
      releaseDate: '2026-08-10',
    })

    expect(run.decision.status).toBe('release')
    expect(run.proposal.createOmaAppBump).toBe('patch')
  })

  it('names the run status, token totals, and unfinished tasks when the budget is exhausted', async () => {
    // A budget stop fails no individual agent, so reporting only per-agent
    // failures used to produce a bare "OMA release analysis failed." and sent
    // the reader to the raw [OMA] progress log to find the cause.
    const failure = await generateReleaseDecision({
      repoRoot: '/tmp/unused-release-bot-test',
      runner: neverRunner,
      evidence,
      adapter: new ReleaseScriptAdapter(),
      releaseDate: '2026-08-10',
      requireEvidenceToolCalls: false,
      maxTokenBudget: 20,
    }).then(() => null, (error: unknown) => error as Error)

    expect(failure).toBeInstanceOf(Error)
    const message = failure?.message ?? ''
    expect(message.replace('OMA release analysis failed.', '').trim()).not.toBe('')
    expect(message).toMatch(/budget_exhausted \(\d+ of 20 tokens\)/)
    // The 2026-08-14 scheduled run failed exactly this way: an evidence agent
    // exhausted the budget and both synthesis tasks were skipped, so no agent
    // result carried a failure to report.
    expect(message).toContain('Propose bounded release plan [skipped]')
    expect(message).toContain('Review bounded release plan [skipped]')
  })

  it('rejects a non-positive token budget before starting the DAG', async () => {
    await expect(generateReleaseDecision({
      repoRoot: '/tmp/unused-release-bot-test',
      runner: neverRunner,
      evidence,
      adapter: new ReleaseScriptAdapter(),
      releaseDate: '2026-08-10',
      requireEvidenceToolCalls: false,
      maxTokenBudget: 0,
    })).rejects.toThrow(/maxTokenBudget must be a positive integer/)
  })

  it('retries a synthesis task through a transient provider failure', async () => {
    // Only the two synthesis tasks carry a retry. The evidence tasks must not,
    // because a second attempt re-calls their tools and would then trip the
    // exactly-one-call coverage assertion.
    const adapter = new FlakyPlannerAdapter()
    const run = await generateReleaseDecision({
      repoRoot: '/tmp/unused-release-bot-test',
      runner: neverRunner,
      evidence,
      adapter,
      releaseDate: '2026-08-10',
      requireEvidenceToolCalls: false,
    })

    expect(adapter.plannerAttempts).toBe(2)
    expect(run.decision.status).toBe('release')
  })

  it('aborts the complete DAG at the configured global deadline', async () => {
    await expect(generateReleaseDecision({
      repoRoot: '/tmp/unused-release-bot-test',
      runner: neverRunner,
      evidence,
      adapter: new DeadlineAdapter(),
      releaseDate: '2026-08-10',
      requireEvidenceToolCalls: false,
      runTimeoutMs: 20,
    })).rejects.toThrow(/global deadline of 20ms/)
  })
})

class ReleaseScriptAdapter implements LLMAdapter {
  readonly name = 'scripted-release-test'
  readonly roles: string[] = []
  readonly toolSets: string[][] = []
  readonly maxTokensByRole = new Map<string, number | undefined>()
  readonly thinkingByRole = new Map<string, ThinkingConfig | undefined>()
  plannerMessages = ''
  reviewerMessages = ''
  private sequence = 0

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = identifyRole(options.systemPrompt ?? '')
    this.roles.push(role)
    this.toolSets.push((options.tools ?? []).map(tool => tool.name))
    this.maxTokensByRole.set(role, options.maxTokens)
    this.thinkingByRole.set(role, options.thinking)
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

class DeadlineAdapter implements LLMAdapter {
  readonly name = 'deadline-release-test'

  async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    await new Promise<void>((resolve) => {
      if (options.abortSignal?.aborted) resolve()
      else options.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
    })
    const role = identifyRole(options.systemPrompt ?? '')
    return {
      id: `deadline-${role}`,
      content: [{ type: 'text', text: JSON.stringify(responseFor(role)) }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    const response = await this.chat(messages, options)
    yield { type: 'done', data: response }
  }
}

class EvidenceToolScriptAdapter implements LLMAdapter {
  readonly name = 'evidence-tool-release-test'
  private readonly toolIndex = new Map<string, number>()
  private sequence = 0

  async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = identifyRole(options.systemPrompt ?? '')
    const toolNames = [
      'get_release_evidence',
      'read_release_review_bundle',
      'read_release_contract',
    ] as const
    const index = this.toolIndex.get(role) ?? 0
    this.sequence += 1

    if ((role === 'change-analyst' || role === 'compatibility-auditor') && index < toolNames.length) {
      const toolName = toolNames[index]!
      this.toolIndex.set(role, index + 1)
      return {
        id: `tool-${this.sequence}`,
        content: [{
          type: 'tool_use',
          id: `call-${role}-${index}`,
          name: toolName,
          input: {},
        }],
        model: options.model,
        stop_reason: 'tool_use',
        usage: { input_tokens: 2, output_tokens: 1 },
      }
    }

    return {
      id: `final-${this.sequence}`,
      content: [{ type: 'text', text: JSON.stringify(responseFor(role)) }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    const response = await this.chat(messages, options)
    yield { type: 'done', data: response }
  }
}

/** Fails the planner's first call with a retryable upstream error, then behaves. */
class FlakyPlannerAdapter implements LLMAdapter {
  readonly name = 'flaky-planner-release-test'
  plannerAttempts = 0
  private sequence = 0

  async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = identifyRole(options.systemPrompt ?? '')
    if (role === 'release-planner') {
      this.plannerAttempts += 1
      if (this.plannerAttempts === 1) {
        throw Object.assign(new Error('upstream unavailable'), { status: 503 })
      }
    }
    this.sequence += 1
    return {
      id: `flaky-${this.sequence}`,
      content: [{ type: 'text', text: JSON.stringify(responseFor(role)) }],
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
