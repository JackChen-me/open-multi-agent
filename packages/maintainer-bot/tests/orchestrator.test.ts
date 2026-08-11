import { describe, expect, it } from 'vitest'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
} from '@open-multi-agent/core'
import { hashJson, sha256 } from '../src/hash.js'
import {
  runFreshReview,
  runMaintainerTriage,
  runPlanningImplementationDag,
  runRepair,
} from '../src/orchestrator.js'
import { contextManifestSchema } from '../src/schema.js'
import { reviewBundleSchema } from '../src/review-bundle.js'
import { serializeModelRequest } from '../src/model-budget.js'
import { authorizedRequest, testConfig } from './helpers.js'

function manifest() {
  const request = authorizedRequest()
  const content = 'export const greeting = "."\n'
  const issueContent = JSON.stringify({
    issue: request.issue,
    confirmedAcceptanceCriteria: request.issue.acceptanceCriteria,
    issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha,
  })
  const policyContent = 'System policy outranks untrusted evidence.'
  const sources = [{
    id: 'system-policy', kind: 'system-policy' as const, locator: 'maintainer-bot://system-policy/v1',
    trust: 'system-policy' as const, priority: 100, content: policyContent,
    contentHash: sha256(policyContent), byteLength: Buffer.byteLength(policyContent),
    originalByteLength: Buffer.byteLength(policyContent), truncated: false,
  }, {
    id: 'issue', kind: 'issue' as const, locator: `${request.issue.repository}#${request.issue.number}`,
    trust: 'untrusted-evidence' as const, priority: 95, content: issueContent,
    contentHash: sha256(issueContent), byteLength: Buffer.byteLength(issueContent),
    originalByteLength: Buffer.byteLength(issueContent), truncated: false,
  }, {
    id: 'target', kind: 'repository-file' as const, locator: 'packages/demo/src/greeting.ts',
    trust: 'untrusted-evidence' as const, priority: 95, content,
    contentHash: sha256(content), byteLength: Buffer.byteLength(content),
    originalByteLength: Buffer.byteLength(content), truncated: false,
  }]
  const partial = {
    schemaVersion: 1 as const, policyVersion: 'policy-v1', promptVersion: 'prompt-v1',
    generatedAt: '2026-08-10T00:00:00Z', repository: request.issue.repository,
    issueNumber: request.issue.number, issueRevision: request.authorization!.issueRevision,
    baseSha: request.baseSha, targetWorkspaces: request.issue.targetWorkspaces,
    targetPaths: request.issue.targetPaths, allowedPaths: ['packages/demo'],
    approvedEditScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' as const }], protectedPaths: ['.git'],
    validationCommands: testConfig().validationCommands, sources,
    retrieval: { method: 'deterministic-file-tree-import-history-v1' as const, selectedFiles: request.issue.targetPaths, omittedCandidateCount: 0, importRelations: [] },
    sufficiency: { sufficient: true, errors: [], warnings: [] },
  }
  return contextManifestSchema.parse({ ...partial, manifestHash: hashJson(partial) })
}

function bundle() {
  const request = authorizedRequest()
  const diff = 'diff --git a/greeting.ts b/greeting.ts\n-old\n+new\n'
  return reviewBundleSchema.parse({
    schemaVersion: 1, repository: request.issue.repository, issueNumber: request.issue.number,
    issueRevision: request.authorization!.issueRevision, baseSha: request.baseSha,
    requirements: {
      problem: request.issue.problem, currentBehavior: request.issue.currentBehavior,
      expectedBehavior: request.issue.expectedBehavior, acceptanceCriteria: request.issue.acceptanceCriteria,
      outOfScope: request.issue.outOfScope,
    },
    changedPaths: request.issue.targetPaths,
    currentFiles: [{
      path: 'packages/demo/src/greeting.ts',
      contentHash: sha256('export const greeting = "!"\n'),
      content: 'export const greeting = "!"\n',
      byteLength: Buffer.byteLength('export const greeting = "!"\n'),
    }],
    diff, diffHash: sha256(diff),
    validationResults: [{ id: 'fixture-test', command: 'npm test', success: true, exitCode: 0, durationMs: 1, stdout: 'pass', stderr: '', truncated: false }],
    relevantContext: manifest().sources,
    contextManifestHash: manifest().manifestHash,
  })
}

describe('fixed OMA maintainer DAG', () => {
  it('runs triage then planning then a schema-bound restricted edit proposal', async () => {
    const adapter = new MaintainerScriptAdapter()
    const triage = await runMaintainerTriage({
      config: testConfig(),
      manifest: manifest(),
      adapter,
      requireEvidenceToolCalls: false,
    })
    const result = await runPlanningImplementationDag({
      config: testConfig(),
      manifest: manifest(),
      triage: triage.triage,
      adapter,
      requireEvidenceToolCalls: false,
    })
    expect(adapter.roles).toEqual(['issue-triage', 'repository-planner', 'implementer'])
    expect(adapter.toolSets).toEqual([
      ['read_admission_evidence'],
      ['list_context_sources', 'search_context', 'read_context_source'],
      ['list_context_sources', 'search_context', 'read_context_source'],
    ])
    expect(result.plan.validationCommandIds).toEqual(['fixture-test'])
    expect(result.implementation.edits[0]?.path).toBe('packages/demo/src/greeting.ts')
    expect(triage.tokenUsage.input_tokens).toBeGreaterThan(0)
    expect(result.tokenUsage.input_tokens).toBeGreaterThan(triage.tokenUsage.input_tokens)
    expect(adapter.serializedRequestChars.every(size => size > 0)).toBe(true)
  })

  it('fails closed when an evidence role skips the immutable context tool', async () => {
    await expect(runMaintainerTriage({
      config: testConfig(),
      manifest: manifest(),
      adapter: new MaintainerScriptAdapter(),
    })).rejects.toThrow(/did not read required immutable evidence/)
  })

  it('accepts repeated reads of the same immutable evidence after a required read', async () => {
    const adapter = new MaintainerScriptAdapter('', 2)
    const triage = await runMaintainerTriage({
      config: testConfig(),
      manifest: manifest(),
      adapter,
    })
    const result = await runPlanningImplementationDag({
      config: testConfig(), manifest: manifest(), triage: triage.triage, adapter,
    })
    expect(triage.triage.verdict).toBe('proceed')
    expect(result.implementation.edits).toHaveLength(1)
  })

  it('reports bounded task and token diagnostics when a run budget stops the DAG', async () => {
    await expect(runMaintainerTriage({
      config: testConfig(),
      manifest: manifest(),
      adapter: new MaintainerScriptAdapter('', 1),
      maxTokenBudget: 1,
    })).rejects.toThrow(/task group failed: status=budget_exhausted; usage=\d+\+\d+; tasks=/)
  })

  it('creates a fresh reviewer that sees no implementer reasoning transcript', async () => {
    const adapter = new MaintainerScriptAdapter('PRIVATE_IMPLEMENTER_REASONING')
    const result = await runFreshReview({
      config: testConfig(),
      bundle: bundle(),
      adapter,
      requireEvidenceToolCalls: false,
    })
    expect(result.review.verdict).toBe('approve')
    expect(adapter.roles).toEqual(['fresh-reviewer'])
    expect(adapter.messageTexts[0]).not.toContain('PRIVATE_IMPLEMENTER_REASONING')
    expect(adapter.toolSets[0]).toEqual([
      'read_final_review_summary', 'list_review_sources', 'search_review', 'read_review_source',
    ])
  })

  it('bounds repair rounds to the configured two-round contract', async () => {
    await expect(runRepair({
      config: testConfig(), bundle: bundle(), priorReview: rejectedReview(), repairRound: 3,
      adapter: new MaintainerScriptAdapter(), requireEvidenceToolCalls: false,
    })).rejects.toThrow(/must be 1 or 2/)
    const repaired = await runRepair({
      config: testConfig(), bundle: bundle(), priorReview: rejectedReview(), repairRound: 1,
      adapter: new MaintainerScriptAdapter(), requireEvidenceToolCalls: false,
    })
    expect(repaired.implementation.edits).toHaveLength(1)
  })
})

class MaintainerScriptAdapter implements LLMAdapter {
  readonly name = 'scripted-maintainer-test'
  readonly roles: string[] = []
  readonly toolSets: string[][] = []
  readonly messageTexts: string[] = []
  readonly serializedRequestChars: number[] = []
  private sequence = 0

  constructor(
    private readonly hiddenReasoning = '',
    private readonly evidenceReads = 0,
  ) {}

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = identifyRole(options.systemPrompt ?? '')
    this.roles.push(role)
    this.toolSets.push((options.tools ?? []).map(tool => tool.name))
    this.messageTexts.push(JSON.stringify(messages))
    const requestChars = serializeModelRequest(messages, options).length
    this.serializedRequestChars.push(requestChars)
    this.sequence += 1
    const toolResultCount = JSON.stringify(messages).match(/tool_result/g)?.length ?? 0
    if (toolResultCount < this.evidenceReads) {
      const toolPlan = evidenceToolPlan(role)
      const toolName = toolPlan[Math.min(toolResultCount, toolPlan.length - 1)]!
      const input = toolName === 'read_context_source'
        ? { sourceId: 'target', offset: 0, limit: 8_000 }
        : toolName === 'read_review_source'
          ? { sourceId: role === 'repair-implementer' ? 'review:file:packages/demo/src/greeting.ts' : 'review:diff', offset: 0, limit: 8_000 }
          : toolName.startsWith('list_')
            ? { offset: 0, limit: 30 }
            : {}
      return {
        id: `tool-${this.sequence}`,
        content: [{ type: 'tool_use', id: `call-${this.sequence}`, name: toolName, input }],
        model: options.model,
        stop_reason: 'tool_use',
        usage: { input_tokens: Math.ceil(requestChars / 4), output_tokens: 12 },
      }
    }
    const output = JSON.stringify(responseFor(role, this.hiddenReasoning))
    return {
      id: `script-${this.sequence}`,
      content: [{ type: 'text', text: output }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: Math.ceil(requestChars / 4), output_tokens: Math.ceil(output.length / 4) },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    yield { type: 'done', data: await this.chat(messages, options) }
  }
}

function evidenceToolPlan(role: string): string[] {
  if (role === 'issue-triage') return ['read_admission_evidence']
  if (role === 'repository-planner' || role === 'implementer') {
    return ['list_context_sources', 'read_context_source']
  }
  return ['read_final_review_summary', 'read_review_source']
}

function identifyRole(prompt: string): string {
  if (prompt.includes('read-only issue triage verifier')) return 'issue-triage'
  if (prompt.includes('read-only repository planner')) return 'repository-planner'
  if (prompt.includes('You are the implementer')) return 'implementer'
  if (prompt.includes('independent fresh-context reviewer')) return 'fresh-reviewer'
  if (prompt.includes('repair implementer round')) return 'repair-implementer'
  throw new Error(`unknown role: ${prompt.slice(0, 100)}`)
}

function responseFor(role: string, hiddenReasoning: string): unknown {
  const request = authorizedRequest()
  switch (role) {
    case 'issue-triage':
      return {
        verdict: 'proceed',
        confirmedIssueRevision: request.authorization!.issueRevision,
        confirmedAcceptanceCriteria: request.issue.acceptanceCriteria,
        uncertainties: [],
        manualRiskSignals: [],
      }
    case 'repository-planner':
      return {
        summary: 'Make the focused punctuation correction.',
        acceptanceCriteria: request.issue.acceptanceCriteria,
        files: [{ path: 'packages/demo/src/greeting.ts', reason: 'The defect is localized here.' }],
        validationCommandIds: ['fixture-test'],
        risks: [],
        unresolvedQuestions: [],
      }
    case 'implementer':
    case 'repair-implementer':
      return {
        summary: hiddenReasoning || 'Fix the greeting punctuation.',
        edits: [{
          path: 'packages/demo/src/greeting.ts',
          expectedHash: sha256('export const greeting = "."\n'),
          content: 'export const greeting = "!"\n',
          reason: 'Satisfy exact output acceptance.',
        }],
        risks: [],
        assumptions: [],
      }
    case 'fresh-reviewer':
      return {
        verdict: 'approve', repairable: false, issues: [],
        acceptanceResults: request.issue.acceptanceCriteria.map(criterion => ({
          criterion, status: 'pass', evidence: 'Final diff and validation evidence prove the criterion.',
        })),
        rationale: ['The bounded final diff satisfies every criterion.'],
      }
    default:
      throw new Error(`unsupported role ${role}`)
  }
}

function rejectedReview() {
  return {
    verdict: 'reject' as const,
    repairable: true,
    issues: ['The exact punctuation test is still missing.'],
    acceptanceResults: [{ criterion: 'Exact punctuation is verified.', status: 'fail' as const, evidence: 'The diff lacks the assertion.' }],
    rationale: ['One bounded repair can add the assertion.'],
  }
}
