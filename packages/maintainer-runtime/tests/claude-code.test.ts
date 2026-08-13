import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildHarnessArgs,
  buildHarnessSettings,
  spawnHarness,
} from '../src/claude-code.js'

const posixIt = process.platform === 'linux' || process.platform === 'darwin' ? it : it.skip

describe('Claude Code runtime boundary', () => {
  it('keeps file scopes exact and grants recursive edits only to directory scopes', () => {
    const allowedScopes = [
      { path: 'packages/core/src/index.ts', kind: 'file' as const },
      { path: 'packages/core/tests', kind: 'directory' as const },
    ]
    const expectedRules = [
      'Edit(//checkout/packages/core/src/index.ts)',
      'Edit(//checkout/packages/core/tests/**)',
    ]
    const settings = buildHarnessSettings({
      repoRoot: '/checkout',
      artifactDir: '/artifacts',
      controlDir: '/control',
      allowedScopes,
    })
    const args = buildHarnessArgs({
      settingsPath: '/control/settings.json',
      repoRoot: '/checkout',
      allowedScopes,
      policy: { model: 'deepseek-v4-flash', limits: { maxTurns: 20 } },
    })
    const allowedToolsIndex = args.indexOf('--allowedTools')

    expect(settings.permissions.allow).toEqual(['Read(//checkout/**)', ...expectedRules])
    expect(args.slice(allowedToolsIndex + 1, allowedToolsIndex + 4))
      .toEqual(['Read(//checkout/**)', ...expectedRules])
    expect(settings.permissions.allow).not.toContain('Edit(//checkout/packages/core/src/index.ts/**)')
    expect(args).not.toContain('Edit(//checkout/packages/core/src/index.ts/**)')
  })

  it('fails closed when the CLI cannot spawn', async () => {
    await expect(spawnHarness({
      command: join(tmpdir(), 'definitely-missing-oma-claude-cli'),
      args: [],
      cwd: tmpdir(),
      env: {},
      stdin: '',
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      maxTurns: 1,
    })).rejects.toMatchObject({ stage: 'harness_execution', reasonCode: 'CLI_UNAVAILABLE' })
  })

  posixIt.each([
    { name: 'timeout', timeoutMs: 500, maxOutputBytes: 10_000, emitOutput: false, reasonCode: 'TIMEOUT' },
    { name: 'output limit', timeoutMs: 2_000, maxOutputBytes: 32, emitOutput: true, reasonCode: 'OUTPUT_LIMIT' },
  ])('kills the complete process group after $name', async ({ timeoutMs, maxOutputBytes, emitOutput, reasonCode }) => {
    const directory = await mkdtemp(join(tmpdir(), 'oma-harness-process-group-'))
    const ready = join(directory, 'descendant-ready')
    const sentinel = join(directory, 'escaped-descendant')
    const descendant = `
const { writeFileSync } = require('node:fs')
process.on('SIGTERM', () => {})
writeFileSync(process.argv[1], 'ready\\n')
process.stdout.write('ready\\n')
setTimeout(() => {
  writeFileSync(process.argv[2], 'descendant survived process-group cleanup\\n')
  process.exit(0)
}, 800)
`
    const parent = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(ready)}, ${JSON.stringify(sentinel)}], {
  stdio: ['ignore', 'pipe', 'ignore'],
})
child.stdout.once('data', () => {
  if (${JSON.stringify(emitOutput)}) process.stdout.write('x'.repeat(4096))
})
setInterval(() => {}, 1000)
`

    await expect(spawnHarness({
      command: process.execPath,
      args: ['-e', parent],
      cwd: directory,
      env: { PATH: process.env['PATH'] },
      stdin: '',
      timeoutMs,
      maxOutputBytes,
      maxTurns: 1,
    })).rejects.toMatchObject({ reasonCode })

    await expect(access(ready)).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 950))
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 5_000)
})
