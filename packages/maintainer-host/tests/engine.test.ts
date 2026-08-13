import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoHostCredentials, buildIsolatedModelEnvironment, runIsolatedEngine } from '../src/engine.js'
import { APP_IDENTITY } from './helpers.js'

describe('credential-isolated model process environment', () => {
  it('keeps the provider key out of the child environment and allows only minimal non-secret runtime values', () => {
    const isolated = buildIsolatedModelEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      RUNNER_TEMP: '/tmp/runner',
      npm_config_cache: '/tmp/npm-cache',
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
    expect(isolated).toMatchObject({ PATH: '/usr/bin', HOME: '/home/runner', CI: 'true' })
    for (const name of [
      'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN', 'SAFE_BUT_UNNEEDED',
      'MAINTAINER_BOT_APP_TOKEN', 'OMA_MAINTAINER_BOT_APP_PRIVATE_KEY',
      'DEEPSEEK_API_KEY', 'RUNNER_TEMP', 'npm_config_cache',
    ]) expect(isolated).not.toHaveProperty(name)
    expect(() => assertNoHostCredentials(isolated)).not.toThrow()
  })

  it('fails closed if any GitHub, npm, or Actions credential is added', () => {
    expect(() => assertNoHostCredentials({
      DEEPSEEK_API_KEY: 'forbidden-in-environment',
      ACTIONS_RUNTIME_TOKEN: 'forbidden',
    })).toThrow(/ACTIONS_RUNTIME_TOKEN|DEEPSEEK_API_KEY/)
  })

  it('does not invoke the model process for a non-runnable policy terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oma-maintainer-engine-skip-'))
    const activationPath = join(root, 'activation.json')
    const resultPath = join(root, 'engine-result.json')
    const detail = 'The requested target path is blocked by repository production policy. The model was not run.'
    await writeFile(activationPath, JSON.stringify({
      schemaVersion: 1,
      shouldRun: false,
      claimId: '104.1',
      actionsRunId: 104,
      runUrl: 'https://github.com/open-multi-agent/open-multi-agent/actions/runs/104',
      commentId: 1,
      branch: null,
      writerIdentity: APP_IDENTITY,
      removedBootstrapCommentCount: 0,
      request: null,
      config: null,
      admission: null,
      status: 'NEEDS_HUMAN',
      detail,
    }))

    const result = await runIsolatedEngine({
      activationPath,
      resultPath,
      repoRoot: root,
      stateDir: join(root, 'state'),
      artifactDir: join(root, 'artifacts'),
      maintainerBotCli: join(root, 'must-not-be-invoked.js'),
    })
    expect(result).toEqual({
      schemaVersion: 1,
      attempted: false,
      exitCode: 0,
      status: 'NEEDS_HUMAN',
      detail,
    })
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual(result)
  })
})
