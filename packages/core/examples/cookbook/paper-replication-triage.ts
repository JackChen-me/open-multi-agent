/**
 * Paper Replication Triage (Multi-Source Evidence Reconciliation)
 *
 * Demonstrates:
 * - Source-specific agents audit different evidence snapshots, not one shared PDF
 * - runTasks() DAG: parallel source audits -> dependent replication planner
 * - Shared memory/dependency context carries upstream JSON into the planner
 * - Seeded conflicts force the planner to reconcile paper claims vs artifacts
 * - Mocked source snapshots are flagged; SOURCE_MODE=live uses Asta + GitHub
 *
 * Run:
 *   npx tsx packages/core/examples/cookbook/paper-replication-triage.ts
 *   npx tsx packages/core/examples/cookbook/paper-replication-triage.ts "paper title or arXiv id"
 *
 * Optional:
 *   SOURCE_MODE=live npx tsx packages/core/examples/cookbook/paper-replication-triage.ts "ARXIV:1706.03762"
 *
 * Prerequisites:
 *   LLM_PROVIDER=anthropic (default) requires ANTHROPIC_API_KEY.
 *   Other supported values: openai, gemini, groq, openrouter.
 *   Gemini accepts GEMINI_API_KEY or GOOGLE_API_KEY.
 *   SOURCE_MODE=live requires ASTA_API_KEY. GITHUB_TOKEN is optional but recommended.
 *   The live Asta path uses the optional @modelcontextprotocol/sdk peer dependency.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'
import { OpenMultiAgent } from '../../src/index.js'
import type { AgentConfig, OrchestratorEvent, TaskExecutionRecord } from '../../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, '../fixtures/paper-replication-triage')

const DEFAULT_QUERY = 'SparseCheck: Calibrated Retrieval for Low-Resource Scientific QA'
const PAPER_QUERY = process.argv[2] ?? DEFAULT_QUERY
const REPO_EVIDENCE_LIMIT = 3
const REPO_DISCOVERY_FETCH_LIMIT = 6
const SUPPORT_FILE_EXCERPT_LIMIT = 450
const README_EXCERPT_LIMIT = 1400
const ISSUE_BODY_EXCERPT_LIMIT = 360
const RELEVANT_PATH_LIMIT = 60
const ISSUE_EVIDENCE_LIMIT = 6
const DATASET_CANDIDATE_LIMIT_PER_REPO = 8
const DATASET_CANDIDATE_MIN_CONFIDENCE = 0.65
const DATASET_CONTEXT_LINE_LIMIT = 4
const DATASET_RELATED_PATH_LIMIT = 12

type SourceMode = 'mock' | 'live'
type ProviderChoice = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'openrouter'
type SnippetSearchScope = 'paper_scoped' | 'global_unscoped'
type PaperMetadataScope = 'target_scoped' | 'unresolved_unscoped'

interface SourceBundle {
  mode: SourceMode
  query: string
  sourceIndex: unknown
  scholarlyMetadata: unknown
  codeArtifacts: unknown
  datasetArtifacts: unknown
  citationFeedback: unknown
  sourceDigest?: SourceDigest
}

interface SourceDigest {
  paper: {
    title: string
    url: string
    venue_or_year: string
  }
  repositories: Array<{
    repository: string
    url: string
    description: string
    relationship_hints: string[]
    useful_paths: string[]
    issue_signals: Array<{
      title: string
      url: string
    }>
  }>
  datasets: Array<{
    name: string
    evidence: string
    source: string
  }>
  dataset_snippet_mentions: string[]
  reproduction_signals: Array<{
    title: string
    url: string
    source: string
  }>
}

interface ProviderSettings {
  label: ProviderChoice
  provider: NonNullable<AgentConfig['provider']>
  model: string
  baseURL?: string
  apiKey?: string
  missingEnv?: string
}

type DatasetEvidenceKind =
  | 'cli_arg'
  | 'data_path'
  | 'repository_path'
  | 'readme_line'
  | 'support_file_line'

interface DatasetCandidateEvidence {
  name: string
  evidence_kind: string
  source_path: string
  evidence: string
  confidence: number
}

interface MCPClientLike {
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>
  close?: () => Promise<void>
}

interface LivePaperIdentity {
  resolvedPaperId?: string
  targetPaperMetadata?: unknown
  metadataScope: PaperMetadataScope
  note: string
}

type MCPClientConstructor = new (
  info: { name: string; version: string },
  options: { capabilities: Record<string, unknown> },
) => MCPClientLike

type StreamableHTTPClientTransportConstructor = new (
  url: URL,
  opts?: { requestInit?: RequestInit },
) => unknown

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

function resolveProvider(): ProviderSettings {
  const raw = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() as ProviderChoice
  const modelOverride = process.env.LLM_MODEL

  switch (raw) {
    case 'openai':
      return {
        label: 'openai',
        provider: 'openai',
        model: modelOverride ?? 'gpt-4o-mini',
        baseURL: process.env.OPENAI_BASE_URL,
        missingEnv: process.env.OPENAI_API_KEY ? undefined : 'OPENAI_API_KEY',
      }
    case 'gemini':
      return {
        label: 'gemini',
        provider: 'gemini',
        model: modelOverride ?? 'gemini-2.5-flash',
        missingEnv: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
          ? undefined
          : 'GEMINI_API_KEY or GOOGLE_API_KEY',
      }
    case 'groq':
      return {
        label: 'groq',
        provider: 'openai',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        model: modelOverride ?? 'llama-3.3-70b-versatile',
        missingEnv: process.env.GROQ_API_KEY ? undefined : 'GROQ_API_KEY',
      }
    case 'openrouter':
      return {
        label: 'openrouter',
        provider: 'openai',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        model: modelOverride ?? 'openai/gpt-4o-mini',
        missingEnv: process.env.OPENROUTER_API_KEY ? undefined : 'OPENROUTER_API_KEY',
      }
    case 'anthropic':
    default:
      return {
        label: 'anthropic',
        provider: 'anthropic',
        model: modelOverride ?? 'claude-sonnet-4-6',
        missingEnv: process.env.ANTHROPIC_API_KEY ? undefined : 'ANTHROPIC_API_KEY',
      }
  }
}

const PROVIDER = resolveProvider()

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

function readJson<T = unknown>(name: string): T {
  const filePath = path.join(FIXTURE_DIR, name)
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T
}

function resolveSourceMode(): SourceMode {
  const raw = (process.env.SOURCE_MODE ?? 'mock').toLowerCase()
  if (raw === 'live') return 'live'
  if (raw !== 'mock') {
    console.warn(`[warn] Unknown SOURCE_MODE=${raw}; falling back to mock snapshots.`)
  }
  return 'mock'
}

function loadMockSourceBundle(query: string): SourceBundle {
  return {
    mode: 'mock',
    query,
    sourceIndex: readJson('source-index.json'),
    scholarlyMetadata: readJson('scholarly-metadata.json'),
    codeArtifacts: readJson('code-artifacts.json'),
    datasetArtifacts: readJson('dataset-artifacts.json'),
    citationFeedback: readJson('citation-feedback.json'),
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | undefined> {
  try {
    const response = await fetch(url, { headers })
    if (!response.ok) {
      return undefined
    }
    return await response.json() as T
  } catch {
    return undefined
  }
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers })
    if (!response.ok) {
      return undefined
    }
    return await response.text()
  } catch {
    return undefined
  }
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function compactText(text: string, maxLength = 180): string {
  const compacted = text.replace(/\s+/g, ' ').trim()
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 3)}...` : compacted
}

function uniqueStrings(values: string[], limit = values.length): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    result.push(normalized)
    if (result.length >= limit) break
  }
  return result
}

function normalizeTitleForCompare(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactSearchItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    full_name: getString(item, 'full_name'),
    html_url: getString(item, 'html_url'),
    description: getString(item, 'description'),
    stargazers_count: getNumber(item, 'stargazers_count'),
    pushed_at: getString(item, 'pushed_at'),
    default_branch: getString(item, 'default_branch'),
  }
}

function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    acc.push(value)
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc)
    return acc
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectStrings(child, acc)
    }
  }
  return acc
}

function findFirstNumberByKey(value: unknown, keyName: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumberByKey(item, keyName)
      if (found !== undefined) return found
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  const direct = record[keyName]
  if (typeof direct === 'number') return direct

  for (const child of Object.values(record)) {
    const found = findFirstNumberByKey(child, keyName)
    if (found !== undefined) return found
  }
  return undefined
}

function findFirstStringByKey(value: unknown, keyName: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, keyName)
      if (found) return found
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  const direct = record[keyName]
  if (typeof direct === 'string' && direct.trim() !== '') return direct

  for (const child of Object.values(record)) {
    const found = findFirstStringByKey(child, keyName)
    if (found) return found
  }
  return undefined
}

function extractCandidateTerms(text: string): string[] {
  const stop = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'that',
    'this',
    'paper',
    'using',
    'based',
    'model',
    'models',
    'method',
    'methods',
    'learning',
  ])
  const terms = new Set<string>()
  const hyphenated = text.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g) ?? []
  const acronyms = text.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? []

  for (const term of [...hyphenated, ...acronyms]) {
    const normalized = term.trim()
    if (normalized.length < 3 || normalized.length > 40) continue
    if (stop.has(normalized.toLowerCase())) continue
    terms.add(normalized)
  }

  return Array.from(terms).slice(0, 6)
}

function extractGithubRepoFullNames(value: unknown): string[] {
  const text = collectStrings(value).join('\n')
  const matches = text.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)
  const repos = new Set<string>()
  for (const match of matches) {
    repos.add(match[1].replace(/\.git$/i, ''))
  }
  return Array.from(repos).slice(0, 5)
}

function buildGitHubSearchQueries(query: string, targetPaperMetadata: unknown): string[] {
  const title = findFirstStringByKey(targetPaperMetadata, 'title')
  const text = collectStrings(targetPaperMetadata).join('\n')
  const queries = new Set<string>()

  for (const candidate of [title, query]) {
    const trimmed = candidate?.trim()
    if (!trimmed) continue
    queries.add(`"${trimmed}" in:readme`)
    queries.add(`${trimmed} in:name,readme`)
  }

  for (const term of extractCandidateTerms(text)) {
    queries.add(`${term} in:name,readme`)
  }

  return Array.from(queries).slice(0, 8)
}

function textContainsNormalizedPhrase(text: string, phrase: string): boolean {
  const normalizedPhrase = normalizeTitleForCompare(phrase)
  if (normalizedPhrase.length < 3) return false
  return normalizeTitleForCompare(text).includes(normalizedPhrase)
}

function textMentionsTarget(text: string, target: string): boolean {
  if (textContainsNormalizedPhrase(text, target)) return true

  const terms = extractCandidateTerms(target)
  return terms.some((term) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(term)}([^A-Za-z0-9]|$)`, 'i')
    return pattern.test(text)
  })
}

function textWindow(text: string, index: number, before = 240, after = 240): string {
  return text.slice(Math.max(0, index - before), Math.min(text.length, index + after))
}

function hasNegatedOfficialPrefix(text: string, index: number, matchLength: number): boolean {
  const local = text.slice(Math.max(0, index - 48), index + matchLength).toLowerCase()
  return /\b(?:un|non)[-\s]?official\b/.test(local)
    || /\bnot\s+(?:an?\s+|the\s+)?official\b/.test(local)
    || /\bno\s+official\b/.test(local)
    || /\bwithout\s+(?:an?\s+|the\s+)?official\b/.test(local)
}

function nonOfficialClaimNearTarget(text: string, target: string | undefined): boolean {
  const nonOfficialPattern =
    /\b(?:(?:un|non)[-\s]?official|third[-\s]?party|community|independent)\s+(?:implementation|code|repo(?:sitory)?|release|reproduction)\b|\bnot\s+(?:an?\s+|the\s+)?official\s+(?:implementation|code|repo(?:sitory)?|release)\b/gi
  const matches = [...text.matchAll(nonOfficialPattern)]
  if (matches.length === 0) return false
  if (!target) return true

  return matches.some((match) => {
    const index = match.index ?? 0
    return textMentionsTarget(textWindow(text, index), target)
  })
}

function officialClaimNearTarget(text: string, target: string | undefined): boolean {
  const officialPattern =
    /\bofficial(?:\s+(?:implementation|code|repo(?:sitory)?|github|release))?\b|\bauthors?['’]?\s+(?:implementation|code|repo(?:sitory)?|release)\b/gi
  const matches = [...text.matchAll(officialPattern)]
  if (matches.length === 0) return false

  return matches.some((match) => {
    const index = match.index ?? 0
    const matchText = match[0] ?? ''
    if (hasNegatedOfficialPrefix(text, index, matchText.length)) return false
    if (!target) return true
    return textMentionsTarget(textWindow(text, index), target)
  })
}

async function fetchGitHubSearch(
  rawQuery: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  return fetchJson<Record<string, unknown>>(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(rawQuery)}&per_page=5`,
    headers,
  )
}

function rawGitHubFileUrl(fullName: string, branch: string, filePath: string): string {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${fullName}/${encodedBranch}/${encodedPath}`
}

function scoreSupportFilePath(filePath: string): number {
  if (/package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.png$|\.jpg$|\.jpeg$|\.gif$/i.test(filePath)) return 0

  let score = 0
  if (/README/i.test(filePath)) score += 4
  if (/(^|\/)scripts?\//i.test(filePath)) score += 5
  if (/(^|\/)(configs?|experiments?)\//i.test(filePath)) score += 4
  if (/(^|\/)(data|datasets?|download|prepare|preprocess)/i.test(filePath)) score += 4
  if (/(train|training|eval|evaluation|metrics?|run|launch)/i.test(filePath)) score += 3
  if (/\.(sh|py|yaml|yml|json|md)$/i.test(filePath)) score += 2
  return score
}

function selectSupportFilePaths(paths: string[]): string[] {
  return paths
    .filter((filePath) =>
      /README|scripts?|configs?|experiments?|data|datasets?|download|prepare|preprocess|train|training|eval|evaluation|metrics?|run|launch/i.test(filePath)
      || /\.(sh|py|yaml|yml|json|md)$/i.test(filePath),
    )
    .map((filePath) => ({ filePath, score: scoreSupportFilePath(filePath) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .map((item) => item.filePath)
    .slice(0, 4)
}

const DATASET_NAME_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'arg',
  'args',
  'benchmark',
  'benchmarks',
  'benchmark.md',
  'config',
  'custom',
  'data',
  'dataset',
  'datasets',
  'data_path',
  'default',
  'download',
  'driven',
  'feature',
  'features',
  'file',
  'input',
  'input_size',
  'label',
  'loader',
  'main',
  'model',
  'path',
  'predict',
  'predict_step',
  'processed',
  'readme',
  'readme.md',
  'root',
  'root_path',
  'script',
  'target',
  'task',
  'task_id',
  'term',
  'then',
  'test',
  'the',
  'train',
  'training',
  'valid',
  'validation',
])

function normalizeDatasetCandidate(raw: string, evidenceKind: DatasetEvidenceKind): string | undefined {
  const fromPath = raw.split(/[\\/]/).filter(Boolean).at(-1) ?? raw
  const cleaned = fromPath
    .replace(/^[-/\s]+/, '')
    .replace(/\.(csv|tsv|txt|npy|npz|pkl|h5|json|md|py|sh|yaml|yml)$/i, '')
    .replace(/["'`),\]]+$/g, '')
    .replace(/^\[|\]$/g, '')
    .trim()
  if (cleaned.length < 3 || cleaned.length > 60) return undefined
  if (cleaned.includes('=')) return undefined
  if (/^-/.test(cleaned)) return undefined

  const lower = cleaned.toLowerCase()
  if (DATASET_NAME_STOPWORDS.has(lower)) return undefined
  if (/^(arg|args|cfg|config|param|kwargs?)[_.-]/i.test(cleaned)) return undefined
  if (/(^|_)(path|size|len|length|step|id|type|flag|mode|root|features?)$/i.test(cleaned)) return undefined
  if (/^\d+$/.test(cleaned)) return undefined

  const highPrecisionSource = evidenceKind === 'cli_arg'
    || evidenceKind === 'data_path'
    || evidenceKind === 'repository_path'
  const hasDigit = /\d/.test(cleaned)
  const isAcronym = /^[A-Z][A-Z0-9-]{2,}$/.test(cleaned)
  const isMixedCaseIdentifier = /^[A-Z][A-Za-z]+[A-Z0-9][A-Za-z0-9-]*$/.test(cleaned)
  const isCompoundDatasetLike = /^[A-Z][A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(cleaned)
  const isTitleCaseWord = /^[A-Z][a-z][A-Za-z0-9-]{2,}$/.test(cleaned)
  const isPlainLowercaseWord = /^[a-z][a-z0-9-]{2,}$/.test(cleaned)
  const looksLikeMethodOrVenue = /(?:benchmark|baseline|linear|transformer|former|forecast|lookback|window|aaai|neurips|icml|iclr|acl|cvpr|emnlp)$/i.test(cleaned)
    || /(?:benchmark|linear|transformer|former|forecasting|lookback|window)/i.test(cleaned)
  const isAmbiguousShortAcronym = isAcronym && cleaned.length <= 3 && !highPrecisionSource
  const isLongAcronym = isAcronym && cleaned.length > 3

  if (isAmbiguousShortAcronym) return undefined
  if (looksLikeMethodOrVenue && !['cli_arg', 'data_path'].includes(evidenceKind)) return undefined

  if (
    !hasDigit
    && !isLongAcronym
    && !isMixedCaseIdentifier
    && !isCompoundDatasetLike
    && !isTitleCaseWord
    && !(highPrecisionSource && isPlainLowercaseWord)
  ) {
    return undefined
  }

  return cleaned
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function datasetEvidenceBaseConfidence(evidenceKind: DatasetEvidenceKind): number {
  switch (evidenceKind) {
    case 'cli_arg':
      return 0.72
    case 'data_path':
      return 0.68
    case 'repository_path':
      return 0.58
    case 'support_file_line':
      return 0.54
    case 'readme_line':
      return 0.54
  }
}

function datasetEvidenceConfidence(
  name: string,
  evidenceKind: DatasetEvidenceKind,
  evidence: string,
): number {
  let confidence = datasetEvidenceBaseConfidence(evidenceKind)
  if (new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}\\.(csv|tsv|txt|npy|npz|pkl|h5|json)([^A-Za-z0-9]|$)`, 'i').test(evidence)) {
    confidence += 0.12
  }
  if (/dataset|benchmark|download|split|train|test|validation/i.test(evidence)) {
    confidence += 0.08
  }
  if (/--data(?:set)?|--data_path|data_path|root_path/i.test(evidence)) {
    confidence += 0.08
  }
  return Math.min(0.95, Number(confidence.toFixed(2)))
}

function makeDatasetCandidateEvidence(
  rawName: string,
  evidenceKind: DatasetEvidenceKind,
  sourcePath: string,
  evidence: string,
): DatasetCandidateEvidence | undefined {
  const name = normalizeDatasetCandidate(rawName, evidenceKind)
  if (!name) return undefined
  return {
    name,
    evidence_kind: evidenceKind,
    source_path: sourcePath,
    evidence: compactText(evidence, 220),
    confidence: datasetEvidenceConfidence(name, evidenceKind, evidence),
  }
}

function extractDatasetCandidateEvidenceFromText(
  text: string,
  sourcePath: string,
  defaultEvidenceKind: DatasetEvidenceKind,
): DatasetCandidateEvidence[] {
  const candidates: DatasetCandidateEvidence[] = []
  const patterns: Array<{ kind: DatasetEvidenceKind, regex: RegExp }> = [
    { kind: 'cli_arg', regex: /--data(?:set)?(?:\s+|=)["']?([A-Za-z0-9_.-]{3,60})/gi },
    { kind: 'data_path', regex: /--data_path(?:\s+|=)["']?([A-Za-z0-9_./-]+\.(?:csv|tsv|txt|npy|npz|pkl|h5|json))/gi },
    { kind: 'data_path', regex: /\b(?:data_path|filename|file_name|target_file)\s*[:=]\s*["']?([A-Za-z0-9_./-]+\.(?:csv|tsv|txt|npy|npz|pkl|h5|json))/gi },
    { kind: defaultEvidenceKind, regex: /\b(?:dataset|data source|data file|benchmark dataset|dataset name)\b[^\n:=]{0,24}[:=]\s*["'`]?([A-Za-z0-9_.-]{3,60})/gi },
    { kind: 'repository_path', regex: /(?:^|\/)(?:data|datasets?)\/([A-Za-z0-9_.-]{3,60})(?:\/|\.|$)/gi },
  ]

  for (const { kind, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      const raw = match[1]
      if (!raw) continue
      const candidate = makeDatasetCandidateEvidence(raw, kind, sourcePath, match[0])
      if (candidate) candidates.push(candidate)
    }
  }

  return candidates
}

function extractDatasetCandidateEvidenceFromPaths(paths: string[]): DatasetCandidateEvidence[] {
  const candidates: DatasetCandidateEvidence[] = []
  for (const filePath of paths) {
    const pathParts = filePath.split('/').filter(Boolean)
    const datasetDirIndex = pathParts.findIndex((part) => /^datasets?$/i.test(part))
    if (datasetDirIndex >= 0 && pathParts[datasetDirIndex + 1]) {
      const candidate = makeDatasetCandidateEvidence(pathParts[datasetDirIndex + 1], 'repository_path', filePath, filePath)
      if (candidate) candidates.push(candidate)
    }

    const basename = pathParts.at(-1) ?? filePath
    if (/\.(csv|tsv|txt|npy|npz|pkl|h5|json)$/i.test(basename) && /(^|\/)(data|datasets?|benchmark)/i.test(filePath)) {
      const candidate = makeDatasetCandidateEvidence(basename, 'data_path', filePath, filePath)
      if (candidate) candidates.push(candidate)
    }

    if (/(^|\/)(scripts?|experiments?)\//i.test(filePath) && /\.(sh|py|yaml|yml|json)$/i.test(basename)) {
      const candidate = makeDatasetCandidateEvidence(basename, 'repository_path', filePath, filePath)
      if (candidate) candidates.push(candidate)
    }
  }
  return candidates
}

function summarizeDatasetCandidates(
  evidenceItems: DatasetCandidateEvidence[],
  limit = DATASET_CANDIDATE_LIMIT_PER_REPO,
): DatasetCandidateEvidence[] {
  const byName = new Map<string, DatasetCandidateEvidence & { evidence_count: number }>()

  for (const item of evidenceItems) {
    const key = item.name.toLowerCase()
    const current = byName.get(key)
    if (!current) {
      byName.set(key, { ...item, evidence_count: 1 })
      continue
    }

    const sourceKinds = new Set(current.evidence_kind.split('+'))
    sourceKinds.add(item.evidence_kind)
    current.evidence_kind = Array.from(sourceKinds).join('+')
    current.evidence_count += 1
    current.confidence = Math.min(
      0.98,
      Number((Math.max(current.confidence, item.confidence) + Math.min(0.2, current.evidence_count * 0.04)).toFixed(2)),
    )
    if (!current.evidence.includes(item.evidence)) {
      current.evidence = compactText(`${current.evidence} | ${item.evidence}`, 260)
    }
    if (!current.source_path.includes(item.source_path)) {
      current.source_path = compactText(`${current.source_path}; ${item.source_path}`, 180)
    }
  }

  return Array.from(byName.values())
    .filter((item) =>
      item.confidence >= DATASET_CANDIDATE_MIN_CONFIDENCE
      || (item.evidence_count >= 2 && item.confidence >= 0.58),
    )
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .map(({ evidence_count: _evidenceCount, ...item }) => item)
    .slice(0, limit)
}

function extractDatasetMentionsFromAstaSnippets(value: unknown): string[] {
  const mentions: string[] = []
  const text = collectStrings(value)
    .filter((item) => /dataset|benchmark|forecast|time[- ]series|long[- ]term|experiment|result/i.test(item))
    .join('\n')
  const contextPatterns = [
    /\b(?:on|across|over|using|with|from)\s+([A-Za-z][A-Za-z0-9_.-]{2,60}(?:\s*(?:,|and|\/)\s*[A-Za-z][A-Za-z0-9_.-]{2,60}){0,6})/gi,
    /\b(?:datasets?|benchmarks?)\s*(?:include|includes|including|are|:)\s+([A-Za-z][A-Za-z0-9_.-]{2,60}(?:\s*(?:,|and|\/)\s*[A-Za-z][A-Za-z0-9_.-]{2,60}){0,10})/gi,
  ]

  for (const pattern of contextPatterns) {
    for (const match of text.matchAll(pattern)) {
      const list = match[1] ?? ''
      for (const rawName of list.split(/\s*(?:,|and|\/)\s*/)) {
        const candidate = normalizeDatasetCandidate(rawName, 'readme_line')
        if (candidate) mentions.push(candidate)
      }
    }
  }

  return uniqueStrings(mentions, 12)
}

async function fetchGitHubRepoEvidence(
  input: Record<string, unknown> | string,
  headers: Record<string, string>,
  sourceQuery?: string,
): Promise<Record<string, unknown> | undefined> {
  const fullName = typeof input === 'string' ? input : getString(input, 'full_name')
  if (!fullName) return undefined

  const apiBase = `https://api.github.com/repos/${fullName}`
  const issueQueries = ['reproduce', 'reproduction', 'result', 'dataset', 'metric']
  const repo = typeof input === 'string'
    ? await fetchJson<Record<string, unknown>>(apiBase, headers)
    : input
  const repoRecord = repo ?? (typeof input === 'string' ? { full_name: input } : input)
  const defaultBranch = getString(repoRecord, 'default_branch') ?? 'main'

  const [readme, tree, issueSearches] = await Promise.all([
    fetchText(`${apiBase}/readme`, {
      ...headers,
      Accept: 'application/vnd.github.raw',
    }),
    fetchJson<Record<string, unknown>>(
      `${apiBase}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      headers,
    ),
    Promise.all(
      issueQueries.map((term) =>
        fetchJson<Record<string, unknown>>(
          'https://api.github.com/search/issues?q=' +
          encodeURIComponent(`repo:${fullName} ${term} in:title,body type:issue`) +
          '&per_page=2',
          headers,
        ),
      ),
    ),
  ])

  const treeItems = Array.isArray(tree?.['tree'])
    ? tree['tree'] as Array<Record<string, unknown>>
    : []
  const treeTruncated = tree?.['truncated'] === true
  const paths = treeItems
    .map((entry) => getString(entry, 'path'))
    .filter((pathValue): pathValue is string => pathValue !== undefined)

  const relevantPaths = paths
    .filter((pathValue) =>
      /(^|\/)(scripts?|experiments?|configs?|data|datasets?|train|training|eval|evaluation|README|requirements|environment|Dockerfile)/i.test(pathValue)
      || /\.(sh|py|yaml|yml|json)$/i.test(pathValue),
    )
    .slice(0, RELEVANT_PATH_LIMIT)

  const supportFilePaths = selectSupportFilePaths(paths)
  const supportFileExcerpts = await Promise.all(
    supportFilePaths.map(async (filePath) => {
      const url = rawGitHubFileUrl(fullName, defaultBranch, filePath)
      const text = await fetchText(url, headers)
      return {
        path: filePath,
        raw_url: url,
        excerpt: text ? compactText(text, SUPPORT_FILE_EXCERPT_LIMIT) : 'unavailable',
      }
    }),
  )

  const issueByUrl = new Map<string, Record<string, unknown>>()
  for (const issueSearch of issueSearches) {
    if (!Array.isArray(issueSearch?.['items'])) continue
    for (const issue of issueSearch['items'] as Array<Record<string, unknown>>) {
      const url = getString(issue, 'html_url')
      if (url) issueByUrl.set(url, issue)
    }
  }

  const issues = Array.from(issueByUrl.values()).slice(0, ISSUE_EVIDENCE_LIMIT).map((issue) => ({
    title: getString(issue, 'title'),
    html_url: getString(issue, 'html_url'),
    state: getString(issue, 'state'),
    created_at: getString(issue, 'created_at'),
    body_excerpt: getString(issue, 'body')?.slice(0, ISSUE_BODY_EXCERPT_LIMIT),
  }))

  const readmeText = readme ?? ''
  const repoIdentityText = [
    fullName,
    getString(repoRecord, 'description') ?? '',
    readmeText,
  ].join('\n')
  const linkedFromPaperMetadata = sourceQuery === 'github-url-from-paper-metadata'
  const targetQuery = linkedFromPaperMetadata ? undefined : sourceQuery
  const hasOfficialClaim = officialClaimNearTarget(readmeText, undefined)
  const officialForTarget = targetQuery ? officialClaimNearTarget(readmeText, targetQuery) : hasOfficialClaim
  const nonOfficialForTarget = targetQuery
    ? nonOfficialClaimNearTarget(readmeText, targetQuery)
    : nonOfficialClaimNearTarget(readmeText, undefined)
  const repoRelationshipHints = {
    linked_from_paper_metadata: linkedFromPaperMetadata,
    mentions_query_or_title: targetQuery ? textMentionsTarget(repoIdentityText, targetQuery) : false,
    mentions_official: officialForTarget,
    official_claim_context_unclear: hasOfficialClaim && !officialForTarget,
    explicit_non_official_claim: nonOfficialForTarget,
    mentions_reproduction: /reproduc|replicat|results?|benchmark/i.test(readmeText),
    mentions_datasets: /dataset|data preparation|download data|benchmark data/i.test(readmeText),
  }

  const datasetCandidateEvidence = summarizeDatasetCandidates(
    [
      ...extractDatasetCandidateEvidenceFromText(readmeText, 'README.md', 'readme_line'),
      ...extractDatasetCandidateEvidenceFromPaths(relevantPaths),
      ...supportFileExcerpts.flatMap((item) =>
        extractDatasetCandidateEvidenceFromText(item.excerpt, item.path, 'support_file_line'),
      ),
    ],
  )
  const datasetMentions = datasetCandidateEvidence.map((candidate) => candidate.name)

  return {
    ...compactSearchItem(repoRecord),
    html_url: getString(repoRecord, 'html_url') ?? `https://github.com/${fullName}`,
    source_query: sourceQuery,
    repo_relationship_hints: repoRelationshipHints,
    readme_excerpt: readme ? readme.slice(0, README_EXCERPT_LIMIT) : 'README unavailable',
    tree_truncated: treeTruncated,
    tree_truncation_note: treeTruncated
      ? 'GitHub recursive tree response was truncated; relevant_paths and dataset/code clues may be incomplete.'
      : undefined,
    relevant_paths: relevantPaths,
    support_file_excerpts: supportFileExcerpts,
    dataset_mentions: datasetMentions,
    dataset_candidate_evidence: datasetCandidateEvidence,
    issue_search_results: issues,
  }
}

function buildDatasetCluesFromRepos(repoEvidence: Array<Record<string, unknown> | undefined>): Array<Record<string, unknown>> {
  const clues: Array<Record<string, unknown>> = []

  for (const repo of repoEvidence) {
    if (!repo) continue
    const paths = Array.isArray(repo['relevant_paths'])
      ? repo['relevant_paths'].filter((pathValue): pathValue is string => typeof pathValue === 'string')
      : []
    const datasetPaths = paths
      .filter((pathValue) => /(^|\/)(data|datasets?|download|prepare|preprocess)/i.test(pathValue))
      .slice(0, DATASET_RELATED_PATH_LIMIT)

    const datasetMentions = Array.isArray(repo['dataset_mentions'])
      ? repo['dataset_mentions'].filter((name): name is string => typeof name === 'string')
      : []
    const datasetCandidateEvidence = Array.isArray(repo['dataset_candidate_evidence'])
      ? repo['dataset_candidate_evidence']
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
        .slice(0, DATASET_CANDIDATE_LIMIT_PER_REPO)
      : []
    const supportFiles = Array.isArray(repo['support_file_excerpts'])
      ? repo['support_file_excerpts'].filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      : []
    const readme = typeof repo['readme_excerpt'] === 'string' ? repo['readme_excerpt'] : ''
    const datasetLines = readme
      .split(/\r?\n/)
      .filter((line) => /dataset|data|download|benchmark|split|train|test/i.test(line))
      .slice(0, DATASET_CONTEXT_LINE_LIMIT)
    const supportFileDatasetLines = supportFiles.flatMap((item) => {
      const excerpt = typeof item['excerpt'] === 'string' ? item['excerpt'] : ''
      const filePath = typeof item['path'] === 'string' ? item['path'] : 'unknown file'
      return excerpt
        .split(/\r?\n|;/)
        .filter((line) => /dataset|data_path|root_path|download|split|train|test/i.test(line))
        .slice(0, 2)
        .map((line) => `${filePath}: ${compactText(line, 120)}`)
    }).slice(0, DATASET_CONTEXT_LINE_LIMIT * 2)

    if (
      datasetPaths.length > 0
      || datasetLines.length > 0
      || datasetMentions.length > 0
      || datasetCandidateEvidence.length > 0
      || supportFileDatasetLines.length > 0
    ) {
      clues.push({
        repository: repo['full_name'],
        repository_url: repo['html_url'],
        repository_relationship_hints: summarizeRelationshipHints(repo['repo_relationship_hints']),
        target_tied_repository: repoIsTargetTied(repo),
        dataset_mentions: datasetMentions,
        dataset_candidate_evidence: datasetCandidateEvidence,
        dataset_related_paths: datasetPaths,
        readme_dataset_lines: datasetLines,
        support_file_dataset_lines: supportFileDatasetLines,
      })
    }
  }

  return clues
}

function collectRecordsWithTitle(value: unknown, acc: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (isUnavailableSourcePayload(value)) return acc
  if (value === null || typeof value !== 'object') return acc
  if (Array.isArray(value)) {
    for (const item of value) collectRecordsWithTitle(item, acc)
    return acc
  }

  const record = value as Record<string, unknown>
  if (typeof record['title'] === 'string' && record['title'].trim() !== '') {
    acc.push(record)
  }
  for (const [key, child] of Object.entries(record)) {
    if (NON_EVIDENCE_PAYLOAD_KEYS.has(key.toLowerCase())) continue
    collectRecordsWithTitle(child, acc)
  }
  return acc
}

function isUnavailableSourcePayload(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record['is_error'] === true || record['source_unavailable'] === true
}

const NON_EVIDENCE_PAYLOAD_KEYS = new Set([
  'args',
  'arguments',
  'count',
  'incomplete_results',
  'is_error',
  'limit',
  'message',
  'next_cursor',
  'note',
  'offset',
  'page',
  'query',
  'reason',
  'request',
  'source',
  'source_unavailable',
  'status',
  'success',
  'total',
  'total_count',
  'type',
])

function hasSuccessfulSourcePayload(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.some(hasSuccessfulSourcePayload)
  if (typeof value !== 'object') return false
  if (isUnavailableSourcePayload(value)) return false

  const evidenceEntries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !NON_EVIDENCE_PAYLOAD_KEYS.has(key.toLowerCase()))
  return evidenceEntries.some(([, child]) => hasSuccessfulSourcePayload(child))
}

function collectSourceEvidenceStrings(value: unknown, acc: string[] = []): string[] {
  if (isUnavailableSourcePayload(value)) return acc
  if (typeof value === 'string') {
    acc.push(value)
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceEvidenceStrings(item, acc)
    return acc
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (NON_EVIDENCE_PAYLOAD_KEYS.has(key.toLowerCase())) continue
      collectSourceEvidenceStrings(child, acc)
    }
  }
  return acc
}

function sourceEvidenceText(...values: unknown[]): string {
  return uniqueStrings(
    values.flatMap((value) => collectSourceEvidenceStrings(value).map((item) => compactText(item, 500))),
    120,
  ).join('\n')
}

function hasReproductionFeedbackSignal(record: Record<string, unknown>): boolean {
  return /\b(?:reproduc|replicat|reimplement|re-implement|rerun|result mismatch|cannot reproduce|fail(?:ed)? to reproduce|metric mismatch|benchmark|evaluation protocol|code availability|data availability|artifact)\b/i
    .test(sourceEvidenceText(record))
}

function sourceHasReproductionFeedbackSignal(value: unknown): boolean {
  return collectRecordsWithTitle(value).some(hasReproductionFeedbackSignal)
}

function firstContextMatch(text: string, patterns: RegExp[], maxLength = 280): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    pattern.lastIndex = 0
    if (!match || match.index === undefined) continue

    const start = Math.max(0, match.index - 140)
    const end = Math.min(text.length, match.index + match[0].length + 140)
    return compactText(text.slice(start, end), maxLength)
  }
  return undefined
}

function findDatasetRestrictionEvidence(text: string): string | undefined {
  const datasetContext = /\b(?:dataset|datasets|data set|split|splits|holdout|benchmark|leaderboard|labels?|annotations?|download|data access)\b/i
  const restrictionSignal = /\b(?:restricted|requires? approval|approval[- ]?gated|apply|application|private|hidden|permission|not public|unavailable|non-commercial|noncommercial|terms of use)\b/i
  const paperLicenseNotice = /\b(?:snippet is extracted|open access paper|paper or abstract|copyright owner|license by the author|source to verify the license|copyright information)\b/i

  for (const segment of text.split(/\r?\n|(?<=[.!?])\s+/)) {
    const normalized = compactText(segment, 320)
    if (!normalized || paperLicenseNotice.test(normalized)) continue
    if (datasetContext.test(normalized) && restrictionSignal.test(normalized)) {
      return normalized
    }
  }

  return undefined
}

function extractGithubUrls(text: string): string[] {
  return uniqueStrings(
    [...text.matchAll(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)]
      .map((match) => match[0].replace(/[).,;]+$/g, '')),
    5,
  )
}

function extractMetricNames(text: string): string[] {
  return uniqueStrings(
    [...text.matchAll(/\b(?:macro[- ]?F1|micro[- ]?F1|F1|accuracy|exact match|EM|BLEU|ROUGE|MSE|MAE|RMSE|AUROC|AUC)\b/gi)]
      .map((match) => match[0]),
    8,
  )
}

function extractedClaim(
  claim: string,
  evidence: string | undefined,
  sourceDescription = 'Asta paper metadata or paper-scoped snippets',
): Record<string, string> {
  return evidence
    ? { status: 'found', claim, evidence }
    : {
      status: 'not_found_in_asta_sources',
      claim: `No explicit claim found in ${sourceDescription}.`,
      evidence: `Asta did not surface enough target-paper text from ${sourceDescription} for this claim type.`,
    }
}

function extractedUnscopedEvidence(
  evidenceType: string,
  evidence: string | undefined,
): Record<string, string> {
  return evidence
    ? {
      status: 'unscoped_evidence',
      evidence_scope: 'global_snippet_search',
      note: `${evidenceType} surfaced in global Asta snippets, but no paper_id was resolved; do not treat this as a target-paper claim without corroboration.`,
      evidence,
    }
    : {
      status: 'not_found_in_global_snippets',
      evidence_scope: 'global_snippet_search',
      note: `No ${evidenceType.toLowerCase()} surfaced in the unscoped Asta snippets.`,
      evidence: 'Asta global snippet_search did not return a matching evidence segment.',
    }
}

function extractLiveClaimEvidence(text: string) {
  const githubUrls = extractGithubUrls(text)
  const metricNames = extractMetricNames(text)

  const codeEvidence = githubUrls.length > 0
    ? firstContextMatch(text, [/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i])
    : firstContextMatch(text, [
      /\b(?:code|source code|implementation|repository)\b.{0,120}\b(?:available|released|public|github)\b/i,
      /\b(?:available|released|public)\b.{0,120}\b(?:code|source code|implementation|repository)\b/i,
    ])
  const datasetEvidence = firstContextMatch(text, [
    /\b(?:dataset|data|split|holdout|benchmark)\b.{0,160}\b(?:public|available|released|restricted|approval|license|download)\b/i,
    /\b(?:public|available|released|restricted|approval|license|download)\b.{0,160}\b(?:dataset|data|split|holdout|benchmark)\b/i,
  ])
  const metricEvidence = firstContextMatch(text, [
    /\b(?:primary|main|reported|evaluation|metric)\b.{0,120}\b(?:macro[- ]?F1|micro[- ]?F1|F1|accuracy|exact match|EM|BLEU|ROUGE|MSE|MAE|RMSE|AUROC|AUC)\b/i,
    /\b(?:macro[- ]?F1|micro[- ]?F1|F1|accuracy|exact match|EM|BLEU|ROUGE|MSE|MAE|RMSE|AUROC|AUC)\b.{0,120}\b(?:primary|main|reported|evaluation|metric)\b/i,
  ])
  const resultEvidence = firstContextMatch(text, [
    /\b\d+(?:\.\d+)?\s*(?:%|points?)?\s*(?:macro[- ]?F1|micro[- ]?F1|F1|accuracy|exact match|EM|BLEU|ROUGE|MSE|MAE|RMSE|AUROC|AUC)\b/i,
    /\b(?:macro[- ]?F1|micro[- ]?F1|F1|accuracy|exact match|EM|BLEU|ROUGE|MSE|MAE|RMSE|AUROC|AUC)\b.{0,40}\b\d+(?:\.\d+)?\b/i,
  ])
  const computeEvidence = firstContextMatch(text, [
    /\b(?:single[- ]?GPU|GPU|TPU|A100|V100|H100|24GB|40GB|80GB|hours?|runtime|compute)\b.{0,140}\b(?:train|reproduce|experiment|run|finetune|fine[- ]?tune)\b/i,
    /\b(?:train|reproduce|experiment|run|finetune|fine[- ]?tune)\b.{0,140}\b(?:single[- ]?GPU|GPU|TPU|A100|V100|H100|24GB|40GB|80GB|hours?|runtime|compute)\b/i,
  ])
  const reproducibilityEvidence = firstContextMatch(text, [
    /\b(?:reproducible|reproduce|replicate|all experiments|released code|public datasets?|artifact)\b/i,
  ])

  return {
    githubUrls,
    metricNames,
    codeEvidence,
    datasetEvidence,
    metricEvidence,
    resultEvidence,
    computeEvidence,
    reproducibilityEvidence,
  }
}

function liveClaimFields(
  evidence: ReturnType<typeof extractLiveClaimEvidence>,
  sourceDescription: string,
): Record<string, Record<string, string>> {
  return {
    code_availability: extractedClaim(
      evidence.githubUrls.length > 0
        ? `Code or implementation URL appears in Asta evidence: ${evidence.githubUrls.join(', ')}.`
        : 'Code or implementation availability is mentioned in Asta evidence.',
      evidence.codeEvidence,
      sourceDescription,
    ),
    dataset_availability: extractedClaim(
      'Dataset, split, access, or benchmark availability is mentioned in Asta evidence.',
      evidence.datasetEvidence,
      sourceDescription,
    ),
    primary_metric: extractedClaim(
      evidence.metricNames.length > 0
        ? `Metric evidence mentions: ${evidence.metricNames.join(', ')}.`
        : 'Metric or evaluation protocol is mentioned in Asta evidence.',
      evidence.metricEvidence,
      sourceDescription,
    ),
    reported_result: extractedClaim(
      'Reported result evidence includes a numeric score tied to an evaluation metric.',
      evidence.resultEvidence,
      sourceDescription,
    ),
    compute_claim: extractedClaim(
      'Compute or runtime evidence is mentioned in Asta evidence.',
      evidence.computeEvidence,
      sourceDescription,
    ),
    reproducibility_promise: extractedClaim(
      'Reproducibility, released-artifact, or replication promise is mentioned in Asta evidence.',
      evidence.reproducibilityEvidence,
      sourceDescription,
    ),
  }
}

function liveUnscopedEvidenceFields(
  evidence: ReturnType<typeof extractLiveClaimEvidence>,
): Record<string, Record<string, string>> {
  return {
    code_availability_lead: extractedUnscopedEvidence('Code availability evidence', evidence.codeEvidence),
    dataset_availability_lead: extractedUnscopedEvidence('Dataset availability evidence', evidence.datasetEvidence),
    primary_metric_lead: extractedUnscopedEvidence('Metric evidence', evidence.metricEvidence),
    reported_result_lead: extractedUnscopedEvidence('Reported result evidence', evidence.resultEvidence),
    compute_claim_lead: extractedUnscopedEvidence('Compute/runtime evidence', evidence.computeEvidence),
    reproducibility_promise_lead: extractedUnscopedEvidence('Reproducibility promise evidence', evidence.reproducibilityEvidence),
  }
}

function buildLivePaperClaims(
  asta: {
    targetPaperMetadata: unknown
    claimSnippets: unknown
    datasetSnippets: unknown
    replicationSnippets: unknown
  },
  resolvedPaperId: string | null | undefined,
): Record<string, unknown> {
  const hasResolvedPaperId = typeof resolvedPaperId === 'string' && resolvedPaperId.trim() !== ''
  const hasTargetMetadata = hasSuccessfulSourcePayload(asta.targetPaperMetadata)
  const scopedText = hasResolvedPaperId
    ? sourceEvidenceText(
      asta.targetPaperMetadata,
      asta.claimSnippets,
      asta.datasetSnippets,
      asta.replicationSnippets,
    )
    : hasTargetMetadata
      ? sourceEvidenceText(asta.targetPaperMetadata)
      : ''
  const scopedSourceDescription = hasResolvedPaperId
    ? hasTargetMetadata
      ? 'validated Asta target-paper metadata and paper-scoped snippets'
      : 'paper-scoped Asta snippets'
    : hasTargetMetadata
      ? 'validated Asta target-paper metadata only'
      : 'no validated Asta target-paper metadata'
  const paperClaimFields = liveClaimFields(extractLiveClaimEvidence(scopedText), scopedSourceDescription)

  const unscopedSnippetText = hasResolvedPaperId
    ? ''
    : sourceEvidenceText(asta.claimSnippets, asta.datasetSnippets, asta.replicationSnippets)

  return {
    source_note: hasResolvedPaperId
      ? 'LIVE claim surface constructed deterministically from validated Asta target-paper metadata when available plus paper-scoped snippet_search results; missing fields are explicit evidence gaps, not model guesses.'
      : hasTargetMetadata
        ? 'LIVE claim surface constructed deterministically from validated Asta target-paper metadata only. Asta snippets were global because no paper_id resolved, so snippet-derived evidence is surfaced separately as unscoped leads.'
        : 'LIVE claim surface has no validated target-paper metadata. Asta snippets were global because no paper_id resolved, so snippet-derived evidence is surfaced separately as unscoped leads.',
    snippet_scope: {
      resolved_paper_id: hasResolvedPaperId ? resolvedPaperId : null,
      snippet_search_scope: hasResolvedPaperId ? 'paper_scoped' : 'global_unscoped',
      metadata_scope: hasTargetMetadata ? 'target_scoped' : 'unresolved_unscoped',
      claim_policy: hasResolvedPaperId
        ? 'Snippet-derived evidence may be treated as target-paper evidence.'
        : 'Snippet-derived evidence must not be treated as target-paper claims without corroboration.',
    },
    ...paperClaimFields,
    ...(!hasResolvedPaperId
      ? {
        unscoped_snippet_evidence: {
          source_note: 'Global Asta snippet_search was used because paper_id resolution failed. Treat these entries as discovery leads or uncertainties, not paper claims.',
          ...liveUnscopedEvidenceFields(extractLiveClaimEvidence(unscopedSnippetText)),
        },
      }
      : {}),
  }
}

function summarizeRelationshipHints(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return []
  const labels: Record<string, string> = {
    linked_from_paper_metadata: 'linked from paper metadata',
    mentions_query_or_title: 'mentions query or title',
    mentions_official: 'official claim tied to target',
    official_claim_context_unclear: 'official claim not tied to target',
    explicit_non_official_claim: 'explicit non-official claim',
    mentions_reproduction: 'mentions reproduction',
    mentions_datasets: 'mentions datasets',
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, flag]) => flag === true)
    .map(([key]) => labels[key] ?? key.replace(/_/g, ' '))
}

function scoreRepositoryForReplication(repo: Record<string, unknown>): number {
  const hints = repo['repo_relationship_hints'] !== null && typeof repo['repo_relationship_hints'] === 'object'
    ? repo['repo_relationship_hints'] as Record<string, unknown>
    : {}
  const paths = Array.isArray(repo['relevant_paths'])
    ? repo['relevant_paths'].filter((item): item is string => typeof item === 'string')
    : []
  const issues = Array.isArray(repo['issue_search_results'])
    ? repo['issue_search_results'].filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    : []

  let score = 0
  if (repo['source_query'] === 'github-url-from-paper-metadata') score += 120
  if (hints['linked_from_paper_metadata'] === true) score += 60
  if (hints['mentions_query_or_title'] === true) score += 80
  if (hints['mentions_official'] === true) score += 55
  if (hints['official_claim_context_unclear'] === true) score -= 12
  if (hints['explicit_non_official_claim'] === true) score -= 35
  if (hints['mentions_reproduction'] === true) score += 20
  if (hints['mentions_datasets'] === true) score += 15

  if (paths.some((pathValue) => /(^|\/)(scripts?|experiments?)\//i.test(pathValue))) score += 25
  if (paths.some((pathValue) => /(run|train|long|forecast|eval|metric).*\.(py|sh)$/i.test(pathValue))) score += 20
  if (paths.some((pathValue) => /(^|\/)(data_provider|data_loader|datasets?)\//i.test(pathValue))) score += 15

  const issueTitles = issues.map((issue) => String(issue['title'] ?? '')).join(' ')
  if (/reproduc|replicat|result|hyperparameter|table/i.test(issueTitles)) score += 15

  const description = String(repo['description'] ?? '')
  const readme = String(repo['readme_excerpt'] ?? '')
  const genericText = `${description}\n${readme}`
  if (/framework|toolkit|library|baseline/i.test(genericText) && hints['mentions_query_or_title'] !== true) {
    score -= 20
  }

  const stars = getNumber(repo, 'stargazers_count') ?? 0
  score += Math.min(10, Math.log10(stars + 1) * 3)

  return score
}

function sortRepositoryEvidence(repos: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...repos].sort((a, b) => {
    const scoreDelta = scoreRepositoryForReplication(b) - scoreRepositoryForReplication(a)
    if (scoreDelta !== 0) return scoreDelta
    return String(a['full_name'] ?? '').localeCompare(String(b['full_name'] ?? ''))
  })
}

function compactRepositoryEvidenceForCodeAgent(repo: Record<string, unknown>): Record<string, unknown> {
  const {
    dataset_candidate_evidence: _datasetCandidateEvidence,
    dataset_mentions: _datasetMentions,
    ...rest
  } = repo
  return rest
}

function repoText(repo: Record<string, unknown>): string {
  return sourceEvidenceText(
    repo['full_name'],
    repo['description'],
    repo['readme_excerpt'],
    repo['relevant_paths'],
    repo['support_file_excerpts'],
    repo['issue_search_results'],
  )
}

function repoHasUsableSnapshot(repo: Record<string, unknown>): boolean {
  const readme = String(repo['readme_excerpt'] ?? '')
  const paths = Array.isArray(repo['relevant_paths']) ? repo['relevant_paths'] : []
  return readme !== '' && readme !== 'README unavailable' || paths.length > 0
}

function repoHasTrainingOrEvalPath(repo: Record<string, unknown>): boolean {
  const paths = Array.isArray(repo['relevant_paths'])
    ? repo['relevant_paths'].filter((item): item is string => typeof item === 'string')
    : []
  return paths.some((pathValue) => /(train|training|eval|evaluation|metric|run|launch).*\.(py|sh|yaml|yml|json)$/i.test(pathValue))
}

function repoHasHint(repo: Record<string, unknown>, key: string): boolean {
  const hints = repo['repo_relationship_hints']
  return hints !== null && typeof hints === 'object' && (hints as Record<string, unknown>)[key] === true
}

function repoIsTargetTied(repo: Record<string, unknown>): boolean {
  return repo['source_query'] === 'github-url-from-paper-metadata'
    || repoHasHint(repo, 'linked_from_paper_metadata')
    || repoHasHint(repo, 'mentions_official')
    || repoHasHint(repo, 'mentions_query_or_title')
}

function repoHasUnofficialImplementationSignal(repo: Record<string, unknown>): boolean {
  if (repoHasHint(repo, 'explicit_non_official_claim')) return true

  const text = repoText(repo)
  return /\b(?:(?:un|non)[-\s]?official|third[-\s]?party|community|independent)\s+(?:implementation|code|repo(?:sitory)?|release|reproduction)\b/i.test(text)
    || /\b(?:reimplementation|re-implementation)\b/i.test(text)
    || /\b(?:replication|reproduction)\s+(?:implementation|code|repo(?:sitory)?)\b/i.test(text)
}

function statusItem(
  artifactType: string,
  status: string,
  source: string,
  note: string,
  evidenceIds: string[] = [],
): Record<string, unknown> {
  return {
    artifact_type: artifactType,
    status,
    source,
    note,
    evidence_ids: evidenceIds,
  }
}

function buildLiveDiscoveryStatus(input: {
  asta: {
    targetPaperMetadata: unknown
    citations: unknown
    datasetSnippets: unknown
    replicationSnippets: unknown
  }
  snippetScope: SnippetSearchScope
  repoEvidence: Array<Record<string, unknown>>
  datasetClues: Array<Record<string, unknown>>
  directRepos: string[]
}): Array<Record<string, unknown>> {
  const { asta, snippetScope, repoEvidence, datasetClues, directRepos } = input
  const snippetsArePaperScoped = snippetScope === 'paper_scoped'
  const scholarlyMetadataFound =
    hasSuccessfulSourcePayload(asta.targetPaperMetadata) && findFirstStringByKey(asta.targetPaperMetadata, 'title') !== undefined
  const officialRepos = repoEvidence.filter((repo) =>
    repo['source_query'] === 'github-url-from-paper-metadata'
    || repoHasHint(repo, 'linked_from_paper_metadata')
    || repoHasHint(repo, 'mentions_official'),
  )
  const targetTiedRepos = repoEvidence.filter(repoIsTargetTied)
  const usableOfficialRepos = officialRepos.filter(repoHasUsableSnapshot)
  const unofficialRepos = repoEvidence.filter((repo) =>
    !officialRepos.includes(repo)
    && repoHasUnofficialImplementationSignal(repo),
  )
  const relatedBenchmarkRepos = repoEvidence.filter((repo) =>
    !officialRepos.includes(repo)
    && !unofficialRepos.includes(repo)
    && /benchmark|baseline|toolkit|framework|library/i.test(repoText(repo)),
  )
  const anyRepoFetched = repoEvidence.length > 0
  const scopedDatasetSnippets = snippetsArePaperScoped ? asta.datasetSnippets : undefined
  const scopedReplicationSnippets = snippetsArePaperScoped ? asta.replicationSnippets : undefined
  const unscopedDatasetSnippetsFound =
    !snippetsArePaperScoped && hasSuccessfulSourcePayload(asta.datasetSnippets)
  const unscopedReplicationSnippetsFound =
    !snippetsArePaperScoped && hasSuccessfulSourcePayload(asta.replicationSnippets)
  const targetTiedDatasetClues = datasetClues.filter((clue) => clue['target_tied_repository'] === true)
  const untiedDatasetCluesFound = datasetClues.length > 0 && targetTiedDatasetClues.length === 0
  const targetTiedEntrypointRepos = targetTiedRepos.filter(repoHasTrainingOrEvalPath)
  const untiedEntrypointReposFound =
    targetTiedEntrypointRepos.length === 0 && repoEvidence.some(repoHasTrainingOrEvalPath)
  const datasetEvidenceFound =
    hasSuccessfulSourcePayload(scopedDatasetSnippets) || targetTiedDatasetClues.length > 0
  const datasetText = sourceEvidenceText(scopedDatasetSnippets, targetTiedDatasetClues)
  const restrictedDatasetEvidence = findDatasetRestrictionEvidence(datasetText)
  const metricPattern = /\b(?:macro[- ]?F1|micro[- ]?F1|F1|accuracy|exact match|EM|BLEU|ROUGE|MSE|MAE|RMSE|AUROC|AUC|metric|evaluator|evaluation)\b/i
  const metricProtocolEvidence = firstContextMatch(sourceEvidenceText(scopedDatasetSnippets, scopedReplicationSnippets, targetTiedRepos), [
    metricPattern,
  ])
  const untiedMetricEvidence = !metricProtocolEvidence && firstContextMatch(sourceEvidenceText(repoEvidence), [
    metricPattern,
  ])
  const citationTraversalFound = hasSuccessfulSourcePayload(asta.citations)
  const citationFeedbackSignalFound = sourceHasReproductionFeedbackSignal(asta.citations)
  const citationFeedbackFound =
    citationFeedbackSignalFound || hasSuccessfulSourcePayload(scopedReplicationSnippets)

  return [
    statusItem(
      'scholarly_metadata',
      scholarlyMetadataFound ? 'found' : 'source_unavailable',
      'Asta MCP get_paper/search_paper_by_title',
      scholarlyMetadataFound
        ? 'Resolved validated target-paper metadata from Asta.'
        : 'Asta paper lookup did not return a validated target-paper metadata payload.',
    ),
    statusItem(
      'official_code',
      usableOfficialRepos.length > 0
        ? 'found'
        : officialRepos.length > 0 || directRepos.length > 0
          ? 'missing'
          : anyRepoFetched
            ? 'ambiguous'
            : 'source_unavailable',
      'GitHub URLs from paper metadata plus GitHub Search README/tree inspection',
      usableOfficialRepos.length > 0
        ? 'At least one candidate official repository has a readable README or relevant file tree.'
        : officialRepos.length > 0 || directRepos.length > 0
          ? 'A paper-linked or official-looking repository was found, but README/tree evidence was unavailable or unusable.'
          : anyRepoFetched
            ? 'GitHub found code-like candidates, but none could be tied to official ownership.'
            : 'No repository evidence could be fetched from GitHub.',
      officialRepos.map((repo) => String(repo['full_name'] ?? repo['html_url'] ?? '')).filter((item) => item !== ''),
    ),
    statusItem(
      'unofficial_code',
      unofficialRepos.length > 0 ? 'found' : anyRepoFetched ? 'not_required_for_replication' : 'source_unavailable',
      'GitHub Search README/tree/issues',
      unofficialRepos.length > 0
        ? 'At least one candidate repository presents as an unofficial reproduction or reimplementation.'
        : anyRepoFetched
          ? 'Fetched repositories did not clearly identify as unofficial reproductions; this is not a missing replication artifact unless another source requires a third-party reproduction.'
          : 'No repository evidence could be fetched from GitHub.',
      unofficialRepos.map((repo) => String(repo['full_name'] ?? repo['html_url'] ?? '')).filter((item) => item !== ''),
    ),
    statusItem(
      'related_benchmark_code',
      relatedBenchmarkRepos.length > 0 ? 'found' : anyRepoFetched ? 'not_required_for_replication' : 'source_unavailable',
      'GitHub Search README/tree/issues',
      relatedBenchmarkRepos.length > 0
        ? 'At least one candidate appears to be related benchmark, baseline, toolkit, or framework code rather than the paper method itself.'
        : anyRepoFetched
          ? 'Fetched repositories did not clearly look like related benchmark/baseline code; this is not a missing replication artifact unless the paper requires a separate baseline repository.'
          : 'No repository evidence could be fetched from GitHub.',
      relatedBenchmarkRepos.map((repo) => String(repo['full_name'] ?? repo['html_url'] ?? '')).filter((item) => item !== ''),
    ),
    statusItem(
      'training_or_eval_entrypoint',
      targetTiedEntrypointRepos.length > 0
        ? 'found'
        : untiedEntrypointReposFound
          ? 'ambiguous'
          : anyRepoFetched
            ? 'missing'
            : 'source_unavailable',
      'GitHub recursive tree and support-file excerpts',
      targetTiedEntrypointRepos.length > 0
        ? 'At least one target-tied candidate repository exposes train/eval/run/metric paths.'
        : untiedEntrypointReposFound
          ? 'Only non-target-tied fetched repositories expose train/eval/run/metric paths; treat as ambiguous, not as target-paper entrypoint evidence.'
          : anyRepoFetched
            ? 'No train/eval/run/metric path was visible in fetched repository snapshots.'
            : 'No repository evidence could be fetched from GitHub.',
      (targetTiedEntrypointRepos.length > 0 ? targetTiedEntrypointRepos : repoEvidence.filter(repoHasTrainingOrEvalPath))
        .map((repo) => String(repo['full_name'] ?? repo['html_url'] ?? ''))
        .filter((item) => item !== ''),
    ),
    statusItem(
      'dataset_candidate_evidence',
      targetTiedDatasetClues.length > 0
        ? 'found'
        : datasetEvidenceFound || untiedDatasetCluesFound || unscopedDatasetSnippetsFound
          ? 'ambiguous'
          : 'source_unavailable',
      'Asta MCP snippet_search plus dataset clues from repository READMEs/paths',
      targetTiedDatasetClues.length > 0
        ? 'Target-tied repository README/path/support-file clues surfaced concrete dataset candidates.'
        : datasetEvidenceFound
          ? 'Asta surfaced dataset-related snippets, but repository candidate evidence is absent or not concrete.'
          : untiedDatasetCluesFound
            ? 'Only non-target-tied repositories surfaced dataset candidates; treat them as leads, not target-paper dataset facts.'
          : unscopedDatasetSnippetsFound
            ? 'Only global/unscoped Asta dataset snippets were available; treat them as leads, not target-paper dataset facts.'
          : 'No dataset evidence was available from Asta snippets or repository clues.',
      (targetTiedDatasetClues.length > 0 ? targetTiedDatasetClues : datasetClues)
        .map((clue) => String(clue['repository'] ?? clue['repository_url'] ?? ''))
        .filter((item) => item !== ''),
    ),
    statusItem(
      'restricted_or_private_dataset',
      restrictedDatasetEvidence
        ? 'restricted'
        : datasetEvidenceFound
          ? 'no_restriction_signal'
          : untiedDatasetCluesFound || unscopedDatasetSnippetsFound
            ? 'ambiguous'
            : 'source_unavailable',
      'Asta MCP dataset snippet_search and repository dataset clues',
      restrictedDatasetEvidence
        ? `Access restriction signal surfaced: ${restrictedDatasetEvidence}`
        : datasetEvidenceFound
          ? 'No restricted/private/approval-gated dataset signal was visible in the live evidence snapshot.'
          : untiedDatasetCluesFound
            ? 'Only non-target-tied repository dataset clues were available, so no target-paper restriction status is asserted.'
          : unscopedDatasetSnippetsFound
            ? 'Only global/unscoped dataset snippets were available, so no target-paper restriction status is asserted.'
          : 'No dataset evidence was available to inspect access restrictions.',
    ),
    statusItem(
      'metric_protocol',
      metricProtocolEvidence
        ? 'found'
        : datasetEvidenceFound || citationFeedbackFound || untiedMetricEvidence
          ? 'ambiguous'
          : 'source_unavailable',
      'Asta MCP snippet_search plus repository metric/eval paths',
      metricProtocolEvidence
        ? `Target-scoped metric/evaluator signal surfaced: ${metricProtocolEvidence}`
        : untiedMetricEvidence
          ? `Only non-target-tied repository metric/evaluator signal surfaced: ${untiedMetricEvidence}`
          : datasetEvidenceFound || citationFeedbackFound
            ? 'Evidence exists, but no concrete target-scoped metric/evaluator signal was surfaced.'
            : 'No dataset or reproduction evidence was available to inspect metrics.',
    ),
    statusItem(
      'citation_feedback',
      citationFeedbackFound
        ? 'found'
        : citationTraversalFound || unscopedReplicationSnippetsFound
          ? 'ambiguous'
          : 'source_unavailable',
      snippetsArePaperScoped
        ? 'Asta MCP get_citations and paper-scoped snippet_search'
        : 'Asta MCP get_citations; global snippet_search is not treated as citation feedback',
      citationFeedbackFound
        ? 'Citation traversal with explicit reproduction-feedback signals or paper-scoped reproduction snippets returned evidence.'
        : citationTraversalFound
          ? 'Citation traversal returned papers, but no explicit reproduction/metric/result/code/data feedback signal was visible in the live snapshot.'
        : unscopedReplicationSnippetsFound
          ? 'Global reproduction snippets were available but no paper_id resolved; they are unscoped leads, not target-paper citation feedback.'
        : 'Asta citation traversal and reproduction snippets were unavailable.',
    ),
  ]
}

function buildLiveSourceDigest(
  query: string,
  asta: {
    targetPaperMetadata: unknown
    citations: unknown
    datasetSnippets: unknown
    replicationSnippets: unknown
  },
  snippetScope: SnippetSearchScope,
  repoEvidence: Array<Record<string, unknown>>,
  datasetClues: Array<Record<string, unknown>>,
): SourceDigest {
  const snippetsArePaperScoped = snippetScope === 'paper_scoped'
  const paperTitle = findFirstStringByKey(asta.targetPaperMetadata, 'title') ?? query
  const paperUrl = findFirstStringByKey(asta.targetPaperMetadata, 'url') ?? ''
  const paperVenue = findFirstStringByKey(asta.targetPaperMetadata, 'venue') ?? ''
  const paperYear = findFirstNumberByKey(asta.targetPaperMetadata, 'year')

  const repositories = repoEvidence.slice(0, REPO_EVIDENCE_LIMIT).map((repo) => {
    const issues = Array.isArray(repo['issue_search_results'])
      ? repo['issue_search_results'].filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      : []
    const paths = Array.isArray(repo['relevant_paths'])
      ? repo['relevant_paths'].filter((item): item is string => typeof item === 'string')
      : []
    return {
      repository: String(repo['full_name'] ?? ''),
      url: String(repo['html_url'] ?? ''),
      description: String(repo['description'] ?? ''),
      relationship_hints: summarizeRelationshipHints(repo['repo_relationship_hints']),
      useful_paths: paths.slice(0, 8),
      issue_signals: issues.slice(0, 4).map((issue) => ({
        title: String(issue['title'] ?? ''),
        url: String(issue['html_url'] ?? ''),
      })),
    }
  })

  const datasetByName = new Map<string, SourceDigest['datasets'][number]>()
  for (const clue of datasetClues) {
    const source = String(clue['repository_url'] ?? clue['repository'] ?? '')
    const mentions = Array.isArray(clue['dataset_mentions'])
      ? clue['dataset_mentions'].filter((item): item is string => typeof item === 'string')
      : []
    const candidateEvidence = Array.isArray(clue['dataset_candidate_evidence'])
      ? clue['dataset_candidate_evidence'].filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      : []
    const candidateMentions = candidateEvidence
      .map((item) => String(item['name'] ?? ''))
      .filter((item) => item !== '')
    for (const name of uniqueStrings([...mentions, ...candidateMentions], 20)) {
      if (datasetByName.has(name)) continue
      const evidenceItem = candidateEvidence.find((item) => String(item['name'] ?? '').toLowerCase() === name.toLowerCase())
      const evidenceKind = evidenceItem ? String(evidenceItem['evidence_kind'] ?? '') : ''
      const evidenceLine = evidenceItem ? String(evidenceItem['evidence'] ?? '') : ''
      const hasEvidence = evidenceKind !== '' || evidenceLine !== ''
      datasetByName.set(name, {
        name,
        evidence: hasEvidence
          ? `Detected from scored candidate evidence (${evidenceKind}): ${compactText(evidenceLine, 140)}`
          : 'Detected from repository README, script/config path, or support-file excerpt.',
        source,
      })
    }
  }
  const datasetSnippetMentions = snippetsArePaperScoped
    ? extractDatasetMentionsFromAstaSnippets(asta.datasetSnippets)
    : []

  const reproductionByKey = new Map<string, SourceDigest['reproduction_signals'][number]>()
  const targetTitles = new Set([
    normalizeTitleForCompare(query),
    normalizeTitleForCompare(paperTitle),
  ])
  for (const repo of repoEvidence) {
    const issues = Array.isArray(repo['issue_search_results'])
      ? repo['issue_search_results'].filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      : []
    for (const issue of issues) {
      const title = String(issue['title'] ?? '')
      const url = String(issue['html_url'] ?? '')
      if (!title || reproductionByKey.has(url || title)) continue
      reproductionByKey.set(url || title, { title, url, source: 'GitHub issue search' })
    }
  }
  for (const item of [
    ...collectRecordsWithTitle(asta.citations),
    ...(snippetsArePaperScoped ? collectRecordsWithTitle(asta.replicationSnippets) : []),
  ]) {
    const title = String(item['title'] ?? '')
    const url = getString(item, 'url') ?? getString(item, 'paperUrl') ?? ''
    const normalizedTitle = normalizeTitleForCompare(title)
    const isToolError = isUnavailableSourcePayload(item)
    if (isToolError || targetTitles.has(normalizedTitle) || /^asta .*retrieval$/i.test(title)) continue
    if (!hasReproductionFeedbackSignal(item)) continue
    if (!title || reproductionByKey.has(url || title)) continue
    reproductionByKey.set(url || title, {
      title,
      url,
      source: 'Asta citation/snippet evidence',
    })
    if (reproductionByKey.size >= 10) break
  }

  return {
    paper: {
      title: paperTitle,
      url: paperUrl,
      venue_or_year: [paperVenue, paperYear].filter((item) => item !== undefined && item !== '').join(' '),
    },
    repositories,
    datasets: Array.from(datasetByName.values()).slice(0, 20),
    dataset_snippet_mentions: datasetSnippetMentions,
    reproduction_signals: Array.from(reproductionByKey.values()).slice(0, 10),
  }
}

function normalizePaperId(query: string): string | undefined {
  const trimmed = query.trim()
  if (/^(DOI|ARXIV|PMID|PMCID|MAG|ACL|CorpusId|URL):/i.test(trimmed)) {
    return trimmed.replace(/^doi:/i, 'DOI:')
      .replace(/^arxiv:/i, 'ARXIV:')
      .replace(/^pmid:/i, 'PMID:')
      .replace(/^pmcid:/i, 'PMCID:')
      .replace(/^mag:/i, 'MAG:')
      .replace(/^acl:/i, 'ACL:')
      .replace(/^corpusid:/i, 'CorpusId:')
      .replace(/^url:/i, 'URL:')
  }
  if (/^10\.\d{4,9}\//.test(trimmed)) {
    return `DOI:${trimmed}`
  }
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(trimmed)) {
    return `ARXIV:${trimmed}`
  }
  if (/^https?:\/\/(arxiv\.org|www\.semanticscholar\.org|aclanthology\.org|dl\.acm\.org)/i.test(trimmed)) {
    return `URL:${trimmed}`
  }
  return undefined
}

function paperIdFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ['paper_id', 'paperId', 'paperID', 'corpusId', 'CorpusId']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      if (key.toLowerCase().includes('corpus') && !candidate.startsWith('CorpusId:')) {
        return `CorpusId:${candidate}`
      }
      return candidate
    }
    if (typeof candidate === 'number') {
      return `CorpusId:${candidate}`
    }
  }
  return undefined
}

function significantTitleTokens(text: string): string[] {
  const stopwords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'by',
    'for',
    'from',
    'in',
    'is',
    'of',
    'on',
    'or',
    'the',
    'to',
    'with',
  ])
  return normalizeTitleForCompare(text)
    .split(' ')
    .filter((token) => token.length > 2 && !stopwords.has(token))
}

function titleMatchesQuery(candidateTitle: string, query: string): boolean {
  const candidate = normalizeTitleForCompare(candidateTitle)
  const target = normalizeTitleForCompare(query)
  if (!candidate || !target) return false
  if (candidate === target) return true

  const targetTokens = significantTitleTokens(query)
  if (targetTokens.length < 3) return false

  const candidateTokens = significantTitleTokens(candidateTitle)
  if (candidateTokens.length < 3) return false

  const candidateTokenSet = new Set(candidateTokens)
  const overlap = targetTokens.filter((token) => candidateTokenSet.has(token)).length
  const targetCoverage = overlap / targetTokens.length
  const candidateCoverage = overlap / candidateTokens.length
  return targetCoverage >= 0.82 && candidateCoverage >= 0.7
}

function resolveLivePaperIdentity(
  query: string,
  knownPaperId: string | undefined,
  paperLookup: unknown,
): LivePaperIdentity {
  if (knownPaperId) {
    return {
      resolvedPaperId: knownPaperId,
      targetPaperMetadata: hasSuccessfulSourcePayload(paperLookup) ? paperLookup : undefined,
      metadataScope: hasSuccessfulSourcePayload(paperLookup) ? 'target_scoped' : 'unresolved_unscoped',
      note: hasSuccessfulSourcePayload(paperLookup)
        ? 'Input was an explicit paper identifier, so Asta get_paper metadata is treated as target-scoped.'
        : 'Input was an explicit paper identifier, but Asta get_paper did not return usable metadata. Snippet and citation requests can still be scoped by the input identifier.',
    }
  }

  for (const record of collectRecordsWithTitle(paperLookup)) {
    const title = getString(record, 'title')
    if (!title || !titleMatchesQuery(title, query)) continue

    const paperId = paperIdFromRecord(record)
    return {
      ...(paperId ? { resolvedPaperId: paperId } : {}),
      targetPaperMetadata: record,
      metadataScope: 'target_scoped',
      note: paperId
        ? 'Asta title lookup returned a strict title match with a paper_id; snippets are paper-scoped.'
        : 'Asta title lookup returned a strict title match but no paper_id; metadata is target-scoped, but snippets remain global/unscoped.',
    }
  }

  return {
    metadataScope: 'unresolved_unscoped',
    note: 'Asta title lookup did not return a strict target-paper match. Raw lookup payload is omitted from source-agent snapshots to avoid treating fuzzy search results as target-paper facts.',
  }
}

function toolResultToPlainObject(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result

  const record = result as Record<string, unknown>
  if (record['structuredContent'] !== undefined) {
    return record['structuredContent']
  }
  if (record['toolResult'] !== undefined) {
    return record['toolResult']
  }

  const content = record['content']
  if (Array.isArray(content)) {
    const textBlocks = content
      .map((block) => {
        if (block !== null && typeof block === 'object' && typeof (block as Record<string, unknown>)['text'] === 'string') {
          return (block as Record<string, unknown>)['text'] as string
        }
        return undefined
      })
      .filter((text): text is string => text !== undefined)

    if (textBlocks.length === 1) {
      try {
        return JSON.parse(textBlocks[0])
      } catch {
        return textBlocks[0]
      }
    }
    if (textBlocks.length > 1) {
      return textBlocks
    }
  }

  return result
}

async function withAstaClient<T>(run: (client: MCPClientLike) => Promise<T>): Promise<T> {
  const apiKey = process.env.ASTA_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('SOURCE_MODE=live requires ASTA_API_KEY.')
  }

  let Client: MCPClientConstructor
  let StreamableHTTPClientTransport: StreamableHTTPClientTransportConstructor
  try {
    const [clientModule, transportModule] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js') as Promise<{ Client: MCPClientConstructor }>,
      import('@modelcontextprotocol/sdk/client/streamableHttp.js') as Promise<{
        StreamableHTTPClientTransport: StreamableHTTPClientTransportConstructor
      }>,
    ])
    Client = clientModule.Client
    StreamableHTTPClientTransport = transportModule.StreamableHTTPClientTransport
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      'SOURCE_MODE=live requires the optional @modelcontextprotocol/sdk peer dependency. ' +
      'Install it with `npm install @modelcontextprotocol/sdk` before using live Asta discovery. ' +
      `Original error: ${message}`,
    )
  }

  const transport = new StreamableHTTPClientTransport(
    new URL('https://asta-tools.allen.ai/mcp/v1'),
    { requestInit: { headers: { 'x-api-key': apiKey } } },
  )
  const client = new Client(
    { name: 'open-multi-agent-paper-replication-triage', version: '0.0.0' },
    { capabilities: {} },
  )

  await client.connect(transport, { timeout: 60_000 })
  try {
    return await run(client)
  } finally {
    await client.close?.()
  }
}

async function callAstaTool(
  client: MCPClientLike,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
    return toolResultToPlainObject(result)
  } catch (error) {
    return {
      is_error: true,
      tool: name,
      args,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function loadLiveSourceBundle(query: string): Promise<SourceBundle> {
  const githubHeaders: Record<string, string> = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}

  const astaFields = 'title,year,authors,venue,tldr,url,abstract,isOpenAccess,publicationDate,fieldsOfStudy'
  const knownPaperId = normalizePaperId(query)

  const asta = await withAstaClient(async (client) => {
    const paperLookup = knownPaperId
      ? await callAstaTool(client, 'get_paper', { paper_id: knownPaperId, fields: astaFields })
      : await callAstaTool(client, 'search_paper_by_title', { title: query, fields: astaFields })

    const paperIdentity = resolveLivePaperIdentity(query, knownPaperId, paperLookup)
    const resolvedPaperId = paperIdentity.resolvedPaperId
    const paperIdsArg = resolvedPaperId ? { paper_ids: resolvedPaperId } : {}
    const snippetScope: SnippetSearchScope = resolvedPaperId ? 'paper_scoped' : 'global_unscoped'

    const [citations, claimSnippets, datasetSnippets, replicationSnippets] = await Promise.all([
      resolvedPaperId
        ? callAstaTool(client, 'get_citations', {
          paper_id: resolvedPaperId,
          fields: 'title,year,authors,venue,tldr,url,abstract',
          limit: 10,
        })
        : Promise.resolve({
          source_unavailable: true,
          reason: 'Could not resolve a paper_id for citation traversal.',
        }),
      callAstaTool(client, 'snippet_search', {
        query: `${query} code implementation repository dataset split public metric result GPU reproducible released artifact`,
        limit: 5,
        ...paperIdsArg,
      }),
      callAstaTool(client, 'snippet_search', {
        query: `${query} dataset split license benchmark holdout public restricted`,
        limit: 5,
        ...paperIdsArg,
      }),
      callAstaTool(client, 'snippet_search', {
        query: `${query} reproduce replication reproduced results code metric mismatch benchmark`,
        limit: 5,
        ...paperIdsArg,
      }),
    ])

    return {
      paperLookupResolution: {
        resolved_paper_id: resolvedPaperId ?? null,
        metadata_scope: paperIdentity.metadataScope,
        note: paperIdentity.note,
      },
      targetPaperMetadata: paperIdentity.targetPaperMetadata ?? null,
      resolvedPaperId: resolvedPaperId ?? null,
      snippetScope,
      citations,
      claimSnippets,
      datasetSnippets,
      replicationSnippets,
    }
  })

  const githubSearchQueries = buildGitHubSearchQueries(query, asta.targetPaperMetadata)
  const githubSearches = await Promise.all(
    githubSearchQueries.map((rawQuery) => fetchGitHubSearch(rawQuery, githubHeaders)),
  )
  const githubItemByName = new Map<string, Record<string, unknown>>()
  for (const search of githubSearches) {
    if (!Array.isArray(search?.['items'])) continue
    for (const item of search['items'] as Array<Record<string, unknown>>) {
      const fullName = getString(item, 'full_name')
      if (fullName && !githubItemByName.has(fullName)) {
        githubItemByName.set(fullName, item)
      }
    }
  }

  const directRepos = extractGithubRepoFullNames(asta.targetPaperMetadata)
  const githubItems = Array.from(githubItemByName.values())
  const directRepoInputs = directRepos.slice(0, REPO_DISCOVERY_FETCH_LIMIT)
  const directRepoNames = new Set(directRepoInputs.map((repo) => repo.toLowerCase()))
  const searchRepoInputs = githubItems
    .filter((item) => {
      const fullName = getString(item, 'full_name')
      return fullName ? !directRepoNames.has(fullName.toLowerCase()) : false
    })
    .slice(0, Math.max(0, REPO_DISCOVERY_FETCH_LIMIT - directRepoInputs.length))
  const repoEvidence = await Promise.all(
    [
      ...directRepoInputs.map((repo) => fetchGitHubRepoEvidence(repo, githubHeaders, 'github-url-from-paper-metadata')),
      ...searchRepoInputs.map((item) => fetchGitHubRepoEvidence(item, githubHeaders, query)),
    ],
  )
  const fullRepoEvidence = sortRepositoryEvidence(
    repoEvidence.filter((item): item is Record<string, unknown> => item !== undefined),
  )
  const snippetScope = asta.snippetScope as SnippetSearchScope
  const topRepoEvidence = fullRepoEvidence.slice(0, REPO_EVIDENCE_LIMIT)
  const datasetCluesFromRepos = buildDatasetCluesFromRepos(fullRepoEvidence)
  const sourceDigest = buildLiveSourceDigest(query, asta, snippetScope, fullRepoEvidence, datasetCluesFromRepos)
  const paperClaims = buildLivePaperClaims(asta, asta.resolvedPaperId)
  const discoveryStatus = buildLiveDiscoveryStatus({
    asta,
    snippetScope,
    repoEvidence: fullRepoEvidence,
    datasetClues: datasetCluesFromRepos,
    directRepos,
  })
  const searchTotal = githubSearches.reduce((sum, search) => {
    const count = typeof search?.['total_count'] === 'number' ? search['total_count'] : 0
    return sum + count
  }, 0)
  const searchIncomplete = githubSearches.some((search) => search?.['incomplete_results'] === true)

  return {
    mode: 'live',
    query,
    sourceIndex: {
      notice: 'LIVE BEST-EFFORT SOURCE DISCOVERY. Scholarly evidence comes from Asta MCP; implementation evidence comes from GitHub Search. Missing sources are evidence, not a request for manual input.',
      query,
      source_mode: 'live',
      discovery_status: discoveryStatus,
    },
    scholarlyMetadata: {
      notice: 'LIVE Asta MCP scholarly metadata. Asta exposes the Semantic Scholar academic graph over MCP.',
      query,
      paper_lookup_resolution: asta.paperLookupResolution,
      resolved_paper_id: asta.resolvedPaperId,
      asta_paper_lookup: hasSuccessfulSourcePayload(asta.targetPaperMetadata)
        ? asta.targetPaperMetadata
        : {
          status: 'unresolved_unscoped_omitted',
          note: 'Raw Asta paper lookup was not exposed to the claim agent because it was not validated as the target paper.',
        },
      claim_snippet_scope: snippetScope,
      ...(snippetScope === 'paper_scoped'
        ? { asta_claim_snippets: asta.claimSnippets }
        : {
          unscoped_claim_snippets: {
            status: 'global_unscoped_omitted_from_claim_extraction',
            note: 'Asta claim snippet_search ran globally because no validated paper_id resolved. Raw snippets are omitted from the claim-agent snapshot so they cannot be mistaken for target-paper claims; see paper_claims.unscoped_snippet_evidence for discovery leads.',
          },
        }),
      paper_claims: paperClaims,
    },
    codeArtifacts: {
      notice: 'LIVE GitHub Search plus shallow repository evidence. GITHUB_TOKEN is optional but recommended to avoid low anonymous rate limits.',
      github_search_queries: githubSearchQueries,
      github_repos_linked_from_paper_metadata: directRepos,
      github_search_summary: {
        total_count_across_queries: searchTotal,
        incomplete_results_seen: searchIncomplete,
        top_results: githubItems.slice(0, REPO_EVIDENCE_LIMIT).map(compactSearchItem),
      },
      top_repository_evidence: topRepoEvidence.map(compactRepositoryEvidenceForCodeAgent),
    },
    datasetArtifacts: {
      notice: 'LIVE dataset evidence from Asta snippet_search plus dataset-related README/path clues from candidate repositories. This avoids requiring a separate dataset-catalog API key.',
      query: `${query} dataset split license benchmark holdout public restricted`,
      dataset_snippet_scope: snippetScope,
      ...(snippetScope === 'paper_scoped'
        ? { asta_dataset_snippets: asta.datasetSnippets }
        : {
          unscoped_dataset_snippets: {
            status: 'global_unscoped_omitted_from_dataset_facts',
            note: 'Asta dataset snippet_search ran globally because no validated paper_id resolved. Raw snippets are omitted from dataset facts; rely on repository-derived dataset clues or treat missing dataset evidence as an evidence gap.',
          },
        }),
      candidate_repositories_considered: fullRepoEvidence.length,
      dataset_clues_from_candidate_repositories: datasetCluesFromRepos,
    },
    citationFeedback: {
      notice: 'LIVE Asta citation and snippet evidence.',
      asta_citations: asta.citations,
      replication_snippet_scope: snippetScope,
      ...(snippetScope === 'paper_scoped'
        ? { asta_replication_snippets: asta.replicationSnippets }
        : {
          unscoped_replication_snippets: {
            status: 'global_unscoped_omitted_from_citation_feedback',
            note: 'Asta reproduction snippet_search ran globally because no validated paper_id resolved. Raw snippets are omitted from citation feedback so they cannot be mistaken for target-paper follow-up evidence.',
          },
        }),
    },
    sourceDigest,
  }
}

async function loadSourceBundle(query: string): Promise<SourceBundle> {
  const mode = resolveSourceMode()
  if (mode === 'live') {
    return loadLiveSourceBundle(query)
  }
  return loadMockSourceBundle(query)
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const EvidenceTopic = z.enum(['code', 'dataset', 'metric', 'result', 'artifact_missing'])
const Severity = z.enum(['low', 'medium', 'high'])
const RepositoryRelationship = z.enum(['likely_official', 'third_party', 'related_benchmark', 'unrelated', 'unclear'])
const DatasetAccessStatus = z.enum(['public', 'restricted', 'unavailable', 'unclear'])

const ClaimReport = z.object({
  source: z.literal('scholarly_metadata'),
  claims: z.array(
    z.object({
      topic: EvidenceTopic,
      claim: z.string(),
      evidence: z.string(),
    }),
  ),
  reproduction_promises: z.array(z.string()),
  uncertainties: z.array(z.string()),
})
type ClaimReport = z.infer<typeof ClaimReport>

const CodeArtifactReport = z.object({
  source: z.literal('code_artifacts'),
  official_code_found: z.boolean(),
  candidate_repositories: z.array(
    z.object({
      repository: z.string(),
      url: z.string(),
      relationship: RepositoryRelationship,
      evidence: z.string(),
      useful_paths: z.array(z.string()),
      issue_signals: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          evidence: z.string(),
        }),
      ),
    }),
  ),
  usable_training_entrypoint: z.boolean(),
  missing_files: z.array(z.string()),
  conflicts: z.array(
    z.object({
      topic: z.enum(['code', 'metric']),
      paper_claim: z.string(),
      artifact_evidence: z.string(),
      severity: Severity,
    }),
  ),
  reproduction_notes: z.array(z.string()),
})
type CodeArtifactReport = z.infer<typeof CodeArtifactReport>

const DatasetArtifactReport = z.object({
  source: z.literal('dataset_artifacts'),
  datasets: z.array(
    z.object({
      name: z.string(),
      source_or_url: z.string(),
      access_status: DatasetAccessStatus,
      split_or_license_notes: z.string(),
      evidence: z.string(),
    }),
  ),
  public_splits: z.array(z.string()),
  restricted_splits: z.array(z.string()),
  license_or_access_notes: z.array(z.string()),
  conflicts: z.array(
    z.object({
      topic: z.enum(['dataset', 'metric']),
      paper_claim: z.string(),
      artifact_evidence: z.string(),
      severity: Severity,
    }),
  ),
})
type DatasetArtifactReport = z.infer<typeof DatasetArtifactReport>

const CitationFeedbackReport = z.object({
  source: z.literal('citation_feedback'),
  full_reproduction_found: z.boolean(),
  feedback_items: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      stance: z.string(),
      evidence: z.string(),
      signals: z.array(z.string()),
    }),
  ),
  conflicts: z.array(
    z.object({
      topic: z.enum(['metric', 'result', 'dataset', 'code']),
      paper_claim: z.string(),
      artifact_evidence: z.string(),
      severity: Severity,
    }),
  ),
})
type CitationFeedbackReport = z.infer<typeof CitationFeedbackReport>

const ArtifactGapReport = z.object({
  source: z.literal('discovery_status'),
  found_artifacts: z.array(z.string()),
  missing_artifacts: z.array(z.string()),
  ambiguous_artifacts: z.array(z.string()),
  evidence_gaps: z.array(
    z.object({
      artifact: z.string(),
      why_it_matters: z.string(),
      severity: Severity,
    }),
  ),
})
type ArtifactGapReport = z.infer<typeof ArtifactGapReport>

const ReplicationPlanSchema = z.object({
  decision: z.enum(['reproduce', 'reproduce_with_caution', 'do_not_reproduce_yet']),
  risk_score: z.number().min(0).max(1),
  artifact_inventory: z.object({
    paper: z.object({
      title: z.string(),
      url: z.string(),
      venue_or_year: z.string(),
    }),
    code_repositories: z.array(
      z.object({
        repository: z.string(),
        url: z.string(),
        relationship: RepositoryRelationship,
        usability: z.string(),
        evidence: z.string(),
        next_action: z.string(),
      }),
    ),
    datasets: z.array(
      z.object({
        name: z.string(),
        source_or_url: z.string(),
        access_status: DatasetAccessStatus,
        split_or_license_notes: z.string(),
        evidence: z.string(),
        next_action: z.string(),
      }),
    ),
    reproduction_evidence: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        stance: z.string(),
        evidence: z.string(),
        next_action: z.string(),
      }),
    ),
  }),
  evidence_conflicts: z.array(
    z.object({
      topic: EvidenceTopic,
      paper_claim: z.string(),
      external_evidence: z.string(),
      resolution: z.string(),
      severity: Severity,
    }),
  ),
  missing_artifacts: z.array(z.string()),
  blocking_issues: z.array(z.string()),
  minimum_next_steps: z.array(z.string()),
  questions_for_authors: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})
type ReplicationPlan = z.infer<typeof ReplicationPlanSchema>

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

function sourceAgentPrompt(sourceName: string): string {
  return `You are the ${sourceName} for a paper replication triage workflow.

Rules:
- Use only the source snapshot in the task description.
- Do not infer facts from general model knowledge.
- Treat missing artifacts as evidence when the source says they are missing.
- In live mode, never call evidence "seeded"; that word is reserved for mock fixtures.
- Use an empty string for any URL field when the source does not provide a URL.
- Return JSON only, matching the configured schema exactly.`
}

const paperClaimAgent: AgentConfig = {
  name: 'paper-claim-agent',
  model: PROVIDER.model,
  systemPrompt: `${sourceAgentPrompt('paper claim agent')}

Extract the paper's own claims about code, data, metrics, reported results, and reproducibility promises.
Prefer the paper_claims block when present; it is a deterministic extraction from Asta paper metadata and paper-scoped snippets.
If paper_claims.snippet_scope says global_unscoped, treat unscoped_snippet_evidence only as uncertainty/discovery leads, not as target-paper claims.
Do not add any field with status "unscoped_evidence" to claims; put it in uncertainties if relevant.
If a paper_claims field says not_found_in_asta_sources, report it as an uncertainty instead of inventing a claim from general knowledge.
Do not compare against external artifacts; that is the planner's job.
The source field must be exactly "scholarly_metadata".
Use topic "code" for code availability or compute/resource claims.`,
  maxTurns: 1,
  maxTokens: 900,
  temperature: 0.1,
  outputSchema: ClaimReport,
}

const codeArtifactAgent: AgentConfig = {
  name: 'code-artifact-agent',
  model: PROVIDER.model,
  systemPrompt: `${sourceAgentPrompt('code artifact agent')}

Audit only code-discovery evidence. Focus on official repository status, missing files, training entrypoints, metric scripts, and GPU recipe clues.
Do not treat GitHub search success as code availability by itself. Inspect README excerpts, repo relationship hints, relevant paths, linked-from-paper metadata, and issue evidence.
Only mark a repository as likely_official when it is linked from paper metadata or the official-code claim is tied to the target paper; an "official implementation" claim for another method is not enough.
Classify each candidate repository as likely_official, third_party, related_benchmark, unrelated, or unclear, and explain the evidence.
For candidate_repositories, include repository URL, useful training/data/metric paths, and issue signals with URLs when available.
The source field must be exactly "code_artifacts".
Use topic "code" for official repo, missing file, or compute recipe conflicts. Use topic "metric" only for metric-script conflicts.`,
  maxTurns: 1,
  maxTokens: 1400,
  temperature: 0.1,
  outputSchema: CodeArtifactReport,
}

const datasetArtifactAgent: AgentConfig = {
  name: 'dataset-artifact-agent',
  model: PROVIDER.model,
  systemPrompt: `${sourceAgentPrompt('dataset artifact agent')}

Audit only dataset evidence. Focus on split access, license restrictions, evaluator policy, and metric documentation.
Live dataset evidence comes from Asta snippet_search plus dataset-related README/path clues from candidate repositories; this is not a general web crawl.
If dataset_snippet_scope says global_unscoped, do not treat omitted/global Asta snippets as target-paper dataset facts.
Prefer dataset_candidate_evidence when present: it contains generic, evidence-derived candidates with source_path, evidence_kind, evidence line, and confidence.
Use target_tied_repository and repository_relationship_hints to separate target-paper dataset evidence from weak repository leads.
Populate datasets only with concrete names supported by source evidence such as README lines, script names, data_path flags, paths, or snippets.
Do not list CLI flags, column names, generic words, file names, or config keys as dataset names.
If candidates are partial, report the confirmed subset and put the missing full roster/split protocol in conflicts or notes instead of guessing.
Do not discuss code or citations unless the dataset source itself mentions them.
The source field must be exactly "dataset_artifacts".`,
  maxTurns: 1,
  maxTokens: 1200,
  temperature: 0.1,
  outputSchema: DatasetArtifactReport,
}

const citationFeedbackAgent: AgentConfig = {
  name: 'citation-feedback-agent',
  model: PROVIDER.model,
  systemPrompt: `${sourceAgentPrompt('citation feedback agent')}

Audit only follow-up citation/reproduction evidence. Separate full reproduction from partial support, metric mismatch, issue reports, and result gaps.
Include URLs for citing papers, snippets, or reproduction discussions whenever the source provides them.
If replication_snippet_scope says global_unscoped, do not create feedback_items from those snippets; treat the absence of paper-scoped feedback as an evidence gap.
Do not treat ordinary citing papers as reproduction feedback unless their title, TLDR, abstract, or snippet explicitly mentions reproduction, replication, implementation, benchmark/result mismatch, metric protocol, code, data, or artifacts.
Do not create feedback_items for the target paper itself, source_unavailable/tool-error records, or retrieval-status messages. Treat those as absence of evidence, not reproduction evidence.
The source field must be exactly "citation_feedback".`,
  maxTurns: 1,
  maxTokens: 1100,
  temperature: 0.1,
  outputSchema: CitationFeedbackReport,
}

const artifactGapAgent: AgentConfig = {
  name: 'artifact-gap-agent',
  model: PROVIDER.model,
  systemPrompt: `${sourceAgentPrompt('artifact gap agent')}

Summarize discovery status. Missing official code, missing data cards, unavailable citations, or ambiguous artifact ownership are not neutral; classify them as evidence gaps.
Do not list non-blocking absence states as missing artifacts: no_restriction_signal means no private/restricted data signal was found, and not_required_for_replication means the optional artifact is not required unless another source explicitly says it is.
Statuses found, no_restriction_signal, and not_required_for_replication belong in found_artifacts or notes, not missing_artifacts.
The source field must be exactly "discovery_status".`,
  maxTurns: 1,
  maxTokens: 700,
  temperature: 0.1,
  outputSchema: ArtifactGapReport,
}

const replicationPlanner: AgentConfig = {
  name: 'replication-planner',
  model: PROVIDER.model,
  systemPrompt: `You are the final replication planner.

You receive JSON reports from source-specific agents. Your job is evidence reconciliation, not generic paper summarization.

Rules:
1. Return JSON only, matching the ReplicationPlan schema.
2. evidence_conflicts must list explicit paper claim vs external evidence conflicts.
3. Allowed conflict topics only: code, dataset, metric, result, artifact_missing.
4. Use topic "code" for compute recipe conflicts from repository evidence.
5. In mock mode, preserve the seeded conflicts if the upstream reports include them.
6. If official code or restricted data blocks reproduction, do not choose "reproduce" without caution.
7. artifact_inventory must be useful to a researcher: name the paper, likely code repositories, datasets, and prior reproduction/citation evidence with URLs when available.
8. minimum_next_steps should be concrete actions that do not require the user to already know the repo or dataset URL.
9. artifact_inventory.reproduction_evidence must contain only external follow-up papers, reproduction attempts, or discussion threads. Do not include the target paper itself or tool failures there; put retrieval failures in missing_artifacts or blocking_issues.
10. If a URL is unknown, use an empty string rather than inventing one.`,
  maxTurns: 2,
  maxTokens: 2000,
  temperature: 0.1,
  outputSchema: ReplicationPlanSchema,
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const progressTaskTitles = new Map<string, string>()

function handleProgress(event: OrchestratorEvent): void {
  const dataTitle =
    event.data !== null
    && typeof event.data === 'object'
    && 'title' in event.data
    && typeof (event.data as { title?: unknown }).title === 'string'
      ? (event.data as { title: string }).title
      : undefined

  if (event.task && dataTitle) {
    progressTaskTitles.set(event.task, dataTitle)
  }

  const taskTitle = dataTitle ?? (event.task ? progressTaskTitles.get(event.task) : undefined) ?? event.task ?? ''

  if (event.type === 'task_start') {
    console.log(`  [START] ${taskTitle} -> ${event.agent ?? ''}`)
  }
  if (event.type === 'task_complete') {
    console.log(`  [DONE]  ${taskTitle}`)
  }
}

function buildOrchestrator(): OpenMultiAgent {
  return new OpenMultiAgent({
    defaultModel: PROVIDER.model,
    defaultProvider: PROVIDER.provider,
    ...(PROVIDER.baseURL ? { defaultBaseURL: PROVIDER.baseURL } : {}),
    ...(PROVIDER.apiKey ? { defaultApiKey: PROVIDER.apiKey } : {}),
    onProgress: handleProgress,
  })
}

function sourceTaskDescription(sourceLabel: string, snapshot: unknown): string {
  return `Audit this ${sourceLabel} source snapshot.

Important:
- This source is intentionally isolated from the other source snapshots.
- Extract only what this source proves or fails to prove.
- Return JSON only.

SOURCE SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}`
}

function validateMockBundle(bundle: SourceBundle): void {
  if (bundle.mode !== 'mock') return

  const sourceText = JSON.stringify(bundle)
  const requiredSignals = [
    'Claimed official repository returns 404',
    'benchmark_holdout is restricted and requires application approval',
    'micro-F1',
    'torchrun --nproc_per_node=4',
  ]

  for (const signal of requiredSignals) {
    if (!sourceText.includes(signal)) {
      throw new Error(`Mock fixture validation failed: missing seeded signal "${signal}".`)
    }
  }
}

function assertPlannerDetectedConflicts(plan: ReplicationPlan, mode: SourceMode): void {
  if (mode !== 'mock') return

  if (plan.evidence_conflicts.length < 2) {
    throw new Error(
      `Expected at least 2 seeded conflicts in mock mode, got ${plan.evidence_conflicts.length}. ` +
      'Tighten planner prompt or fixture evidence.',
    )
  }

  const topics = new Set(plan.evidence_conflicts.map((conflict) => conflict.topic))
  if (!topics.has('code') && !topics.has('dataset')) {
    throw new Error(
      'Expected planner to detect at least one code or dataset conflict in mock mode.',
    )
  }
}

function verifySourceTasksStartedTogether(resultTasks: readonly TaskExecutionRecord[]): void {
  const sourceTitles = new Set([
    'Extract paper claims',
    'Audit code artifacts',
    'Audit dataset artifacts',
    'Audit citation feedback',
    'Audit artifact gaps',
  ])
  const sourceTasks = resultTasks.filter((task) => sourceTitles.has(task.title))

  if (
    sourceTasks.length === sourceTitles.size
    && sourceTasks.every((task) => task.metrics?.startMs !== undefined)
  ) {
    const starts = sourceTasks.map((task) => task.metrics!.startMs)
    const startSkew = Math.max(...starts) - Math.min(...starts)
    console.log(`Source task start skew: ${startSkew}ms`)

    if (startSkew > 2000) {
      throw new Error(
        `Expected source audit tasks to start in parallel; observed ${startSkew}ms start skew.`,
      )
    }
  }
}

function printSourceDigest(digest: SourceDigest | undefined): void {
  if (!digest) return

  console.log('LIVE SOURCE DISCOVERY SNAPSHOT')
  console.log('-'.repeat(78))
  console.log(`Paper: ${digest.paper.title}${digest.paper.venue_or_year ? ` (${digest.paper.venue_or_year})` : ''}`)
  if (digest.paper.url) {
    console.log(`Paper URL: ${digest.paper.url}`)
  }

  console.log('Candidate repositories:')
  if (digest.repositories.length === 0) {
    console.log('  - none discovered')
  }
  for (const repo of digest.repositories.slice(0, REPO_EVIDENCE_LIMIT)) {
    const hints = repo.relationship_hints.length > 0 ? `; hints: ${repo.relationship_hints.join(', ')}` : ''
    console.log(`  - ${repo.repository}${repo.url ? ` (${repo.url})` : ''}${hints}`)
    if (repo.useful_paths.length > 0) {
      console.log(`    paths: ${repo.useful_paths.slice(0, 4).join(', ')}`)
    }
    if (repo.issue_signals.length > 0) {
      console.log(`    issues: ${repo.issue_signals.slice(0, 2).map((issue) => issue.title).join('; ')}`)
    }
  }

  console.log('Dataset clues from repositories:')
  if (digest.datasets.length === 0) {
    console.log('  - none discovered')
  } else {
    console.log(`  - ${digest.datasets.slice(0, 12).map((dataset) => dataset.name).join(', ')}`)
  }

  console.log('Dataset mentions from paper snippets:')
  if (digest.dataset_snippet_mentions.length === 0) {
    console.log('  - none discovered')
  } else {
    console.log(`  - ${digest.dataset_snippet_mentions.slice(0, 12).join(', ')}`)
  }

  console.log('Reproduction / follow-up signals:')
  if (digest.reproduction_signals.length === 0) {
    console.log('  - none discovered')
  }
  for (const signal of digest.reproduction_signals.slice(0, 5)) {
    console.log(`  - ${signal.title}${signal.url ? ` (${signal.url})` : ''}`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (PROVIDER.missingEnv) {
  console.log(`[skip] LLM_PROVIDER=${PROVIDER.label} requires ${PROVIDER.missingEnv}.`)
  process.exit(0)
}

const bundle = await loadSourceBundle(PAPER_QUERY)
validateMockBundle(bundle)

const orchestrator = buildOrchestrator()
const team = orchestrator.createTeam('paper-replication-triage-team', {
  name: 'paper-replication-triage-team',
  agents: [
    paperClaimAgent,
    codeArtifactAgent,
    datasetArtifactAgent,
    citationFeedbackAgent,
    artifactGapAgent,
    replicationPlanner,
  ],
  sharedMemory: true,
  maxConcurrency: 5,
})

const tasks = [
  {
    title: 'Extract paper claims',
    description: sourceTaskDescription('scholarly metadata', bundle.scholarlyMetadata),
    assignee: 'paper-claim-agent',
  },
  {
    title: 'Audit code artifacts',
    description: sourceTaskDescription('code artifact', bundle.codeArtifacts),
    assignee: 'code-artifact-agent',
  },
  {
    title: 'Audit dataset artifacts',
    description: sourceTaskDescription('dataset artifact', bundle.datasetArtifacts),
    assignee: 'dataset-artifact-agent',
  },
  {
    title: 'Audit citation feedback',
    description: sourceTaskDescription('citation feedback', bundle.citationFeedback),
    assignee: 'citation-feedback-agent',
  },
  {
    title: 'Audit artifact gaps',
    description: sourceTaskDescription('discovery status', bundle.sourceIndex),
    assignee: 'artifact-gap-agent',
  },
  {
    title: 'Plan replication decision',
    description: `Reconcile the upstream source-specific reports for this paper query: "${bundle.query}".

Use the prerequisite task outputs as the only evidence. Produce the final structured JSON report.`,
    assignee: 'replication-planner',
    dependsOn: [
      'Extract paper claims',
      'Audit code artifacts',
      'Audit dataset artifacts',
      'Audit citation feedback',
      'Audit artifact gaps',
    ],
  },
]

console.log('Paper Replication Triage - Multi-Source Evidence Reconciliation')
console.log('='.repeat(78))
console.log(`Query: ${bundle.query}`)
console.log(`Source mode: ${bundle.mode}`)
console.log(`Provider: ${PROVIDER.label} (model=${PROVIDER.model})`)
console.log('DAG: 5 source audits in parallel -> replication planner')
console.log('='.repeat(78))
console.log()
printSourceDigest(bundle.sourceDigest)

const result = await orchestrator.runTasks(team, tasks)

if (result.tasks) {
  verifySourceTasksStartedTogether(result.tasks)
}

console.log('\n' + '='.repeat(78))
console.log(`Overall success: ${result.success}`)
console.log(`Tokens - input: ${result.totalTokenUsage.input_tokens}, output: ${result.totalTokenUsage.output_tokens}`)
console.log()

for (const [agentName, agentResult] of result.agentResults) {
  const status = agentResult.success ? 'OK  ' : 'FAIL'
  const tokens = `in:${agentResult.tokenUsage.input_tokens} out:${agentResult.tokenUsage.output_tokens}`
  console.log(`  [${status}] ${agentName.padEnd(24)} ${tokens}`)
}

const plannerResult = result.agentResults.get('replication-planner')
if (!plannerResult?.success || !plannerResult.structured) {
  console.error('\nReplication planner failed or did not return structured output.')
  if (plannerResult?.output) {
    console.error(plannerResult.output)
  }
  process.exit(1)
}

const plan = plannerResult.structured as ReplicationPlan
assertPlannerDetectedConflicts(plan, bundle.mode)

console.log('\n' + '='.repeat(78))
console.log('REPLICATION TRIAGE REPORT (JSON)')
console.log('='.repeat(78))
console.log(JSON.stringify(plan, null, 2))
console.log('\nDone.')
