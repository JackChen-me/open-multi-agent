import { describe, expect, it } from 'vitest'
import {
  buildProductionConfig,
  deriveRiskFlags,
  resolveTargetWorkspaces,
} from '../src/policy.js'
import { productionPolicySchema } from '../src/schema.js'
import { productionPolicy } from './helpers.js'

describe('trusted production policy and command registry', () => {
  it('accepts #488 as an exact create-oma-app file scope with trusted ambient and clean validations', async () => {
    const policy = await productionPolicy()
    const path = 'packages/create-oma-app/tests/runtime.test.ts'
    expect(resolveTargetWorkspaces(policy, [path])).toEqual(['create-oma-app'])
    const config = buildProductionConfig(policy, [path])
    expect(config.allowedPaths).not.toEqual(['packages/maintainer-bot'])
    expect(config.validationCommands.map(command => command.id)).toEqual([
      'git-diff-check',
      'create-lint',
      'create-test',
      'create-template-typecheck',
      'create-runtime-ambient',
      'create-runtime-clean',
    ])
    expect(config.validationCommands.find(command => command.id === 'create-runtime-ambient')?.env)
      .toEqual({ OMA_MODEL: 'ambient-model' })
    expect(config.validationCommands.find(command => command.id === 'create-runtime-clean')?.unsetEnv)
      .toEqual(['OMA_MODEL'])
  })

  it('accepts only the enumerated OTel README and selects the full OTel validation suite', async () => {
    const policy = await productionPolicy()
    const path = 'packages/otel/README.md'
    expect(resolveTargetWorkspaces(policy, [path])).toEqual(['@open-multi-agent/otel'])
    expect(buildProductionConfig(policy, [path]).validationCommands.map(command => command.id)).toEqual([
      'git-diff-check',
      'otel-lint',
      'otel-test',
      'otel-build',
    ])

    expect(() => resolveTargetWorkspaces(policy, ['packages/otel/package.json']))
      .toThrow(/outside the trusted production allowlist/)
    expect(() => resolveTargetWorkspaces(policy, ['packages/otel/CHANGELOG.md']))
      .toThrow(/outside the trusted production allowlist/)
  })

  it('routes workflow, permission, public-entry, and cross-workspace requests to manual risks', async () => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags({
      policy,
      targetPaths: ['.github/workflows/ci.yml'],
      targetWorkspaces: ['repository-control-plane'],
      title: 'Update CI', body: 'Change CI behavior.', labels: [],
    })).toContain('ci')
    expect(deriveRiskFlags({
      policy,
      targetPaths: ['packages/core/src/index.ts'],
      targetWorkspaces: ['@open-multi-agent/core'],
      title: 'Change exports', body: 'Change an export.', labels: [],
    })).toContain('public-api-major')
    expect(deriveRiskFlags({
      policy,
      targetPaths: ['packages/core/tests/a.test.ts', 'packages/otel/tests/b.test.ts'],
      targetWorkspaces: ['@open-multi-agent/core', '@open-multi-agent/otel'],
      title: 'Refactor tests', body: 'Refactor tests.', labels: [],
    })).toContain('cross-workspace-refactor')
    expect(deriveRiskFlags({
      policy,
      targetPaths: ['.git/config'],
      targetWorkspaces: ['repository-control-plane'],
      title: 'Change local repository config', body: 'Change the file.', labels: [],
    })).toContain('permissions')
  })

  it('rejects paths that trusted repository policy never permits', async () => {
    const policy = await productionPolicy()
    expect(() => resolveTargetWorkspaces(policy, ['scripts/untrusted.sh'])).toThrow(/outside the trusted production allowlist/)
    expect(() => buildProductionConfig(policy, ['.github/workflows/ci.yml'])).toThrow(/protected|manual-only/)
  })

  it('rejects non-canonical, globbed, and duplicate trusted policy paths', async () => {
    const policy = await productionPolicy()
    expect(() => productionPolicySchema.parse({ ...policy, allowedPaths: ['packages//core'] }))
      .toThrow(/canonical normalized form/)
    expect(() => productionPolicySchema.parse({ ...policy, allowedPaths: ['packages/*'] }))
      .toThrow(/literal, not globs/)
    expect(() => productionPolicySchema.parse({ ...policy, allowedPaths: ['packages/core', 'packages/core'] }))
      .toThrow(/allowed paths must be unique/)
  })

  it('uses one mutually exclusive backend selector and can roll back to the legacy engine', async () => {
    const policy = await productionPolicy()
    const path = 'packages/core/tests/subpath-exports.test.ts'
    expect(buildProductionConfig(policy, [path]).executionBackend).toBe('legacy')
    const claudePolicy = productionPolicySchema.parse({ ...policy, executionBackend: 'claude-code' })
    expect(buildProductionConfig(claudePolicy, [path]).executionBackend).toBe('claude-code')
    expect(() => productionPolicySchema.parse({ ...policy, executionBackend: 'both' })).toThrow()
  })
})
