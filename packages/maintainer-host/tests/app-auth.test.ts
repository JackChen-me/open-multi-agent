import { describe, expect, it } from 'vitest'
import { sameGitHubAppWriterIdentity, verifyGitHubAppWriter } from '../src/app-auth.js'
import {
  APP_BOT_LOGIN,
  APP_CONTRACT,
  APP_IDENTITY,
  FakeGitHub,
  REPOSITORY,
} from './helpers.js'

describe('dedicated GitHub App writer attestation', () => {
  it('verifies the token viewer, App metadata, bot user, installation, and exact repository scope', async () => {
    const identity = await verifyGitHubAppWriter({
      github: new FakeGitHub(),
      repository: REPOSITORY,
      contract: APP_CONTRACT,
    })
    expect(identity).toEqual(APP_IDENTITY)
    expect(sameGitHubAppWriterIdentity(identity, APP_IDENTITY)).toBe(true)
  })

  it('fails closed when operator enablement or pinned action outputs do not match', async () => {
    const github = new FakeGitHub()
    await expect(verifyGitHubAppWriter({
      github,
      repository: REPOSITORY,
      contract: { ...APP_CONTRACT, enabled: false },
    })).rejects.toMatchObject({ code: 'APP_WRITER_DISABLED' })
    await expect(verifyGitHubAppWriter({
      github,
      repository: REPOSITORY,
      contract: { ...APP_CONTRACT, actualSlug: 'different-app' },
    })).rejects.toMatchObject({ code: 'APP_SLUG_MISMATCH' })
    await expect(verifyGitHubAppWriter({
      github,
      repository: REPOSITORY,
      contract: { ...APP_CONTRACT, actualInstallationId: APP_CONTRACT.actualInstallationId + 1 },
    })).rejects.toMatchObject({ code: 'APP_INSTALLATION_MISMATCH' })
  })

  it('rejects a non-App-token viewer, unexpected App metadata, bot user, or repository scope', async () => {
    const wrongViewer = new FakeGitHub()
    wrongViewer.viewerLogin = 'github-actions[bot]'
    await expect(verifyGitHubAppWriter({
      github: wrongViewer,
      repository: REPOSITORY,
      contract: APP_CONTRACT,
    })).rejects.toMatchObject({ code: 'APP_TOKEN_VIEWER_MISMATCH' })

    const wrongApp = new FakeGitHub()
    wrongApp.app.clientId = 'Iv1.unexpectedApp'
    await expect(verifyGitHubAppWriter({
      github: wrongApp,
      repository: REPOSITORY,
      contract: APP_CONTRACT,
    })).rejects.toMatchObject({ code: 'APP_METADATA_MISMATCH' })

    const wrongBot = new FakeGitHub()
    wrongBot.botUser = { ...wrongBot.botUser, login: `${APP_BOT_LOGIN}-forged` }
    await expect(verifyGitHubAppWriter({
      github: wrongBot,
      repository: REPOSITORY,
      contract: APP_CONTRACT,
    })).rejects.toMatchObject({ code: 'APP_BOT_USER_MISMATCH' })

    const broadToken = new FakeGitHub()
    broadToken.installationRepositories.push('open-multi-agent/other')
    await expect(verifyGitHubAppWriter({
      github: broadToken,
      repository: REPOSITORY,
      contract: APP_CONTRACT,
    })).rejects.toMatchObject({ code: 'APP_REPOSITORY_SCOPE_MISMATCH' })
  })
})
