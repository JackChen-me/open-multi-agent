import { readFile } from 'node:fs/promises'
import {
  maintainerConfigSchema,
  pathWithin,
  type IssueRiskFlag,
  type MaintainerConfig,
} from '@open-multi-agent/maintainer-bot'
import {
  productionPolicySchema,
  type ProductionPolicy,
} from './schema.js'

export class ProductionPolicyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProductionPolicyError'
    this.code = code
  }
}

export async function loadProductionPolicy(path: string): Promise<ProductionPolicy> {
  return productionPolicySchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export function resolveTargetWorkspaces(
  policy: ProductionPolicy,
  targetPaths: readonly string[],
): string[] {
  const names = new Set<string>()
  for (const path of targetPaths) {
    const allowed = policy.allowedPaths.some(allowedPath => pathWithin(path, allowedPath))
    const manual = policy.manualOnlyPaths.some(manualPath => pathWithin(path, manualPath))
    const protectedPath = policy.protectedPaths.some(candidate => pathWithin(path, candidate))
    if (!allowed && !manual && !protectedPath) {
      throw new ProductionPolicyError(
        'TARGET_OUTSIDE_PRODUCTION_POLICY',
        `Target path is outside the trusted production allowlist: ${path}`,
      )
    }
    const matches = policy.workspaces.filter(workspace => pathWithin(path, workspace.root))
    if (matches.length === 0 && (manual || protectedPath)) {
      names.add('repository-control-plane')
      continue
    }
    if (matches.length !== 1) {
      throw new ProductionPolicyError(
        'TARGET_WORKSPACE_AMBIGUOUS',
        `Target path must resolve to exactly one trusted workspace policy: ${path}`,
      )
    }
    names.add(matches[0]!.name)
  }
  return [...names].sort()
}

export function buildProductionConfig(
  policy: ProductionPolicy,
  targetPaths: readonly string[],
): MaintainerConfig {
  if (!policy.enabled) throw new ProductionPolicyError('BOT_DISABLED', 'OMA Maintainer Bot is disabled by repository policy.')
  for (const path of targetPaths) {
    if (policy.protectedPaths.some(protectedPath => pathWithin(path, protectedPath))) {
      throw new ProductionPolicyError(
        'TARGET_PROTECTED_BY_PRODUCTION_POLICY',
        `Target path is protected by trusted repository policy: ${path}`,
      )
    }
    if (policy.manualOnlyPaths.some(manualPath => pathWithin(path, manualPath))) {
      throw new ProductionPolicyError(
        'TARGET_MANUAL_ONLY_BY_PRODUCTION_POLICY',
        `Target path is manual-only under trusted repository policy: ${path}`,
      )
    }
  }
  const workspaceNames = resolveTargetWorkspaces(policy, targetPaths)
  const ids = new Set(policy.alwaysValidationIds)
  for (const name of workspaceNames) {
    const workspace = policy.workspaces.find(candidate => candidate.name === name)!
    workspace.validationIds.forEach(id => ids.add(id))
    for (const rule of workspace.pathRules) {
      const matches = targetPaths.some(path => rule.kind === 'file'
        ? path === rule.path
        : pathWithin(path, rule.path))
      if (matches) rule.validationIds.forEach(id => ids.add(id))
    }
  }
  const registry = new Map(policy.validationRegistry.map(command => [command.id, command]))
  const validationCommands = [...ids]
    .map(id => {
      const command = registry.get(id)
      if (command === undefined) throw new ProductionPolicyError('UNKNOWN_VALIDATION', `Unknown trusted validation id: ${id}`)
      return command
    })
  return maintainerConfigSchema.parse({
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    promptVersion: policy.promptVersion,
    model: policy.model,
    agentReadyLabel: policy.agentReadyLabel,
    allowedPaths: policy.allowedPaths,
    protectedPaths: policy.protectedPaths,
    context: policy.context,
    edits: policy.edits,
    validationCommands,
    limits: policy.limits,
    modelPricing: policy.modelPricing,
  })
}

export function deriveRiskFlags(input: {
  readonly policy: ProductionPolicy
  readonly targetPaths: readonly string[]
  readonly targetWorkspaces: readonly string[]
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
}): IssueRiskFlag[] {
  const flags = new Set<IssueRiskFlag>()
  const text = `${input.title}\n${input.body}\n${input.labels.join(' ')}`.toLowerCase()
  const sensitivePaths = input.targetPaths.filter(path =>
    input.policy.manualOnlyPaths.some(manualPath => pathWithin(path, manualPath))
    || input.policy.protectedPaths.some(protectedPath => pathWithin(path, protectedPath)))
  for (const path of sensitivePaths) {
    if (path.startsWith('.github/') || path === '.github') flags.add('ci')
    else if (path.startsWith('.git') || path === '.env' || path === '.npmrc') flags.add('permissions')
    else if (path === 'SECURITY.md') flags.add('security')
    else if (path === 'LICENSE') flags.add('license')
    else if (/package(?:-lock)?\.json$/.test(path)) flags.add('dependency-compatibility-unknown')
    else if (path.startsWith('docs/durable-approvals') || path.startsWith('docs/egress-policy')) flags.add('permissions')
    else if (path.startsWith('packages/maintainer-host') || path.startsWith('packages/maintainer-bot/config')) flags.add('permissions')
    else if (path === 'AGENTS.md') flags.add('architecture')
    else flags.add('public-api-major')
  }
  if (/\bsecurity\b|\bvulnerabilit(?:y|ies)\b|\bcve-\d+/i.test(text)) flags.add('security')
  if (/\bpermissions?\b|\bauthori[sz]ation\b|\brbac\b/i.test(text)) flags.add('permissions')
  if (/\bprivacy\b|\bpersonal data\b|\bpii\b/i.test(text)) flags.add('privacy')
  if (/\blicen[cs]e\b|\bcopyright\b/i.test(text)) flags.add('license')
  if (/\brelease\b|\bpublish(?:ing)?\b|\bdeploy(?:ment)?\b/i.test(text)) flags.add('release')
  if (/\bbreaking change\b/i.test(text)) flags.add('breaking-change')
  if (/\bmajor public api\b|\bpublic api redesign\b/i.test(text)) flags.add('public-api-major')
  if (/\barchitecture decision\b|\bchoose (?:an? )?architecture\b/i.test(text)) flags.add('architecture')
  if (input.targetWorkspaces.length > 1) flags.add('cross-workspace-refactor')
  return [...flags].sort()
}

export function deterministicBranchName(
  policy: ProductionPolicy,
  issueNumber: number,
  issueRevision: string,
): string {
  const branch = `${policy.pullRequest.branchPrefix}${issueNumber}-${issueRevision.slice(0, 12)}`
  if (!/^agent\/issue-\d+-[0-9a-f]{12}$/.test(branch)) {
    throw new ProductionPolicyError('INVALID_BRANCH_NAME', 'Trusted policy produced an invalid branch name.')
  }
  return branch
}
