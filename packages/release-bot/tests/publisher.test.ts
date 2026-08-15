import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/command.js'
import type { CreatePullRequestInput, CreateReleaseInput, GitHubClient, GitHubPullRequest, GitHubRelease } from '../src/github.js'
import { publishRelease } from '../src/publisher.js'
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
    expect(github.createdRelease?.body).toContain('### Added')

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
