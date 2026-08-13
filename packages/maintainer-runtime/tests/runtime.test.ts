import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fstatSync, openSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  canonicalGitDiffArgs,
  maintainerRuntimeCodingContractSchema,
  maintainerRuntimeCodingResultSchema,
  maintainerRuntimeValidationContractSchema,
  maintainerRuntimeValidationResultSchema,
  type CommandResult,
} from '@open-multi-agent/maintainer-bot'
import {
  assertHarnessCredentialIsolation,
  BoundedProcessError,
  BoundedProcessRunner,
  buildValidationSandboxInvocation,
  buildHarnessEnvironment,
  buildHarnessSettings,
  cleanupValidationWorkspace,
  createValidationWorkspace,
  preflightValidationSandbox,
  readProviderKeyFromFd,
  runProductionClaudeCodeBackend,
  runProductionSandboxValidation,
  takeProductionProviderKey,
  VALIDATION_HOSTS,
  ValidationSandboxPreflightError,
  type BoundedProcessRunOptions,
  type SandboxProcessRunner,
} from '../src/index.js'

const exec = promisify(execFile)
const TARGET = 'packages/example/candidate.txt'
const NEW_TARGET = 'packages/example/new-candidate.txt'
const FAKE_KEY = 'fake-provider-key-for-runtime-tests'

for (const name of [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
]) delete process.env[name]

class MockBubblewrapRunner implements SandboxProcessRunner {
  readonly roots: string[] = []

  async run(
    command: string,
    args: readonly string[],
    options: BoundedProcessRunOptions,
  ): Promise<CommandResult> {
    expect(command).toBe('/usr/bin/bwrap')
    expect(options).toMatchObject({ cwd: '/', env: {} })
    expect(args).toEqual(expect.arrayContaining([
      '--unshare-net', '--cap-drop', 'ALL', '--clearenv',
    ]))
    const bindIndex = args.findIndex((value, index) => value === '--bind' && args[index + 2] === '/workspace')
    expect(bindIndex).toBeGreaterThanOrEqual(0)
    const root = args[bindIndex + 1]!
    this.roots.push(root)
    expect(['base\n', 'candidate\n']).toContain(await readFile(join(root, TARGET), 'utf8'))
    await mkdir(join(root, '.ephemeral-output'), { recursive: true })
    await writeFile(join(root, '.ephemeral-output', 'result.txt'), 'discarded\n')
    return { stdout: 'mock validation passed\n', stderr: '', exitCode: 0 }
  }
}

describe('runtime contract and credential boundary', () => {
  it('keeps the v1 literals in the shared producer-consumer schemas', () => {
    const coding = maintainerRuntimeCodingContractSchema.parse({
      schemaVersion: 1,
      contract: 'oma-maintainer-claude-code-backend-v1',
      baseSha: 'a'.repeat(40),
      allowedScopes: [{ path: TARGET, kind: 'file' }],
      model: 'deepseek-v4-flash',
      claudeCodeVersion: '2.1.220',
      limits: { timeoutMs: 5_000, maxTurns: 20, maxProcessOutputBytes: 100_000 },
    })
    expect(coding.contract).toBe('oma-maintainer-claude-code-backend-v1')
    expect(maintainerRuntimeCodingResultSchema.parse({
      status: 'CODING_COMPLETED', turns: 1, terminationReason: 'success', safeEventCount: 2,
    }).status).toBe('CODING_COMPLETED')

    const validation = maintainerRuntimeValidationContractSchema.parse({
      schemaVersion: 1,
      contract: 'oma-maintainer-sandbox-validation-v1',
      baseSha: 'a'.repeat(40),
      changedFiles: [{ path: TARGET, contentHash: 'b'.repeat(64) }],
      candidateDiff: 'diff --git a/x b/x\n',
      validationCommands: [{
        id: 'focused', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [],
      }],
      limits: { maxFileBytes: 10_000, maxValidationOutputBytes: 10_000 },
    })
    expect(validation.contract).toBe('oma-maintainer-sandbox-validation-v1')
    expect(maintainerRuntimeValidationResultSchema.parse({
      status: 'VALIDATION_COMPLETED',
      validationResults: [{
        id: 'focused', command: 'node --test', success: true, exitCode: 0, durationMs: 1,
        stdout: '', stderr: '', truncated: false, environment: { set: [], unset: [] },
      }],
    }).status).toBe('VALIDATION_COMPLETED')
  })

  it('constructs a scrubbed Claude environment and fail-closed settings', () => {
    const environment = buildHarnessEnvironment({
      source: {
        PATH: '/bin',
        GITHUB_TOKEN: 'write-token',
        NPM_TOKEN: 'publish-token',
        SSH_AUTH_SOCK: '/tmp/ssh.sock',
      },
      deepSeekApiKey: FAKE_KEY,
      isolatedHome: '/tmp/oma-runtime-home',
    })
    expect(environment['ANTHROPIC_AUTH_TOKEN']).toBe(FAKE_KEY)
    expect(environment['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1')
    expect(environment['GITHUB_TOKEN']).toBeUndefined()
    expect(environment['NPM_TOKEN']).toBeUndefined()
    expect(environment['SSH_AUTH_SOCK']).toBeUndefined()
    expect(() => assertHarnessCredentialIsolation({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      GITHUB_TOKEN: 'forbidden',
    })).toThrow(/forbidden host credentials/)

    const settings = buildHarnessSettings({
      repoRoot: '/checkout',
      artifactDir: '/evidence',
      controlDir: '/control',
      allowedScopes: [{ path: TARGET, kind: 'file' }],
    })
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
    })
    expect(settings.permissions.allow).toEqual([
      'Read(//checkout/**)',
      `Edit(//checkout/${TARGET})`,
    ])
    expect(JSON.stringify(settings)).not.toContain(FAKE_KEY)
  })

  it('takes the production provider key exactly once and reads one-shot fd input', async () => {
    const environment = { DEEPSEEK_API_KEY: FAKE_KEY, PATH: '/bin' }
    expect(takeProductionProviderKey(environment)).toBe(FAKE_KEY)
    expect(environment).not.toHaveProperty('DEEPSEEK_API_KEY')

    const directory = await mkdtemp(join(tmpdir(), 'oma-runtime-key-'))
    const path = join(directory, 'provider-key')
    await writeFile(path, `${FAKE_KEY}\n`, { mode: 0o600 })
    const validFd = openSync(path, 'r')
    expect(readProviderKeyFromFd(String(validFd))).toBe(FAKE_KEY)
    expect(() => fstatSync(validFd)).toThrow()

    for (const [name, value, message] of [
      ['empty', '', /empty/],
      ['multiline', `${FAKE_KEY}\nsecond\n`, /one line/],
    ] as const) {
      const invalidPath = join(directory, name)
      await writeFile(invalidPath, value, { mode: 0o600 })
      const fd = openSync(invalidPath, 'r')
      expect(() => readProviderKeyFromFd(String(fd))).toThrow(message)
      expect(() => fstatSync(fd)).toThrow()
    }
    expect(() => readProviderKeyFromFd('not-an-fd')).toThrow(/integer/)
    expect(() => readProviderKeyFromFd('2')).toThrow(/allowed range/)
  })
})

describe('production coding and deterministic validation', () => {
  it('runs one bounded fake Claude coding worker with the shared v1 contract', async () => {
    const fixture = await createRepositoryFixture()
    const contractPath = join(fixture.controlDir, 'coding-contract.json')
    await writeFile(contractPath, JSON.stringify({
      schemaVersion: 1,
      contract: 'oma-maintainer-claude-code-backend-v1',
      baseSha: fixture.baseSha,
      allowedScopes: [{ path: TARGET, kind: 'file' }],
      model: 'deepseek-v4-flash',
      claudeCodeVersion: '2.1.220',
      limits: { timeoutMs: 5_000, maxTurns: 20, maxProcessOutputBytes: 100_000 },
    }))
    const script = join(fixture.controlDir, 'fake-claude.mjs')
    await writeFile(script, `
import { readFile, writeFile } from 'node:fs/promises'
const chunks = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const prompt = Buffer.concat(chunks).toString('utf8')
if (!prompt.includes('acceptanceCriteria')) process.exit(8)
const settingsIndex = process.argv.indexOf('--settings')
const settings = JSON.parse(await readFile(process.argv[settingsIndex + 1], 'utf8'))
if (!settings.permissions.deny.includes('Bash')) process.exit(9)
await writeFile(${JSON.stringify(TARGET)}, 'candidate\\n')
for (const event of [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', subtype: 'success' },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 4 },
]) process.stdout.write(JSON.stringify(event) + '\\n')
`)
    const result = await runProductionClaudeCodeBackend({
      contractPath,
      repoRoot: fixture.root,
      prompt: JSON.stringify({ acceptanceCriteria: ['write the candidate'] }),
      deepSeekApiKey: FAKE_KEY,
      sourceEnvironment: { PATH: process.env['PATH'] },
      claudeCommand: process.execPath,
      claudeArgsPrefix: [script],
    })
    expect(result).toEqual({ turns: 4, terminationReason: 'success', safeEventCount: 3 })
    expect(await readFile(join(fixture.root, TARGET), 'utf8')).toBe('candidate\n')
  })

  it('runs each validation command in a fresh disposable Bubblewrap snapshot', async () => {
    const fixture = await createRepositoryFixture()
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const diff = (await exec('git', canonicalGitDiffArgs({ paths: [TARGET] }), { cwd: fixture.root })).stdout
    const runner = new MockBubblewrapRunner()
    const results = await runProductionSandboxValidation({
      contract: {
        schemaVersion: 1,
        contract: 'oma-maintainer-sandbox-validation-v1',
        baseSha: fixture.baseSha,
        changedFiles: [{
          path: TARGET,
          contentHash: createHash('sha256').update('candidate\n').digest('hex'),
        }],
        candidateDiff: diff,
        validationCommands: [
          { id: 'first', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
          { id: 'second', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
        ],
        limits: { maxFileBytes: 10_000, maxValidationOutputBytes: 10_000 },
      },
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      sourceEnvironment: { PATH: process.env['PATH'] },
    })
    expect(results.map(result => result.id)).toEqual(['first', 'second'])
    expect(results.every(result => result.success)).toBe(true)
    expect(runner.roots).toHaveLength(2)
    expect(runner.roots[0]).not.toBe(runner.roots[1])
    await expect(readFile(join(runner.roots[0]!, TARGET), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(runner.roots[1]!, TARGET), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('discards Vitest cache and build output before the next validation command', async () => {
    const fixture = await createRepositoryFixture()
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const diff = (await exec('git', canonicalGitDiffArgs({ paths: [TARGET] }), { cwd: fixture.root })).stdout
    const parent = await mkdtemp(join(tmpdir(), 'oma-runtime-validation-'))
    const workspaceRoots: string[] = []
    const runner: SandboxProcessRunner = {
      run: async (_command, args) => {
        const bindIndex = args.findIndex((value, index) => value === '--bind' && args[index + 2] === '/workspace')
        const workspaceRoot = args[bindIndex + 1]!
        const vitestCache = join(workspaceRoot, 'packages/example/node_modules/.vite/vitest/results.json')
        const buildOutput = join(workspaceRoot, 'packages/example/dist/index.js')
        if (workspaceRoots.length > 0) {
          await expect(readFile(vitestCache, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(readFile(buildOutput, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        }
        workspaceRoots.push(workspaceRoot)
        await mkdir(join(workspaceRoot, 'packages/example/node_modules/.vite/vitest'), { recursive: true })
        await mkdir(join(workspaceRoot, 'packages/example/dist'), { recursive: true })
        await writeFile(vitestCache, '{"passed":true}\n')
        await writeFile(buildOutput, 'export {}\n')
        return { stdout: 'mock validation passed\n', stderr: '', exitCode: 0 }
      },
    }

    const results = await runProductionSandboxValidation({
      contract: {
        ...validationContract(fixture.baseSha, diff, 'candidate\n'),
        validationCommands: [
          { id: 'vitest', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
          { id: 'build', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
        ],
      },
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      workspaceParentDir: parent,
      sourceEnvironment: { PATH: process.env['PATH'] },
    })

    expect(results.map(result => result.id)).toEqual(['vitest', 'build'])
    expect(new Set(workspaceRoots).size).toBe(2)
    expect(await readdir(parent)).toEqual([])
    await expect(readFile(join(fixture.root, 'packages/example/node_modules/.vite/vitest/results.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(fixture.root, 'packages/example/dist/index.js'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('validates a frozen candidate that creates a new file and discards unrelated untracked output', async () => {
    const fixture = await createRepositoryFixture()
    const content = 'new candidate\nsecond line'
    await writeFile(join(fixture.root, NEW_TARGET), content)
    const candidateDiff = (await exec('git', canonicalNoIndexDiffArgs(NEW_TARGET), {
      cwd: fixture.root,
    }).catch(error => error)).stdout
    const workspaceRoots: string[] = []
    const runner: SandboxProcessRunner = {
      run: async (_command, args) => {
        const bindIndex = args.findIndex((value, index) => value === '--bind' && args[index + 2] === '/workspace')
        const workspaceRoot = args[bindIndex + 1]!
        workspaceRoots.push(workspaceRoot)
        expect(await readFile(join(workspaceRoot, NEW_TARGET), 'utf8')).toBe(content)
        await mkdir(join(workspaceRoot, '.validation-product'), { recursive: true })
        await writeFile(join(workspaceRoot, '.validation-product/output.txt'), 'discarded\n')
        return { stdout: 'new file validated\n', stderr: '', exitCode: 0 }
      },
    }

    const results = await runProductionSandboxValidation({
      contract: {
        schemaVersion: 1,
        contract: 'oma-maintainer-sandbox-validation-v1',
        baseSha: fixture.baseSha,
        changedFiles: [{
          path: NEW_TARGET,
          contentHash: createHash('sha256').update(content).digest('hex'),
        }],
        candidateDiff,
        validationCommands: [
          { id: 'new-file', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
        ],
        limits: { maxFileBytes: 10_000, maxValidationOutputBytes: 10_000 },
      },
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      sourceEnvironment: { PATH: process.env['PATH'] },
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    expect(workspaceRoots).toHaveLength(1)
    await expect(readFile(join(workspaceRoots[0]!, NEW_TARGET), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(fixture.root, NEW_TARGET), 'utf8')).toBe(content)
  }, 15_000)

  it('rejects a candidate diff whose applied bytes disagree with the frozen file hash before launch', async () => {
    const fixture = await createRepositoryFixture()
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const frozenHash = createHash('sha256').update('candidate\n').digest('hex')
    await writeFile(join(fixture.root, TARGET), 'drifted-candidate\n')
    const driftedDiff = (await exec('git', canonicalGitDiffArgs({ paths: [TARGET] }), { cwd: fixture.root })).stdout
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const runner = new MockBubblewrapRunner()

    await expect(runProductionSandboxValidation({
      contract: {
        schemaVersion: 1,
        contract: 'oma-maintainer-sandbox-validation-v1',
        baseSha: fixture.baseSha,
        changedFiles: [{ path: TARGET, contentHash: frozenHash }],
        candidateDiff: driftedDiff,
        validationCommands: [
          { id: 'must-not-run', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
        ],
        limits: { maxFileBytes: 10_000, maxValidationOutputBytes: 10_000 },
      },
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      sourceEnvironment: { PATH: process.env['PATH'] },
    })).rejects.toThrow(/(?:patch|content) differs from the approved candidate/)
    expect(runner.roots).toHaveLength(0)
  })

  it('rejects source mode drift that is absent from the frozen canonical diff before launch', async () => {
    const fixture = await createRepositoryFixture()
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const frozenDiff = (await exec('git', canonicalGitDiffArgs({ paths: [TARGET] }), { cwd: fixture.root })).stdout
    await chmod(join(fixture.root, TARGET), 0o755)
    const runner = new MockBubblewrapRunner()

    await expect(runProductionSandboxValidation({
      contract: validationContract(fixture.baseSha, frozenDiff, 'candidate\n'),
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      sourceEnvironment: { PATH: process.env['PATH'] },
    })).rejects.toThrow(/patch differs from the approved candidate/)
    expect(runner.roots).toHaveLength(0)
  })

  it('rejects an executable untracked candidate that the v1 new-file diff describes as 100644', async () => {
    const fixture = await createRepositoryFixture()
    const content = 'executable candidate\n'
    await writeFile(join(fixture.root, NEW_TARGET), content)
    const frozenDiff = (await exec('git', canonicalNoIndexDiffArgs(NEW_TARGET), {
      cwd: fixture.root,
    }).catch(error => error)).stdout
    await chmod(join(fixture.root, NEW_TARGET), 0o755)
    const runner = new MockBubblewrapRunner()

    await expect(runProductionSandboxValidation({
      contract: {
        ...validationContract(fixture.baseSha, frozenDiff, content),
        changedFiles: [{
          path: NEW_TARGET,
          contentHash: createHash('sha256').update(content).digest('hex'),
        }],
      },
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      sourceEnvironment: { PATH: process.env['PATH'] },
    })).rejects.toThrow(/mode 100644/)
    expect(runner.roots).toHaveLength(0)
  })

  it('rejects provider credentials before deterministic validation can create a sandbox', async () => {
    const fixture = await createRepositoryFixture()
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const diff = (await exec('git', canonicalGitDiffArgs({ paths: [TARGET] }), { cwd: fixture.root })).stdout
    const runner = new MockBubblewrapRunner()
    await expect(runProductionSandboxValidation({
      contract: validationContract(fixture.baseSha, diff, 'candidate\n'),
      repoRoot: fixture.root,
      sandboxProcessRunner: runner,
      sourceEnvironment: { PATH: process.env['PATH'], DEEPSEEK_API_KEY: FAKE_KEY },
    })).rejects.toThrow(/forbidden credentials/)
    expect(runner.roots).toHaveLength(0)
  })

  it('rejects protected policy environment names and tampered resolver files before Bubblewrap', async () => {
    const fixture = await createRepositoryFixture()
    await writeFile(join(fixture.root, TARGET), 'candidate\n')
    const diff = (await exec('git', canonicalGitDiffArgs({ paths: [TARGET] }), { cwd: fixture.root })).stdout
    const workspace = await createValidationWorkspace({
      sourceRepoRoot: fixture.root,
      baseSha: fixture.baseSha,
      changedPaths: [TARGET],
      candidateDiff: diff,
      maxFileBytes: 10_000,
    })
    const command = {
      id: 'focused',
      command: 'node',
      args: ['--test'],
      cwd: '.',
      timeoutMs: 5_000,
      env: { HOME: '/host-home' },
      unsetEnv: [],
    }
    try {
      await expect(buildValidationSandboxInvocation({
        workspaceRoot: workspace.repoRoot,
        dependencyRoot: workspace.dependencyRoot,
        resolverHostsPath: workspace.resolverHostsPath,
        resolverNsswitchPath: workspace.resolverNsswitchPath,
        command,
      })).rejects.toThrow(/environment invariants/)

      await writeFile(workspace.resolverHostsPath, '8.8.8.8 example.invalid\n')
      await expect(buildValidationSandboxInvocation({
        workspaceRoot: workspace.repoRoot,
        dependencyRoot: workspace.dependencyRoot,
        resolverHostsPath: workspace.resolverHostsPath,
        resolverNsswitchPath: workspace.resolverNsswitchPath,
        command: { ...command, env: {} },
      })).rejects.toThrow(/loopback policy/)
    } finally {
      await cleanupValidationWorkspace(workspace)
    }
  })

  it('preflights in a disposable snapshot and emits stable evidence for Bubblewrap setup failure', async () => {
    const fixture = await createRepositoryFixture()
    const parent = await mkdtemp(join(tmpdir(), 'oma-runtime-preflight-'))
    const runner = new MockBubblewrapRunner()
    await preflightValidationSandbox({
      repoRoot: fixture.root,
      runner,
      workspaceParentDir: parent,
    })
    expect(runner.roots).toHaveLength(1)
    expect(await readdir(parent)).toEqual([])
    expect(await readdir(join(fixture.root, 'packages/core'))).toEqual(['runtime-preflight-fixture.txt'])

    const failedRunner: SandboxProcessRunner = {
      run: async () => ({
        stdout: `${fixture.root}/unsafe\n`,
        stderr: 'mock sandbox setup failed\n',
        exitCode: 125,
      }),
    }
    const failure = await preflightValidationSandbox({
      repoRoot: fixture.root,
      runner: failedRunner,
      workspaceParentDir: parent,
    }).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(ValidationSandboxPreflightError)
    expect((failure as ValidationSandboxPreflightError).diagnostic).toMatchObject({
      status: 'SANDBOX_UNAVAILABLE',
      reasonCode: 'BWRAP_EXIT_NONZERO',
      exitCode: 125,
      stdout: '<repo>/unsafe',
      stderr: 'mock sandbox setup failed',
    })
    expect(await readdir(parent)).toEqual([])
  })

  it('fails closed when bounded process output crosses the combined byte limit', async () => {
    await expect(new BoundedProcessRunner().run(process.execPath, [
      '--eval', `process.stdout.write('é'.repeat(10_000))`,
    ], {
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] },
      timeoutMs: 5_000,
      maxOutputBytes: 100,
    })).rejects.toMatchObject<Partial<BoundedProcessError>>({ reason: 'OUTPUT_LIMIT' })
  })

  it('bounds timeout and reports a stable spawn failure without host fallback', async () => {
    const runner = new BoundedProcessRunner()
    await expect(runner.run(process.execPath, [
      '--eval', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)`,
    ], {
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] },
      timeoutMs: 25,
      maxOutputBytes: 1_000,
    })).rejects.toMatchObject<Partial<BoundedProcessError>>({ reason: 'TIMEOUT' })

    await expect(runner.run('/definitely-not-a-real-bwrap-binary', [], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
    })).rejects.toMatchObject<Partial<BoundedProcessError>>({
      reason: 'SPAWN_ERROR',
      osErrorCode: 'ENOENT',
    })
  })
})

function validationContract(baseSha: string, candidateDiff: string, content: string) {
  return {
    schemaVersion: 1 as const,
    contract: 'oma-maintainer-sandbox-validation-v1' as const,
    baseSha,
    changedFiles: [{
      path: TARGET,
      contentHash: createHash('sha256').update(content).digest('hex'),
    }],
    candidateDiff,
    validationCommands: [
      { id: 'focused', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 5_000, env: {}, unsetEnv: [] },
    ],
    limits: { maxFileBytes: 10_000, maxValidationOutputBytes: 10_000 },
  }
}

function canonicalNoIndexDiffArgs(path: string): string[] {
  const args = canonicalGitDiffArgs({ paths: ['/dev/null', path] })
  const separator = args.indexOf('--')
  return [...args.slice(0, separator), '--no-index', ...args.slice(separator)]
}

async function createRepositoryFixture(): Promise<{
  root: string
  controlDir: string
  baseSha: string
}> {
  const container = await mkdtemp(join(tmpdir(), 'oma-runtime-test-'))
  const root = join(container, 'repo')
  const controlDir = join(container, 'control')
  await mkdir(join(root, 'packages/example'), { recursive: true })
  await mkdir(join(root, 'packages/core'), { recursive: true })
  await mkdir(controlDir)
  await writeFile(join(root, TARGET), 'base\n')
  await writeFile(join(root, 'packages/core/runtime-preflight-fixture.txt'), 'tracked\n')
  await exec('git', ['init', '--quiet'], { cwd: root })
  await exec('git', ['config', 'user.name', 'Runtime Test'], { cwd: root })
  await exec('git', ['config', 'user.email', 'runtime@example.invalid'], { cwd: root })
  await exec('git', ['add', TARGET, 'packages/core/runtime-preflight-fixture.txt'], { cwd: root })
  await exec('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
  await mkdir(join(root, 'node_modules'))
  const baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  return { root, controlDir, baseSha }
}
