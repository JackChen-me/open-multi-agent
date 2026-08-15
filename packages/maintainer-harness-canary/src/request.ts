import { readFile, writeFile } from 'node:fs/promises'
import {
  canonicalJson,
  hashJson,
  pathWithin,
  type ValidationCommand,
} from '@open-multi-agent/maintainer-bot'
import { parseIssueMarkdown } from '@open-multi-agent/maintainer-host'
import {
  canaryPolicySchema,
  canaryRequestSchema,
  rawIssueSnapshotSchema,
  type CanaryPolicy,
  type CanaryRequest,
  type RawIssueSnapshot,
} from './schema.js'

export async function loadCanaryPolicy(path: string): Promise<CanaryPolicy> {
  return canaryPolicySchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export function computeCanarySnapshotRevision(snapshotInput: RawIssueSnapshot): string {
  const snapshot = rawIssueSnapshotSchema.parse(snapshotInput)
  return hashJson({
    schemaVersion: snapshot.schemaVersion,
    repository: snapshot.repository,
    issue: snapshot.issue,
    materialEvidence: snapshot.materialEvidence,
  })
}

export function deriveValidationCommands(
  policyInput: CanaryPolicy,
  allowedPaths: readonly string[],
): ValidationCommand[] {
  const policy = canaryPolicySchema.parse(policyInput)
  const commands = policy.validationRules
    .filter(rule => allowedPaths.some(path => pathWithin(path, rule.path) || pathWithin(rule.path, path)))
    .flatMap(rule => rule.validationCommands)
  if (commands.length === 0) throw new Error('No trusted canary validation rule covers the Issue targets.')
  const unique = new Map<string, ValidationCommand>()
  for (const command of commands) {
    const prior = unique.get(command.id)
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(command)) {
      throw new Error(`Canary policy reuses validation id with different commands: ${command.id}`)
    }
    if (prior === undefined) unique.set(command.id, command)
  }
  return [...unique.values()]
}

export function prepareCanaryRequest(
  snapshotInput: RawIssueSnapshot,
  policyInput: CanaryPolicy,
): CanaryRequest {
  const snapshot = rawIssueSnapshotSchema.parse(snapshotInput)
  const policy = canaryPolicySchema.parse(policyInput)
  if (snapshot.repository !== policy.repository) throw new Error('Snapshot repository differs from canary policy.')
  if (snapshot.issue.state !== 'open') throw new Error('Canary only accepts an open Issue.')
  if (!snapshot.issue.labels.includes('agent-ready')) throw new Error('Canary requires the current agent-ready label.')
  const parsed = parseIssueMarkdown(snapshot.issue.body)
  if (!parsed.ok) throw new Error(parsed.errors.map(error => error.message).join(' '))
  for (const path of parsed.value.targetPaths) {
    if (!policy.allowedPaths.some(allowed => pathWithin(path, allowed))) {
      throw new Error(`Issue target is outside the canary allowlist: ${path}`)
    }
    if (policy.protectedPaths.some(protectedPath => pathWithin(path, protectedPath))) {
      throw new Error(`Issue target is protected from canary writes: ${path}`)
    }
  }
  return canaryRequestSchema.parse({
    schemaVersion: 1,
    contract: 'oma-maintainer-harness-request-v1',
    repository: snapshot.repository,
    baseSha: snapshot.baseSha,
    canarySnapshotRevision: computeCanarySnapshotRevision(snapshot),
    materialEvidence: snapshot.materialEvidence,
    issue: {
      ...snapshot.issue,
      problem: parsed.value.problem,
      currentBehavior: parsed.value.currentBehavior,
      expectedBehavior: parsed.value.expectedBehavior,
      reproductionSteps: parsed.value.reproductionSteps,
      acceptanceCriteria: parsed.value.acceptanceCriteria,
      targetPaths: parsed.value.targetPaths,
      outOfScope: parsed.value.outOfScope,
    },
    allowedPaths: parsed.value.targetPaths,
    validationCommands: deriveValidationCommands(policy, parsed.value.targetPaths),
  })
}

export async function prepareCanaryRequestFile(options: {
  readonly snapshotPath: string
  readonly policyPath: string
  readonly outputPath: string
}): Promise<CanaryRequest> {
  const [snapshot, policy] = await Promise.all([
    readFile(options.snapshotPath, 'utf8').then(value => rawIssueSnapshotSchema.parse(JSON.parse(value))),
    loadCanaryPolicy(options.policyPath),
  ])
  const request = prepareCanaryRequest(snapshot, policy)
  await writeFile(options.outputPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 })
  return request
}
