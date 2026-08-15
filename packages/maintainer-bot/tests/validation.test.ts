import { describe, expect, it } from 'vitest'
import { allValidationsPassed, runRegisteredValidations } from '../src/validation.js'
import { ScriptedCommandRunner, testConfig } from './helpers.js'

describe('pre-registered deterministic validation runner', () => {
  it('runs the exact configured argv without shell and strips credentials', async () => {
    const runner = new ScriptedCommandRunner(() => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }))
    const results = await runRegisteredValidations({
      repoRoot: '/tmp/repository',
      config: testConfig(),
      runner,
      env: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'must-not-leak',
        MAINTAINER_BOT_APP_TOKEN: 'must-not-leak',
        OMA_MAINTAINER_BOT_APP_PRIVATE_KEY: 'must-not-leak',
        DEEPSEEK_API_KEY: 'must-not-leak',
        SAFE_VALUE: 'kept',
      },
      now: (() => { let value = 0; return () => value += 5 })(),
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: 'fixture-test', success: true, durationMs: 5 })
    expect(runner.calls[0]?.command).toBe('npm')
    expect(runner.calls[0]?.args).toEqual(['test', '-w', '@fixture/demo'])
    expect(runner.calls[0]?.options.env).toMatchObject({ PATH: '/usr/bin', SAFE_VALUE: 'kept' })
    expect(runner.calls[0]?.options.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(runner.calls[0]?.options.env).not.toHaveProperty('MAINTAINER_BOT_APP_TOKEN')
    expect(runner.calls[0]?.options.env).not.toHaveProperty('OMA_MAINTAINER_BOT_APP_PRIVATE_KEY')
    expect(runner.calls[0]?.options.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(allValidationsPassed(results)).toBe(true)
  })

  it('records failures as evidence and does not convert them to exceptions', async () => {
    const runner = new ScriptedCommandRunner(() => ({ stdout: '', stderr: 'failed', exitCode: 2 }))
    const results = await runRegisteredValidations({
      repoRoot: '/tmp/repository',
      config: testConfig(),
      runner,
      env: { PATH: '/usr/bin' },
    })
    expect(results[0]).toMatchObject({ success: false, exitCode: 2, stderr: 'failed' })
    expect(allValidationsPassed(results)).toBe(false)
  })

  it('treats truncated output as an unsafe validation result', async () => {
    const runner = new ScriptedCommandRunner(() => ({ stdout: 'x'.repeat(60_000), stderr: '', exitCode: 0 }))
    const results = await runRegisteredValidations({
      repoRoot: '/tmp/repository',
      config: testConfig(),
      runner,
      env: { PATH: '/usr/bin' },
    })
    expect(results[0]?.truncated).toBe(true)
    expect(allValidationsPassed(results)).toBe(false)
  })

  it('applies trusted per-command environment overrides and unsets after credential stripping', async () => {
    const runner = new ScriptedCommandRunner(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    const config = testConfig({
      validationCommands: [{
        id: 'ambient-test',
        command: 'npm',
        args: ['test'],
        cwd: '.',
        timeoutMs: 10_000,
        env: { OMA_MODEL: 'ambient-model' },
        unsetEnv: ['INHERITED_MODEL'],
      }],
    })
    const results = await runRegisteredValidations({
      repoRoot: '/tmp/repository',
      config,
      runner,
      env: {
        PATH: '/usr/bin',
        INHERITED_MODEL: 'remove-me',
        GITHUB_TOKEN: 'remove-me-too',
      },
    })
    expect(runner.calls[0]?.options.env).toMatchObject({ PATH: '/usr/bin', OMA_MODEL: 'ambient-model' })
    expect(runner.calls[0]?.options.env).not.toHaveProperty('INHERITED_MODEL')
    expect(runner.calls[0]?.options.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(results[0]?.environment).toEqual({
      set: [{ name: 'OMA_MODEL', value: 'ambient-model' }],
      unset: ['INHERITED_MODEL'],
    })
  })
})
