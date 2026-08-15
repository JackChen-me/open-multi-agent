#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { NodeCommandRunner, readProviderKeyFromFd } from '@open-multi-agent/maintainer-bot'
import { finalizeActivation, prepareActivation, renderActionsSummary } from './activation.js'
import { runIsolatedEngine } from './engine.js'
import { GitHubRestClient } from './github.js'
import { loadProductionPolicy } from './policy.js'
import { sanitizePublicLine } from './public-output.js'
import {
  activationContextSchema,
  engineResultSchema,
  githubAppWriterContractSchema,
} from './schema.js'

const command = process.argv[2] ?? 'help'

try {
  switch (command) {
    case 'prepare':
      await prepare()
      break
    case 'run-engine':
      await runEngine()
      break
    case 'finalize':
      await finalize()
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      throw new Error(`Unknown command ${JSON.stringify(command)}.`)
  }
} catch (error) {
  console.error(`maintainer-host: ${sanitizePublicLine(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
}

async function prepare(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  delete process.env['MAINTAINER_BOT_APP_TOKEN']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
  const [event, policy] = await Promise.all([
    readJson(requireFlag('--event')),
    loadProductionPolicy(requireFlag('--policy')),
  ])
  const context = await prepareActivation({
    event,
    github: new GitHubRestClient({ token }),
    runner: new NodeCommandRunner(),
    repoRoot: resolve(requireFlag('--repo')),
    policy,
    eventId: requireFlag('--event-id'),
    receivedAt: flag('--received-at') ?? new Date().toISOString(),
    claimId: requireFlag('--claim-id'),
    actionsRunId: positiveInteger(requireFlag('--actions-run-id')),
    runUrl: requireFlag('--run-url'),
    baseShaHint: requireFlag('--base-sha'),
    eventSnapshotMatched: booleanFlag('--event-snapshot-matched'),
    writerContract: writerContractFromFlags(),
    removedBootstrapCommentCount: nonnegativeInteger(requireFlag('--removed-bootstrap-comment-count')),
  })
  await atomicWriteJson(requireFlag('--activation-out'), context)
  await appendSummary(renderActionsSummary(context))
}

async function runEngine(): Promise<void> {
  const deepSeekApiKey = readProviderKeyFromFd(requireFlag('--provider-key-fd'))
  const result = await runIsolatedEngine({
    activationPath: requireFlag('--activation'),
    resultPath: requireFlag('--result-out'),
    repoRoot: resolve(requireFlag('--repo')),
    stateDir: resolve(requireFlag('--state-dir')),
    artifactDir: resolve(requireFlag('--artifact-dir')),
    maintainerBotCli: resolve(requireFlag('--maintainer-bot-cli')),
    claudeCodeHarnessCli: flag('--claude-code-harness-cli') === undefined
      ? undefined
      : resolve(requireFlag('--claude-code-harness-cli')),
    deepSeekApiKey,
    sourceEnvironment: process.env,
  })
  if (result.attempted && result.status === 'FAILED') process.exitCode = 1
}

async function finalize(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  delete process.env['MAINTAINER_BOT_APP_TOKEN']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
  const activation = activationContextSchema.parse(await readJson(requireFlag('--activation')))
  const engineResult = await readEngineResult(flag('--engine-result'))
  const [event, policy] = await Promise.all([
    readJson(requireFlag('--event')),
    loadProductionPolicy(requireFlag('--policy')),
  ])
  const result = await finalizeActivation({
    activation,
    engineResult,
    originalEvent: event,
    github: new GitHubRestClient({ token }),
    runner: new NodeCommandRunner(),
    githubAppToken: token,
    writerContract: writerContractFromFlags(),
    repoRoot: resolve(requireFlag('--repo')),
    policy,
    stateDir: resolve(requireFlag('--state-dir')),
    artifactDir: resolve(requireFlag('--artifact-dir')),
    finalizedAt: new Date().toISOString(),
  })
  await atomicWriteJson(requireFlag('--final-out'), result)
  await appendSummary(renderActionsSummary(result))
  await appendOutput(`terminal_status=${result.status}\n`)
}

async function readEngineResult(path: string | undefined) {
  if (path === undefined) {
    return engineResultSchema.parse({
      schemaVersion: 1,
      attempted: false,
      exitCode: 1,
      status: 'FAILED',
      detail: 'The isolated engine step did not produce a result file.',
    })
  }
  try {
    return engineResultSchema.parse(await readJson(path))
  } catch {
    return engineResultSchema.parse({
      schemaVersion: 1,
      attempted: true,
      exitCode: 1,
      status: 'FAILED',
      detail: 'The isolated engine result file is missing or invalid.',
    })
  }
}

async function appendSummary(content: string): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path !== undefined) await appendFile(path, content, 'utf8')
}

async function appendOutput(content: string): Promise<void> {
  const path = process.env['GITHUB_OUTPUT']
  if (path !== undefined) await appendFile(path, content, 'utf8')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, destination)
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

function requireFlag(name: string): string {
  const value = flag(name)
  if (value === undefined) throw new Error(`Required flag ${name} is missing.`)
  return value
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Required environment variable ${name} is missing.`)
  return value
}

function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`)
  return parsed
}

function nonnegativeInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Expected a non-negative integer, received ${JSON.stringify(value)}.`)
  return parsed
}

function booleanFlag(name: string): boolean {
  const value = requireFlag(name)
  if (value === 'true') return true
  if (value === 'false' || value === '') return false
  throw new Error(`${name} must be exactly true or false.`)
}

function writerContractFromFlags() {
  return githubAppWriterContractSchema.parse({
    enabled: booleanFlag('--app-writer-enabled'),
    expectedAppId: positiveInteger(requireFlag('--expected-app-id')),
    expectedClientId: requireFlag('--expected-app-client-id'),
    expectedSlug: requireFlag('--expected-app-slug'),
    expectedInstallationId: positiveInteger(requireFlag('--expected-app-installation-id')),
    expectedBotUserId: positiveInteger(requireFlag('--expected-app-bot-user-id')),
    actualSlug: requireFlag('--app-slug'),
    actualInstallationId: positiveInteger(requireFlag('--app-installation-id')),
  })
}

function printHelp(): void {
  console.log(`OMA Maintainer Host

prepare      Re-fetch and validate an issues.labeled event, claim durable BOT state, and write activation input.
run-engine   Spawn the OMA Maintainer Bot in a credential-isolated child process.
finalize     Re-fetch every authorization fact, run the final safe-output gate, and create at most one Draft PR.

The GitHub App installation token is accepted only by prepare/finalize. Its expected App ID, client ID,
slug, installation ID, bot user ID, and operator enablement are verified before model execution and again
before the writer. DEEPSEEK_API_KEY is accepted only by run-engine.`)
}
