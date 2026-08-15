#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { prepareCanaryRequestFile, loadCanaryPolicy } from './request.js'
import { runHarnessCanary } from './runner.js'
import { readProviderKeyFromFd } from './provider-key.js'
import { runProductionClaudeCodeBackend, takeProductionProviderKey } from './production-backend.js'
import { runProductionSandboxValidation } from './production-validation.js'
import {
  preflightValidationSandbox,
  ValidationSandboxPreflightError,
} from './validation-sandbox.js'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'prepare') {
    const options = parseArgs(args, ['snapshot', 'policy', 'output'])
    const request = await prepareCanaryRequestFile({
      snapshotPath: resolve(options['snapshot']!),
      policyPath: resolve(options['policy']!),
      outputPath: resolve(options['output']!),
    })
    process.stdout.write(`${JSON.stringify({ status: 'PREPARED', canarySnapshotRevision: request.canarySnapshotRevision })}\n`)
    return
  }
  if (command === 'run') {
    const options = parseArgs(args, ['request', 'policy', 'repo', 'artifact-dir', 'provider-key-fd'])
    const deepSeekApiKey = readProviderKeyFromFd(options['provider-key-fd']!)
    const [request, policy] = await Promise.all([
      readFile(resolve(options['request']!), 'utf8').then(value => JSON.parse(value) as unknown),
      loadCanaryPolicy(resolve(options['policy']!)),
    ])
    const artifact = await runHarnessCanary({
      request,
      policy,
      repoRoot: resolve(options['repo']!),
      artifactDir: resolve(options['artifact-dir']!),
      deepSeekApiKey,
    })
    if (artifact.status !== 'SUCCEEDED') throw new Error('Canary runner returned an unexpected non-success result.')
    process.stdout.write(`${JSON.stringify({
      status: artifact.status,
      artifactHash: artifact.artifactHash,
      diffHash: artifact.diffHash,
      turns: artifact.turns,
      terminationReason: artifact.terminationReason,
    })}\n`)
    return
  }
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
    process.stdout.write(`${JSON.stringify({ status: 'CODING_COMPLETED', ...result })}\n`)
    return
  }
  if (command === 'run-production-validation') {
    const options = parseArgs(args, ['contract', 'repo'])
    const contract = await readFile(resolve(options['contract']!), 'utf8').then(value => JSON.parse(value) as unknown)
    const validationResults = await runProductionSandboxValidation({
      contract,
      repoRoot: resolve(options['repo']!),
      sourceEnvironment: process.env,
    })
    process.stdout.write(`${JSON.stringify({ status: 'VALIDATION_COMPLETED', validationResults })}\n`)
    return
  }
  if (command === 'sandbox-preflight') {
    const options = parseArgs(args, ['repo'])
    await preflightValidationSandbox({ repoRoot: resolve(options['repo']!) })
    process.stdout.write(`${JSON.stringify({ status: 'SANDBOX_READY' })}\n`)
    return
  }
  throw new Error('Usage: oma-maintainer-harness-canary <prepare|sandbox-preflight|run|run-production-backend|run-production-validation> [options]')
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
    if (flag === undefined || value === undefined || !flag.startsWith('--')) throw new Error('Arguments must be --name value pairs.')
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
