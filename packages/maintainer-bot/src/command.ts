import { spawn } from 'node:child_process'

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface RunCommandOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly allowFailure?: boolean
  readonly timeoutMs?: number
  readonly maxOutputChars?: number
}

export interface CommandRunner {
  run(
    command: string,
    args?: readonly string[],
    options?: RunCommandOptions,
  ): Promise<CommandResult>
}

export class CommandError extends Error {
  readonly command: string
  readonly args: readonly string[]
  readonly exitCode: number

  constructor(command: string, args: readonly string[], result: CommandResult) {
    const rendered = renderCommand(command, args)
    const detail = redactSensitiveText(result.stderr.trim() || result.stdout.trim() || 'no output')
    super(`Command failed (${result.exitCode}): ${rendered}\n${detail}`)
    this.name = 'CommandError'
    this.command = command
    this.args = args
    this.exitCode = result.exitCode
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {},
  ): Promise<CommandResult> {
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let timedOut = false
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
        }, options.timeoutMs)

      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      child.on('error', error => {
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      })
      child.on('close', code => {
        if (timer !== undefined) clearTimeout(timer)
        const limit = options.maxOutputChars ?? 200_000
        const out = boundOutput(Buffer.concat(stdout).toString('utf8'), limit)
        const err = boundOutput(Buffer.concat(stderr).toString('utf8'), limit)
        resolve({
          stdout: redactSensitiveText(out),
          stderr: redactSensitiveText(
            timedOut ? `${err}\n[command timed out after ${options.timeoutMs}ms]` : err,
          ),
          exitCode: timedOut ? 124 : code ?? 1,
        })
      })
    })

    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new CommandError(command, args, result)
    }
    return result
  }
}

export function sanitizedChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isCredentialName(name)) continue
    output[name] = value
  }
  output['CI'] = source['CI'] ?? '1'
  return output
}

export function assertModelCredentialIsolation(env: NodeJS.ProcessEnv = process.env): void {
  const forbidden = [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'RELEASE_BOT_GITHUB_TOKEN',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_INSTALLATION_TOKEN',
    'MAINTAINER_BOT_APP_TOKEN',
    'OMA_MAINTAINER_BOT_APP_PRIVATE_KEY',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
  ]
  const present = [...new Set([
    ...forbidden.filter(name => Boolean(env[name])),
    ...Object.keys(env).filter(name =>
      Boolean(env[name])
      && /(?:GITHUB|^GH_|NPM|NODE_AUTH|MAINTAINER_BOT_APP)/i.test(name)
      && /(?:TOKEN|SECRET|PRIVATE_KEY|CREDENTIAL)/i.test(name),
    ),
  ])]
  if (present.length > 0) {
    throw new Error(
      `Maintainer-bot model execution refuses environments containing write credentials: ${present.join(', ')}. Launch the custom engine in a credential-isolated process.`,
    )
  }
}

export function renderCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(value => JSON.stringify(value)).join(' ')
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/((?:token|api[_-]?key|password|secret)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]')
}

function isCredentialName(name: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH_SOCK)/i.test(name)
}

function boundOutput(value: string, limit: number): string {
  if (value.length <= limit) return value
  const half = Math.floor((limit - 40) / 2)
  return `${value.slice(0, half)}\n[output truncated]\n${value.slice(-half)}`
}
