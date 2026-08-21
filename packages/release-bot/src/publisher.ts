import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { composeReleaseBody, renderReleaseNotes, type ReleaseContributor } from './apply-plan.js'
import type { CommandRunner } from './command.js'
import type { GitHubClient } from './github.js'
import type { RegistryClient } from './registry.js'
import { compareVersions } from './semver.js'

/**
 * Accounts the Thanks section never credits.
 *
 * The section exists to credit people outside the project, so the maintainer's
 * own commits are excluded. Both forms appear depending on whether a commit
 * carried a GitHub noreply address.
 */
const DEFAULT_EXCLUDED_CONTRIBUTORS: readonly string[] = ['Jack Chen', 'JackChen-me']

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
}

export interface PublishPackageResult {
  readonly name: string
  readonly version: string
  readonly action: 'published' | 'already-published'
}

export interface PublishReleaseResult {
  readonly coreVersion: string
  readonly tag: string
  readonly packages: readonly PublishPackageResult[]
  readonly tagAction: 'created' | 'already-existed'
  readonly releaseAction: 'created' | 'already-existed'
  readonly releaseUrl: string
}

export interface PublishReleaseOptions {
  readonly repoRoot: string
  readonly expectedSha: string
  readonly runner: CommandRunner
  readonly registry: RegistryClient
  readonly github: GitHubClient
  readonly pollAttempts?: number
  readonly pollDelayMs?: number
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Test seam; production always uses the npm trusted-publishing preflight. */
  readonly preflightRuntime?: () => Promise<void>
  /** Accounts the Thanks section skips. Defaults to the maintainer's own. */
  readonly excludedContributors?: readonly string[]
}

interface PublishTarget {
  readonly workspace: string
  readonly path: string
  readonly name: string
  readonly version: string
}

export async function publishRelease(
  options: PublishReleaseOptions,
): Promise<PublishReleaseResult> {
  await assertCleanExpectedCommit(options)
  await assertReleaseCommit(options)
  await (options.preflightRuntime?.() ?? assertTrustedPublishingRuntime(options.runner, options.repoRoot))

  const targets = await readPublishTargets(options.repoRoot)
  const core = targets[0]
  if (!core) throw new Error('Core publish target is missing.')
  const changelog = await readFile(join(options.repoRoot, 'CHANGELOG.md'), 'utf8')
  // Composed before anything is published so a malformed changelog or an
  // inconsistent manifest set still fails ahead of the registry, exactly as the
  // notes rendering alone used to.
  const parentVersions = await readParentVersions(options)
  const releaseNotes = composeReleaseBody({
    notes: renderReleaseNotes(changelog, core.version),
    coreVersion: core.version,
    packages: targets.map(target => ({
      name: target.name,
      version: target.version,
      changed: parentVersions.get(target.path) !== target.version,
    })),
    contributors: await collectReleaseContributors(options),
  })
  const tag = `v${core.version}`

  const localTag = await resolveTag(options.runner, options.repoRoot, tag)
  if (localTag !== null && localTag !== options.expectedSha) {
    throw new Error(`${tag} already points to ${localTag}, not ${options.expectedSha}.`)
  }

  const preflight = await Promise.all(targets.map(async target => ({
    target,
    registry: await options.registry.getVersion(target.name, target.version),
  })))
  if (localTag !== null) {
    const missing = preflight.filter(item => item.registry === null)
    if (missing.length > 0) {
      throw new Error(`${tag} already exists while npm packages are missing: ${missing.map(item => `${item.target.name}@${item.target.version}`).join(', ')}.`)
    }
  }

  const packageResults: PublishPackageResult[] = []
  for (const item of preflight) {
    if (item.registry !== null) {
      packageResults.push({
        name: item.target.name,
        version: item.target.version,
        action: 'already-published',
      })
      continue
    }

    await options.runner.run('npm', ['publish', '--workspace', item.target.workspace], {
      cwd: options.repoRoot,
    })
    await waitForRegistry(options, item.target)
    packageResults.push({
      name: item.target.name,
      version: item.target.version,
      action: 'published',
    })
  }

  let tagAction: PublishReleaseResult['tagAction'] = 'already-existed'
  if (localTag === null) {
    await options.runner.run('git', ['tag', tag, options.expectedSha], { cwd: options.repoRoot })
    await options.runner.run('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: options.repoRoot })
    tagAction = 'created'
  }

  const existingRelease = await options.github.getReleaseByTag(tag)
  if (existingRelease) {
    return {
      coreVersion: core.version,
      tag,
      packages: packageResults,
      tagAction,
      releaseAction: 'already-existed',
      releaseUrl: existingRelease.htmlUrl,
    }
  }

  const release = await options.github.createRelease({
    tagName: tag,
    targetCommitish: options.expectedSha,
    name: tag,
    body: releaseNotes,
  })
  return {
    coreVersion: core.version,
    tag,
    packages: packageResults,
    tagAction,
    releaseAction: 'created',
    releaseUrl: release.htmlUrl,
  }
}


/** Versions this release commit's first parent carried, keyed by manifest path. */
async function readParentVersions(
  options: PublishReleaseOptions,
): Promise<ReadonlyMap<string, string>> {
  const parent = (await options.runner.run('git', ['rev-parse', `${options.expectedSha}^`], {
    cwd: options.repoRoot,
  })).stdout.trim()
  const versions = new Map<string, string>()
  for (const path of [
    'packages/core/package.json',
    'packages/otel/package.json',
    'packages/create-oma-app/package.json',
  ]) {
    const raw = await options.runner.run('git', ['show', `${parent}:${path}`], { cwd: options.repoRoot })
    const manifest = JSON.parse(raw.stdout) as PackageManifest
    if (typeof manifest.version !== 'string') {
      throw new Error(`${path} has no readable version at the release commit's parent.`)
    }
    versions.set(path, manifest.version)
  }
  return versions
}


/**
 * Outside contributors whose commits land in this release, newest first.
 *
 * Resolved from the previous release tag reachable from the release commit's
 * parent, not from HEAD: on an idempotent re-run this release's tag already
 * exists, and describing from HEAD would then report an empty range and drop
 * every contributor from the body.
 */
export async function collectReleaseContributors(
  options: PublishReleaseOptions,
): Promise<readonly ReleaseContributor[]> {
  const previousTag = (await options.runner.run(
    'git',
    ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${options.expectedSha}^`],
    { cwd: options.repoRoot },
  )).stdout.trim()
  if (!/^v\d+\.\d+\.\d+$/.test(previousTag)) {
    throw new Error(`Cannot resolve a previous release tag from the release commit's parent; got "${previousTag}".`)
  }

  const log = await options.runner.run(
    'git',
    ['log', '--format=%an%x1f%ae%x1f%s%x1e', `${previousTag}..${options.expectedSha}`],
    { cwd: options.repoRoot },
  )
  const excluded = new Set(options.excludedContributors ?? DEFAULT_EXCLUDED_CONTRIBUTORS)
  const byName = new Map<string, string[]>()
  for (const record of log.stdout.split('\u001e')) {
    const line = record.trim()
    if (line === '') continue
    const [author = '', email = '', subject = ''] = line.split('\u001f')
    const name = resolveContributorName(author, email)
    if (name === '' || name.endsWith('[bot]') || excluded.has(name)) continue
    const contribution = describeContribution(subject)
    if (contribution === '') continue
    const existing = byName.get(name)
    if (existing) existing.push(contribution)
    else byName.set(name, [contribution])
  }
  return [...byName].map(([name, contributions]) => ({ name, contributions }))
}

/** A GitHub noreply address carries the login; anything else only has a display name. */
function resolveContributorName(author: string, email: string): string {
  const noreply = /^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/.exec(email.trim())
  return (noreply?.[1] ?? author).trim()
}

/** `feat(examples): add a thing (#12)` becomes `add a thing (#12)`. */
function describeContribution(subject: string): string {
  return subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '').trim()
}

async function assertReleaseCommit(options: PublishReleaseOptions): Promise<void> {
  const parentResult = await options.runner.run('git', ['rev-parse', `${options.expectedSha}^`], {
    cwd: options.repoRoot,
    allowFailure: true,
  })
  if (parentResult.exitCode !== 0) throw new Error('Release commit has no readable first parent.')
  const parent = parentResult.stdout.trim()
  const checks = [
    { path: 'packages/core/package.json', name: '@open-multi-agent/core' },
    { path: 'packages/create-oma-app/package.json', name: 'create-oma-app' },
  ] as const
  for (const check of checks) {
    const [beforeRaw, afterRaw] = await Promise.all([
      options.runner.run('git', ['show', `${parent}:${check.path}`], { cwd: options.repoRoot }),
      readFile(join(options.repoRoot, check.path), 'utf8'),
    ])
    const before = JSON.parse(beforeRaw.stdout) as PackageManifest
    const after = JSON.parse(afterRaw) as PackageManifest
    if (typeof before.version !== 'string' || typeof after.version !== 'string') {
      throw new Error(`${check.path} has no comparable version across the release commit.`)
    }
    if (compareVersions(after.version, before.version) <= 0) {
      throw new Error(`${options.expectedSha} is not a release commit: ${check.name} did not increment from its first parent.`)
    }
  }
}

export async function assertTrustedPublishingRuntime(
  runner: CommandRunner,
  repoRoot: string,
): Promise<void> {
  if (compareVersions(normalizeRuntimeVersion(process.versions.node), '22.14.0') < 0) {
    throw new Error(`npm trusted publishing requires Node >=22.14.0; found ${process.versions.node}.`)
  }
  const npmVersion = (await runner.run('npm', ['--version'], { cwd: repoRoot })).stdout.trim()
  if (compareVersions(normalizeRuntimeVersion(npmVersion), '11.5.1') < 0) {
    throw new Error(`npm trusted publishing requires npm >=11.5.1; found ${npmVersion}.`)
  }
}

async function readPublishTargets(repoRoot: string): Promise<readonly PublishTarget[]> {
  const definitions = [
    { workspace: '@open-multi-agent/core', path: 'packages/core/package.json' },
    { workspace: '@open-multi-agent/otel', path: 'packages/otel/package.json' },
    { workspace: 'create-oma-app', path: 'packages/create-oma-app/package.json' },
  ] as const
  const targets = await Promise.all(definitions.map(async definition => {
    const manifest = JSON.parse(await readFile(join(repoRoot, definition.path), 'utf8')) as PackageManifest
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`${definition.path} is missing a string name or version.`)
    }
    if (manifest.name !== definition.workspace) {
      throw new Error(`${definition.path} declares ${String(manifest.name)}, expected ${definition.workspace}.`)
    }
    return { ...definition, name: manifest.name, version: manifest.version }
  }))

  const [core, , createOmaApp] = targets
  if (!core || !createOmaApp) throw new Error('Required publish targets are missing.')
  const templatePaths = [
    'packages/create-oma-app/template/package.json',
    'packages/create-oma-app/templates/demo/package.json',
    'packages/create-oma-app/templates/pr-review/package.json',
    'packages/create-oma-app/templates/security/package.json',
  ]
  for (const path of templatePaths) {
    const manifest = JSON.parse(await readFile(join(repoRoot, path), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    if (manifest.dependencies?.['@open-multi-agent/core'] !== core.version) {
      throw new Error(`${path} does not pin @open-multi-agent/core@${core.version}.`)
    }
  }
  if (compareVersions(createOmaApp.version, '0.0.0') <= 0) {
    throw new Error('create-oma-app must have a publishable version.')
  }
  return targets
}

async function assertCleanExpectedCommit(options: PublishReleaseOptions): Promise<void> {
  const [head, status] = await Promise.all([
    options.runner.run('git', ['rev-parse', 'HEAD'], { cwd: options.repoRoot }),
    options.runner.run('git', ['status', '--porcelain'], { cwd: options.repoRoot }),
  ])
  if (head.stdout.trim() !== options.expectedSha) {
    throw new Error(`Publish checkout is ${head.stdout.trim()}, expected ${options.expectedSha}.`)
  }
  if (status.stdout.trim() !== '') {
    throw new Error('Publish checkout must be clean.')
  }
}

async function resolveTag(
  runner: CommandRunner,
  repoRoot: string,
  tag: string,
): Promise<string | null> {
  const result = await runner.run('git', ['rev-parse', `refs/tags/${tag}^{commit}`], {
    cwd: repoRoot,
    allowFailure: true,
  })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

async function waitForRegistry(
  options: PublishReleaseOptions,
  target: PublishTarget,
): Promise<void> {
  const attempts = options.pollAttempts ?? 9
  const delay = options.pollDelayMs ?? 10_000
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await options.registry.getVersion(target.name, target.version)) return
    if (attempt < attempts) await sleep(delay)
  }
  throw new Error(`${target.name}@${target.version} did not appear in the npm registry after publication.`)
}

function normalizeRuntimeVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`Cannot parse runtime version "${version}".`)
  return `${match[1]}.${match[2]}.${match[3]}`
}
