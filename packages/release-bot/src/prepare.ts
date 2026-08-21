import type { OrchestratorEvent } from '@open-multi-agent/core'
import { applyReleasePlan, buildReleasePrBody, buildReleasePrTitle, RELEASE_PLAN_PATHS } from './apply-plan.js'
import type { CommandRunner } from './command.js'
import { collectReleaseEvidence } from './evidence.js'
import type { GitHubClient } from './github.js'
import { generateReleaseDecision, type ReleaseBotRun } from './orchestrator.js'
import type { ReleaseEvidence } from './schema.js'

export type PrepareReleasePrResult =
  | { readonly status: 'no-op'; readonly reason: string; readonly run?: ReleaseBotRun }
  | { readonly status: 'rejected'; readonly reason: string; readonly run: ReleaseBotRun }
  | { readonly status: 'created'; readonly branch: string; readonly pullNumber: number; readonly pullUrl: string; readonly run: ReleaseBotRun }
  | { readonly status: 'recovered'; readonly branch: string; readonly pullNumber: number; readonly pullUrl: string; readonly run: ReleaseBotRun }

export interface PrepareReleasePrOptions {
  readonly repoRoot: string
  readonly repository: string
  readonly baseBranch?: string
  readonly runner: CommandRunner
  readonly github: GitHubClient
  readonly model?: string
  readonly deepseekApiKey?: string
  readonly releaseDate?: string
  readonly validate?: boolean
  readonly onProgress?: (event: OrchestratorEvent) => void
  readonly generate?: (
    evidence: ReleaseEvidence,
  ) => Promise<ReleaseBotRun>
}

export async function prepareReleasePr(
  options: PrepareReleasePrOptions,
): Promise<PrepareReleasePrResult> {
  const baseBranch = options.baseBranch ?? 'main'
  const openPulls = await options.github.listOpenPullRequests(baseBranch)
  const existing = openPulls.find(pull =>
    pull.headRef.startsWith('release-bot/')
    || /^chore: release core v\d+\.\d+\.\d+\b/i.test(pull.title),
  )
  if (existing) {
    return {
      status: 'no-op',
      reason: `Release PR #${existing.number} is already open: ${existing.htmlUrl}`,
    }
  }

  await assertCleanWorktree(options)
  const evidence = await collectReleaseEvidence(options.repoRoot, options.runner)
  if (`v${evidence.versions.core}` !== evidence.baseTag) {
    return {
      status: 'no-op',
      reason: `Core manifest ${evidence.versions.core} is ahead of latest tag ${evidence.baseTag}; publication or recovery is still pending.`,
    }
  }
  if (evidence.commits.length === 0) {
    return { status: 'no-op', reason: `HEAD matches ${evidence.baseTag}; there are no merged changes to release.` }
  }
  if (!evidence.workspaceChanges.core) {
    return { status: 'no-op', reason: `No packages/core changes exist after ${evidence.baseTag}; a core release is not needed.` }
  }

  const run = options.generate
    ? await options.generate(evidence)
    : await generateReleaseDecision({
        repoRoot: options.repoRoot,
        runner: options.runner,
        evidence,
        model: options.model,
        apiKey: options.deepseekApiKey,
        releaseDate: options.releaseDate,
        onProgress: options.onProgress,
      })

  if (run.decision.status === 'none') {
    return { status: 'no-op', reason: run.proposal.rationale.join(' '), run }
  }
  if (run.decision.status === 'rejected') {
    return { status: 'rejected', reason: run.review.issues.join(' ') || 'Independent reviewer rejected the release plan.', run }
  }

  const plan = run.decision.plan
  const currentHead = (await options.runner.run('git', ['rev-parse', 'HEAD'], { cwd: options.repoRoot })).stdout.trim()
  if (currentHead !== plan.headSha) {
    throw new Error(`HEAD advanced during planning: expected ${plan.headSha}, found ${currentHead}.`)
  }

  const branch = `release-bot/core-v${plan.nextVersions.core}`
  const remoteSha = await options.github.getBranchSha(branch)
  if (remoteSha !== null) {
    await verifyRecoverableRemoteBranch(options, branch, remoteSha, plan)
    const pull = await options.github.createPullRequest({
      title: buildReleasePrTitle(plan),
      body: buildReleasePrBody(plan),
      head: branch,
      base: baseBranch,
      draft: false,
    })
    return {
      status: 'recovered',
      branch,
      pullNumber: pull.number,
      pullUrl: pull.htmlUrl,
      run,
    }
  }

  await options.runner.run('git', ['switch', '-c', branch, plan.headSha], { cwd: options.repoRoot })
  const changedByPlan = await applyReleasePlan(options.repoRoot, plan)
  await options.runner.run(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: options.repoRoot },
  )

  await assertExpectedChanges(options, changedByPlan)
  await options.runner.run('git', ['diff', '--check'], { cwd: options.repoRoot })
  if (options.validate !== false) {
    // Echoed: these three dominate the step's wall clock, and a silent failure
    // or hang here is otherwise indistinguishable from a slow model call.
    await options.runner.run('npm', ['run', 'lint'], { cwd: options.repoRoot, echo: true })
    await options.runner.run('npm', ['test'], { cwd: options.repoRoot, echo: true })
    await options.runner.run('npm', ['run', 'build'], { cwd: options.repoRoot, echo: true })
  }

  const stagedPaths = [...new Set([...changedByPlan, 'package-lock.json'])]
  await options.runner.run('git', ['add', '--', ...stagedPaths], { cwd: options.repoRoot })
  const title = buildReleasePrTitle(plan)
  await options.runner.run('git', ['commit', '-m', title], { cwd: options.repoRoot })
  await options.runner.run('git', ['push', '--set-upstream', 'origin', branch], { cwd: options.repoRoot })

  const pull = await options.github.createPullRequest({
    title,
    body: buildReleasePrBody(plan),
    head: branch,
    base: baseBranch,
    draft: false,
  })
  return {
    status: 'created',
    branch,
    pullNumber: pull.number,
    pullUrl: pull.htmlUrl,
    run,
  }
}

async function assertCleanWorktree(options: PrepareReleasePrOptions): Promise<void> {
  const status = await options.runner.run('git', ['status', '--porcelain'], { cwd: options.repoRoot })
  if (status.stdout.trim() !== '') {
    throw new Error('Release bot requires a clean worktree before planning.')
  }
}

async function assertExpectedChanges(
  options: PrepareReleasePrOptions,
  changedByPlan: readonly string[],
): Promise<void> {
  const status = await options.runner.run('git', ['status', '--porcelain', '-z'], { cwd: options.repoRoot })
  const changed = parseStatusPaths(status.stdout)
  const allowed = new Set<string>(RELEASE_PLAN_PATHS)
  for (const path of changed) {
    if (!allowed.has(path)) {
      throw new Error(`Release materialization changed an unexpected path: ${path}`)
    }
  }
  for (const expected of [...changedByPlan, 'package-lock.json']) {
    if (!changed.has(expected)) {
      throw new Error(`Release materialization did not change expected path: ${expected}`)
    }
  }
}

function parseStatusPaths(output: string): Set<string> {
  const entries = output.split('\0').filter(Boolean)
  const paths = new Set<string>()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? ''
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (path) paths.add(path)
    if (status.includes('R') || status.includes('C')) {
      const destination = entries[index + 1]
      if (destination) paths.add(destination)
      index += 1
    }
  }
  return paths
}

async function verifyRecoverableRemoteBranch(
  options: PrepareReleasePrOptions,
  branch: string,
  remoteSha: string,
  plan: Extract<ReleaseBotRun['decision'], { status: 'release' }>['plan'],
): Promise<void> {
  await options.runner.run('git', ['fetch', 'origin', `refs/heads/${branch}`], { cwd: options.repoRoot })
  const fetched = (await options.runner.run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: options.repoRoot })).stdout.trim()
  const parent = (await options.runner.run('git', ['rev-parse', 'FETCH_HEAD^'], { cwd: options.repoRoot })).stdout.trim()
  if (fetched !== remoteSha || parent !== plan.headSha) {
    throw new Error(`Remote branch ${branch} exists but is not the expected one-commit child of ${plan.headSha}.`)
  }

  const names = await options.runner.run(
    'git',
    ['diff', '--name-only', '-z', `${plan.headSha}..${fetched}`],
    { cwd: options.repoRoot },
  )
  const changed = new Set(names.stdout.split('\0').filter(Boolean))
  const allowed = new Set<string>(RELEASE_PLAN_PATHS)
  for (const path of changed) {
    if (!allowed.has(path)) {
      throw new Error(`Remote recovery branch changed an unexpected path: ${path}`)
    }
  }

  for (const [path, expectedVersion] of [
    ['packages/core/package.json', plan.nextVersions.core],
    ['packages/create-oma-app/package.json', plan.nextVersions.createOmaApp],
    ['packages/otel/package.json', plan.nextVersions.otel],
  ] as const) {
    const manifest = JSON.parse((await options.runner.run(
      'git',
      ['show', `${fetched}:${path}`],
      { cwd: options.repoRoot },
    )).stdout) as { version?: unknown }
    if (manifest.version !== expectedVersion) {
      throw new Error(`Remote recovery branch has ${path}@${String(manifest.version)}, expected ${expectedVersion}.`)
    }
  }
}
