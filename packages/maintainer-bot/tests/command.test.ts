import { describe, expect, it } from 'vitest'
import { assertModelCredentialIsolation, canonicalGitDiffArgs } from '../src/command.js'

describe('canonical Git diff arguments', () => {
  it('pins the patch representation used across checkout boundaries', () => {
    expect(canonicalGitDiffArgs({
      baseSha: 'a'.repeat(40),
      paths: ['packages/core/src/index.ts', 'packages/core/tests/subpath-exports.test.ts'],
    })).toEqual([
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-color',
      '--no-renames',
      '--no-textconv',
      '--full-index',
      '--unified=5',
      '--no-indent-heuristic',
      '--diff-algorithm=myers',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'a'.repeat(40),
      '--',
      'packages/core/src/index.ts',
      'packages/core/tests/subpath-exports.test.ts',
    ])
  })

  it('rejects an empty path set instead of widening the diff', () => {
    expect(() => canonicalGitDiffArgs({ paths: [] })).toThrow(/at least one path/)
  })
})

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
