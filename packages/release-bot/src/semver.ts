const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export type VersionBump = 'none' | 'patch' | 'minor' | 'major'

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

export function parseVersion(version: string): ParsedVersion {
  const match = SEMVER_RE.exec(version)
  if (!match) throw new Error(`Expected a stable semantic version, got "${version}".`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function bumpVersion(version: string, bump: Exclude<VersionBump, 'none'>): string {
  const parsed = parseVersion(version)
  switch (bump) {
    case 'major':
      return `${parsed.major + 1}.0.0`
    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0`
    case 'patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  }
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}
