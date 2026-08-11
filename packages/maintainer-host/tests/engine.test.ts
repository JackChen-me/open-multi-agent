import { describe, expect, it } from 'vitest'
import { assertNoHostCredentials, buildIsolatedModelEnvironment } from '../src/engine.js'

describe('credential-isolated model process environment', () => {
  it('allows only DeepSeek plus the minimal non-secret runtime environment', () => {
    const isolated = buildIsolatedModelEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      RUNNER_TEMP: '/tmp/runner',
      CI: 'true',
      DEEPSEEK_API_KEY: 'old-value',
      GITHUB_TOKEN: 'github-write',
      GH_TOKEN: 'github-write',
      ACTIONS_RUNTIME_TOKEN: 'actions-runtime',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-runtime',
      NPM_TOKEN: 'npm-write',
      NODE_AUTH_TOKEN: 'npm-write',
      CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: 'host-specific-write',
      MAINTAINER_BOT_APP_TOKEN: 'github-app-installation-write',
      OMA_MAINTAINER_BOT_APP_PRIVATE_KEY: 'github-app-private-key',
      SAFE_BUT_UNNEEDED: 'omit-me',
    }, 'deepseek-only')
    expect(isolated).toMatchObject({
      PATH: '/usr/bin', HOME: '/home/runner', RUNNER_TEMP: '/tmp/runner', CI: 'true',
      DEEPSEEK_API_KEY: 'deepseek-only',
    })
    for (const name of [
      'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN', 'SAFE_BUT_UNNEEDED',
      'MAINTAINER_BOT_APP_TOKEN', 'OMA_MAINTAINER_BOT_APP_PRIVATE_KEY',
    ]) expect(isolated).not.toHaveProperty(name)
    expect(() => assertNoHostCredentials(isolated)).not.toThrow()
  })

  it('fails closed if any GitHub, npm, or Actions credential is added', () => {
    expect(() => assertNoHostCredentials({
      DEEPSEEK_API_KEY: 'allowed',
      ACTIONS_RUNTIME_TOKEN: 'forbidden',
    })).toThrow(/ACTIONS_RUNTIME_TOKEN/)
  })
})
