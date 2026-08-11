import { normalizeRepoPath } from '@open-multi-agent/maintainer-bot'

export interface ParsedIssueMarkdown {
  readonly problem: string
  readonly reproductionSteps: string[]
  readonly currentBehavior: string
  readonly expectedBehavior: string
  readonly acceptanceCriteria: string[]
  readonly targetPaths: string[]
  readonly outOfScope: string[]
  readonly openDecisions: string[]
  readonly blockers: string[]
}

export interface IssueMarkdownError {
  readonly code: string
  readonly message: string
}

export type IssueMarkdownResult =
  | { readonly ok: true; readonly value: ParsedIssueMarkdown }
  | { readonly ok: false; readonly errors: IssueMarkdownError[] }

const SECTION_ALIASES = {
  problem: ['describe the bug', 'problem'],
  reproduction: ['to reproduce', 'reproduction', 'reproduction steps'],
  current: ['current behavior'],
  expected: ['expected behavior'],
  acceptance: ['acceptance criteria'],
  targets: ['target paths'],
  outOfScope: ['out of scope'],
  openDecisions: ['open decisions'],
  blockers: ['blockers'],
} as const

export function parseIssueMarkdown(body: string): IssueMarkdownResult {
  const sections = splitSections(body)
  const errors: IssueMarkdownError[] = []
  const select = (key: keyof typeof SECTION_ALIASES, required: boolean): string => {
    const matches = SECTION_ALIASES[key]
      .filter(alias => sections.has(alias))
      .map(alias => sections.get(alias)!)
    if (matches.length > 1) {
      errors.push({
        code: `CONFLICTING_${key.toUpperCase()}_SECTIONS`,
        message: `Issue contains more than one ${key} section alias. Keep exactly one.`,
      })
      return ''
    }
    const value = matches[0]?.trim() ?? ''
    if (required && value.length === 0) {
      errors.push({
        code: `MISSING_${key.toUpperCase()}_SECTION`,
        message: `Issue requires a non-empty ${SECTION_ALIASES[key][0]} section.`,
      })
    }
    return value
  }

  const problem = normalizeProse(select('problem', true))
  const reproduction = normalizeProse(select('reproduction', false))
  const explicitCurrent = normalizeProse(select('current', false))
  const expectedBehavior = normalizeProse(select('expected', true))
  const acceptanceCriteria = parseList(select('acceptance', true))
  const rawTargets = parseList(select('targets', true))
  const outOfScope = parseList(select('outOfScope', true))
  const openDecisions = parseOptionalList(select('openDecisions', false))
  const blockers = parseOptionalList(select('blockers', false))

  if (acceptanceCriteria.length === 0) {
    errors.push({ code: 'MISSING_ACCEPTANCE_ITEMS', message: 'Acceptance criteria must contain bullet items.' })
  }
  if (rawTargets.length === 0) {
    errors.push({ code: 'MISSING_TARGET_PATH_ITEMS', message: 'Target paths must contain bullet items.' })
  }
  if (outOfScope.length === 0) {
    errors.push({ code: 'MISSING_OUT_OF_SCOPE_ITEMS', message: 'Out of scope must contain bullet items.' })
  }

  const targetPaths: string[] = []
  for (const raw of rawTargets) {
    const unquoted = raw.replace(/^`([^`]+)`$/, '$1').trim()
    try {
      if (/[*?\[\]{}!]/.test(unquoted)) throw new Error('globs and patterns are not allowed')
      const normalized = normalizeRepoPath(unquoted)
      if (normalized !== unquoted) {
        throw new Error('path must already be normalized')
      }
      targetPaths.push(normalized)
    } catch (error) {
      errors.push({
        code: 'INVALID_TARGET_PATH',
        message: `Invalid target path ${JSON.stringify(raw)}: ${error instanceof Error ? error.message : String(error)}.`,
      })
    }
  }
  if (new Set(targetPaths).size !== targetPaths.length) {
    errors.push({ code: 'DUPLICATE_TARGET_PATH', message: 'Target paths must be unique.' })
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      problem,
      reproductionSteps: reproduction.length === 0 ? [] : [reproduction],
      currentBehavior: explicitCurrent.length > 0 ? explicitCurrent : problem,
      expectedBehavior,
      acceptanceCriteria,
      targetPaths,
      outOfScope,
      openDecisions,
      blockers,
    },
  }
}

function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current: string | undefined
  let lines: string[] = []
  const flush = () => {
    if (current !== undefined && !sections.has(current)) sections.set(current, lines.join('\n').trim())
    lines = []
  }
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      flush()
      current = normalizeHeading(heading[1]!)
      continue
    }
    if (current !== undefined) lines.push(line)
  }
  flush()
  return sections
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ')
}

function normalizeProse(value: string): string {
  return value
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^```$/gm, '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseList(value: string): string[] {
  const items: string[] = []
  for (const line of value.split('\n')) {
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line)
    if (match === null) continue
    const normalized = match[1]!.replace(/^\[[ xX]\]\s*/, '').trim()
    if (normalized.length > 0 && !isNoneValue(normalized)) items.push(normalized)
  }
  return items
}

function parseOptionalList(value: string): string[] {
  if (value.trim().length === 0 || isNoneValue(value.trim())) return []
  const items = parseList(value)
  return items.length > 0 ? items : [normalizeProse(value)]
}

function isNoneValue(value: string): boolean {
  return /^(?:none|n\/a|not applicable|无)[.!。！]?$/i.test(value.trim())
}
