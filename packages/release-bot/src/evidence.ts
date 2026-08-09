import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandRunner } from './command.js'
import {
  releaseEvidenceSchema,
  type ChangedFile,
  type ReleaseCommit,
  type ReleaseEvidence,
} from './schema.js'

interface PackageManifest {
  readonly version?: unknown
}

export async function collectReleaseEvidence(
  repoRoot: string,
  runner: CommandRunner,
  generatedAt = new Date().toISOString(),
): Promise<ReleaseEvidence> {
  const [baseTagResult, headResult, versions] = await Promise.all([
    runner.run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { cwd: repoRoot }),
    runner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    readVersions(repoRoot),
  ])

  const baseTag = baseTagResult.stdout.trim()
  if (!/^v\d+\.\d+\.\d+$/.test(baseTag)) {
    throw new Error(`Latest core tag is not a stable release tag: "${baseTag}".`)
  }

  const baseSha = (await runner.run('git', ['rev-list', '-n', '1', baseTag], { cwd: repoRoot })).stdout.trim()
  const headSha = headResult.stdout.trim()
  const range = `${baseSha}..${headSha}`

  const [logResult, namesResult, statsResult, changelog] = await Promise.all([
    runner.run('git', ['log', '--format=%H%x1f%s%x1f%b%x1e', range], { cwd: repoRoot }),
    runner.run('git', ['diff', '--name-only', '-z', range], { cwd: repoRoot }),
    runner.run('git', ['diff', '--numstat', '-z', range], { cwd: repoRoot }),
    readFile(join(repoRoot, 'CHANGELOG.md'), 'utf8'),
  ])

  const paths = namesResult.stdout.split('\0').filter(Boolean)
  const stats = parseNumstat(statsResult.stdout)
  const changedFiles = paths.map(path => ({
    path,
    additions: stats.get(path)?.additions ?? null,
    deletions: stats.get(path)?.deletions ?? null,
  }))

  return releaseEvidenceSchema.parse({
    schemaVersion: 1,
    generatedAt,
    baseTag,
    baseSha,
    headSha,
    versions,
    commits: parseLog(logResult.stdout),
    changedFiles,
    changelogUnreleased: extractUnreleased(changelog),
    workspaceChanges: {
      core: paths.some(path => path.startsWith('packages/core/')),
      otel: paths.some(path => path.startsWith('packages/otel/')),
      createOmaApp: paths.some(path => path.startsWith('packages/create-oma-app/')),
      docs: paths.some(path => path === 'README.md' || path.startsWith('docs/')),
      workflows: paths.some(path => path.startsWith('.github/workflows/')),
    },
  })
}

async function readVersions(repoRoot: string): Promise<ReleaseEvidence['versions']> {
  const [core, otel, createOmaApp] = await Promise.all([
    readManifestVersion(join(repoRoot, 'packages/core/package.json')),
    readManifestVersion(join(repoRoot, 'packages/otel/package.json')),
    readManifestVersion(join(repoRoot, 'packages/create-oma-app/package.json')),
  ])
  return { core, otel, createOmaApp }
}

async function readManifestVersion(path: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
  if (typeof manifest.version !== 'string') {
    throw new Error(`Manifest has no string version: ${path}`)
  }
  return manifest.version
}

function parseLog(output: string): ReleaseCommit[] {
  return output
    .split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [sha = '', subject = '', ...body] = record.split('\x1f')
      return { sha, subject, body: body.join('\x1f').trim() }
    })
}

function parseNumstat(output: string): Map<string, Pick<ChangedFile, 'additions' | 'deletions'>> {
  const result = new Map<string, Pick<ChangedFile, 'additions' | 'deletions'>>()
  const fields = output.split('\0').filter(Boolean)
  for (const field of fields) {
    const [rawAdditions = '-', rawDeletions = '-', path = ''] = field.split('\t')
    if (!path) continue
    result.set(path, {
      additions: rawAdditions === '-' ? null : Number(rawAdditions),
      deletions: rawDeletions === '-' ? null : Number(rawDeletions),
    })
  }
  return result
}

function extractUnreleased(changelog: string): string {
  const match = /^## Unreleased[ \t]*(?:\n|$)/m.exec(changelog)
  if (!match) throw new Error('CHANGELOG.md is missing the "## Unreleased" section.')
  const bodyStart = match.index + match[0].length
  const remainder = changelog.slice(bodyStart)
  const next = /^## /m.exec(remainder)
  return remainder.slice(0, next?.index ?? remainder.length).trim()
}
