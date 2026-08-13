import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
import {
  FileRunStateStore,
  sha256,
  runMaintainerBot,
} from '@open-multi-agent/maintainer-bot'
import { finalizeActivation, prepareActivation } from '../src/activation.js'
import { productionPolicy } from './helpers.js'
import {
  BASE_SHA,
  APP_CONTRACT,
  APP_BOT_LOGIN,
  FakeGitHub,
  ISSUE_NUMBER,
  RecordingRunner,
  REPOSITORY,
  SECOND_SHA,
  ISSUE_BODY,
  cleanRunner,
  labelEvent,
  ok,
} from './helpers.js'

const TARGET = 'packages/create-oma-app/tests/runtime.test.ts'
const ORIGINAL = 'export const isolated = false\n'
const FIXED = 'export const isolated = true\n'

describe('mocked GitHub + scripted OMA activation path', () => {
  it('runs the agent-ready Claude backend through OMA, sandbox contract, fresh review, and the deterministic Draft PR writer', async () => {
    const fixture = await runClaudeToProposal()
    const final = await finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 0,
        status: 'DRAFT_PR_PROPOSAL_READY', detail: 'Proposal ready.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:00:00Z',
    })
    expect(final.status).toBe('DRAFT_PR_CREATED')
    expect(fixture.github.createdPullRequests).toBe(1)
    expect(fixture.github.pulls[0]).toMatchObject({ draft: true, state: 'open' })
    expect(await readFile(fixture.backendCountPath, 'utf8')).toBe('1')
    expect(fixture.adapter.roles).toEqual(['triage', 'reviewer'])
    const sandboxCalls = fixture.runner.calls.filter(call => call.args.includes('run-production-validation'))
    expect(sandboxCalls).toHaveLength(1)
    expect(sandboxCalls[0]?.options.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(fixture.runner.calls.filter(call => call.args[0] === 'push')).toHaveLength(1)
  })

  it('creates one and only one Draft PR after the final actual-worktree safe-output gate', async () => {
    const fixture = await runToProposal()
    const final = await finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 0,
        status: 'DRAFT_PR_PROPOSAL_READY', detail: 'Proposal ready.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:00:00Z',
    })
    expect(final.status, final.detail).toBe('DRAFT_PR_CREATED')
    expect(fixture.github.createdPullRequests).toBe(1)
    expect(fixture.github.pulls[0]).toMatchObject({ state: 'open', draft: true })
    expect(fixture.github.pulls[0]?.body).toContain('Related Issue: [#488]')
    expect(fixture.github.pulls[0]?.body).not.toMatch(/(?:fixes|closes)\s+#488/i)
    expect(await readFile(join(fixture.repoRoot, TARGET), 'utf8')).toBe(FIXED)

    const calls = fixture.runner.calls.map(call => `${call.command} ${call.args.join(' ')}`)
    const finalStatus = calls.lastIndexOf('git status --porcelain=v1 --untracked-files=all')
    const switchIndex = calls.findIndex(call => call.startsWith('git switch -c agent/issue-'))
    const pushIndex = calls.findIndex(call => call.startsWith(`git push https://github.com/${REPOSITORY}`))
    expect(finalStatus).toBeGreaterThan(-1)
    expect(switchIndex).toBeGreaterThan(finalStatus)
    expect(pushIndex).toBeGreaterThan(switchIndex)
    const push = fixture.runner.calls[pushIndex]!
    expect(push.options.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(push.options.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(push.options.env).not.toHaveProperty('MAINTAINER_BOT_APP_TOKEN')
    expect(push.options.env).toMatchObject({ GIT_AUTHOR_NAME: APP_BOT_LOGIN })

    fixture.github.timeline = [{
      event: 'cross-referenced',
      source: {
        issue: {
          number: fixture.github.pulls[0]!.number,
          state: 'open',
          pull_request: { merged_at: null },
        },
      },
    }]

    const duplicateRepo = await fixtureRepo()
    const duplicate = await prepareActivation({
      event: fixture.event,
      github: fixture.github,
      runner: repositoryRunner(duplicateRepo),
      repoRoot: duplicateRepo,
      policy: fixture.policy,
      eventId: '101.1',
      receivedAt: '2026-08-10T18:01:00Z',
      claimId: '101.1',
      actionsRunId: 101,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/101`,
      baseShaHint: BASE_SHA,
      eventSnapshotMatched: true,
      writerContract: APP_CONTRACT,
      removedBootstrapCommentCount: 0,
    })
    expect(duplicate).toMatchObject({ shouldRun: false, status: 'DRAFT_PR_CREATED' })
    expect(fixture.github.createdPullRequests).toBe(1)
  })

  it('stops before any writer command when final file content drifts after review', async () => {
    const fixture = await runToProposal()
    await writeFile(join(fixture.repoRoot, TARGET), 'export const isolated = "drift"\n')
    const final = await finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 0,
        status: 'DRAFT_PR_PROPOSAL_READY', detail: 'Proposal ready.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:00:00Z',
    })
    expect(final.status).toBe('NEEDS_HUMAN')
    expect(final.detail).toMatch(/content drifted after review/)
    expect(fixture.github.createdPullRequests).toBe(0)
    expect(fixture.runner.calls.some(call => call.args[0] === 'push')).toBe(false)
  })

  it('fails closed before the writer when the App token identity changes after prepare', async () => {
    const fixture = await runToProposal()
    fixture.github.viewerLogin = 'unexpected-app[bot]'
    await expect(finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 0,
        status: 'DRAFT_PR_PROPOSAL_READY', detail: 'Proposal ready.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:00:00Z',
    })).rejects.toThrow(/not the expected Maintainer Bot App installation identity/)
    expect(fixture.github.createdPullRequests).toBe(0)
    expect(fixture.runner.calls.some(call => call.args[0] === 'push')).toBe(false)
  })

  it('fails before model execution when the dedicated App writer is not enabled', async () => {
    const repoRoot = await fixtureRepo()
    const github = new FakeGitHub()
    await expect(prepareActivation({
      event: labelEvent(),
      github,
      runner: repositoryRunner(repoRoot),
      repoRoot,
      policy: await productionPolicy(),
      eventId: '100.1',
      receivedAt: '2026-08-10T17:43:00Z',
      claimId: '100.1',
      actionsRunId: 100,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/100`,
      baseShaHint: BASE_SHA,
      eventSnapshotMatched: true,
      writerContract: { ...APP_CONTRACT, enabled: false },
      removedBootstrapCommentCount: 0,
    })).rejects.toThrow(/not explicitly enabled/)
    expect(github.createdPullRequests).toBe(0)
  })

  it('stops before model execution when the checked-out base is stale', async () => {
    const repoRoot = await fixtureRepo()
    const github = new FakeGitHub()
    const context = await prepareActivation({
      event: labelEvent(),
      github,
      runner: repositoryRunner(repoRoot),
      repoRoot,
      policy: await productionPolicy(),
      eventId: '102.1',
      receivedAt: '2026-08-10T18:02:00Z',
      claimId: '102.1',
      actionsRunId: 102,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/102`,
      baseShaHint: 'b'.repeat(40),
      eventSnapshotMatched: true,
      writerContract: APP_CONTRACT,
      removedBootstrapCommentCount: 0,
    })
    expect(context).toMatchObject({ shouldRun: false, status: 'NEEDS_HUMAN' })
    expect(context.detail).toMatch(/checked-out base SHA differs/)
    expect(github.createdPullRequests).toBe(0)
  })

  it('stops before refetch or model execution when the first Issue snapshot is stale', async () => {
    const repoRoot = await fixtureRepo()
    const github = new FakeGitHub()
    const context = await prepareActivation({
      event: labelEvent(),
      github,
      runner: repositoryRunner(repoRoot),
      repoRoot,
      policy: await productionPolicy(),
      eventId: '103.1',
      receivedAt: '2026-08-10T18:04:00Z',
      claimId: '103.1',
      actionsRunId: 103,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/103`,
      baseShaHint: BASE_SHA,
      eventSnapshotMatched: false,
      writerContract: APP_CONTRACT,
      removedBootstrapCommentCount: 0,
    })
    expect(context).toMatchObject({ shouldRun: false, status: 'NEEDS_HUMAN' })
    expect(context.detail).toMatch(/changed between the labeled event and the first trusted GitHub snapshot/)
    expect(github.createdPullRequests).toBe(0)
  })

  it('publishes NEEDS_HUMAN and stops before local or model work when production policy rejects the target', async () => {
    const github = new FakeGitHub()
    github.issue.body = ISSUE_BODY.replaceAll(
      'packages/create-oma-app/tests/runtime.test.ts',
      'packages/otel/package.json',
    )
    const event = labelEvent({ issue: { ...labelEvent().issue, body: github.issue.body } })
    const runner = cleanRunner()
    const context = await prepareActivation({
      event,
      github,
      runner,
      repoRoot: '/unused-before-policy-admission',
      policy: await productionPolicy(),
      eventId: '104.1',
      receivedAt: '2026-08-10T18:05:00Z',
      claimId: '104.1',
      actionsRunId: 104,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/104`,
      baseShaHint: BASE_SHA,
      eventSnapshotMatched: true,
      writerContract: APP_CONTRACT,
      removedBootstrapCommentCount: 0,
    })
    expect(context).toMatchObject({ shouldRun: false, status: 'NEEDS_HUMAN' })
    expect(context.detail).toContain('blocked by repository production policy')
    expect(context.detail).toContain('The model was not run')
    expect(context.detail).toContain('reauthorize')
    expect(runner.calls).toEqual([])
    expect(github.comments.at(-1)?.body).toContain('OMA Maintainer Bot — NEEDS_HUMAN')
    expect(github.comments.at(-1)?.body).not.toContain('NEEDS_CLARIFICATION')
  })

  it('keeps incomplete Issue Markdown as NEEDS_CLARIFICATION before model work', async () => {
    const github = new FakeGitHub()
    github.issue.body = '## Problem\n\nMissing the required fields.'
    const event = labelEvent({ issue: { ...labelEvent().issue, body: github.issue.body } })
    const runner = cleanRunner()
    const context = await prepareActivation({
      event,
      github,
      runner,
      repoRoot: '/unused-before-markdown-admission',
      policy: await productionPolicy(),
      eventId: '105.1',
      receivedAt: '2026-08-10T18:06:00Z',
      claimId: '105.1',
      actionsRunId: 105,
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/105`,
      baseShaHint: BASE_SHA,
      eventSnapshotMatched: true,
      writerContract: APP_CONTRACT,
      removedBootstrapCommentCount: 0,
    })
    expect(context).toMatchObject({ shouldRun: false, status: 'NEEDS_CLARIFICATION' })
    expect(runner.calls).toEqual([])
    expect(github.comments.at(-1)?.body).toContain('OMA Maintainer Bot — NEEDS_CLARIFICATION')
  })

  it('never invokes the writer after a failed engine result', async () => {
    const fixture = await runToProposal()
    const result = await finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 1,
        status: 'FAILED', detail: 'Scripted engine failure.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:03:00Z',
    })
    expect(result.status).toBe('FAILED')
    expect(fixture.github.createdPullRequests).toBe(0)
    expect(fixture.runner.calls.some(call => call.args[0] === 'switch')).toBe(false)
    expect(fixture.runner.calls.some(call => call.args[0] === 'push')).toBe(false)
  })

  it('rechecks the label actor permission before every writer action', async () => {
    const fixture = await runToProposal()
    fixture.github.permission = 'read'
    const result = await finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 0,
        status: 'DRAFT_PR_PROPOSAL_READY', detail: 'Proposal ready.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:04:00Z',
    })
    expect(result).toMatchObject({ shouldRun: false, status: 'NEEDS_HUMAN' })
    expect(fixture.github.createdPullRequests).toBe(0)
    expect(fixture.runner.calls.some(call => call.args[0] === 'switch')).toBe(false)
    expect(fixture.runner.calls.some(call => call.args[0] === 'push')).toBe(false)
  })

  it('rejects candidate-created Git hooks, proxies, and credential configuration before the writer', async () => {
    const fixture = await runToProposal([
      'core.repositoryformatversion',
      'http.proxy',
      'core.hooksPath',
      'trace2.envVars',
    ])
    const result = await finalizeActivation({
      activation: fixture.activation,
      engineResult: {
        schemaVersion: 1, attempted: true, exitCode: 0,
        status: 'DRAFT_PR_PROPOSAL_READY', detail: 'Proposal ready.',
      },
      originalEvent: fixture.event,
      github: fixture.github,
      runner: fixture.runner,
      githubAppToken: 'github-app-installation-token',
      writerContract: APP_CONTRACT,
      repoRoot: fixture.repoRoot,
      policy: fixture.policy,
      stateDir: fixture.stateDir,
      artifactDir: fixture.artifactDir,
      finalizedAt: '2026-08-10T18:05:00Z',
    })
    expect(result).toMatchObject({ shouldRun: false, status: 'NEEDS_HUMAN' })
    expect(result.detail).toMatch(/Unsafe local Git configuration/)
    expect(fixture.github.createdPullRequests).toBe(0)
    expect(fixture.runner.calls.some(call => call.args[0] === 'switch')).toBe(false)
    expect(fixture.runner.calls.some(call => call.args[0] === 'push')).toBe(false)
  })
})

async function runToProposal(localGitConfigKeys?: readonly string[]) {
  const repoRoot = await fixtureRepo()
  const runner = repositoryRunner(repoRoot, localGitConfigKeys)
  const github = new FakeGitHub()
  const policy = await productionPolicy()
  const event = labelEvent()
  const activation = await prepareActivation({
    event,
    github,
    runner,
    repoRoot,
    policy,
    eventId: '100.1',
    receivedAt: '2026-08-10T17:43:00Z',
    claimId: '100.1',
    actionsRunId: 100,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/100`,
    baseShaHint: BASE_SHA,
    eventSnapshotMatched: true,
    writerContract: APP_CONTRACT,
    removedBootstrapCommentCount: 0,
  })
  if (!activation.shouldRun || activation.request === null || activation.config === null) {
    throw new Error(`expected runnable activation: ${activation.detail}`)
  }
  const stateDir = await mkdtemp(join(tmpdir(), 'oma-host-state-'))
  const artifactDir = await mkdtemp(join(tmpdir(), 'oma-host-artifacts-'))
  const adapter = new ActivationAdapter(
    activation.admission!.issueRevision,
    activation.request.issue.acceptanceCriteria,
    activation.config.validationCommands.map(command => command.id),
  )
  const result = await runMaintainerBot({
    repoRoot,
    artifactDir,
    request: activation.request,
    config: activation.config,
    runner,
    stateStore: new FileRunStateStore(stateDir),
    runId: activation.claimId,
    adapter,
    env: { PATH: '/usr/bin', HOME: '/tmp/oma-host-home' },
    requireEvidenceToolCalls: false,
    now: () => new Date('2026-08-10T17:50:00Z'),
  })
  expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
  expect(adapter.roles).toEqual(['triage', 'planner', 'implementer', 'reviewer'])
  return { repoRoot, runner, github, policy, event, activation, stateDir, artifactDir }
}

async function runClaudeToProposal() {
  const repoRoot = await fixtureRepo()
  const runner = repositoryRunner(repoRoot)
  const github = new FakeGitHub()
  const policy = { ...await productionPolicy(), executionBackend: 'claude-code' as const }
  const event = labelEvent()
  const activation = await prepareActivation({
    event, github, runner, repoRoot, policy,
    eventId: '100.2', receivedAt: '2026-08-10T17:43:00Z', claimId: '100.2', actionsRunId: 100,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/100`, baseShaHint: BASE_SHA,
    eventSnapshotMatched: true, writerContract: APP_CONTRACT, removedBootstrapCommentCount: 0,
  })
  if (!activation.shouldRun || activation.request === null || activation.config === null) {
    throw new Error(`expected runnable activation: ${activation.detail}`)
  }
  const harnessRoot = await mkdtemp(join(tmpdir(), 'oma-host-production-harness-'))
  const harnessCli = join(harnessRoot, 'harness.mjs')
  const backendCountPath = join(harnessRoot, 'backend-count.txt')
  await writeFile(harnessCli, `
import { readFile, writeFile } from 'node:fs/promises'
const args = process.argv.slice(2)
const repo = args[args.indexOf('--repo') + 1]
let count = 0
try { count = Number(await readFile(${JSON.stringify(backendCountPath)}, 'utf8')) } catch {}
await writeFile(${JSON.stringify(backendCountPath)}, String(count + 1))
await new Promise(resolve => { process.stdin.resume(); process.stdin.on('end', resolve) })
await writeFile(repo + '/' + ${JSON.stringify(TARGET)}, ${JSON.stringify(FIXED)})
console.log(JSON.stringify({ status: 'CODING_COMPLETED', turns: 2, terminationReason: 'success', safeEventCount: 3 }))
`)
  const stateDir = await mkdtemp(join(tmpdir(), 'oma-host-state-'))
  const artifactDir = await mkdtemp(join(tmpdir(), 'oma-host-artifacts-'))
  const adapter = new ActivationAdapter(
    activation.admission!.issueRevision,
    activation.request.issue.acceptanceCriteria,
    activation.config.validationCommands.map(command => command.id),
  )
  const result = await runMaintainerBot({
    repoRoot, artifactDir, request: activation.request, config: activation.config, runner,
    stateStore: new FileRunStateStore(stateDir), runId: activation.claimId, adapter,
    apiKey: 'scripted-provider-key', claudeCodeHarnessCli: harnessCli,
    env: { PATH: process.env['PATH'] ?? '/usr/bin', HOME: '/tmp/oma-host-home' },
    requireEvidenceToolCalls: false, now: () => new Date('2026-08-10T17:50:00Z'),
  })
  expect(result.status).toBe('DRAFT_PR_PROPOSAL_READY')
  return { repoRoot, runner, github, policy, event, activation, stateDir, artifactDir, adapter, backendCountPath }
}

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-host-repo-'))
  await mkdir(join(root, '.github'), { recursive: true })
  await mkdir(join(root, 'packages/create-oma-app/tests'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# Fixture policy\n')
  await writeFile(join(root, '.github/CONTRIBUTING.md'), '# Contributing\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }))
  await writeFile(join(root, 'packages/create-oma-app/package.json'), JSON.stringify({ name: 'create-oma-app' }))
  await writeFile(join(root, 'packages/create-oma-app/tsconfig.json'), '{}\n')
  await writeFile(join(root, 'packages/create-oma-app/README.md'), '# Fixture\n')
  await writeFile(join(root, TARGET), ORIGINAL)
  return root
}

function repositoryRunner(
  root: string,
  localGitConfigKeys: readonly string[] = ['core.repositoryformatversion', 'core.filemode', 'remote.origin.url'],
): RecordingRunner {
  let committed = false
  return new RecordingRunner(async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return ok(`${committed ? SECOND_SHA : BASE_SHA}\n`)
    if (command === 'git' && args[0] === 'status') {
      const current = await readFile(join(root, TARGET), 'utf8')
      return ok(current === ORIGINAL || committed ? '' : ` M ${TARGET}\n`)
    }
    if (command === 'git' && args[0] === 'log') return ok(`${BASE_SHA}\t2026-08-10T00:00:00Z\tfixture\n`)
    if (command === 'git' && args[0] === 'remote') return ok(`https://github.com/${REPOSITORY}.git\n`)
    if (command === 'git' && args[0] === 'config' && args[1] === '--local') {
      return ok(`${localGitConfigKeys.join('\n')}\n`)
    }
    if (command === 'git' && args[0] === 'diff') {
      if (args.includes('--cached') && args.includes('--diff-filter=ACM')) return ok(`${TARGET}\n`)
      if (args.includes('--cached') && args.includes('--diff-filter=DRTUXB')) return ok('')
      if (args.length === 2 && args[1] === '--name-only') return ok('')
      const current = await readFile(join(root, TARGET), 'utf8')
      return ok(`diff --git a/${TARGET} b/${TARGET}\n-${ORIGINAL.trimEnd()}\n+${current.trimEnd()}\n`)
    }
    if (command === 'git' && args[0] === 'ls-files') return ok('')
    if (command === 'git' && args[0] === 'commit') {
      committed = true
      return ok('')
    }
    if (command === 'git' && ['switch', 'add', 'push'].includes(args[0] ?? '')) return ok('')
    if (command === 'npm') return ok('validation passed\n')
    if (command === process.execPath && args.includes('run-production-validation')) {
      const contractPath = args[args.indexOf('--contract') + 1]!
      const contract = JSON.parse(await readFile(contractPath, 'utf8')) as {
        validationCommands: Array<{ id: string; command: string; args: string[]; env: Record<string, string>; unsetEnv: string[] }>
      }
      return ok(JSON.stringify({
        status: 'VALIDATION_COMPLETED',
        validationResults: contract.validationCommands.map(command => ({
          id: command.id,
          command: [command.command, ...command.args].map(value => JSON.stringify(value)).join(' '),
          success: true, exitCode: 0, durationMs: 1, stdout: 'sandbox validation passed\n', stderr: '', truncated: false,
          environment: { set: Object.entries(command.env).map(([name, value]) => ({ name, value })), unset: command.unsetEnv },
        })),
      }))
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  })
}

class ActivationAdapter implements LLMAdapter {
  readonly name = 'activation-scripted-adapter'
  readonly roles: string[] = []
  private sequence = 0

  constructor(
    private readonly issueRevision: string,
    private readonly acceptanceCriteria: readonly string[],
    private readonly validationIds: readonly string[],
  ) {}

  async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const role = identifyRole(options.systemPrompt ?? '')
    this.roles.push(role)
    this.sequence += 1
    const output = role === 'triage'
      ? {
          verdict: 'proceed', confirmedIssueRevision: this.issueRevision,
          confirmedAcceptanceCriteria: this.acceptanceCriteria, uncertainties: [], manualRiskSignals: [],
        }
      : role === 'planner'
        ? {
            summary: 'Isolate the focused test environment.', acceptanceCriteria: this.acceptanceCriteria,
            files: [{ path: TARGET, reason: 'The test isolation defect is localized here.' }],
            validationCommandIds: this.validationIds, risks: [], unresolvedQuestions: [],
          }
        : role === 'implementer'
          ? {
              summary: 'Isolate OMA_MODEL in the runtime tests.', risks: [], assumptions: [],
              edits: [{ path: TARGET, expectedHash: sha256(ORIGINAL), content: FIXED, reason: 'Control the ambient model variable.' }],
            }
          : {
              verdict: 'approve', repairable: false, issues: [],
              acceptanceResults: this.acceptanceCriteria.map(criterion => ({
                criterion, status: 'pass', evidence: 'The bounded diff and trusted validations prove this criterion.',
              })),
              rationale: ['Every authorized criterion passed fresh review.'],
            }
    return {
      id: `activation-${this.sequence}`,
      content: [{ type: 'text', text: JSON.stringify(output) }],
      model: options.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  }

  async *stream(messages: LLMMessage[], options: LLMStreamOptions): AsyncIterable<StreamEvent> {
    yield { type: 'done', data: await this.chat(messages, options) }
  }
}

function identifyRole(prompt: string): 'triage' | 'planner' | 'implementer' | 'reviewer' {
  if (prompt.includes('read-only issue triage verifier')) return 'triage'
  if (prompt.includes('read-only repository planner')) return 'planner'
  if (prompt.includes('You are the implementer')) return 'implementer'
  if (prompt.includes('independent fresh-context reviewer')) return 'reviewer'
  throw new Error(`unknown role: ${prompt.slice(0, 100)}`)
}
