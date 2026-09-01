import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions } from '../src/command.js'
import type { CreatePullRequestInput, CreateReleaseInput, GitHubClient, GitHubPullRequest, GitHubRelease } from '../src/github.js'
import type { ReleaseBotRun } from '../src/orchestrator.js'
import { prepareReleasePr } from '../src/prepare.js'
import { buildReleaseDecision, type ReleaseEvidence, type ReleaseProposal, type ReleaseReview } from '../src/schema.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('release PR preparation', () => {
  it('materializes, validates, commits, pushes, and opens a ready PR', async () => {
    const { root, remote } = await createRepository()
    const runner = new FakeValidationRunner(root)
    const github = new FakeGitHubClient()

    const result = await prepareReleasePr({
      repoRoot: root,
      repository: 'open-multi-agent/open-multi-agent',
      runner,
      github,
      generate: async evidence => scriptedRun(evidence),
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error('expected created')
    expect(result.branch).toBe('release-bot/core-v1.15.0')
    expect(result.pullUrl).toBe('https://github.test/pull/42')
    expect(github.createdPull).toMatchObject({
      head: 'release-bot/core-v1.15.0',
      base: 'main',
      draft: false,
    })
    expect(runner.npmCommands).toEqual([
      'install --package-lock-only --ignore-scripts --no-audit --no-fund',
      'run lint',
      'test',
      'run build',
    ])

    const remoteHead = (await runner.delegate.run(
      'git',
      ['--git-dir', remote, 'rev-parse', 'refs/heads/release-bot/core-v1.15.0'],
    )).stdout.trim()
    expect(remoteHead).toMatch(/^[0-9a-f]{40}$/)
    const changed = (await runner.delegate.run('git', ['show', '--name-only', '--format=', remoteHead], { cwd: root })).stdout
    expect(changed).toContain('packages/core/package.json')
    expect(changed).toContain('package-lock.json')
    expect(changed).not.toContain('packages/otel/package.json')
  })

  it('does not call the model while another release PR is open', async () => {
    const { root } = await createRepository()
    const runner = new FakeValidationRunner(root)
    const github = new FakeGitHubClient([
      { number: 9, htmlUrl: 'https://github.test/pull/9', headRef: 'release-bot/core-v1.15.0', baseRef: 'main', title: 'release' },
    ])
    let generated = false
    const result = await prepareReleasePr({
      repoRoot: root,
      repository: 'open-multi-agent/open-multi-agent',
      runner,
      github,
      generate: async evidence => {
        generated = true
        return scriptedRun(evidence)
      },
    })
    expect(result.status).toBe('no-op')
    expect(generated).toBe(false)
  })

  it('recognizes a manually prepared release PR by title', async () => {
    const { root } = await createRepository()
    const runner = new FakeValidationRunner(root)
    const github = new FakeGitHubClient([
      { number: 10, htmlUrl: 'https://github.test/pull/10', headRef: 'chore/release-v1.15.0', baseRef: 'main', title: 'chore: release core v1.15.0 and create-oma-app v0.8.0' },
    ])
    let generated = false
    const result = await prepareReleasePr({
      repoRoot: root,
      repository: 'open-multi-agent/open-multi-agent',
      runner,
      github,
      generate: async evidence => {
        generated = true
        return scriptedRun(evidence)
      },
    })
    expect(result.status).toBe('no-op')
    expect(generated).toBe(false)
  })
})

class FakeValidationRunner implements CommandRunner {
  readonly delegate = new NodeCommandRunner()
  readonly npmCommands: string[] = []

  constructor(private readonly root: string) {}

  async run(command: string, args: readonly string[] = [], options?: RunCommandOptions): Promise<CommandResult> {
    if (command !== 'npm') return await this.delegate.run(command, args, options)
    this.npmCommands.push(args.join(' '))
    if (args[0] === 'install') {
      await writeFile(join(this.root, 'package-lock.json'), '{"lockfileVersion":3,"release":true}\n')
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

class FakeGitHubClient implements GitHubClient {
  createdPull?: CreatePullRequestInput

  constructor(private readonly pulls: readonly GitHubPullRequest[] = []) {}

  async listOpenPullRequests(): Promise<readonly GitHubPullRequest[]> {
    return this.pulls
  }

  async getBranchSha(): Promise<string | null> {
    return null
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    this.createdPull = input
    return {
      number: 42,
      htmlUrl: 'https://github.test/pull/42',
      headRef: input.head,
      baseRef: input.base,
      title: input.title,
    }
  }

  async getReleaseByTag(): Promise<GitHubRelease | null> {
    throw new Error('not used')
  }

  async createRelease(_input: CreateReleaseInput): Promise<GitHubRelease> {
    throw new Error('not used')
  }

  async getCommitAuthorLogin(): Promise<string | null> {
    throw new Error('not used')
  }
}

function scriptedRun(evidence: ReleaseEvidence): ReleaseBotRun {
  const proposal: ReleaseProposal = {
    decision: 'release',
    coreBump: 'minor',
    createOmaAppBump: 'minor',
    otelBump: 'none',
    summary: 'Release resumable execution.',
    changelog: {
      breakingChanges: [],
      added: ['Resumable execution restores interrupted turns.'],
      changed: [],
      fixed: [],
      security: [],
      compatibility: ['Existing checkpoint snapshots remain readable.'],
    },
    risks: [],
    rationale: ['The merged core capability is additive.'],
  }
  const review: ReleaseReview = {
    verdict: 'approve',
    issues: [],
    rationale: ['The proposal matches current repository evidence.'],
  }
  return {
    decision: buildReleaseDecision(evidence, proposal, review, '2026-08-10'),
    proposal,
    review,
    analysis: {
      releaseRecommended: true,
      recommendedCoreBump: 'minor',
      recommendedCreateOmaAppBump: 'minor',
      recommendedOtelBump: 'none',
      changelog: proposal.changelog,
      rationale: proposal.rationale,
    },
    compatibility: {
      risk: 'low',
      breaking: false,
      recommendedCoreBump: 'minor',
      issues: [],
      migrationNotes: [],
      rationale: ['No compatibility break found.'],
    },
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
  }
}

async function createRepository(): Promise<{ root: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oma-release-prepare-'))
  const remote = await mkdtemp(join(tmpdir(), 'oma-release-remote-'))
  roots.push(root, remote)
  const runner = new NodeCommandRunner()
  await runner.run('git', ['init', '--bare'], { cwd: remote })
  await runner.run('git', ['init', '-b', 'main'], { cwd: root })
  await runner.run('git', ['config', 'user.name', 'OMA Test'], { cwd: root })
  await runner.run('git', ['config', 'user.email', 'oma-test@example.com'], { cwd: root })
  await runner.run('git', ['remote', 'add', 'origin', remote], { cwd: root })

  await writeJson(root, 'packages/core/package.json', { name: '@open-multi-agent/core', version: '1.14.0' })
  await writeJson(root, 'packages/otel/package.json', { name: '@open-multi-agent/otel', version: '0.1.1' })
  await writeJson(root, 'packages/create-oma-app/package.json', { name: 'create-oma-app', version: '0.7.0' })
  for (const path of [
    'packages/create-oma-app/template/package.json',
    'packages/create-oma-app/templates/demo/package.json',
    'packages/create-oma-app/templates/pr-review/package.json',
    'packages/create-oma-app/templates/security/package.json',
  ]) {
    await writeJson(root, path, { dependencies: { '@open-multi-agent/core': '1.14.0' } })
  }
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
  await writeText(root, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## 1.14.0 - 2026-08-01\n\n- Previous.\n')
  await runner.run('git', ['add', '.'], { cwd: root })
  await runner.run('git', ['commit', '-m', 'chore: baseline'], { cwd: root })
  await runner.run('git', ['tag', 'v1.14.0'], { cwd: root })
  await runner.run('git', ['push', '--set-upstream', 'origin', 'main', '--tags'], { cwd: root })

  await writeText(root, 'packages/core/src/recovery.ts', 'export const recovery = true\n')
  await runner.run('git', ['add', '.'], { cwd: root })
  await runner.run('git', ['commit', '-m', 'feat(core): add resumable execution'], { cwd: root })
  return { root, remote }
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await writeText(root, path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, value)
}
