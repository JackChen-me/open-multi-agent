import { describe, expect, it } from 'vitest'
import {
  buildProductionConfig,
  deriveRiskFlags,
  resolveTargetWorkspaces,
} from '../src/policy.js'
import { productionPolicySchema } from '../src/schema.js'
import { productionPolicy } from './helpers.js'

function riskInput(
  policy: Awaited<ReturnType<typeof productionPolicy>>,
  overrides: Partial<Parameters<typeof deriveRiskFlags>[0]> = {},
): Parameters<typeof deriveRiskFlags>[0] {
  return {
    policy,
    targetPaths: ['packages/otel/README.md'],
    targetWorkspaces: ['@open-multi-agent/otel'],
    title: 'Fix documentation wording',
    problem: 'The wording is unclear.',
    currentBehavior: 'Readers see unclear wording.',
    expectedBehavior: 'The wording is precise.',
    acceptanceCriteria: ['The wording is updated.'],
    labels: [],
    ...overrides,
  }
}

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
    expect(deriveRiskFlags(riskInput(policy, {
      targetPaths: ['.github/workflows/ci.yml'],
      targetWorkspaces: ['repository-control-plane'],
      title: 'Update CI', problem: 'Change CI behavior.',
    }))).toContain('ci')
    expect(deriveRiskFlags(riskInput(policy, {
      targetPaths: ['packages/core/src/index.ts'],
      targetWorkspaces: ['@open-multi-agent/core'],
      title: 'Change exports', problem: 'Change an export.',
    }))).toContain('public-api-major')
    expect(deriveRiskFlags(riskInput(policy, {
      targetPaths: ['packages/core/tests/a.test.ts', 'packages/otel/tests/b.test.ts'],
      targetWorkspaces: ['@open-multi-agent/core', '@open-multi-agent/otel'],
      title: 'Refactor tests', problem: 'Refactor tests.',
    }))).toContain('cross-workspace-refactor')
    expect(deriveRiskFlags(riskInput(policy, {
      targetPaths: ['.git/config'],
      targetWorkspaces: ['repository-control-plane'],
      title: 'Change local repository config', problem: 'Change the file.',
    }))).toContain('permissions')
  })

  it('does not infer manual risk from ordinary sensitive-file references', async () => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags(riskInput(policy, {
      problem: 'The package publishes `dist`, `README.md`, and `LICENSE`.',
      currentBehavior: 'The README links to `SECURITY.md`.',
      expectedBehavior: 'Use canonical repository links.',
    }))).toEqual([])
  })

  it.each([
    ['request in the next sentence', 'The package contains README.md. Amend LICENSE.'],
    ['request after a semicolon', 'The package publishes README.md; relicense under MIT.'],
    ['sensitive-only inventory', 'The package ships LICENSE.'],
    ['modal inventory', 'The package should ship `README.md` and `LICENSE`.'],
    ['unknown inventory suffix', 'The package ships `README.md` and `LICENSE` changes.'],
  ])('keeps %s license-sensitive', async (_case, problem) => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags(riskInput(policy, { problem }))).toContain('license')
  })

  it.each([
    ['expected', { expectedBehavior: 'The package ships LICENSE.' }],
    ['acceptance', { acceptanceCriteria: ['The artifact contains `README.md` and `LICENSE`.'] }],
  ] as const)('does not apply inventory masking to %s intent', async (_case, overrides) => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags(riskInput(policy, overrides))).toContain('license')
  })

  it.each([
    ['title', { title: 'Update the license' }, 'license'],
    ['problem', { problem: 'Change security authorization behavior.' }, 'security'],
    ['expected', { expectedBehavior: 'Personal data privacy handling changes.' }, 'privacy'],
    ['acceptance', { acceptanceCriteria: ['Publishing requires release deployment.'] }, 'release'],
    ['label', { labels: ['permissions'] }, 'permissions'],
  ] as const)('keeps real %s intent manual-only', async (_source, overrides, expected) => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags(riskInput(policy, overrides))).toContain(expected)
  })

  it.each([
    ['inline code request', 'Change `LICENSE`.', ['license']],
    ['inline filename plus permission request', 'Update `SECURITY.md` permissions.', ['permissions', 'security']],
    ['fenced request', '```text\nChange LICENSE, permissions, and security.\n```', ['license', 'permissions', 'security']],
    ['request after a fence', '```text\nordinary example\n```\nChange privacy before release.', ['privacy', 'release']],
  ] as const)('does not let %s bypass risk scanning', async (_case, problem, expected) => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags(riskInput(policy, { problem }))).toEqual(expect.arrayContaining(expected))
  })

  it.each([
    ['LICENSE', 'license'],
    ['SECURITY.md', 'security'],
    ['.github/workflows/ci.yml', 'ci'],
  ] as const)('preserves the hard risk for target path %s', async (targetPath, expected) => {
    const policy = await productionPolicy()
    expect(deriveRiskFlags(riskInput(policy, {
      targetPaths: [targetPath],
      targetWorkspaces: ['repository-control-plane'],
    }))).toContain(expected)
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

  it('uses Claude Code by default and can roll back to the legacy engine', async () => {
    const policy = await productionPolicy()
    const path = 'packages/core/tests/subpath-exports.test.ts'
    expect(buildProductionConfig(policy, [path]).executionBackend).toBe('claude-code')
    const legacyPolicy = productionPolicySchema.parse({ ...policy, executionBackend: 'legacy' })
    expect(buildProductionConfig(legacyPolicy, [path]).executionBackend).toBe('legacy')
    expect(() => productionPolicySchema.parse({ ...policy, executionBackend: 'both' })).toThrow()
  })
})
