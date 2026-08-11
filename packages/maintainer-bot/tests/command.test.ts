import { describe, expect, it } from 'vitest'
import { assertModelCredentialIsolation } from '../src/command.js'

describe('model credential isolation', () => {
  it('rejects write credentials even when their names have a host-specific prefix', () => {
    expect(() => assertModelCredentialIsolation({
      CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: 'must-not-leak',
    })).toThrow(/CODEX_GITHUB_PERSONAL_ACCESS_TOKEN/)
    expect(() => assertModelCredentialIsolation({
      MAINTAINER_BOT_APP_TOKEN: 'must-not-leak',
      OMA_MAINTAINER_BOT_APP_PRIVATE_KEY: 'must-not-leak',
    })).toThrow(/MAINTAINER_BOT_APP_TOKEN/)
  })

  it('allows the model provider credential in an otherwise isolated environment', () => {
    expect(() => assertModelCredentialIsolation({
      DEEPSEEK_API_KEY: 'provider-only',
      PATH: '/usr/bin',
    })).not.toThrow()
  })
})
