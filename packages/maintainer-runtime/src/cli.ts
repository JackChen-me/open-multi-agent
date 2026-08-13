#!/usr/bin/env node
import { resolve } from 'node:path'
import {
  createMaintainerRuntimeCodingResult,
  createMaintainerRuntimeValidationResult,
  readMaintainerRuntimeValidationContract,
} from './artifacts.js'
import { runProductionClaudeCodeBackend, takeProductionProviderKey } from './coding-worker.js'
import { runProductionSandboxValidation } from './validation-runner.js'
import {
  preflightValidationSandbox,
  ValidationSandboxPreflightError,
} from './validation-sandbox.js'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'run-production-backend') {
    const options = parseArgs(args, ['contract', 'repo'])
    const deepSeekApiKey = takeProductionProviderKey(process.env)
    const prompt = await readStdin(200_000)
    const result = await runProductionClaudeCodeBackend({
      contractPath: resolve(options['contract']!),
      repoRoot: resolve(options['repo']!),
      prompt,
      deepSeekApiKey,
      sourceEnvironment: process.env,
      claudeCommand: options['claude-command'],
    })
    const envelope = createMaintainerRuntimeCodingResult(result)
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
    return
  }
  if (command === 'run-production-validation') {
    const options = parseArgs(args, ['contract', 'repo'])
    const contract = await readMaintainerRuntimeValidationContract(resolve(options['contract']!))
    const validationResults = await runProductionSandboxValidation({
      contract,
      repoRoot: resolve(options['repo']!),
      sourceEnvironment: process.env,
    })
    const envelope = createMaintainerRuntimeValidationResult(validationResults)
    process.stdout.write(`${JSON.stringify(envelope)}\n`)
    return
  }
  if (command === 'sandbox-preflight') {
    const options = parseArgs(args, ['repo'])
    await preflightValidationSandbox({ repoRoot: resolve(options['repo']!) })
    process.stdout.write(`${JSON.stringify({ status: 'SANDBOX_READY' })}\n`)
    return
  }
  throw new Error('Usage: oma-maintainer-runtime <sandbox-preflight|run-production-backend|run-production-validation> [options]')
}

async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error('Production backend stdin exceeded the byte limit.')
    chunks.push(buffer)
  }
  const value = Buffer.concat(chunks).toString('utf8')
  if (value.trim().length === 0) throw new Error('Production backend stdin was empty.')
  return value
}

function parseArgs(args: readonly string[], required: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === undefined || value === undefined || !flag.startsWith('--')) {
      throw new Error('Arguments must be --name value pairs.')
    }
    output[flag.slice(2)] = value
  }
  for (const name of required) if (output[name] === undefined) throw new Error(`Missing --${name}.`)
  return output
}

main().catch(error => {
  const evidence = error instanceof ValidationSandboxPreflightError
    ? JSON.stringify(error.diagnostic)
    : error instanceof Error ? error.message : String(error)
  process.stderr.write(`${evidence}\n`)
  process.exitCode = 1
})
