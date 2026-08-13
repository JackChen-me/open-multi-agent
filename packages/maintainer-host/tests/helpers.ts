import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions,
} from '@open-multi-agent/maintainer-bot'
import type { GitHubClient, GitHubIssueCommentAuthorship } from '../src/github.js'
import { loadProductionPolicy } from '../src/policy.js'
import type {
  GitHubActor,
  GitHubActionsRun,
  GitHubAppWriterContract,
  GitHubAppWriterIdentity,
  GitHubComment,
  GitHubIssue,
  GitHubLabelEvent,
  GitHubPullRequest,
  GitHubTimelineEvent,
} from '../src/schema.js'

export const BASE_SHA = 'a'.repeat(40)
export const SECOND_SHA = 'b'.repeat(40)
export const ISSUE_NUMBER = 488
export const REPOSITORY = 'open-multi-agent/open-multi-agent'
export const APP_ID = 246_810
export const APP_CLIENT_ID = 'Iv1.omaMaintainerBot'
export const APP_SLUG = 'oma-maintainer-bot'
export const APP_INSTALLATION_ID = 135_791
export const APP_BOT_USER_ID = 975_310
export const APP_BOT_LOGIN = `${APP_SLUG}[bot]`

export const APP_IDENTITY: GitHubAppWriterIdentity = {
  appId: APP_ID,
  clientId: APP_CLIENT_ID,
  slug: APP_SLUG,
  installationId: APP_INSTALLATION_ID,
  botUserId: APP_BOT_USER_ID,
  botLogin: APP_BOT_LOGIN,
}

export const APP_CONTRACT: GitHubAppWriterContract = {
  enabled: true,
  expectedAppId: APP_ID,
  expectedClientId: APP_CLIENT_ID,
  expectedSlug: APP_SLUG,
  expectedInstallationId: APP_INSTALLATION_ID,
  expectedBotUserId: APP_BOT_USER_ID,
  actualSlug: APP_SLUG,
  actualInstallationId: APP_INSTALLATION_ID,
}

export const ISSUE_BODY = `## Describe the bug

\`packages/create-oma-app/tests/runtime.test.ts\` reads an ambient OMA_MODEL and fails for unrelated reasons.

## To Reproduce

Run the focused runtime test with OMA_MODEL set and observe two deterministic failures.

## Expected behavior

The runtime tests fully control and restore OMA_MODEL for every test.

## Acceptance criteria

- The focused runtime test passes with OMA_MODEL=ambient-model.
- The focused runtime test passes without an ambient OMA_MODEL.

## Target paths

- \`packages/create-oma-app/tests/runtime.test.ts\`

## Out of scope

- Production runtime behavior, dependencies, CI, release, public APIs, and other workspaces.
`

export function labelEvent(overrides: Partial<GitHubLabelEvent> = {}): GitHubLabelEvent {
  return {
    action: 'labeled',
    label: { name: 'agent-ready' },
    issue: {
      number: ISSUE_NUMBER,
      title: '[Bug] Isolate runtime tests from ambient OMA_MODEL',
      body: ISSUE_BODY,
      state: 'open',
      updated_at: '2026-08-10T17:42:09Z',
      comments: 0,
      user: { login: 'reporter' },
      labels: [{ name: 'agent-ready' }, { name: 'bug' }],
    },
    repository: { full_name: REPOSITORY, default_branch: 'main' },
    sender: { login: 'maintainer' },
    ...overrides,
  }
}

export function issueFromEvent(event = labelEvent()): GitHubIssue {
  return {
    number: event.issue.number,
    title: event.issue.title,
    body: event.issue.body,
    state: event.issue.state,
    updated_at: event.issue.updated_at,
    comments: event.issue.comments,
    user: event.issue.user,
    labels: event.issue.labels,
  }
}

export async function productionPolicy() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return loadProductionPolicy(resolve(root, 'config/production-policy.json'))
}

export class FakeGitHub implements GitHubClient {
  viewerLogin = APP_BOT_LOGIN
  app = { id: APP_ID, clientId: APP_CLIENT_ID, slug: APP_SLUG }
  botUser: GitHubActor = { id: APP_BOT_USER_ID, login: APP_BOT_LOGIN, type: 'Bot' }
  commentUser: GitHubActor = { id: APP_BOT_USER_ID, login: APP_BOT_LOGIN, type: 'Bot' }
  installationRepositories = [REPOSITORY]
  commentAuthorshipOverrides = new Map<string, GitHubIssueCommentAuthorship>()
  issue: GitHubIssue = issueFromEvent()
  comments: GitHubComment[] = []
  timeline: GitHubTimelineEvent[] = []
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' = 'write'
  baseSha: string | null = BASE_SHA
  actionsRuns = new Map<number, GitHubActionsRun>()
  pulls: GitHubPullRequest[] = []
  createdPullRequests = 0
  createdComments = 0
  updatedComments = 0
  deletedComments = 0

  async getAuthenticatedViewerLogin() {
    return this.viewerLogin
  }

  async getApp() {
    return structuredClone(this.app)
  }

  async getUser(): Promise<GitHubActor> {
    return structuredClone(this.botUser)
  }

  async listInstallationRepositories(): Promise<string[]> {
    return [...this.installationRepositories]
  }

  async getIssueCommentAuthorship(nodeId: string) {
    const override = this.commentAuthorshipOverrides.get(nodeId)
    if (override !== undefined) return structuredClone(override)
    const comment = this.comments.find(candidate => candidate.node_id === nodeId)
    if (comment === undefined) throw new Error('comment not found')
    const author = graphQlActor(comment.user)
    return {
      author,
      editor: comment.updated_at === comment.created_at ? null : author,
      createdViaEmail: false,
    }
  }

  async getRepository() {
    return { defaultBranch: 'main', fullName: REPOSITORY }
  }

  async getIssue(): Promise<GitHubIssue> {
    return structuredClone(this.issue)
  }

  async listIssueComments(): Promise<GitHubComment[]> {
    return structuredClone(this.comments)
  }

  async listIssueTimeline(): Promise<GitHubTimelineEvent[]> {
    return structuredClone(this.timeline)
  }

  async getCollaboratorPermission() {
    return this.permission
  }

  async getBranchSha(_repository: string, branch: string): Promise<string | null> {
    if (branch === 'main') return this.baseSha
    const pull = this.pulls.find(candidate => candidate.head.ref === branch)
    return pull?.head.sha ?? null
  }

  async getActionsRun(_repository: string, runId: number): Promise<GitHubActionsRun | null> {
    return this.actionsRuns.get(runId) ?? null
  }

  async createIssueComment(_repository: string, _issueNumber: number, body: string): Promise<GitHubComment> {
    this.createdComments += 1
    const comment = { ...botComment(10_000 + this.createdComments, body), user: structuredClone(this.commentUser) }
    this.comments.push(comment)
    return structuredClone(comment)
  }

  async updateIssueComment(_repository: string, commentId: number, body: string): Promise<GitHubComment> {
    this.updatedComments += 1
    const index = this.comments.findIndex(comment => comment.id === commentId)
    if (index === -1) throw new Error('comment not found')
    const updated = { ...this.comments[index]!, body, updated_at: '2026-08-10T18:00:00Z' }
    this.comments[index] = updated
    return structuredClone(updated)
  }

  async deleteIssueComment(_repository: string, commentId: number): Promise<void> {
    const index = this.comments.findIndex(comment => comment.id === commentId)
    if (index === -1) throw new Error('comment not found')
    this.comments.splice(index, 1)
    this.deletedComments += 1
  }

  async listPullRequestsForHead(_repository: string, head: string): Promise<GitHubPullRequest[]> {
    return structuredClone(this.pulls.filter(pull => pull.head.ref === head))
  }

  async createDraftPullRequest(input: {
    repository: string
    title: string
    body: string
    head: string
    base: string
  }): Promise<GitHubPullRequest> {
    this.createdPullRequests += 1
    const pull: GitHubPullRequest = {
      number: 700 + this.createdPullRequests,
      html_url: `https://github.com/${input.repository}/pull/${700 + this.createdPullRequests}`,
      state: 'open',
      draft: true,
      title: input.title,
      body: input.body,
      user: structuredClone(this.botUser),
      head: { ref: input.head, sha: SECOND_SHA },
      base: { ref: input.base, sha: BASE_SHA },
      merged_at: null,
    }
    this.pulls.push(pull)
    return structuredClone(pull)
  }
}

export class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: RunCommandOptions }> = []

  constructor(private readonly handler: (
    command: string,
    args: readonly string[],
    options: RunCommandOptions,
  ) => CommandResult | Promise<CommandResult>) {}

  async run(command: string, args: readonly string[] = [], options: RunCommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args, options })
    return this.handler(command, args, options)
  }
}

export function cleanRunner(head = BASE_SHA): RecordingRunner {
  return new RecordingRunner((_command, args) => {
    if (args[0] === 'rev-parse') return ok(`${head}\n`)
    if (args[0] === 'status') return ok('')
    throw new Error(`unexpected command: ${args.join(' ')}`)
  })
}

export function botComment(id: number, body: string): GitHubComment {
  return {
    id,
    node_id: `IC_${id}`,
    body,
    created_at: '2026-08-10T17:43:00Z',
    updated_at: '2026-08-10T17:43:00Z',
    author_association: 'NONE',
    user: { id: APP_BOT_USER_ID, login: APP_BOT_LOGIN, type: 'Bot' },
  }
}

export function githubActionsComment(id: number, body: string): GitHubComment {
  return {
    ...botComment(id, body),
    user: { id: 41_898_282, login: 'github-actions[bot]', type: 'Bot' },
  }
}

function graphQlActor(user: GitHubActor) {
  return {
    databaseId: user.id,
    login: user.type === 'Bot' && user.login.endsWith('[bot]')
      ? user.login.slice(0, -'[bot]'.length)
      : user.login,
    type: user.type,
  }
}

export function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0 }
}

export async function readWorkflow(): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  return readFile(resolve(root, '.github/workflows/maintainer-bot.yml'), 'utf8')
}
