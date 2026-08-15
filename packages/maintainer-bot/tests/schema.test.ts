import { describe, expect, it } from 'vitest'
import { modelTriageSchema, validationCommandSchema } from '../src/schema.js'
import { authorizedRequest } from './helpers.js'

function triage(overrides: Record<string, unknown> = {}) {
  const request = authorizedRequest()
  return {
    verdict: 'proceed',
    confirmedIssueRevision: request.authorization!.issueRevision,
    confirmedAcceptanceCriteria: request.issue.acceptanceCriteria,
    uncertainties: [],
    manualRiskSignals: [],
    ...overrides,
  }
}

describe('model triage schema', () => {
  it('requires proceed to contain no blocking uncertainty or manual-only risk', () => {
    expect(modelTriageSchema.parse(triage()).verdict).toBe('proceed')
    expect(() => modelTriageSchema.parse(triage({
      uncertainties: ['The acceptance criterion requires a product decision.'],
    }))).toThrow(/proceed requires empty/)
  })

  it('requires needs_human to name a concrete blocker and rejects reassuring risk text', () => {
    expect(() => modelTriageSchema.parse(triage({ verdict: 'needs_human' })))
      .toThrow(/requires at least one concrete blocking reason/)
    expect(() => modelTriageSchema.parse(triage({
      verdict: 'needs_human',
      manualRiskSignals: ['No significant risk identified.'],
    }))).toThrow(/must not contain reassuring/)
    expect(modelTriageSchema.parse(triage({
      verdict: 'needs_human',
      uncertainties: ['The issue leaves the public API shape undecided.'],
    })).verdict).toBe('needs_human')
  })
})

describe('validation command schema', () => {
  it('allows non-secret trusted environment controls and rejects credential overrides', () => {
    expect(validationCommandSchema.parse({
      id: 'ambient-test', command: 'npm', args: ['test'], env: { OMA_MODEL: 'ambient-model' },
      unsetEnv: ['OMA_MODEL_FALLBACK'],
    }).env).toEqual({ OMA_MODEL: 'ambient-model' })
    expect(() => validationCommandSchema.parse({
      id: 'unsafe-test', command: 'npm', args: ['test'], env: { GITHUB_TOKEN: 'value' },
    })).toThrow(/credential-like/)
  })

  it('rejects removed scratch-path exceptions and other unknown command controls', () => {
    expect(validationCommandSchema.parse({
      id: 'no-output', command: 'git', args: ['diff', '--check'],
    })).not.toHaveProperty('scratchPaths')
    expect(() => validationCommandSchema.parse({
      id: 'otel-build', command: 'npm', args: ['run', 'build'],
      scratchPaths: ['packages/otel/dist'],
    })).toThrow(/Unrecognized key/)
  })
})
