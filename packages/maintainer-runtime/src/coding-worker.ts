import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeCommandRunner } from '@open-multi-agent/maintainer-bot'
import { readMaintainerRuntimeCodingContract } from './artifacts.js'
import { buildHarnessEnvironment } from './environment.js'
import { buildHarnessArgs, buildHarnessSettings, spawnHarness } from './claude-code.js'

export function takeProductionProviderKey(environment: NodeJS.ProcessEnv): string {
  const name = 'DEEPSEEK_API_KEY'
  const value = environment[name] ?? ''
  delete environment[name]
  if (value.length === 0) throw new Error('Production Claude Code backend requires its provider credential.')
  return value
}

export async function runProductionClaudeCodeBackend(options: {
  readonly contractPath: string
  readonly repoRoot: string
  readonly prompt: string
  readonly deepSeekApiKey: string
  readonly sourceEnvironment?: NodeJS.ProcessEnv
  readonly claudeCommand?: string
  /** Test-only argv prefix. The production CLI never exposes this option. */
  readonly claudeArgsPrefix?: readonly string[]
}): Promise<{ turns: number; terminationReason: string; safeEventCount: number }> {
  if (Buffer.byteLength(options.prompt) > 200_000) throw new Error('OMA coding prompt exceeds the production harness limit.')
  const contract = await readMaintainerRuntimeCodingContract(resolve(options.contractPath))
  const repoRoot = resolve(options.repoRoot)
  const runner = new NodeCommandRunner()
  const [head, status] = await Promise.all([
    runner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    runner.run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot }),
  ])
  if (head.stdout.trim() !== contract.baseSha) throw new Error('Claude Code backend checkout differs from the pinned base SHA.')
  if (status.stdout.length > 0) throw new Error('Claude Code backend requires a clean checkout before coding.')

  const controlDir = await mkdtemp(join(tmpdir(), 'oma-production-claude-control-'))
  const isolatedHome = join(controlDir, 'home')
  const artifactDir = join(controlDir, 'artifacts')
  await Promise.all([
    mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
    mkdir(artifactDir, { recursive: true, mode: 0o700 }),
  ])
  const settingsPath = join(controlDir, 'trusted-settings.json')
  const settings = buildHarnessSettings({
    repoRoot,
    artifactDir,
    controlDir,
    allowedScopes: contract.allowedScopes,
  })
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  const environment = buildHarnessEnvironment({
    source: options.sourceEnvironment,
    deepSeekApiKey: options.deepSeekApiKey,
    isolatedHome,
  })
  const summary = await spawnHarness({
    command: options.claudeCommand ?? 'claude',
    args: buildHarnessArgs({
      prefix: options.claudeArgsPrefix,
      settingsPath,
      repoRoot,
      allowedScopes: contract.allowedScopes,
      policy: {
        model: contract.model,
        limits: {
          maxTurns: contract.limits.maxTurns,
        },
      },
    }),
    cwd: repoRoot,
    env: environment,
    stdin: options.prompt,
    timeoutMs: contract.limits.timeoutMs,
    maxOutputBytes: contract.limits.maxProcessOutputBytes,
    maxTurns: contract.limits.maxTurns,
  })
  return {
    turns: summary.turns,
    terminationReason: summary.terminationReason,
    safeEventCount: summary.safeEvents.length,
  }
}
