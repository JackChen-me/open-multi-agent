import type { GitHubClient } from './github.js'
import {
  githubAppWriterContractSchema,
  githubAppWriterIdentitySchema,
  type GitHubAppWriterContract,
  type GitHubAppWriterIdentity,
} from './schema.js'

export class GitHubAppWriterError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GitHubAppWriterError'
    this.code = code
  }
}

export async function verifyGitHubAppWriter(input: {
  readonly github: GitHubClient
  readonly repository: string
  readonly contract: GitHubAppWriterContract
}): Promise<GitHubAppWriterIdentity> {
  const contract = githubAppWriterContractSchema.parse(input.contract)
  if (!contract.enabled) {
    throw new GitHubAppWriterError(
      'APP_WRITER_DISABLED',
      'The dedicated Maintainer Bot GitHub App writer is not explicitly enabled.',
    )
  }
  if (contract.actualSlug !== contract.expectedSlug) {
    throw new GitHubAppWriterError(
      'APP_SLUG_MISMATCH',
      'The minted GitHub App token slug does not match the trusted Maintainer Bot App contract.',
    )
  }
  if (contract.actualInstallationId !== contract.expectedInstallationId) {
    throw new GitHubAppWriterError(
      'APP_INSTALLATION_MISMATCH',
      'The minted GitHub App installation does not match the trusted Maintainer Bot App contract.',
    )
  }

  const botLogin = `${contract.expectedSlug}[bot]`
  const [viewerLogin, app, botUser, repositories] = await Promise.all([
    input.github.getAuthenticatedViewerLogin(),
    input.github.getApp(contract.expectedSlug),
    input.github.getUser(botLogin),
    input.github.listInstallationRepositories(),
  ])
  if (viewerLogin !== botLogin) {
    throw new GitHubAppWriterError(
      'APP_TOKEN_VIEWER_MISMATCH',
      'The authenticated GitHub token is not the expected Maintainer Bot App installation identity.',
    )
  }
  if (
    app.id !== contract.expectedAppId
    || app.clientId !== contract.expectedClientId
    || app.slug !== contract.expectedSlug
  ) {
    throw new GitHubAppWriterError(
      'APP_METADATA_MISMATCH',
      'GitHub App metadata does not match the trusted Maintainer Bot App ID, client ID, and slug.',
    )
  }
  if (
    botUser.id !== contract.expectedBotUserId
    || botUser.login !== botLogin
    || botUser.type !== 'Bot'
  ) {
    throw new GitHubAppWriterError(
      'APP_BOT_USER_MISMATCH',
      'The GitHub App bot user does not match the trusted Maintainer Bot App identity.',
    )
  }
  if (repositories.length !== 1 || repositories[0] !== input.repository) {
    throw new GitHubAppWriterError(
      'APP_REPOSITORY_SCOPE_MISMATCH',
      'The GitHub App installation token is not scoped to exactly the canonical repository.',
    )
  }
  return githubAppWriterIdentitySchema.parse({
    appId: app.id,
    clientId: app.clientId,
    slug: app.slug,
    installationId: contract.actualInstallationId,
    botUserId: botUser.id,
    botLogin: botUser.login,
  })
}

export function sameGitHubAppWriterIdentity(
  left: GitHubAppWriterIdentity,
  right: GitHubAppWriterIdentity,
): boolean {
  return left.appId === right.appId
    && left.clientId === right.clientId
    && left.slug === right.slug
    && left.installationId === right.installationId
    && left.botUserId === right.botUserId
    && left.botLogin === right.botLogin
}
