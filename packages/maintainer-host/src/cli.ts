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
  bootstrapFailureStageSchema,
  engineResultSchema,
  githubAppWriterContractSchema,
  startContextSchema,
  startFailureStageSchema,
  type StartFailureStage,
} from './schema.js'
import { publicActivationStatus } from './status.js'
import {
  StartWorkflowError,
  publishBootstrapFailure,
  recoverStartFailure,
  recoverWorkflowFailure,
  startWorkflow,
  verifyStartContextHash,
} from './workflow-control.js'

const command = process.argv[2] ?? 'help'

try {
  switch (command) {
    case 'start':
      await start()
      break
    case 'prepare':
      await prepare()
      break
    case 'run-engine':
      await runEngine()
      break
    case 'finalize':
      await finalize()
      break
    case 'bootstrap-failure':
      await bootstrapFailure()
      break
    case 'recover-start':
      await recoverStart()
      break
    case 'recover':
      await recover()
      break
    case 'exit-terminal':
      exitTerminal()
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

async function start(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  clearGitHubTokens()
  let phase: StartFailureStage = 'event-policy'
  try {
    const [event, policy] = await Promise.all([
      readJson(requireFlag('--event')),
      loadProductionPolicy(requireFlag('--policy')),
    ])
    const context = await startWorkflow({
      event,
      github: new GitHubRestClient({ token }),
      runner: new NodeCommandRunner(),
      repoRoot: resolve(requireFlag('--repo')),
      policy,
      claimId: requireFlag('--claim-id'),
      actionsRunId: positiveInteger(requireFlag('--actions-run-id')),
      runUrl: requireFlag('--run-url'),
      workflowSha: requireFlag('--workflow-sha'),
      writerContract: writerContractFromFlags(),
      startedAt: new Date().toISOString(),
    })
    phase = 'artifact-write'
    await atomicWriteJson(requireFlag('--start-out'), context)
    phase = 'summary-write'
    await appendSummary(`# OMA Maintainer Bot — STARTED\n\n- Actions run: ${context.runUrl}\n- Base SHA: ${context.baseSha}\n\nRuntime preflight is starting; no durable runKey exists yet.\n`)
    phase = 'output-write'
    await appendOutput([
      `base_sha=${context.baseSha}`,
      `claim_id=${context.claimId}`,
      `run_url=${context.runUrl}`,
      `execution_backend=${context.executionBackend}`,
      `start_hash=${context.artifactHash}`,
      'terminal_status=STARTED',
      '',
    ].join('\n'))
  } catch (error) {
    const failure = startFailure(error, phase)
    await appendStartFailureOutput(failure.stage, failure.detail)
    throw error
  }
}

async function prepare(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  clearGitHubTokens()
  const start = verifyStartContextHash(
    startContextSchema.parse(await readJson(requireFlag('--start'))),
    requireFlag('--start-hash'),
  )
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
    eventId: start.claimId,
    receivedAt: start.startedAt,
    claimId: start.claimId,
    actionsRunId: start.actionsRunId,
    runUrl: start.runUrl,
    baseShaHint: start.baseSha,
    eventSnapshotMatched: start.eventSnapshotMatched,
    writerContract: writerContractFromFlags(),
    removedBootstrapCommentCount: start.removedBootstrapCommentCount,
  })
  await atomicWriteJson(requireFlag('--activation-out'), context)
  await appendSummary(renderActionsSummary(context))
  await appendOutput([
    `should_run=${context.shouldRun}`,
    `execution_backend=${context.config?.executionBackend ?? start.executionBackend}`,
    `terminal_status=${publicActivationStatus(context.status)}`,
    `base_sha=${context.request?.baseSha ?? start.baseSha}`,
    '',
  ].join('\n'))
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
    maintainerRuntimeCli: flag('--maintainer-runtime-cli') === undefined
      ? undefined
      : resolve(requireFlag('--maintainer-runtime-cli')),
    deepSeekApiKey,
    sourceEnvironment: process.env,
  })
  if (result.attempted && result.status === 'FAILED') process.exitCode = 1
}

async function finalize(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  clearGitHubTokens()
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
  await appendOutput(`terminal_status=${publicActivationStatus(result.status)}\n`)
}

async function bootstrapFailure(): Promise<void> {
  const token = requireEnv('GITHUB_TOKEN')
  clearGitHubTokens()
  const event = await readJson(requireFlag('--event'))
  const result = await publishBootstrapFailure({
    event,
    github: new GitHubRestClient({ token }),
    actionsRunId: positiveInteger(requireFlag('--actions-run-id')),
    runUrl: requireFlag('--run-url'),
    stage: bootstrapFailureStageSchema.parse(requireFlag('--stage')),
    publishedAt: new Date().toISOString(),
  })
  await appendSummary(`# OMA Maintainer Bot — FAILED\n\n- Actions run: ${requireFlag('--run-url')}\n- Base SHA: ${result.baseSha}\n\n${result.detail}\n`)
  await appendOutput(`terminal_status=${result.status}\n`)
}

async function recoverStart(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  clearGitHubTokens()
  const [event, policy] = await Promise.all([
    readJson(requireFlag('--event')),
    loadProductionPolicy(requireFlag('--policy')),
  ])
  const result = await recoverStartFailure({
    event,
    github: new GitHubRestClient({ token }),
    policy,
    claimId: requireFlag('--claim-id'),
    actionsRunId: positiveInteger(requireFlag('--actions-run-id')),
    runUrl: requireFlag('--run-url'),
    writerContract: writerContractFromFlags(),
    failureStage: startFailureStageSchema.parse(requireFlag('--failure-stage')),
    failureDetail: requireFlag('--failure-detail'),
    recoveredAt: new Date().toISOString(),
  })
  await appendSummary(`# OMA Maintainer Bot — FAILED\n\n- Failure stage: ${result.stage}\n- Authoritative Issue state: ${result.authoritativeStatus}\n\n${result.detail}\n`)
  await appendOutput(`terminal_status=${result.status}\n`)
}

async function recover(): Promise<void> {
  const token = requireEnv('MAINTAINER_BOT_APP_TOKEN')
  clearGitHubTokens()
  const [event, startInput] = await Promise.all([
    readJson(requireFlag('--event')),
    readJson(requireFlag('--start')),
  ])
  const start = verifyStartContextHash(
    startContextSchema.parse(startInput),
    requireFlag('--start-hash'),
  )
  const result = await recoverWorkflowFailure({
    event,
    start,
    github: new GitHubRestClient({ token }),
    writerContract: writerContractFromFlags(),
    recoveredAt: new Date().toISOString(),
  })
  await appendSummary(`# OMA Maintainer Bot — ${result.status}\n\n${result.detail}\n`)
  await appendOutput(`terminal_status=${result.status}\n`)
}

function exitTerminal(): void {
  const status = requireFlag('--status')
  if (!['NEEDS_CLARIFICATION', 'MANUAL_ONLY', 'FAILED', 'DRAFT_PR_CREATED'].includes(status)) {
    throw new Error(`Expected a terminal public status, received ${JSON.stringify(status)}.`)
  }
  if (status === 'FAILED') process.exitCode = 1
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

function booleanFlag(name: string): boolean {
  const value = requireFlag(name)
  if (value === 'true') return true
  if (value === 'false' || value === '') return false
  throw new Error(`${name} must be exactly true or false.`)
}

function clearGitHubTokens(): void {
  delete process.env['MAINTAINER_BOT_APP_TOKEN']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
}

function startFailure(error: unknown, phase: StartFailureStage): { stage: StartFailureStage; detail: string } {
  if (error instanceof StartWorkflowError) return { stage: error.stage, detail: error.publicDetail }
  const detailByPhase: Record<StartFailureStage, string> = {
    'event-policy': 'The typed start command could not load the trusted event or production policy.',
    'app-identity': 'The typed start command could not verify the dedicated GitHub App identity.',
    'repository-metadata': 'The typed start command could not verify repository metadata.',
    'issue-snapshot': 'The typed start command could not verify the Issue snapshot.',
    'base-identity': 'The typed start command could not verify the default-branch base.',
    'local-checkout': 'The typed start command could not verify the local workflow checkout.',
    'status-preflight': 'The typed start command could not verify existing status state.',
    'status-write': 'The typed start command could not write and verify STARTED.',
    'artifact-write': 'STARTED was published, but the hash-bound start artifact could not be persisted.',
    'summary-write': 'STARTED and its hash-bound artifact were written, but the Actions summary could not be persisted.',
    'output-write': 'STARTED and its hash-bound artifact were written, but trusted step outputs could not be persisted.',
  }
  return { stage: phase, detail: detailByPhase[phase] }
}

async function appendStartFailureOutput(stage: StartFailureStage, detail: string): Promise<void> {
  try {
    await appendOutput(`failure_stage=${stage}\nfailure_detail=${sanitizePublicLine(detail)}\n`)
  } catch {
    // The workflow recovery step uses a bounded output-write fallback when GITHUB_OUTPUT itself is unavailable.
  }
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

start        Verify App/event/base identity and publish STARTED without establishing a durable runKey.
prepare      Re-fetch and validate an issues.labeled event, claim durable BOT state, and write activation input.
run-engine   Spawn the OMA Maintainer Bot in a credential-isolated child process.
finalize     Re-fetch every authorization fact, run the final safe-output gate, and create at most one Draft PR.
bootstrap-failure  Publish a non-authoritative repository-token failure notice when App start cannot run.
recover-start  Reverify the App/run/event and close or restore status when typed start fails without an artifact.
recover      Preserve terminal state or fail an active App claim after control-plane infrastructure failure.
exit-terminal  Exit unsuccessfully only for the public FAILED terminal state.

The GitHub App installation token is accepted only by start/recover-start/prepare/finalize/recover. Its expected App ID,
client ID, slug, installation ID, bot user ID, and operator enablement are verified before model execution
and again before the writer or recovery update. GITHUB_TOKEN is accepted only by bootstrap-failure;
DEEPSEEK_API_KEY is accepted only by run-engine.`)
}
