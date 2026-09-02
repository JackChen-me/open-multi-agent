export interface GitHubPullRequest {
  readonly number: number
  readonly htmlUrl: string
  readonly headRef: string
  readonly baseRef: string
  readonly title: string
}

export interface GitHubRelease {
  readonly id: number
  readonly htmlUrl: string
  readonly tagName: string
}

export interface CreatePullRequestInput {
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly draft?: boolean
}

export interface CreateReleaseInput {
  readonly tagName: string
  readonly targetCommitish: string
  readonly name: string
  readonly body: string
}

export interface GitHubClient {
  listOpenPullRequests(base: string): Promise<readonly GitHubPullRequest[]>
  getBranchSha(branch: string): Promise<string | null>
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>
  getReleaseByTag(tag: string): Promise<GitHubRelease | null>
  createRelease(input: CreateReleaseInput): Promise<GitHubRelease>
  /** The GitHub login linked to a commit, or null when no account claims it. */
  getCommitAuthorLogin(sha: string): Promise<string | null>
}

interface PullResponse {
  number: number
  html_url: string
  title: string
  head: { ref: string }
  base: { ref: string }
}

interface ReleaseResponse {
  id: number
  html_url: string
  tag_name: string
}

interface RefResponse {
  object: { sha: string }
}

interface CommitResponse {
  author: { login: string } | null
}

export class GitHubApiClient implements GitHubClient {
  private readonly apiBase: string

  constructor(
    private readonly repository: string,
    private readonly token: string,
    apiBase = 'https://api.github.com',
  ) {
    if (!/^[^/]+\/[^/]+$/.test(repository)) {
      throw new Error(`Expected GitHub repository as owner/name, got "${repository}".`)
    }
    if (!token) throw new Error('GitHub token is required.')
    this.apiBase = apiBase.replace(/\/$/, '')
  }

  async listOpenPullRequests(base: string): Promise<readonly GitHubPullRequest[]> {
    const params = new URLSearchParams({ state: 'open', base, per_page: '100' })
    const response = await this.request<PullResponse[]>(`/repos/${this.repository}/pulls?${params}`)
    return response.map(pull => ({
      number: pull.number,
      htmlUrl: pull.html_url,
      headRef: pull.head.ref,
      baseRef: pull.base.ref,
      title: pull.title,
    }))
  }

  async getBranchSha(branch: string): Promise<string | null> {
    const response = await this.rawRequest(
      `/repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    )
    if (response.status === 404) return null
    if (!response.ok) await throwGitHubError(response)
    return (await response.json() as RefResponse).object.sha
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const pull = await this.request<PullResponse>(`/repos/${this.repository}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
      }),
    })
    return {
      number: pull.number,
      htmlUrl: pull.html_url,
      headRef: pull.head.ref,
      baseRef: pull.base.ref,
      title: pull.title,
    }
  }

  async getReleaseByTag(tag: string): Promise<GitHubRelease | null> {
    const response = await this.rawRequest(
      `/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`,
    )
    if (response.status === 404) return null
    if (!response.ok) await throwGitHubError(response)
    return mapRelease(await response.json() as ReleaseResponse)
  }

  async createRelease(input: CreateReleaseInput): Promise<GitHubRelease> {
    const release = await this.request<ReleaseResponse>(`/repos/${this.repository}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: input.tagName,
        target_commitish: input.targetCommitish,
        name: input.name,
        body: input.body,
        draft: false,
        prerelease: false,
      }),
    })
    return mapRelease(release)
  }

  async getCommitAuthorLogin(sha: string): Promise<string | null> {
    const response = await this.rawRequest(
      `/repos/${this.repository}/commits/${encodeURIComponent(sha)}`,
    )
    if (response.status === 404) return null
    if (!response.ok) await throwGitHubError(response)
    // A commit whose email is not linked to any account has a null author.
    return (await response.json() as CommitResponse).author?.login ?? null
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.rawRequest(path, init)
    if (!response.ok) await throwGitHubError(response)
    return await response.json() as T
  }

  private async rawRequest(path: string, init?: RequestInit): Promise<Response> {
    return await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'user-agent': 'oma-release-bot',
        'x-github-api-version': '2026-03-10',
        ...init?.headers,
      },
    })
  }
}

function mapRelease(release: ReleaseResponse): GitHubRelease {
  return {
    id: release.id,
    htmlUrl: release.html_url,
    tagName: release.tag_name,
  }
}

async function throwGitHubError(response: Response): Promise<never> {
  const body = (await response.text()).slice(0, 2_000)
  throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`)
}
