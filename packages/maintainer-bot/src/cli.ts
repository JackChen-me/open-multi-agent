#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { computeIssueRevision, evaluateAdmission } from './admission.js'
import { NodeCommandRunner } from './command.js'
import { runMaintainerBot } from './pipeline.js'
import {
  controlPlaneRequestSchema,
  maintainerConfigSchema,
  maintainerIssueSchema,
  type ControlPlaneRequest,
} from './schema.js'
import { FileRunStateStore } from './state.js'
import { readProviderKeyFromFd } from './provider-key.js'

const command = process.argv[2] ?? 'help'
const runner = new NodeCommandRunner()

try {
  switch (command) {
    case 'admit':
      await admit()
      break
    case 'dry-run':
      await execute(true)
      break
    case 'run':
      await execute(false)
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      throw new Error(`Unknown command "${command}". Run oma-maintainer-bot help.`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`maintainer-bot: ${redact(message)}`)
  process.exitCode = 1
}

async function admit(): Promise<void> {
  const repoRoot = await resolveRepoRoot()
  const request = await loadRequest(requireFlag('--request'), repoRoot)
  console.log(JSON.stringify(evaluateAdmission(request), null, 2))
}

async function execute(dryRun: boolean): Promise<void> {
  const repoRoot = await resolveRepoRoot()
  const request = await loadRequest(requireFlag('--request'), repoRoot)
  const config = maintainerConfigSchema.parse(await readJson(requireFlag('--config')))
  const stateDir = dryRun
    ? resolve(flag('--state-dir') ?? '/tmp/oma-maintainer-bot-dry-run-state')
    : resolve(requireFlag('--state-dir'))
  const artifactDir = dryRun
    ? resolve(flag('--artifact-dir') ?? '/tmp/oma-maintainer-bot-dry-run-artifacts')
    : resolve(requireFlag('--artifact-dir'))
  const runId = flag('--run-id') ?? `local-${request.issue.number}-${Date.now()}`
  const result = await runMaintainerBot({
    repoRoot,
    artifactDir,
    request,
    config,
    runner,
    stateStore: new FileRunStateStore(stateDir),
    runId,
    dryRun,
    env: process.env,
    apiKey: dryRun ? undefined : readProviderKeyFromFd(requireFlag('--provider-key-fd')),
    claudeCodeHarnessCli: flag('--claude-code-harness-cli'),
    onProgress: event => {
      if (event.type === 'task_start' || event.type === 'task_complete' || event.type === 'error') {
        console.error(`[OMA] ${event.type}: ${event.agent ?? event.task ?? 'task'}`)
      }
    },
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'FAILED') process.exitCode = 1
}

async function resolveRepoRoot(): Promise<string> {
  const explicit = flag('--repo')
  if (explicit !== undefined) return resolve(explicit)
  return (await runner.run('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
}

async function loadRequest(path: string, repoRoot: string): Promise<ControlPlaneRequest> {
  const raw = await readJson(path) as Record<string, unknown>
  const head = (await runner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
  const rawAuthorization = raw['authorization'] as Record<string, unknown> | null | undefined
  const withHead: Record<string, unknown> = {
    ...raw,
    baseSha: raw['baseSha'] === '$HEAD' ? head : raw['baseSha'],
    authorization: rawAuthorization === null || rawAuthorization === undefined
      ? rawAuthorization
      : {
          ...rawAuthorization,
          baseSha: rawAuthorization['baseSha'] === '$HEAD' ? head : rawAuthorization['baseSha'],
        },
  }
  const issue = maintainerIssueSchema.parse(withHead['issue'])
  const issueRevision = computeIssueRevision(issue)
  const authorization = withHead.authorization as Record<string, unknown> | null | undefined
  return controlPlaneRequestSchema.parse({
    ...withHead,
    authorization: authorization === null || authorization === undefined
      ? authorization
      : {
          ...authorization,
          issueRevision: authorization['issueRevision'] === '$ISSUE_REVISION'
            ? issueRevision
            : authorization['issueRevision'],
        },
  })
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
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

function redact(value: string): string {
  return value.replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
}

function printHelp(): void {
  console.log(`OMA Maintainer Bot

Usage:
  oma-maintainer-bot admit --request request.json [--repo PATH]
  oma-maintainer-bot dry-run --request request.json --config config.json [--repo PATH]
  oma-maintainer-bot run --request request.json --config config.json --state-dir PATH --artifact-dir PATH --provider-key-fd FD [--repo PATH] [--run-id ID]

admit and dry-run are read-only. run receives the provider credential through a dedicated file descriptor and refuses to
start if GitHub/npm write credentials are present in the model process. It may
edit only an already-isolated clean worktree and produces a local Draft PR
proposal; it never calls GitHub, creates a branch, commits, pushes, or opens a PR.`)
}
