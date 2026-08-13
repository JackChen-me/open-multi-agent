import {
  canonicalGitDiffArgs,
  revalidateDraftPrSafeOutput,
  sha256,
  type CommandRunner,
  type ContextManifest,
  type ControlPlaneRequest,
  type DraftPrProposal,
  type MaintainerConfig,
  type RunRecord,
} from '@open-multi-agent/maintainer-bot'
import type { GitHubClient } from './github.js'
import { deterministicBranchName } from './policy.js'
import { sanitizePublicLine } from './public-output.js'
import type { GitHubAppWriterIdentity, GitHubPullRequest, ProductionPolicy } from './schema.js'
import { isExpectedAppBotUser } from './status.js'

export const PR_MARKER = 'oma-maintainer-bot-pr:v1'

export interface DraftPrWriteResult {
  readonly pullRequest: GitHubPullRequest
  readonly branch: string
}

export async function writeDraftPullRequest(options: {
  readonly repoRoot: string
  readonly runner: CommandRunner
  readonly github: GitHubClient
  readonly githubAppToken: string
  readonly writerIdentity: GitHubAppWriterIdentity
  readonly policy: ProductionPolicy
  readonly request: ControlPlaneRequest
  readonly config: MaintainerConfig
  readonly manifest: ContextManifest
  readonly proposal: DraftPrProposal
  readonly record: RunRecord
  readonly runUrl: string
  readonly defaultBranch: string
}): Promise<DraftPrWriteResult> {
  const proposal = await revalidateDraftPrSafeOutput({
    repoRoot: options.repoRoot,
    runner: options.runner,
    request: options.request,
    config: options.config,
    manifest: options.manifest,
    proposal: options.proposal,
    record: options.record,
  })
  if (proposal.changedFiles.length > options.policy.pullRequest.maxChangedFiles) {
    throw new Error('Safe output exceeds the production Draft PR changed-file limit.')
  }
  const branch = deterministicBranchName(options.policy, proposal.issueNumber, proposal.issueRevision)
  const runKey = options.record.runKey
  const existingPulls = await options.github.listPullRequestsForHead(proposal.repository, branch)
  if (existingPulls.length > 0) {
    throw new Error('The deterministic head branch is already associated with pull request state not bound by this writer invocation.')
  }
  if (await options.github.getBranchSha(proposal.repository, branch) !== null) {
    throw new Error('The deterministic remote branch already exists without a matching open Draft PR.')
  }

  const nonSecretGitEnvironment = writerGitEnvironment(process.env, options.writerIdentity)
  await assertSafeLocalGitConfiguration(options.runner, options.repoRoot, nonSecretGitEnvironment)
  const remote = (await options.runner.run('git', ['remote', 'get-url', 'origin'], { cwd: options.repoRoot })).stdout.trim()
  const expectedRemote = `https://github.com/${proposal.repository}`
  if (remote !== expectedRemote && remote !== `${expectedRemote}.git`) {
    throw new Error('Repository origin does not match the authorized canonical GitHub repository.')
  }

  await options.runner.run(
    'git',
    ['switch', '-c', branch, proposal.baseSha],
    { cwd: options.repoRoot, env: nonSecretGitEnvironment },
  )
  const paths = proposal.changedFiles.map(file => file.path)
  await options.runner.run(
    'git',
    ['add', '--', ...paths],
    { cwd: options.repoRoot, env: nonSecretGitEnvironment },
  )
  const staged = (await options.runner.run(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
    { cwd: options.repoRoot },
  )).stdout.split('\n').filter(Boolean).sort()
  assertSamePaths(staged, [...paths].sort(), 'Staged paths differ from the reviewed proposal.')
  const unsafeStaged = (await options.runner.run(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=DRTUXB'],
    { cwd: options.repoRoot },
  )).stdout.trim()
  if (unsafeStaged.length > 0) throw new Error('Staged changes contain a deletion, rename, or unsupported Git status.')
  const unstaged = (await options.runner.run('git', ['diff', '--name-only'], { cwd: options.repoRoot })).stdout.trim()
  const untracked = (await options.runner.run(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: options.repoRoot },
  )).stdout.trim()
  if (unstaged.length > 0 || untracked.length > 0) {
    throw new Error('Unreviewed unstaged or untracked files remain after deterministic staging.')
  }
  await assertFrozenCandidateDiff({
    runner: options.runner,
    repoRoot: options.repoRoot,
    paths,
    mode: 'cached',
    expectedHash: proposal.validatedCandidateDiffHash,
    driftMessage: 'Staged candidate diff differs from the validated and reviewed proposal.',
  })
  await options.runner.run(
    'git',
    ['commit', '-m', commitMessage(options.request)],
    { cwd: options.repoRoot, env: nonSecretGitEnvironment },
  )
  const headSha = (await options.runner.run('git', ['rev-parse', 'HEAD'], { cwd: options.repoRoot })).stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(headSha) || headSha === proposal.baseSha) {
    throw new Error('Deterministic commit did not produce a valid new head SHA.')
  }
  await assertFrozenCandidateDiff({
    runner: options.runner,
    repoRoot: options.repoRoot,
    paths,
    mode: 'committed',
    baseSha: proposal.baseSha,
    expectedHash: proposal.validatedCandidateDiffHash,
    driftMessage: 'Committed candidate diff differs from the validated and reviewed proposal.',
  })
  await assertSafeLocalGitConfiguration(options.runner, options.repoRoot, nonSecretGitEnvironment)
  await options.runner.run(
    'git',
    ['push', expectedRemote, `HEAD:refs/heads/${branch}`],
    { cwd: options.repoRoot, env: writerGitEnvironment(process.env, options.writerIdentity, options.githubAppToken) },
  )
  const pullRequest = await options.github.createDraftPullRequest({
    repository: proposal.repository,
    title: proposal.title,
    body: renderDraftPrBody({
      request: options.request,
      proposal,
      runKey,
      runUrl: options.runUrl,
      headSha,
    }),
    head: branch,
    base: options.defaultBranch,
  })
  if (
    !isMatchingBotDraftPullRequest(
      pullRequest,
      runKey,
      options.defaultBranch,
      proposal.baseSha,
      branch,
      options.writerIdentity,
      headSha,
    )
    || pullRequest.head.sha !== headSha
  ) {
    throw new Error('GitHub did not return the expected trusted open Draft PR after creation.')
  }
  return { pullRequest, branch }
}

export function renderDraftPrBody(options: {
  readonly request: ControlPlaneRequest
  readonly proposal: DraftPrProposal
  readonly runKey: string
  readonly runUrl: string
  readonly headSha: string
}): string {
  const issueUrl = `https://github.com/${options.request.issue.repository}/issues/${options.request.issue.number}`
  const files = options.proposal.changedFiles.map(file => `- \`${file.path}\` — ${sanitizePublicLine(file.reason)}`)
  const validations = options.proposal.validationResults.map(result =>
    `- \`${result.id}\`: ${result.success && !result.truncated ? 'passed' : 'failed'}`)
  const risks = options.proposal.risks.length === 0
    ? ['- No additional model-reported risk after deterministic gates.']
    : options.proposal.risks.map(risk => `- ${sanitizePublicLine(risk)}`)
  const claudeCodeTokenUsage = options.proposal.claudeCodeTokenUsage === 'not_reported'
    ? 'unknown (not reported)'
    : 'not applicable'
  return `<!-- ${PR_MARKER} run-key:${options.runKey} -->
## Summary

${sanitizePublicLine(options.proposal.summary)}

Related Issue: [#${options.request.issue.number}](${issueUrl})

## Auditable run

- Actions run: [${options.runUrl}](${options.runUrl})
- Base SHA: \`${options.proposal.baseSha}\`
- Issue revision: \`${options.proposal.issueRevision}\`
- Run key: \`${options.runKey}\`
- Head SHA: \`${options.headSha}\`
- Claude Code token usage: ${claudeCodeTokenUsage}

## Reviewed files

${files.join('\n')}

## Deterministic validation

${validations.join('\n')}

## Risks

${risks.join('\n')}

## AI-assisted disclosure

OMA Maintainer Bot used remote DeepSeek inference to propose this bounded change. Repository checkout, editing, validation, safe-output revalidation, commit, push, and Draft PR creation were controlled by deterministic GitHub Actions host code. No GitHub credential was exposed to the model process.

This pull request is intentionally Draft. The bot did not approve, merge, close the Issue, release, publish, tag, or deploy.
`
}

export function isMatchingBotDraftPullRequest(
  pull: GitHubPullRequest,
  runKey: string,
  base: string,
  baseSha: string,
  head: string,
  writerIdentity: GitHubAppWriterIdentity,
  expectedHeadSha: string,
): boolean {
  return pull.state === 'open'
    && pull.draft === true
    && isExpectedAppBotUser(pull.user, writerIdentity)
    && pull.base.ref === base
    && pull.base.sha === baseSha
    && pull.head.ref === head
    && pull.head.sha === expectedHeadSha
    && (pull.body ?? '').includes(`<!-- ${PR_MARKER} run-key:${runKey} -->`)
}

function commitMessage(request: ControlPlaneRequest): string {
  const type = request.issue.kind === 'docs'
    ? 'docs'
    : request.issue.kind === 'test'
      ? 'test'
      : request.issue.kind === 'refactor'
        ? 'refactor'
        : 'fix'
  return `${type}: address issue #${request.issue.number}`
}

function writerGitEnvironment(
  source: NodeJS.ProcessEnv,
  writerIdentity: GitHubAppWriterIdentity,
  token?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  const config: Array<[string, string]> = [
    ['core.hooksPath', '/dev/null'],
    ['credential.helper', ''],
    ['http.proxy', ''],
  ]
  if (token !== undefined) {
    if (!token) throw new Error('Draft PR writer requires a GitHub token.')
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    config.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`])
  }
  environment['GIT_CONFIG_COUNT'] = String(config.length)
  config.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key
    environment[`GIT_CONFIG_VALUE_${index}`] = value
  })
  environment['GIT_CONFIG_GLOBAL'] = '/dev/null'
  environment['GIT_CONFIG_NOSYSTEM'] = '1'
  environment['GIT_TERMINAL_PROMPT'] = '0'
  const email = `${writerIdentity.botUserId}+${writerIdentity.botLogin}@users.noreply.github.com`
  environment['GIT_AUTHOR_NAME'] = writerIdentity.botLogin
  environment['GIT_AUTHOR_EMAIL'] = email
  environment['GIT_COMMITTER_NAME'] = writerIdentity.botLogin
  environment['GIT_COMMITTER_EMAIL'] = email
  return environment
}

async function assertSafeLocalGitConfiguration(
  runner: CommandRunner,
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await runner.run(
    'git',
    ['config', '--local', '--name-only', '--get-regexp', '.*'],
    { cwd: repoRoot, env: environment, allowFailure: true },
  )
  if (result.exitCode > 1) throw new Error('Local Git configuration could not be verified safely.')
  const dangerous = result.stdout.split('\n').filter(Boolean).filter(key =>
    /^(?:alias\.|include(?:if)?\.|url\.|http\.|credential\.|filter\.|protocol\.|gpg\.|trace2\.|pager\.|commit\.gpgsign$|push\.(?:gpgsign|pushoption)$|interactive\.difffilter$|core\.(?:hooksPath|sshCommand|gitProxy|askPass|fsmonitor|worktree|alternateRefsCommand)$|diff\.(?:external$|.*\.(?:command|textconv)$)|merge\..*\.driver$|remote\..*\.(?:proxy|proxyAuthMethod|uploadpack|receivepack)$)/i.test(key))
  if (dangerous.length > 0) {
    throw new Error(`Unsafe local Git configuration blocks the credentialed writer: ${dangerous.sort().join(', ')}`)
  }
}

function assertSamePaths(actual: readonly string[], expected: readonly string[], message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message)
}

export async function assertFrozenCandidateDiff(options: {
  readonly runner: CommandRunner
  readonly repoRoot: string
  readonly paths: readonly string[]
  readonly mode: 'cached' | 'committed'
  readonly baseSha?: string
  readonly expectedHash: string
  readonly driftMessage: string
}): Promise<void> {
  let diff = ''
  for (const path of [...options.paths].sort()) {
    const [command, ...canonicalArgs] = canonicalGitDiffArgs({
      baseSha: options.mode === 'committed' ? options.baseSha! : 'HEAD',
      paths: [path],
    })
    if (command !== 'diff') throw new Error('Canonical writer diff command is invalid.')
    const args = options.mode === 'cached'
      ? ['diff', '--cached', ...canonicalArgs]
      : ['diff', ...canonicalArgs.slice(0, canonicalArgs.indexOf('--')), 'HEAD', ...canonicalArgs.slice(canonicalArgs.indexOf('--'))]
    const result = await options.runner.run('git', args, {
      cwd: options.repoRoot,
      maxOutputChars: 300_001,
    })
    if (result.stdout.includes('[output truncated]')) {
      throw new Error('Draft PR writer candidate diff output was truncated.')
    }
    diff += result.stdout
    if (diff.length > 300_000) throw new Error('Draft PR writer candidate diff exceeds the safe limit.')
  }
  if (sha256(diff) !== options.expectedHash) throw new Error(options.driftMessage)
}
