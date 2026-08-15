#!/usr/bin/env node

import { appendFile } from 'node:fs/promises'
import type { OrchestratorEvent } from '@open-multi-agent/core'
import { NodeCommandRunner } from './command.js'
import { collectReleaseEvidence } from './evidence.js'
import { GitHubApiClient } from './github.js'
import { generateReleaseDecision } from './orchestrator.js'
import { prepareReleasePr } from './prepare.js'
import { publishRelease } from './publisher.js'
import { NpmRegistryClient } from './registry.js'

const command = process.argv[2] ?? 'help'
const taskStartTimes = new Map<string, number>()
const taskTitles = new Map<string, string>()

try {
  switch (command) {
    case 'plan':
      await plan()
      break
    case 'prepare-pr':
      await preparePr()
      break
    case 'publish':
      await publish()
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      throw new Error(`Unknown command "${command}". Run oma-release-bot help.`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`release-bot: ${message}`)
  await writeOutput('status', 'failed')
  await writeSummary(`## OMA release bot failed\n\n${escapeMarkdown(message)}\n`)
  process.exitCode = 1
}

async function plan(): Promise<void> {
  const runner = new NodeCommandRunner()
  const repoRoot = await resolveRepoRoot(runner)
  const apiKey = requireEnv('DEEPSEEK_API_KEY')
  const evidence = await collectReleaseEvidence(repoRoot, runner)
  const run = await generateReleaseDecision({
    repoRoot,
    runner,
    evidence,
    model: process.env['RELEASE_BOT_MODEL'],
    apiKey,
    onProgress: logProgress,
  })
  console.log(JSON.stringify(run, null, 2))
}

async function preparePr(): Promise<void> {
  const runner = new NodeCommandRunner()
  const repoRoot = await resolveRepoRoot(runner)
  const repository = requireEnv('GITHUB_REPOSITORY')
  const token = requireEnvEither('RELEASE_BOT_GITHUB_TOKEN', 'GITHUB_TOKEN')
  const github = new GitHubApiClient(
    repository,
    token,
    process.env['GITHUB_API_URL'],
  )
  const result = await prepareReleasePr({
    repoRoot,
    repository,
    baseBranch: process.env['RELEASE_BOT_BASE_BRANCH'] ?? 'main',
    runner,
    github,
    model: process.env['RELEASE_BOT_MODEL'],
    deepseekApiKey: requireEnv('DEEPSEEK_API_KEY'),
    validate: process.env['RELEASE_BOT_SKIP_VALIDATION'] !== '1',
    onProgress: logProgress,
  })

  await writeOutput('status', result.status)
  if (result.status === 'created' || result.status === 'recovered') {
    await writeOutput('pr_url', result.pullUrl)
    await writeOutput('pr_number', String(result.pullNumber))
    await writeOutput('branch', result.branch)
    await writeSummary(`## OMA release PR created\n\n- PR: [#${result.pullNumber}](${result.pullUrl})\n- Branch: \`${result.branch}\`\n- OMA tokens: ${result.run.tokenUsage.input_tokens} input / ${result.run.tokenUsage.output_tokens} output\n`)
    console.log(`Created release PR #${result.pullNumber}: ${result.pullUrl}`)
    return
  }

  await writeOutput('reason', result.reason)
  await writeSummary(`## OMA release bot: ${result.status}\n\n${escapeMarkdown(result.reason)}\n`)
  console.log(`${result.status}: ${result.reason}`)
  if (result.status === 'rejected') {
    throw new Error(`Release plan rejected: ${result.reason}`)
  }
}

async function publish(): Promise<void> {
  if (process.env['GITHUB_ACTIONS'] !== 'true' && process.env['RELEASE_BOT_ALLOW_LOCAL_PUBLISH'] !== '1') {
    throw new Error('Publishing is restricted to GitHub Actions. Set RELEASE_BOT_ALLOW_LOCAL_PUBLISH=1 only for an explicitly reviewed recovery.')
  }
  const runner = new NodeCommandRunner()
  const repoRoot = await resolveRepoRoot(runner)
  const repository = requireEnv('GITHUB_REPOSITORY')
  const token = requireEnvEither('RELEASE_BOT_GITHUB_TOKEN', 'GITHUB_TOKEN')
  const expectedSha = requireEnvEither('RELEASE_BOT_EXPECTED_SHA', 'GITHUB_SHA')
  const github = new GitHubApiClient(repository, token, process.env['GITHUB_API_URL'])
  const registry = new NpmRegistryClient(process.env['NPM_CONFIG_REGISTRY'])
  const result = await publishRelease({
    repoRoot,
    expectedSha,
    runner,
    github,
    registry,
  })

  await writeOutput('status', 'published')
  await writeOutput('tag', result.tag)
  await writeOutput('release_url', result.releaseUrl)
  const packageLines = result.packages
    .map(item => `- \`${item.name}@${item.version}\`: ${item.action}`)
    .join('\n')
  await writeSummary(`## OMA release published\n\n${packageLines}\n- Tag: \`${result.tag}\` (${result.tagAction})\n- GitHub Release: [${result.tag}](${result.releaseUrl}) (${result.releaseAction})\n`)
  console.log(JSON.stringify(result, null, 2))
}

async function resolveRepoRoot(runner: NodeCommandRunner): Promise<string> {
  return (await runner.run('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Required environment variable ${name} is not set.`)
  return value
}

function requireEnvEither(primary: string, fallback: string): string {
  return process.env[primary] || process.env[fallback] || requireEnv(primary)
}

function logProgress(event: OrchestratorEvent): void {
  const taskId = event.task ?? 'task'
  const title = readStringField(event.data, 'title')
  const effectiveTitle = title ?? taskTitles.get(taskId)
  const label = [event.agent, effectiveTitle ?? taskId].filter(Boolean).join(' · ')

  if (event.type === 'task_start') {
    taskStartTimes.set(taskId, Date.now())
    if (title !== undefined) taskTitles.set(taskId, title)
    console.log(`[OMA] start: ${label}`)
  }
  if (event.type === 'task_retry') {
    const attempt = readNumberField(event.data, 'attempt')
    const maxAttempts = readNumberField(event.data, 'maxAttempts')
    const delay = readNumberField(event.data, 'nextDelayMs')
    console.warn(
      `[OMA] retry: ${label}`
      + (attempt !== undefined && maxAttempts !== undefined ? ` (${attempt}/${maxAttempts})` : '')
      + (delay !== undefined ? ` after ${delay}ms` : ''),
    )
  }
  if (event.type === 'task_complete') {
    const startedAt = taskStartTimes.get(taskId)
    taskStartTimes.delete(taskId)
    taskTitles.delete(taskId)
    const duration = startedAt === undefined ? '' : ` in ${Date.now() - startedAt}ms`
    const tokenUsage = readObjectField(event.data, 'tokenUsage')
    const inputTokens = readNumberField(tokenUsage, 'input_tokens')
    const outputTokens = readNumberField(tokenUsage, 'output_tokens')
    const tokens = inputTokens === undefined || outputTokens === undefined
      ? ''
      : ` (${inputTokens} input / ${outputTokens} output tokens)`
    console.log(`[OMA] complete: ${label}${duration}${tokens}`)
  }
  if (event.type === 'task_skipped') {
    taskStartTimes.delete(taskId)
    taskTitles.delete(taskId)
    console.warn(`[OMA] skipped: ${label}`)
  }
  if (event.type === 'budget_exceeded') console.error(`[OMA] budget exceeded: ${label}`)
  if (event.type === 'warning') console.warn(`[OMA] warning: ${renderProgressData(event.data)}`)
  if (event.type === 'error') {
    taskStartTimes.delete(taskId)
    taskTitles.delete(taskId)
    console.error(`[OMA] error: ${label}${event.data === undefined ? '' : ` · ${renderProgressData(event.data)}`}`)
  }
}

function readObjectField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function readStringField(value: unknown, key: string): string | undefined {
  const field = readObjectField(value, key)
  return typeof field === 'string' ? field : undefined
}

function readNumberField(value: unknown, key: string): number | undefined {
  const field = readObjectField(value, key)
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function renderProgressData(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function writeOutput(name: string, value: string): Promise<void> {
  const path = process.env['GITHUB_OUTPUT']
  if (!path) return
  if (/[\r\n]/.test(value)) {
    const delimiter = `OMA_${Date.now()}_${Math.random().toString(16).slice(2)}`
    await appendFile(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
  } else {
    await appendFile(path, `${name}=${value}\n`)
  }
}

async function writeSummary(markdown: string): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path) await appendFile(path, markdown)
}

function escapeMarkdown(value: string): string {
  return value.replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;')
}

function printHelp(): void {
  console.log(`OMA release bot

Usage:
  oma-release-bot plan         Analyze merged changes without writing files
  oma-release-bot prepare-pr   Materialize an approved plan and create a ready PR
  oma-release-bot publish      Publish missing packages, then tag and create a GitHub Release

The planning path requires DEEPSEEK_API_KEY. GitHub mutations require a GitHub
App installation token in RELEASE_BOT_GITHUB_TOKEN. npm publication uses trusted
publishing (OIDC); no long-lived npm token is accepted by this bot.`)
}
