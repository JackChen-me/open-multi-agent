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
  readonly stdin?: string
  /**
   * Also write the child's output to this process's own streams.
   *
   * Output is always captured. Long validation commands are otherwise silent
   * for their whole duration, which leaves a CI log with no evidence that they
   * ran and no way to see where a hang occurred.
   */
  readonly echo?: boolean
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
  readonly stderr: string

  constructor(
    command: string,
    args: readonly string[],
    result: CommandResult,
  ) {
    const rendered = [command, ...args].join(' ')
    const detail = result.stderr.trim() || result.stdout.trim() || 'no output'
    super(`Command failed (${result.exitCode}): ${rendered}\n${detail}`)
    this.name = 'CommandError'
    this.command = command
    this.args = args
    this.exitCode = result.exitCode
    this.stderr = result.stderr
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
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', chunk => {
        stdout.push(Buffer.from(chunk))
        if (options.echo) process.stdout.write(chunk)
      })
      child.stderr.on('data', chunk => {
        stderr.push(Buffer.from(chunk))
        if (options.echo) process.stderr.write(chunk)
      })
      child.on('error', reject)
      child.on('close', code => {
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? 1,
        })
      })

      if (options.stdin !== undefined) child.stdin.end(options.stdin)
      else child.stdin.end()
    })

    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new CommandError(command, args, result)
    }
    return result
  }
}
