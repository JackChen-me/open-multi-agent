import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/command.js'
import type { CreatePullRequestInput, CreateReleaseInput, GitHubClient, GitHubPullRequest, GitHubRelease } from '../src/github.js'
import { collectReleaseContributors, publishRelease } from '../src/publisher.js'
import type { RegistryClient, RegistryVersion } from '../src/registry.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('deterministic publisher', () => {
  it('publishes only missing versions in fixed order, then tags and releases', async () => {
    const root = await createFixture()
    const sha = 'b'.repeat(40)
    const registry = new FakeRegistry([
      { name: '@open-multi-agent/otel', version: '0.1.1' },
    ])
    const runner = new PublishRunner(sha, registry)
    const github = new PublishGitHub()

    const result = await publishRelease({
      repoRoot: root,
      expectedSha: sha,
      runner,
      registry,
      github,
      pollAttempts: 1,
      sleep: async () => {},
      preflightRuntime: async () => {},
    })

    expect(runner.publishedWorkspaces).toEqual([
      '@open-multi-agent/core',
      'create-oma-app',
    ])
    expect(result.packages).toEqual([
      { name: '@open-multi-agent/core', version: '1.15.0', action: 'published' },
      { name: '@open-multi-agent/otel', version: '0.1.1', action: 'already-published' },
      { name: 'create-oma-app', version: '0.8.0', action: 'published' },
    ])
    expect(result.tagAction).toBe('created')
    expect(result.releaseAction).toBe('created')
    expect(github.createdRelease).toMatchObject({
      tagName: 'v1.15.0',
      targetCommitish: sha,
    })
    const body = github.createdRelease?.body ?? ''
    expect(body).toContain('### Added')
    // A reader of the release page needs what shipped and how to install it,
    // neither of which the changelog section carries.
    expect(body).toContain('## Packages')
    expect(body).toContain('- `@open-multi-agent/core`: `1.15.0`')
    expect(body).toContain('- `create-oma-app`: `0.8.0`; generated starters pin core `1.15.0`')
    expect(body).toContain('- `@open-multi-agent/otel`: remains at `0.1.1` and is not republished')
    expect(body).toContain('## Install')
    expect(body).toContain('@open-multi-agent/core@1.15.0')
    // Outside contributors only: the maintainer and the bot are filtered out.
    expect(body).toContain('## Thanks')
    expect(body).toContain('- green3sf: add a verify loop (#541)')
    expect(body).not.toContain('Jack Chen')
    expect(body).not.toContain('oma-release-bot')

    runner.publishedWorkspaces.length = 0
    const resumed = await publishRelease({
      repoRoot: root,
      expectedSha: sha,
      runner,
      registry,
      github,
      pollAttempts: 1,
      preflightRuntime: async () => {},
    })
    expect(runner.publishedWorkspaces).toEqual([])
    expect(resumed.tagAction).toBe('already-existed')
    expect(resumed.releaseAction).toBe('already-existed')
  })

  it('fails closed when a tag exists before every package is visible', async () => {
    const root = await createFixture()
    const sha = 'b'.repeat(40)
    const registry = new FakeRegistry([
      { name: '@open-multi-agent/otel', version: '0.1.1' },
    ])
    const runner = new PublishRunner(sha, registry)
    runner.tagSha = sha
    await expect(publishRelease({
      repoRoot: root,
      expectedSha: sha,
      runner,
      registry,
      github: new PublishGitHub(),
      preflightRuntime: async () => {},
    })).rejects.toThrow(/already exists while npm packages are missing/i)
  })
})

class FakeRegistry implements RegistryClient {
  private readonly versions = new Map<string, RegistryVersion>()

  constructor(initial: readonly RegistryVersion[]) {
    for (const version of initial) this.add(version.name, version.version)
  }

  async getVersion(packageName: string, version: string): Promise<RegistryVersion | null> {
    return this.versions.get(`${packageName}@${version}`) ?? null
  }

  add(name: string, version: string): void {
    this.versions.set(`${name}@${version}`, { name, version })
  }
}

class PublishRunner implements CommandRunner {
  readonly publishedWorkspaces: string[] = []
  tagSha: string | null = null

  constructor(
    private readonly sha: string,
    private readonly registry: FakeRegistry,
  ) {}

  async run(command: string, args: readonly string[] = [], _options?: RunCommandOptions): Promise<CommandResult> {
    if (command === 'git') return this.git(args)
    if (command === 'npm' && args[0] === 'publish' && args[1] === '--workspace') {
      const workspace = args[2]
      if (!workspace) throw new Error('missing workspace')
      this.publishedWorkspaces.push(workspace)
      const versions: Record<string, string> = {
        '@open-multi-agent/core': '1.15.0',
        '@open-multi-agent/otel': '0.1.1',
        'create-oma-app': '0.8.0',
      }
      this.registry.add(workspace, versions[workspace] ?? '')
      return success()
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  private git(args: readonly string[]): CommandResult {
    if (args[0] === 'status') return success('')
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return success(`${this.sha}\n`)
    if (args[0] === 'rev-parse' && args[1] === `${this.sha}^`) return success(`${'a'.repeat(40)}\n`)
    if (args[0] === 'show' && args[1]?.endsWith(':packages/core/package.json')) {
      return success('{"name":"@open-multi-agent/core","version":"1.14.0"}\n')
    }
    if (args[0] === 'show' && args[1]?.endsWith(':packages/create-oma-app/package.json')) {
      return success('{"name":"create-oma-app","version":"0.7.0"}\n')
    }
    // Unchanged across the release commit, so the body must report it as not republished.
    if (args[0] === 'show' && args[1]?.endsWith(':packages/otel/package.json')) {
      return success('{"name":"@open-multi-agent/otel","version":"0.1.1"}\n')
    }
    if (args[0] === 'describe' && args[args.length - 1] === `${this.sha}^`) {
      return success('v1.14.0\n')
    }
    if (args[0] === 'log' && args[2] === `v1.14.0..${this.sha}`) {
      // One outside contributor, the maintainer, and the release bot itself.
      return success([
        'green3sf\u001f222944370+green3sf@users.noreply.github.com\u001ffeat(examples): add a verify loop (#541)\u001e',
        'Jack Chen\u001fchenkaijie01@gmail.com\u001ffix(core): export public config types (#533)\u001e',
        'oma-release-bot[bot]\u001f1+oma-release-bot[bot]@users.noreply.github.com\u001fchore: release core v1.15.0 (#543)\u001e',
      ].join(''))
    }
    if (args[0] === 'rev-parse' && args[1] === 'refs/tags/v1.15.0^{commit}') {
      return this.tagSha ? success(`${this.tagSha}\n`) : { stdout: '', stderr: 'missing', exitCode: 128 }
    }
    if (args[0] === 'tag' && args[1] === 'v1.15.0') {
      this.tagSha = args[2] ?? null
      return success()
    }
    if (args[0] === 'push' && args[2] === 'refs/tags/v1.15.0') return success()
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  }
}

class PublishGitHub implements GitHubClient {
  createdRelease?: CreateReleaseInput
  private release: GitHubRelease | null = null

  async listOpenPullRequests(): Promise<readonly GitHubPullRequest[]> { return [] }
  async getBranchSha(): Promise<string | null> { return null }
  async createPullRequest(_input: CreatePullRequestInput): Promise<GitHubPullRequest> { throw new Error('not used') }
  async getReleaseByTag(): Promise<GitHubRelease | null> { return this.release }
  async createRelease(input: CreateReleaseInput): Promise<GitHubRelease> {
    this.createdRelease = input
    this.release = { id: 1, htmlUrl: 'https://github.test/releases/v1.15.0', tagName: input.tagName }
    return this.release
  }
}

function success(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0 }
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-release-publish-'))
  roots.push(root)
  await writeJson(root, 'packages/core/package.json', { name: '@open-multi-agent/core', version: '1.15.0' })
  await writeJson(root, 'packages/otel/package.json', { name: '@open-multi-agent/otel', version: '0.1.1' })
  await writeJson(root, 'packages/create-oma-app/package.json', { name: 'create-oma-app', version: '0.8.0' })
  for (const path of [
    'packages/create-oma-app/template/package.json',
    'packages/create-oma-app/templates/demo/package.json',
    'packages/create-oma-app/templates/pr-review/package.json',
    'packages/create-oma-app/templates/security/package.json',
  ]) {
    await writeJson(root, path, { dependencies: { '@open-multi-agent/core': '1.15.0' } })
  }
  await writeText(root, 'CHANGELOG.md', `# Changelog

## Unreleased

## 1.15.0 - 2026-08-10

### Added

- Durable recovery resumes interrupted turns.

## 1.14.0 - 2026-08-01

- Previous.
`)
  return root
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await writeText(root, path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, value)
}

describe('release contributor collection', () => {
  const runner = (log: string, tag = 'v1.14.0'): CommandRunner => ({
    run: async (command: string, args: readonly string[] = []): Promise<CommandResult> => {
      if (command === 'git' && args[0] === 'describe') return success(`${tag}\n`)
      if (command === 'git' && args[0] === 'log') return success(log)
      throw new Error(`unexpected: ${command} ${args.join(' ')}`)
    },
  })

  const record = (author: string, email: string, subject: string) =>
    `${author}\u001f${email}\u001f${subject}\u001e`

  it('groups a contributor and strips the conventional-commit prefix', async () => {
    const contributors = await collectReleaseContributors({
      repoRoot: '/tmp/unused', expectedSha: 'c'.repeat(40),
      runner: runner([
        record('green3sf', '9+green3sf@users.noreply.github.com', 'feat(examples): add a verify loop (#541)'),
        record('green3sf', '9+green3sf@users.noreply.github.com', 'fix(orchestrator): refresh output (#536)'),
      ].join('')),
    } as Parameters<typeof collectReleaseContributors>[0])

    expect(contributors).toEqual([
      { name: 'green3sf', contributions: ['add a verify loop (#541)', 'refresh output (#536)'] },
    ])
  })

  it('falls back to the author name when the address is not a GitHub noreply', async () => {
    const contributors = await collectReleaseContributors({
      repoRoot: '/tmp/unused', expectedSha: 'c'.repeat(40),
      runner: runner(record('Ada Lovelace', 'ada@example.com', 'fix(core): tighten a guard (#12)')),
    } as Parameters<typeof collectReleaseContributors>[0])

    expect(contributors).toEqual([
      { name: 'Ada Lovelace', contributions: ['tighten a guard (#12)'] },
    ])
  })

  it('honours an explicit exclusion list', async () => {
    const contributors = await collectReleaseContributors({
      repoRoot: '/tmp/unused', expectedSha: 'c'.repeat(40),
      excludedContributors: ['Ada Lovelace'],
      runner: runner(record('Ada Lovelace', 'ada@example.com', 'fix(core): tighten a guard (#12)')),
    } as Parameters<typeof collectReleaseContributors>[0])

    expect(contributors).toEqual([])
  })

  it('fails closed when no previous release tag resolves', async () => {
    // Silently returning an empty list here would drop every contributor from
    // a published release body without anything reporting it.
    await expect(collectReleaseContributors({
      repoRoot: '/tmp/unused', expectedSha: 'c'.repeat(40),
      runner: runner('', 'not-a-tag'),
    } as Parameters<typeof collectReleaseContributors>[0]))
      .rejects.toThrow(/Cannot resolve a previous release tag/)
  })
})
