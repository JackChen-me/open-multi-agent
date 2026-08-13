import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { z } from 'zod'
import {
  activationContextSchema,
  engineResultSchema,
  type ActivationContext,
  type EngineResult,
} from './schema.js'
import { sanitizePublicLine } from './public-output.js'

const engineOutputSchema = z.object({
  status: z.string().min(1),
  detail: z.string().optional(),
})

const SAFE_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'TMPDIR',
  'CI',
  'LANG',
  'LC_ALL',
  'TZ',
] as const

export function buildIsolatedModelEnvironment(
  source: NodeJS.ProcessEnv,
  deepSeekApiKey: string,
): NodeJS.ProcessEnv {
  if (!deepSeekApiKey) throw new Error('DEEPSEEK_API_KEY is required for an eligible engine run.')
  const environment: NodeJS.ProcessEnv = { CI: '1' }
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  assertNoHostCredentials(environment)
  return environment
}

export function assertNoHostCredentials(environment: NodeJS.ProcessEnv): void {
  const forbidden = Object.keys(environment).filter(name =>
    /^(?:GITHUB|GH_|ACTIONS_|RUNNER_TRACKING_ID|NPM_TOKEN|NODE_AUTH_TOKEN)/i.test(name)
    || /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK)/i.test(name)
    )
  if (forbidden.length > 0) {
    throw new Error(`Isolated model environment contains forbidden host credentials: ${forbidden.sort().join(', ')}`)
  }
}

export async function runIsolatedEngine(options: {
  readonly activationPath: string
  readonly resultPath: string
  readonly repoRoot: string
  readonly stateDir: string
  readonly artifactDir: string
  readonly maintainerBotCli: string
  readonly maintainerRuntimeCli?: string
  readonly deepSeekApiKey?: string
  readonly sourceEnvironment?: NodeJS.ProcessEnv
  readonly nodeExecutable?: string
}): Promise<EngineResult> {
  const activation = activationContextSchema.parse(JSON.parse(await readFile(options.activationPath, 'utf8')))
  if (!activation.shouldRun) {
    const skipped = engineResultSchema.parse({
      schemaVersion: 1,
      attempted: false,
      exitCode: 0,
      status: activation.status,
      detail: activation.detail,
    })
    await atomicWriteJson(options.resultPath, skipped)
    return skipped
  }
  if (activation.request === null || activation.config === null) {
    throw new Error('Eligible activation is missing its request or production configuration.')
  }
  const deepSeekApiKey = options.deepSeekApiKey ?? ''
  const environment = buildIsolatedModelEnvironment(options.sourceEnvironment ?? process.env, deepSeekApiKey)
  await mkdir(options.stateDir, { recursive: true })
  await mkdir(options.artifactDir, { recursive: true })
  const requestPath = join(dirname(options.activationPath), 'request.json')
  const configPath = join(dirname(options.activationPath), 'config.json')
  await Promise.all([
    atomicWriteJson(requestPath, activation.request),
    atomicWriteJson(configPath, activation.config),
  ])
  if (activation.config.executionBackend === 'claude-code' && options.maintainerRuntimeCli === undefined) {
    throw new Error('Claude Code backend requires a maintainer runtime CLI path.')
  }
  const child = await spawnCaptured(
    options.nodeExecutable ?? process.execPath,
    [
      resolve(options.maintainerBotCli),
      'run',
      '--request', requestPath,
      '--config', configPath,
      '--state-dir', resolve(options.stateDir),
      '--artifact-dir', resolve(options.artifactDir),
      '--repo', resolve(options.repoRoot),
      '--run-id', activation.claimId,
      '--provider-key-fd', '3',
      ...(activation.config.executionBackend === 'claude-code'
        ? ['--maintainer-runtime-cli', resolve(options.maintainerRuntimeCli!)]
        : []),
    ],
    environment,
    deepSeekApiKey,
  )
  let parsed: z.infer<typeof engineOutputSchema> | undefined
  try {
    parsed = engineOutputSchema.parse(JSON.parse(child.stdout))
  } catch {
    // The finalizer receives a bounded public-safe failure instead of raw model or process output.
  }
  const result = engineResultSchema.parse({
    schemaVersion: 1,
    attempted: true,
    exitCode: child.exitCode,
    status: parsed?.status ?? 'FAILED',
    detail: sanitizePublicLine(
      parsed?.detail
        ?? (child.exitCode === 0 ? 'Engine returned no parseable result.' : 'The isolated Maintainer Bot engine process failed.'),
    ),
  })
  await atomicWriteJson(options.resultPath, result)
  return result
}

async function spawnCaptured(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  providerKey: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const providerPipe = child.stdio[3] as Writable | null | undefined
    if (providerPipe === null || providerPipe === undefined) {
      child.kill('SIGTERM')
      reject(new Error('Could not create the provider credential pipe.'))
      return
    }
    providerPipe.on('error', reject)
    providerPipe.end(`${providerKey}\n`)
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout!.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      stdoutBytes += buffer.byteLength
      if (stdoutBytes <= 5_000_000) stdout.push(buffer)
      else child.kill('SIGTERM')
    })
    child.stderr!.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > 1_000_000) child.kill('SIGTERM')
    })
    child.on('error', reject)
    child.on('close', code => resolvePromise({
      stdout: Buffer.concat(stdout).toString('utf8'),
      exitCode: stdoutBytes > 5_000_000 || stderrBytes > 1_000_000 ? 124 : code ?? 1,
    }))
  })
}

async function atomicWriteJson(path: string, value: ActivationContext | EngineResult | unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  const destination = resolve(path)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, destination)
}
