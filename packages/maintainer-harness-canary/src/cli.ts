#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { prepareCanaryRequestFile, loadCanaryPolicy } from './request.js'
import { runHarnessCanary } from './runner.js'
import { readProviderKeyFromFd } from './provider-key.js'
import { preflightValidationSandbox } from './validation-sandbox.js'

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
  if (command === 'sandbox-preflight') {
    const options = parseArgs(args, ['repo'])
    await preflightValidationSandbox({ repoRoot: resolve(options['repo']!) })
    process.stdout.write(`${JSON.stringify({ status: 'SANDBOX_READY' })}\n`)
    return
  }
  throw new Error('Usage: oma-maintainer-harness-canary <prepare|sandbox-preflight|run> [options]')
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
