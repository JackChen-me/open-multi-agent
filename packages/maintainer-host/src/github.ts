import { z } from 'zod'
import {
  githubActionsRunSchema,
  githubActorSchema,
  githubCommentSchema,
  githubIssueSchema,
  githubPullRequestSchema,
  githubTimelineEventSchema,
  type GitHubActionsRun,
  type GitHubActor,
  type GitHubComment,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubTimelineEvent,
} from './schema.js'

const permissionSchema = z.object({
  permission: z.enum(['admin', 'maintain', 'write', 'triage', 'read', 'none']),
})
const branchSchema = z.object({ commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) })
const repositorySchema = z.object({ default_branch: z.string().min(1), full_name: z.string() })
const githubAppSchema = z.object({
  id: z.number().int().positive(),
  client_id: z.string().min(1),
  slug: z.string().min(1),
})
const installationRepositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.object({ full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/) })),
})
const viewerSchema = z.object({
  data: z.object({ viewer: z.object({ login: z.string().min(1) }) }),
})
const issueCommentActorSchema = z.object({
  __typename: z.string().min(1),
  login: z.string().min(1),
  databaseId: z.number().int().positive().optional(),
})
const issueCommentAuthorshipSchema = z.object({
  data: z.object({
    node: z.object({
      author: issueCommentActorSchema.nullable(),
      editor: issueCommentActorSchema.nullable(),
      createdViaEmail: z.boolean(),
    }).nullable(),
  }),
})

export interface GitHubIssueCommentActor {
  readonly databaseId: number | null
  readonly login: string
  readonly type: string
}

export interface GitHubIssueCommentAuthorship {
  readonly author: GitHubIssueCommentActor | null
  readonly editor: GitHubIssueCommentActor | null
  readonly createdViaEmail: boolean
}

export interface GitHubClient {
  getAuthenticatedViewerLogin(): Promise<string>
  getApp(appSlug: string): Promise<{ id: number; clientId: string; slug: string }>
  getUser(login: string): Promise<GitHubActor>
  listInstallationRepositories(): Promise<string[]>
  getIssueCommentAuthorship(nodeId: string): Promise<GitHubIssueCommentAuthorship>
  getRepository(repository: string): Promise<{ defaultBranch: string; fullName: string }>
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>
  listIssueComments(repository: string, issueNumber: number): Promise<GitHubComment[]>
  listIssueTimeline(repository: string, issueNumber: number): Promise<GitHubTimelineEvent[]>
  getCollaboratorPermission(repository: string, login: string): Promise<'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'>
  getBranchSha(repository: string, branch: string): Promise<string | null>
  getActionsRun(repository: string, runId: number): Promise<GitHubActionsRun | null>
  createIssueComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment>
  updateIssueComment(repository: string, commentId: number, body: string): Promise<GitHubComment>
  listPullRequestsForHead(repository: string, head: string): Promise<GitHubPullRequest[]>
  createDraftPullRequest(input: {
    repository: string
    title: string
    body: string
    head: string
    base: string
  }): Promise<GitHubPullRequest>
}

export class GitHubApiError extends Error {
  readonly status: number

  constructor(status: number, method: string, path: string) {
    super(`GitHub API request failed (${status}) for ${method} ${path}.`)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

export class GitHubRestClient implements GitHubClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: { token: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    if (options.token.length < 10) throw new Error('GitHub host token is missing or invalid.')
    this.token = options.token
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async getAuthenticatedViewerLogin(): Promise<string> {
    const result = viewerSchema.parse(await this.request('POST', '/graphql', {
      query: 'query { viewer { login } }',
    }))
    return result.data.viewer.login
  }

  async getApp(appSlug: string): Promise<{ id: number; clientId: string; slug: string }> {
    const result = githubAppSchema.parse(await this.request('GET', `/apps/${encodeURIComponent(appSlug)}`))
    return { id: result.id, clientId: result.client_id, slug: result.slug }
  }

  async getUser(login: string): Promise<GitHubActor> {
    return githubActorSchema.parse(await this.request('GET', `/users/${encodeURIComponent(login)}`))
  }

  async listInstallationRepositories(): Promise<string[]> {
    const result = installationRepositoriesSchema.parse(await this.request(
      'GET',
      '/installation/repositories?per_page=100',
    ))
    if (result.total_count !== result.repositories.length) {
      throw new Error('GitHub App installation token repository scope exceeds the deterministic 100-item limit.')
    }
    return result.repositories.map(repository => repository.full_name).sort()
  }

  async getIssueCommentAuthorship(nodeId: string): Promise<GitHubIssueCommentAuthorship> {
    const result = issueCommentAuthorshipSchema.parse(await this.request('POST', '/graphql', {
      query: `query OMAStatusCommentAuthorship($id: ID!) {
        node(id: $id) {
          ... on IssueComment {
            author { __typename login ... on Bot { databaseId } }
            editor { __typename login ... on Bot { databaseId } }
            createdViaEmail
          }
        }
      }`,
      variables: { id: nodeId },
    }))
    if (result.data.node === null) throw new Error('Trusted Maintainer Bot status comment no longer exists.')
    return {
      author: issueCommentActor(result.data.node.author),
      editor: issueCommentActor(result.data.node.editor),
      createdViaEmail: result.data.node.createdViaEmail,
    }
  }

  async getRepository(repository: string): Promise<{ defaultBranch: string; fullName: string }> {
    const result = repositorySchema.parse(await this.request('GET', `/repos/${repo(repository)}`))
    return { defaultBranch: result.default_branch, fullName: result.full_name }
  }

  async getIssue(repository: string, issueNumber: number): Promise<GitHubIssue> {
    return githubIssueSchema.parse(await this.request('GET', `/repos/${repo(repository)}/issues/${issueNumber}`))
  }

  async listIssueComments(repository: string, issueNumber: number): Promise<GitHubComment[]> {
    return githubCommentSchema.array().parse(await this.paginate(`/repos/${repo(repository)}/issues/${issueNumber}/comments`))
  }

  async listIssueTimeline(repository: string, issueNumber: number): Promise<GitHubTimelineEvent[]> {
    return githubTimelineEventSchema.array().parse(await this.paginate(
      `/repos/${repo(repository)}/issues/${issueNumber}/timeline`,
      'application/vnd.github+json',
    ))
  }

  async getCollaboratorPermission(
    repository: string,
    login: string,
  ): Promise<'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'> {
    const result = permissionSchema.parse(await this.request(
      'GET',
      `/repos/${repo(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
    ))
    return result.permission
  }

  async getBranchSha(repository: string, branch: string): Promise<string | null> {
    try {
      const result = branchSchema.parse(await this.request(
        'GET',
        `/repos/${repo(repository)}/branches/${encodeURIComponent(branch)}`,
      ))
      return result.commit.sha
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null
      throw error
    }
  }

  async getActionsRun(repository: string, runId: number): Promise<GitHubActionsRun | null> {
    try {
      return githubActionsRunSchema.parse(await this.request(
        'GET',
        `/repos/${repo(repository)}/actions/runs/${runId}`,
      ))
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null
      throw error
    }
  }

  async createIssueComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment> {
    return githubCommentSchema.parse(await this.request(
      'POST',
      `/repos/${repo(repository)}/issues/${issueNumber}/comments`,
      { body },
    ))
  }

  async updateIssueComment(repository: string, commentId: number, body: string): Promise<GitHubComment> {
    return githubCommentSchema.parse(await this.request(
      'PATCH',
      `/repos/${repo(repository)}/issues/comments/${commentId}`,
      { body },
    ))
  }

  async listPullRequestsForHead(repository: string, head: string): Promise<GitHubPullRequest[]> {
    const [owner] = splitRepository(repository)
    const query = new URLSearchParams({ state: 'all', head: `${owner}:${head}`, per_page: '100' })
    return githubPullRequestSchema.array().parse(await this.request(
      'GET',
      `/repos/${repo(repository)}/pulls?${query.toString()}`,
    ))
  }

  async createDraftPullRequest(input: {
    repository: string
    title: string
    body: string
    head: string
    base: string
  }): Promise<GitHubPullRequest> {
    return githubPullRequestSchema.parse(await this.request(
      'POST',
      `/repos/${repo(input.repository)}/pulls`,
      { title: input.title, body: input.body, head: input.head, base: input.base, draft: true },
    ))
  }

  private async paginate(path: string, accept = 'application/vnd.github+json'): Promise<unknown[]> {
    const all: unknown[] = []
    for (let page = 1; page <= 10; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const value = await this.request('GET', `${path}${separator}per_page=100&page=${page}`, undefined, accept)
      if (!Array.isArray(value)) throw new Error(`GitHub API pagination expected an array for ${path}.`)
      all.push(...value)
      if (value.length < 100) return all
    }
    throw new Error(`GitHub API pagination exceeded the deterministic 1000-item limit for ${path}.`)
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'oma-maintainer-host-v1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new GitHubApiError(response.status, method, path.replace(/\?.*$/, ''))
    return response.status === 204 ? null : response.json()
  }
}

function issueCommentActor(
  actor: z.infer<typeof issueCommentActorSchema> | null,
): GitHubIssueCommentActor | null {
  if (actor === null) return null
  return {
    databaseId: actor.databaseId ?? null,
    login: actor.login,
    type: actor.__typename,
  }
}

function repo(repository: string): string {
  const [owner, name] = splitRepository(repository)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function splitRepository(repository: string): [string, string] {
  const parts = repository.split('/')
  if (parts.length !== 2 || parts.some(part => !part)) throw new Error(`Invalid GitHub repository: ${repository}`)
  return [parts[0]!, parts[1]!]
}
