import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReleasePlan, ChangelogSections } from './schema.js'

const TEMPLATE_MANIFESTS = [
  'packages/create-oma-app/template/package.json',
  'packages/create-oma-app/templates/demo/package.json',
  'packages/create-oma-app/templates/pr-review/package.json',
  'packages/create-oma-app/templates/security/package.json',
] as const

const OTEL_VERSION_CONSTANT_PATH = 'packages/otel/src/version.ts'

export const RELEASE_PLAN_PATHS = [
  'CHANGELOG.md',
  'package-lock.json',
  'packages/core/package.json',
  'packages/otel/package.json',
  OTEL_VERSION_CONSTANT_PATH,
  'packages/create-oma-app/package.json',
  ...TEMPLATE_MANIFESTS,
] as const

interface MutableManifest {
  version?: unknown
  dependencies?: Record<string, string>
}

export async function applyReleasePlan(
  repoRoot: string,
  plan: ReleasePlan,
): Promise<readonly string[]> {
  await assertCurrentVersions(repoRoot, plan)

  const changed = new Set<string>()
  await updateManifest(
    repoRoot,
    'packages/core/package.json',
    manifest => { manifest.version = plan.nextVersions.core },
    changed,
  )
  await updateManifest(
    repoRoot,
    'packages/create-oma-app/package.json',
    manifest => { manifest.version = plan.nextVersions.createOmaApp },
    changed,
  )

  if (plan.bumps.otel !== null) {
    await updateManifest(
      repoRoot,
      'packages/otel/package.json',
      manifest => { manifest.version = plan.nextVersions.otel },
      changed,
    )
    await updateOtelVersionConstant(repoRoot, plan.nextVersions.otel, changed)
  }

  for (const path of TEMPLATE_MANIFESTS) {
    await updateManifest(repoRoot, path, manifest => {
      if (!manifest.dependencies || typeof manifest.dependencies['@open-multi-agent/core'] !== 'string') {
        throw new Error(`${path} does not declare @open-multi-agent/core in dependencies.`)
      }
      manifest.dependencies['@open-multi-agent/core'] = plan.nextVersions.core
    }, changed)
  }

  const changelogPath = 'CHANGELOG.md'
  const oldChangelog = await readFile(join(repoRoot, changelogPath), 'utf8')
  const newChangelog = insertReleaseEntry(oldChangelog, plan)
  if (oldChangelog !== newChangelog) {
    await writeFile(join(repoRoot, changelogPath), newChangelog)
    changed.add(changelogPath)
  }

  return [...changed]
}

export function insertReleaseEntry(changelog: string, plan: ReleasePlan): string {
  const section = findTopLevelSection(changelog, 'Unreleased')
  // The planner's changelog is the single source of truth for the new release.
  // `## Unreleased` content already fed the planner as reference evidence, so
  // appending it again here would duplicate the same changes under two sets of
  // Added/Changed/Fixed headings.
  const generated = renderChangelogSections(plan.changelog)
  const entry = `## Unreleased\n\n## ${plan.nextVersions.core} - ${plan.releaseDate}\n\n${generated}\n\n`
  return changelog.slice(0, section.start) + entry + changelog.slice(section.end)
}

export function renderChangelogSections(sections: ChangelogSections): string {
  const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['Breaking changes', sections.breakingChanges],
    ['Added', sections.added],
    ['Changed', sections.changed],
    ['Fixed', sections.fixed],
    ['Security', sections.security],
    ['Compatibility', sections.compatibility],
  ]
  return groups
    .filter(([, entries]) => entries.length > 0)
    .map(([heading, entries]) => `### ${heading}\n\n${entries.map(entry => wrapBullet(entry)).join('\n')}`)
    .join('\n\n')
}

const CORE_PACKAGE_NAME = '@open-multi-agent/core'
const SCAFFOLDER_PACKAGE_NAME = 'create-oma-app'

export function renderReleaseNotes(changelog: string, coreVersion: string): string {
  const section = findTopLevelSection(changelog, coreVersion, true)
  return unwrapMarkdown(changelog.slice(section.bodyStart, section.end).trim())
}

/** One published workspace as the release body reports it. */
export interface ReleasePackageSummary {
  readonly name: string
  readonly version: string
  /** False when this release left the package's version where it already was. */
  readonly changed: boolean
}

/** One outside contributor and what they landed in this release. */
export interface ReleaseContributor {
  /** GitHub login when one was resolved, else the author's display name. */
  readonly name: string
  /**
   * Whether {@link name} is a GitHub login rather than a display name, which
   * decides whether it is safe to @-mention. See the Thanks section in
   * {@link composeReleaseBody}.
   */
  readonly isLogin: boolean
  /** What they landed, one entry per merged commit, already stripped of its type prefix. */
  readonly contributions: readonly string[]
}

export interface ReleaseBodyInput {
  /** Output of {@link renderReleaseNotes}. */
  readonly notes: string
  readonly coreVersion: string
  readonly packages: readonly ReleasePackageSummary[]
  /** Outside contributors only; omitted entirely when there are none. */
  readonly contributors?: readonly ReleaseContributor[]
}

/**
 * Compose the published release body.
 *
 * The changelog section alone answers "what changed" but not "what do I
 * install", which is the first thing a reader of a release page needs. Both
 * added sections are derived from the release commit's own manifests, so no
 * model output reaches them.
 */
export function composeReleaseBody(input: ReleaseBodyInput): string {
  const core = input.packages.find(item => item.name === CORE_PACKAGE_NAME)
  if (!core) throw new Error(`Release body is missing the ${CORE_PACKAGE_NAME} package summary.`)
  if (core.version !== input.coreVersion) {
    throw new Error(`Release body core version ${core.version} does not match the rendered notes ${input.coreVersion}.`)
  }

  const packageLines = input.packages.map(item => {
    if (!item.changed) return `- \`${item.name}\`: remains at \`${item.version}\` and is not republished`
    if (item.name === SCAFFOLDER_PACKAGE_NAME) {
      return `- \`${item.name}\`: \`${item.version}\`; generated starters pin core \`${input.coreVersion}\``
    }
    return `- \`${item.name}\`: \`${item.version}\``
  })

  // @-mention a contributor so the credit reaches them, but only when the name
  // is a login GitHub itself confirmed. A display name is not a handle and can
  // belong to someone else: v1.17.0 credited `s4kura` for #549 when the author
  // was `Iams4kura`. As plain text that was a wrong name; as an @-mention it
  // would have notified an uninvolved stranger, in a body this bot publishes
  // without anyone reviewing it first. So the display-name fallback stays plain.
  const thanks = (input.contributors ?? [])
    .filter(contributor => contributor.contributions.length > 0)
    .map(contributor => {
      const credit = contributor.isLogin ? `@${contributor.name}` : contributor.name
      return `- ${credit}: ${contributor.contributions.join('; ')}`
    })
  const thanksSection = thanks.length > 0 ? `\n## Thanks\n\n${thanks.join('\n')}\n` : ''

  return `${input.notes}

## Packages

${packageLines.join('\n')}
${thanksSection}
## Install

\`\`\`bash
npm i ${CORE_PACKAGE_NAME}@${input.coreVersion}
npm create oma-app@latest my-oma
\`\`\`
`
}

/**
 * The title names every package this release publishes.
 *
 * It used to hard-code core and create-oma-app, so a release that republished
 * otel never said so: v1.18.0 shipped otel 0.1.3 under a title that named two
 * packages. otel is the only conditional one, because a release always moves
 * core and create-oma-app, and `bumps.otel === null` is the same signal the
 * body's package table already switches on.
 *
 * The `chore: release core vX.Y.Z` prefix is load-bearing and must stay first:
 * `prepareReleasePr` recognizes an already-open release PR by it, and this
 * string is also the release commit subject.
 */
export function buildReleasePrTitle(plan: ReleasePlan): string {
  const core = `core v${plan.nextVersions.core}`
  const scaffolder = `create-oma-app v${plan.nextVersions.createOmaApp}`
  if (plan.bumps.otel === null) return `chore: release ${core} and ${scaffolder}`
  return `chore: release ${core}, otel v${plan.nextVersions.otel}, and ${scaffolder}`
}

export function buildReleasePrBody(plan: ReleasePlan): string {
  const packageRows = [
    `| \`@open-multi-agent/core\` | \`${plan.currentVersions.core}\` | \`${plan.nextVersions.core}\` |`,
    `| \`create-oma-app\` | \`${plan.currentVersions.createOmaApp}\` | \`${plan.nextVersions.createOmaApp}\` |`,
  ]
  if (plan.bumps.otel !== null) {
    packageRows.splice(1, 0, `| \`@open-multi-agent/otel\` | \`${plan.currentVersions.otel}\` | \`${plan.nextVersions.otel}\` |`)
  }

  const risks = plan.risks.length > 0
    ? plan.risks.map(risk => `- ${risk}`).join('\n')
    : '- No material risk identified by the release planner.'
  const reviewIssues = plan.review.issues.length > 0
    ? plan.review.issues.map(issue => `- ${issue}`).join('\n')
    : '- None.'

  return `## Summary

${plan.summary}

Generated by the repository-local OMA release bot using an explicit four-task DAG: change analysis and compatibility audit, followed by planning and independent review.

## Versions

| Package | Current | Next |
|---|---:|---:|
${packageRows.join('\n')}

## Evidence boundary

- Base tag: \`${plan.baseTag}\` (\`${plan.baseSha.slice(0, 12)}\`)
- Reviewed HEAD: \`${plan.headSha}\`
- Model output selected only bounded bump classes and changelog text.
- Version calculation, template pins, manifest writes, lockfile generation, and publication order are deterministic.
- Merging this PR is the human release approval. It does not bypass branch protection or CI.

## Risks

${risks}

## Independent review

- Verdict: **${plan.review.verdict.toUpperCase()}**
${reviewIssues}

## Validation

The release branch runs the normal repository CI matrix. Publication remains a separate deterministic workflow that starts only after CI succeeds on the merged release commit.
`
}

async function assertCurrentVersions(repoRoot: string, plan: ReleasePlan): Promise<void> {
  const pairs = [
    ['packages/core/package.json', plan.currentVersions.core],
    ['packages/otel/package.json', plan.currentVersions.otel],
    ['packages/create-oma-app/package.json', plan.currentVersions.createOmaApp],
  ] as const
  for (const [path, expected] of pairs) {
    const manifest = JSON.parse(await readFile(join(repoRoot, path), 'utf8')) as MutableManifest
    if (manifest.version !== expected) {
      throw new Error(`${path} advanced from expected version ${expected} to ${String(manifest.version)}.`)
    }
  }
}

async function updateManifest(
  repoRoot: string,
  path: string,
  mutate: (manifest: MutableManifest) => void,
  changed: Set<string>,
): Promise<void> {
  const absolute = join(repoRoot, path)
  const oldContent = await readFile(absolute, 'utf8')
  const manifest = JSON.parse(oldContent) as MutableManifest
  mutate(manifest)
  const newContent = `${JSON.stringify(manifest, null, 2)}\n`
  if (newContent !== oldContent) {
    await writeFile(absolute, newContent)
    changed.add(path)
  }
}

async function updateOtelVersionConstant(
  repoRoot: string,
  nextVersion: string,
  changed: Set<string>,
): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
    throw new Error(`Refusing to write an invalid otel version constant: "${nextVersion}".`)
  }
  const absolute = join(repoRoot, OTEL_VERSION_CONSTANT_PATH)
  const oldContent = await readFile(absolute, 'utf8')
  const newContent = oldContent.replace(
    /export const PACKAGE_VERSION = '[^']+'/,
    `export const PACKAGE_VERSION = '${nextVersion}'`,
  )
  if (newContent === oldContent) {
    throw new Error(`${OTEL_VERSION_CONSTANT_PATH} does not declare a PACKAGE_VERSION constant.`)
  }
  await writeFile(absolute, newContent)
  changed.add(OTEL_VERSION_CONSTANT_PATH)
}

function wrapBullet(text: string, width = 80): string {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let line = '-'
  for (const word of words) {
    const candidate = `${line} ${word}`
    if (candidate.length > width && line !== '-') {
      lines.push(line)
      line = `  ${word}`
    } else {
      line = candidate
    }
  }
  if (line !== '-') lines.push(line)
  return lines.join('\n')
}

function unwrapMarkdown(markdown: string): string {
  const output: string[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length > 0) output.push(paragraph.join(' ').replace(/\s+/g, ' ').trim())
    paragraph = []
  }

  for (const line of markdown.split('\n')) {
    if (/^#{1,6}\s/.test(line) || /^[-*]\s/.test(line)) {
      flush()
      output.push(line.trim())
    } else if (/^\s{2,}\S/.test(line) && output.at(-1)?.startsWith('- ')) {
      output[output.length - 1] = `${output.at(-1)} ${line.trim()}`
    } else if (line.trim() === '') {
      flush()
      if (output.at(-1) !== '') output.push('')
    } else {
      paragraph.push(line.trim())
    }
  }
  flush()
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function findTopLevelSection(
  markdown: string,
  heading: string,
  withDate = false,
): { readonly start: number; readonly bodyStart: number; readonly end: number } {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const suffix = withDate ? ' - \\d{4}-\\d{2}-\\d{2}' : ''
  const match = new RegExp(`^## ${escaped}${suffix}[ \\t]*(?:\\n|$)`, 'm').exec(markdown)
  if (!match) throw new Error(`CHANGELOG.md has no top-level section for ${heading}.`)
  const bodyStart = match.index + match[0].length
  const remainder = markdown.slice(bodyStart)
  const next = /^## /m.exec(remainder)
  return {
    start: match.index,
    bodyStart,
    end: next ? bodyStart + next.index : markdown.length,
  }
}
