import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  StreamEvent,
} from '@open-multi-agent/core'
import { computeIssueRevision } from '../src/admission.js'
import { sha256 } from '../src/hash.js'
import { runMaintainerBot } from '../src/pipeline.js'
import { serializeModelRequest } from '../src/model-budget.js'
import { controlPlaneRequestSchema } from '../src/schema.js'
import { computeRunKey, FileRunStateStore } from '../src/state.js'
import { authorizedRequest, BASE_SHA, ScriptedCommandRunner, testConfig } from './helpers.js'

const ORIGINAL = 'export const greeting = "."\n'
const FIXED = 'export const greeting = "!"\n'
const HELPER_ORIGINAL = 'export const helper = "."\n'

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-pipeline-repo-'))
  await mkdir(join(root, '.github'), { recursive: true })
  await mkdir(join(root, 'packages/demo/src'), { recursive: true })
  await mkdir(join(root, 'packages/demo/tests'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# Fixture policy\n')
  await writeFile(join(root, '.github/CONTRIBUTING.md'), '# Contributing\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }))
  await writeFile(join(root, 'packages/demo/package.json'), JSON.stringify({ name: '@fixture/demo' }))
  await writeFile(join(root, 'packages/demo/tsconfig.json'), '{}\n')
  await writeFile(join(root, 'packages/demo/src/greeting.ts'), ORIGINAL)
  await writeFile(join(root, 'packages/demo/src/helper.ts'), HELPER_ORIGINAL)
  await writeFile(join(root, 'packages/demo/tests/greeting.test.ts'), 'export const covered = true\n')
  return root
}

async function scriptedClaudeHarness(options: {
  readonly fail?: boolean
} = {}): Promise<{ cli: string; contractPath: string; countPath: string; promptPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oma-scripted-claude-backend-'))
  const cli = join(root, 'backend.mjs')
  const contractPath = join(root, 'contract.json')
  const countPath = join(root, 'count.txt')
  const promptPath = join(root, 'prompt.txt')
  const body = options.fail === true
    ? `process.stdin.resume(); process.stdin.on('end', () => { console.error('token=ghp_abcdefghijklmnopqrstuvwxyz'); process.exitCode = 7 })\n`
    : `import { readFile, writeFile } from 'node:fs/promises'\n` +
      `const values = process.argv.slice(2); const repoIndex = values.indexOf('--repo'); const repo = values[repoIndex + 1]\n` +
      `const contractIndex = values.indexOf('--contract'); await writeFile(${JSON.stringify(contractPath)}, await readFile(values[contractIndex + 1], 'utf8'))\n` +
      `const countPath = ${JSON.stringify(countPath)}\n` +
      `let count = 0; try { count = Number(await readFile(countPath, 'utf8')) } catch {}\n` +
      `await writeFile(countPath, String(count + 1))\n` +
      `const chunks = []; process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk))); process.stdin.on('end', async () => { await writeFile(${JSON.stringify(promptPath)}, Buffer.concat(chunks)); await writeFile(repo + '/packages/demo/src/greeting.ts', ${JSON.stringify(FIXED)}); console.log(JSON.stringify({ status: 'CODING_COMPLETED', turns: 3, terminationReason: 'success', safeEventCount: 4 })) })\n`
  await writeFile(cli, body)
  return { cli, contractPath, countPath, promptPath }
}

function repositoryRunner(
  root: string,
  validationExitCode = 0,
  validationMutation?: string,
  validationModeMutation?: number,
): ScriptedCommandRunner {
  return new ScriptedCommandRunner(async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${BASE_SHA}\n`, stderr: '', exitCode: 0 }
    if (command === 'git' && args[0] === 'log') return { stdout: `${BASE_SHA}\t2026-08-10T00:00:00Z\tfixture\n`, stderr: '', exitCode: 0 }
    if (command === 'git' && args[0] === 'status') {
      const content = await readFile(join(root, 'packages/demo/src/greeting.ts'), 'utf8')
      return { stdout: content === ORIGINAL ? '' : ' M packages/demo/src/greeting.ts\n', stderr: '', exitCode: 0 }
    }
    if (command === 'git' && args[0] === 'diff') {
      const current = await readFile(join(root, 'packages/demo/src/greeting.ts'), 'utf8')
      const info = await stat(join(root, 'packages/demo/src/greeting.ts'))
      return {
        stdout: `diff --git a/packages/demo/src/greeting.ts b/packages/demo/src/greeting.ts\n${(info.mode & 0o111) === 0 ? '' : 'old mode 100644\nnew mode 100755\n'}-${ORIGINAL.trimEnd()}\n${current.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n`,
        stderr: '',
        exitCode: 0,
      }
    }
    if (command === 'npm') {
      if (validationMutation !== undefined) {
        await writeFile(join(root, 'packages/demo/src/greeting.ts'), validationMutation)
      }
      if (validationModeMutation !== undefined) {
        await chmod(join(root, 'packages/demo/src/greeting.ts'), validationModeMutation)
      }
      return {
        stdout: validationExitCode === 0 ? '1 test passed\n' : '',
        stderr: validationExitCode === 0 ? '' : '1 test failed\n',
        exitCode: validationExitCode,
      }
    }
    if (command === process.execPath && args.includes('run-production-validation')) {
      return {
        stdout: JSON.stringify({
          status: 'VALIDATION_COMPLETED',
          validationResults: [{
            id: 'fixture-test',
            command: '"npm" "test"',
            success: validationExitCode === 0,
            exitCode: validationExitCode,
            durationMs: 1,
            stdout: validationExitCode === 0 ? '1 test passed\n' : '',
            stderr: validationExitCode === 0 ? '' : '1 test failed\n',
            truncated: false,
            environment: { set: [], unset: [] },
          }],
        }),
        stderr: '',
        exitCode: 0,
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  })
}

describe('maintainer-bot vertical pipeline', () => {
  it('refuses the actual model environment when it contains a host-prefixed GitHub credential', async () => {
    const repoRoot = await fixtureRepo()
    const adapter = new PipelineAdapter('approve')
    await expect(runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-credential-isolation',
      adapter,
      env: {
        PATH: '/usr/bin',
        CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: 'must-not-leak',
      },
      requireEvidenceToolCalls: false,
    })).rejects.toThrow(/CODEX_GITHUB_PERSONAL_ACCESS_TOKEN/)
    expect(adapter.roles).toEqual([])
    expect(await readFile(join(repoRoot, 'packages/demo/src/greeting.ts'), 'utf8')).toBe(ORIGINAL)
  })

  it('produces only a local Draft PR proposal after admission, edit, validation, and fresh review', async () => {
    const repoRoot = await fixtureRepo()
    const stateDir = await mkdtemp(join(tmpdir(), 'oma-maintainer-pipeline-state-'))
    const artifactDir = await mkdtemp(join(tmpdir(), 'oma-maintainer-pipeline-artifacts-'))
    const adapter = new PipelineAdapter('approve')
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir,
      request: authorizedRequest(),
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(stateDir),
      runId: 'run-success',
      adapter,
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
      now: () => new Date('2026-08-10T03:00:00.000Z'),
    })
    expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
    if (result.status !== 'DRAFT_PR_PROPOSAL_READY') throw new Error('expected proposal')
    expect(result.proposal).toMatchObject({ kind: 'draft_pr', eligibleForHostWrite: true })
    expect(result.record.status).toBe('DRAFT_PR_PROPOSAL_READY')
    expect(result.reviewBundle.diff).toContain('+export const greeting = "!"')
    expect(await readFile(join(repoRoot, 'packages/demo/src/greeting.ts'), 'utf8')).toBe(FIXED)
    expect(adapter.roles).toEqual(['triage', 'planner', 'implementer', 'reviewer'])
    expect(result.proposal.validationResults.every(validation => validation.success)).toBe(true)
    expect(result.proposal.claudeCodeTokenUsage).toBe('not_applicable')
    const trace = JSON.parse(await readFile(join(
      artifactDir,
      `${result.record.runKey}.pipeline-trace.json`,
    ))) as {
      omaTokenUsage: { input_tokens: number; output_tokens: number }
      estimatedCostUsd: number
      events: Array<{ stage: string; status: string }>
    }
    expect(trace.events.map(event => `${event.stage}:${event.status}`)).toEqual([
      'admission:start', 'admission:complete',
      'coding:start', 'coding:complete',
      'validation:start', 'validation:complete',
      'review:start', 'review:complete',
      'proposal:start', 'proposal:complete',
    ])
    expect(trace.omaTokenUsage).toEqual(result.tokenUsage)
    expect(trace.estimatedCostUsd).toBe(result.estimatedCostUsd)
  })

  it('keeps trace persistence failure isolated from the authoritative pipeline result', async () => {
    const repoRoot = await fixtureRepo()
    const artifactDir = await mkdtemp(join(tmpdir(), 'oma-artifacts-'))
    const request = authorizedRequest()
    const runKey = computeRunKey({
      repository: request.issue.repository,
      issueNumber: request.issue.number,
      issueRevision: request.authorization!.issueRevision,
      baseSha: request.baseSha,
    })
    await mkdir(join(artifactDir, `${runKey}.pipeline-trace.json`))
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir,
      request,
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-trace-write-failure',
      adapter: new PipelineAdapter('approve'),
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
  })

  it('records token usage and estimated cost without enforcing compatibility budget fields', async () => {
    const repoRoot = await fixtureRepo()
    const config = testConfig({
      limits: {
        ...testConfig().limits,
        maxTokenBudget: 1,
        maxCostUsd: 0.000_001,
      },
    })
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config,
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-observational-model-usage',
      adapter: new PipelineAdapter('approve'),
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
    expect(result.tokenUsage.input_tokens + result.tokenUsage.output_tokens)
      .toBeGreaterThan(config.limits.maxTokenBudget)
    expect(result.estimatedCostUsd).toBeGreaterThan(config.limits.maxCostUsd)
  })

  it('selects Claude Code as the sole coding engine while OMA runs coding and independent review', async () => {
    const repoRoot = await fixtureRepo()
    const scripted = await scriptedClaudeHarness()
    const adapter = new PipelineAdapter('approve')
    const runner = repositoryRunner(repoRoot)
    const progress: string[] = []
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig({ executionBackend: 'claude-code' }),
      runner,
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-claude-code-success',
      adapter,
      apiKey: 'scripted-provider-key',
      maintainerRuntimeCli: scripted.cli,
      env: { PATH: process.env['PATH'] ?? '/usr/bin' },
      requireEvidenceToolCalls: false,
      onProgress: event => progress.push(`${event.type}:${event.agent ?? event.task ?? ''}`),
    })
    expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
    expect(adapter.roles).toEqual(['triage', 'reviewer'])
    expect(await readFile(scripted.countPath, 'utf8')).toBe('1')
    expect(JSON.parse(await readFile(scripted.contractPath, 'utf8'))).toMatchObject({
      allowedScopes: [{ path: 'packages/demo/src/greeting.ts', kind: 'file' }],
    })
    const codingPrompt = await readFile(scripted.promptPath, 'utf8')
    expect(codingPrompt).toContain('"title":"Fix deterministic greeting output"')
    expect(codingPrompt).toContain('"reproductionSteps":["Call greeting(\\"Ada\\") and compare the returned string."]')
    expect(progress.some(value => value.includes('claude-code-coder'))).toBe(true)
    expect(progress.some(value => value.includes('fresh-reviewer'))).toBe(true)
    const firstValidation = runner.calls.findIndex(call => call.args.includes('run-production-validation'))
    const scopeChecksBeforeValidation = runner.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call, index }) => call.command === 'git' && call.args[0] === 'status' && index < firstValidation)
    expect(scopeChecksBeforeValidation.length).toBeGreaterThanOrEqual(2)
  })

  it('fails closed with bounded redacted diagnostics when the Claude Code backend fails', async () => {
    const repoRoot = await fixtureRepo()
    const scripted = await scriptedClaudeHarness({ fail: true })
    const adapter = new PipelineAdapter('approve')
    const artifactDir = await mkdtemp(join(tmpdir(), 'oma-artifacts-'))
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir,
      request: authorizedRequest(),
      config: testConfig({ executionBackend: 'claude-code' }),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-claude-code-failure',
      adapter,
      apiKey: 'scripted-provider-key',
      maintainerRuntimeCli: scripted.cli,
      env: { PATH: process.env['PATH'] ?? '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('FAILED')
    expect(result).not.toHaveProperty('proposal')
    expect(result.detail).toMatch(/\[redacted\]/i)
    expect(result.detail).not.toContain('ghp_')
    expect(result.detail.length).toBeLessThanOrEqual(8_000)
    expect(adapter.roles).toEqual(['triage'])
    const [traceName] = (await readdir(artifactDir)).filter(name => name.endsWith('.pipeline-trace.json'))
    const trace = JSON.parse(await readFile(join(artifactDir, traceName!))) as {
      claudeCodeTokenUsage: string
      events: Array<{ stage: string; status: string }>
    }
    expect(trace.claudeCodeTokenUsage).toBe('not_reported')
    expect(trace.events.map(event => `${event.stage}:${event.status}`)).toEqual([
      'admission:start', 'admission:complete', 'coding:start', 'coding:failure',
    ])
    expect(JSON.stringify(trace)).not.toMatch(/ghp_|token=/)
  })

  it('does not call a model or modify files without agent-ready authorization', async () => {
    const repoRoot = await fixtureRepo()
    const adapter = new PipelineAdapter('approve')
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest({}, { authorization: null }),
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-no-auth',
      adapter,
      env: { PATH: '/usr/bin' },
    })
    expect(result.status).toBe('READY_CANDIDATE')
    expect(adapter.roles).toEqual([])
    expect(await readFile(join(repoRoot, 'packages/demo/src/greeting.ts'), 'utf8')).toBe(ORIGINAL)
  })

  it('records bounded schema-validated triage reasons without editing files', async () => {
    const repoRoot = await fixtureRepo()
    const adapter = new PipelineAdapter('approve', 'packages/demo/src/greeting.ts', {
      uncertainties: ['The target behavior conflicts with one acceptance criterion.'],
      manualRiskSignals: ['The request appears to require a public API decision.'],
    })
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-triage-block',
      adapter,
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.detail).toContain('uncertainty=The target behavior conflicts')
    expect(result.detail).toContain('manual-risk=The request appears')
    expect(adapter.roles).toEqual(['triage'])
    expect(await readFile(join(repoRoot, 'packages/demo/src/greeting.ts'), 'utf8')).toBe(ORIGINAL)
  })

  it('invalidates an edited issue before context or model execution', async () => {
    const repoRoot = await fixtureRepo()
    const original = authorizedRequest()
    const editedIssue = { ...original.issue, title: 'Edited after authorization', updatedAt: '2026-08-10T04:00:00Z' }
    expect(computeIssueRevision(editedIssue)).not.toBe(original.authorization?.issueRevision)
    const request = controlPlaneRequestSchema.parse({ ...original, issue: editedIssue })
    const adapter = new PipelineAdapter('approve')
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request,
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-stale',
      adapter,
      env: { PATH: '/usr/bin' },
    })
    expect(result.status).toBe('BLOCKED')
    expect(adapter.roles).toEqual([])
  })

  it('routes failed validation and reviewer rejection to NEEDS_HUMAN without a proposal', async () => {
    const repoRoot = await fixtureRepo()
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig(),
      runner: repositoryRunner(repoRoot, 1),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-failed-validation',
      adapter: new PipelineAdapter('reject'),
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result).not.toHaveProperty('proposal')
    expect(result.detail).toMatch(/Validation failed/)
  })

  it('does not produce an eligible proposal when validation changes a reviewed file', async () => {
    const repoRoot = await fixtureRepo()
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig(),
      runner: repositoryRunner(repoRoot, 0, 'export const greeting = "validation-drift"\n'),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-validation-mutated-file',
      adapter: new PipelineAdapter('approve'),
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('FAILED')
    expect(result).not.toHaveProperty('proposal')
    expect(result.detail).toMatch(/Candidate differs from the pre-validation frozen bundle/)
  })

  it('does not promote a legacy candidate when validation changes only its file mode', async () => {
    const repoRoot = await fixtureRepo()
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig(),
      runner: repositoryRunner(repoRoot, 0, undefined, 0o755),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-validation-mode-drift',
      adapter: new PipelineAdapter('approve'),
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('FAILED')
    expect(result).not.toHaveProperty('proposal')
    expect(result.detail).toMatch(/Candidate differs from the pre-validation frozen bundle/)
  })

  it('rejects a model plan that widens beyond the maintainer-approved target file', async () => {
    const repoRoot = await fixtureRepo()
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig({ allowedPaths: ['packages/demo'] }),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-scope-widening',
      adapter: new PipelineAdapter('approve', 'packages/demo/src/helper.ts'),
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    })
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.detail).toMatch(/maintainer-approved issue scope/)
    expect(await readFile(join(repoRoot, 'packages/demo/src/helper.ts'), 'utf8')).toBe(HELPER_ORIGINAL)
    expect(await readFile(join(repoRoot, 'packages/demo/src/greeting.ts'), 'utf8')).toBe(ORIGINAL)
  })

  it('deduplicates a revision before a second model mutation', async () => {
    const repoRoot = await fixtureRepo()
    const stateDir = await mkdtemp(join(tmpdir(), 'oma-state-'))
    const store = new FileRunStateStore(stateDir)
    const request = authorizedRequest()
    const firstAdapter = new PipelineAdapter('approve')
    const common = {
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request,
      config: testConfig(),
      runner: repositoryRunner(repoRoot),
      stateStore: store,
      env: { PATH: '/usr/bin' },
      requireEvidenceToolCalls: false,
    }
    const first = await runMaintainerBot({ ...common, runId: 'run-first', adapter: firstAdapter })
    expect(first.status).toBe('DRAFT_PR_PROPOSAL_READY')
    const secondAdapter = new PipelineAdapter('approve')
    const second = await runMaintainerBot({ ...common, runId: 'run-second', adapter: secondAdapter })
    expect(second).toMatchObject({ duplicate: true, status: 'DRAFT_PR_PROPOSAL_READY' })
    expect(secondAdapter.roles).toEqual([])
  })

  it('measures a full triage-to-repair-to-fresh-review flow within the 160k production budget', async () => {
    const repoRoot = await fixtureRepo()
    const adapter = new ToolReadingRepairAdapter()
    const result = await runMaintainerBot({
      repoRoot,
      artifactDir: await mkdtemp(join(tmpdir(), 'oma-artifacts-')),
      request: authorizedRequest(),
      config: testConfig({ limits: { ...testConfig().limits, maxTokenBudget: 160_000 } }),
      runner: repositoryRunner(repoRoot),
      stateStore: new FileRunStateStore(await mkdtemp(join(tmpdir(), 'oma-state-'))),
      runId: 'run-repair-current-hash',
      adapter,
      env: { PATH: '/usr/bin' },
    })
    expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
    expect(adapter.repairExpectedHash).toBe(sha256(FIXED))
    expect(result.tokenUsage.input_tokens + result.tokenUsage.output_tokens).toBeLessThan(160_000)
    expect(adapter.serializedRequestChars.length).toBeGreaterThanOrEqual(10)
    expect(adapter.serializedRequestChars.every(size => size > 0)).toBe(true)
    expect(await readFile(join(repoRoot, 'packages/demo/src/greeting.ts'), 'utf8'))
      .toBe(`// reviewer-requested repair\n${FIXED}`)
  })
})

class PipelineAdapter implements LLMAdapter {
  readonly name = 'pipeline-adapter'
  readonly roles: string[] = []
  private sequence = 0

  constructor(
    private readonly reviewVerdict: 'approve' | 'reject',
    private readonly editPath = 'packages/demo/src/greeting.ts',
    private readonly triageBlock?: {
      readonly uncertainties: string[]
      readonly manualRiskSignals: string[]
    },
  ) {}

  async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = roleFor(options.systemPrompt ?? '')
    this.roles.push(role)
    this.sequence += 1
    return {
      id: `pipeline-${this.sequence}`,
      content: [{ type: 'text', text: JSON.stringify(this.response(role)) }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    yield { type: 'done', data: await this.chat(messages, options) }
  }

  private response(role: string): unknown {
    const issue = authorizedRequest().issue
    if (role === 'triage') return {
      verdict: this.triageBlock === undefined ? 'proceed' : 'needs_human',
      confirmedIssueRevision: authorizedRequest().authorization!.issueRevision,
      confirmedAcceptanceCriteria: issue.acceptanceCriteria,
      uncertainties: this.triageBlock?.uncertainties ?? [],
      manualRiskSignals: this.triageBlock?.manualRiskSignals ?? [],
    }
    if (role === 'planner') return {
      summary: 'Fix the bounded greeting implementation.', acceptanceCriteria: issue.acceptanceCriteria,
      files: [{ path: this.editPath, reason: 'The incorrect output is implemented here.' }],
      validationCommandIds: ['fixture-test'], risks: [], unresolvedQuestions: [],
    }
    if (role === 'implementer') return {
      summary: 'Fix deterministic greeting punctuation.', risks: [], assumptions: [],
      edits: [{
        path: this.editPath,
        expectedHash: sha256(this.editPath.endsWith('helper.ts') ? HELPER_ORIGINAL : ORIGINAL),
        content: this.editPath.endsWith('helper.ts') ? 'export const helper = "!"\n' : FIXED,
        reason: 'Return the accepted exclamation mark.',
      }],
    }
    if (role === 'reviewer' && this.reviewVerdict === 'approve') return {
      verdict: 'approve', repairable: false, issues: [],
      acceptanceResults: issue.acceptanceCriteria.map(criterion => ({
        criterion, status: 'pass', evidence: 'Final diff and deterministic validation prove the criterion.',
      })),
      rationale: ['The bounded final diff satisfies the issue.'],
    }
    return {
      verdict: 'reject', repairable: false, issues: ['Deterministic validation failed.'],
      acceptanceResults: issue.acceptanceCriteria.map(criterion => ({
        criterion, status: 'unknown', evidence: 'The failed validation prevents confirmation.',
      })),
      rationale: ['A human must inspect the failed command.'],
    }
  }
}

function roleFor(prompt: string): string {
  if (prompt.includes('read-only issue triage verifier')) return 'triage'
  if (prompt.includes('read-only repository planner')) return 'planner'
  if (prompt.includes('You are the implementer')) return 'implementer'
  if (prompt.includes('independent fresh-context reviewer')) return 'reviewer'
  if (prompt.includes('repair implementer round')) return 'repair'
  throw new Error(`unknown role: ${prompt.slice(0, 100)}`)
}

class ToolReadingRepairAdapter implements LLMAdapter {
  readonly name = 'tool-reading-repair-adapter'
  repairExpectedHash: string | undefined
  readonly serializedRequestChars: number[] = []
  private sequence = 0
  private reviewRound = 0

  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = roleFor(options.systemPrompt ?? '')
    this.sequence += 1
    const requestChars = serializeModelRequest(messages, options).length
    this.serializedRequestChars.push(requestChars)
    const toolResultCount = JSON.stringify(messages).match(/tool_result/g)?.length ?? 0
    const toolPlan = pipelineEvidencePlan(role)
    if (toolResultCount < toolPlan.length) {
      const toolName = toolPlan[toolResultCount]!
      const input = toolInput(role, toolName)
      return {
        id: `tool-${this.sequence}`,
        content: [{ type: 'tool_use', id: `call-${this.sequence}`, name: toolName, input }],
        model: options.model,
        stop_reason: 'tool_use',
        usage: { input_tokens: Math.ceil(requestChars / 4), output_tokens: 12 },
      }
    }

    const issue = authorizedRequest().issue
    let output: unknown
    if (role === 'triage') {
      output = {
        verdict: 'proceed',
        confirmedIssueRevision: authorizedRequest().authorization!.issueRevision,
        confirmedAcceptanceCriteria: issue.acceptanceCriteria,
        uncertainties: [], manualRiskSignals: [],
      }
    } else if (role === 'planner') {
      output = {
        summary: 'Fix the greeting and validate the reviewer-requested repair.',
        acceptanceCriteria: issue.acceptanceCriteria,
        files: [{ path: 'packages/demo/src/greeting.ts', reason: 'The bounded defect and repair are localized here.' }],
        validationCommandIds: ['fixture-test'], risks: [], unresolvedQuestions: [],
      }
    } else if (role === 'implementer') {
      output = {
        summary: 'Apply the initial punctuation fix.', risks: [], assumptions: [],
        edits: [{
          path: 'packages/demo/src/greeting.ts', expectedHash: sha256(ORIGINAL), content: FIXED,
          reason: 'Correct the punctuation.',
        }],
      }
    } else if (role === 'repair') {
      const snapshot = findReviewSourcePage(messages, 'review:file:packages/demo/src/greeting.ts')
      this.repairExpectedHash = snapshot.source.contentHash
      output = {
        summary: 'Apply the bounded reviewer-requested repair.', risks: [], assumptions: [],
        edits: [{
          path: snapshot.source.locator,
          expectedHash: snapshot.source.contentHash,
          content: `// reviewer-requested repair\n${snapshot.content}`,
          reason: 'Address the concrete fresh-review issue.',
        }],
      }
    } else {
      this.reviewRound += 1
      output = this.reviewRound === 1
        ? {
            verdict: 'reject', repairable: true,
            issues: ['Add the bounded reviewer-requested source comment.'],
            acceptanceResults: issue.acceptanceCriteria.map(criterion => ({
              criterion, status: 'fail', evidence: 'The first diff needs one bounded repair.',
            })),
            rationale: ['One in-scope source edit can resolve the review issue.'],
          }
        : {
            verdict: 'approve', repairable: false, issues: [],
            acceptanceResults: issue.acceptanceCriteria.map(criterion => ({
              criterion, status: 'pass', evidence: 'The repaired diff and validation evidence satisfy the criterion.',
            })),
            rationale: ['The repaired diff is bounded and fully validated.'],
          }
    }
    const text = JSON.stringify(output)
    return {
      id: `final-${this.sequence}`,
      content: [{ type: 'text', text }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: Math.ceil(requestChars / 4), output_tokens: Math.ceil(text.length / 4) },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    yield { type: 'done', data: await this.chat(messages, options) }
  }
}

function pipelineEvidencePlan(role: string): string[] {
  if (role === 'triage') return ['read_admission_evidence']
  if (role === 'planner' || role === 'implementer') return ['list_context_sources', 'read_context_source']
  return ['read_final_review_summary', 'read_review_source']
}

function toolInput(role: string, toolName: string): Record<string, unknown> {
  if (toolName === 'list_context_sources') return { offset: 0, limit: 30 }
  if (toolName === 'read_context_source') {
    return { sourceId: 'file:packages/demo/src/greeting.ts', offset: 0, limit: 8_000 }
  }
  if (toolName === 'read_review_source') {
    return {
      sourceId: role === 'repair' ? 'review:file:packages/demo/src/greeting.ts' : 'review:diff',
      offset: 0,
      limit: 8_000,
    }
  }
  return {}
}

function findReviewSourcePage(messages: LLMMessage[], sourceId: string): {
  source: { id: string; locator: string; contentHash: string }
  content: string
} {
  const found = findObject(messages, value => {
    const source = value['source']
    return source !== null && typeof source === 'object'
      && (source as Record<string, unknown>)['id'] === sourceId
      && typeof value['content'] === 'string'
  })
  if (found === undefined) throw new Error(`review source page ${sourceId} was not present in tool results`)
  return found as {
    source: { id: string; locator: string; contentHash: string }
    content: string
  }
}

function findObject(
  value: unknown,
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return findObject(JSON.parse(value), predicate)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (predicate(record)) return record
  for (const item of Object.values(record)) {
    const found = findObject(item, predicate)
    if (found !== undefined) return found
  }
  return undefined
}
