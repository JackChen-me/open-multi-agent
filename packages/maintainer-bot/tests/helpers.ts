import type { CommandRunner, CommandResult, RunCommandOptions } from '../src/command.js'
import { computeIssueRevision } from '../src/admission.js'
import {
  controlPlaneRequestSchema,
  maintainerConfigSchema,
  maintainerIssueSchema,
  type ControlPlaneRequest,
  type MaintainerConfig,
  type MaintainerIssue,
} from '../src/schema.js'

export const BASE_SHA = 'a'.repeat(40)

export function readyIssue(overrides: Partial<MaintainerIssue> = {}): MaintainerIssue {
  return maintainerIssueSchema.parse({
    repository: 'open-multi-agent/open-multi-agent',
    number: 101,
    title: 'Fix deterministic greeting output',
    body: 'The greeting output contains the wrong punctuation in one bounded fixture.',
    state: 'open',
    author: 'reporter',
    updatedAt: '2026-08-10T00:00:00.000Z',
    labels: ['agent-ready'],
    comments: [],
    kind: 'bug',
    problem: 'The deterministic greeting returns a period instead of the expected exclamation mark.',
    reproductionSteps: ['Call greeting("Ada") and compare the returned string.'],
    currentBehavior: 'The function returns "Hello, Ada.".',
    expectedBehavior: 'The function returns "Hello, Ada!".',
    acceptanceCriteria: [
      'greeting("Ada") returns exactly "Hello, Ada!".',
      'The focused greeting test passes without changing public APIs.',
    ],
    targetWorkspaces: ['@fixture/demo'],
    targetPaths: ['packages/demo/src/greeting.ts'],
    outOfScope: ['Do not change public exports or unrelated formatting.'],
    openDecisions: [],
    riskFlags: [],
    linkedPullRequests: [],
    blockers: [],
    ...overrides,
  })
}

export function authorizedRequest(
  issueOverrides: Partial<MaintainerIssue> = {},
  requestOverrides: Partial<ControlPlaneRequest> = {},
): ControlPlaneRequest {
  const issue = readyIssue(issueOverrides)
  const revision = computeIssueRevision(issue)
  return controlPlaneRequestSchema.parse({
    schemaVersion: 1,
    eventId: 'event-101',
    receivedAt: '2026-08-10T00:00:01.000Z',
    baseSha: BASE_SHA,
    issue,
    authorization: {
      kind: 'label',
      label: 'agent-ready',
      grantedBy: 'maintainer',
      grantedByPermission: 'write',
      issueRevision: revision,
      baseSha: BASE_SHA,
      grantedAt: '2026-08-10T00:00:00.500Z',
    },
    ...requestOverrides,
  })
}

export function testConfig(overrides: Partial<MaintainerConfig> = {}): MaintainerConfig {
  return maintainerConfigSchema.parse({
    schemaVersion: 1,
    policyVersion: 'policy-v1',
    promptVersion: 'prompt-v1',
    model: 'deepseek-v4-flash',
    allowedPaths: ['packages/demo'],
    protectedPaths: ['.git', '.github/workflows', 'package-lock.json'],
    context: {
      maxFiles: 80,
      maxBytes: 500_000,
      maxBytesPerFile: 100_000,
      maxHistoryEntries: 5,
    },
    edits: {
      maxFiles: 10,
      maxBytesPerFile: 100_000,
      maxTotalBytes: 300_000,
    },
    validationCommands: [{
      id: 'fixture-test',
      command: 'npm',
      args: ['test', '-w', '@fixture/demo'],
      cwd: '.',
      timeoutMs: 10_000,
    }],
    limits: {
      maxTokenBudget: 100_000,
      maxCostUsd: 5,
      runTimeoutMs: 60_000,
      maxRepairLoops: 2,
    },
    modelPricing: {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
    },
    ...overrides,
  })
}

export class ScriptedCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: RunCommandOptions }> = []

  constructor(
    private readonly handler: (
      command: string,
      args: readonly string[],
      options: RunCommandOptions,
    ) => Promise<CommandResult> | CommandResult,
  ) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options })
    return this.handler(command, args, options)
  }
}
