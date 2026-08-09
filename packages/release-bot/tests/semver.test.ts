import { describe, expect, it } from 'vitest'
import { bumpVersion, compareVersions, parseVersion } from '../src/semver.js'

describe('semantic version helpers', () => {
  it('parses and increments stable versions', () => {
    expect(parseVersion('1.14.2')).toEqual({ major: 1, minor: 14, patch: 2 })
    expect(bumpVersion('1.14.2', 'patch')).toBe('1.14.3')
    expect(bumpVersion('1.14.2', 'minor')).toBe('1.15.0')
    expect(bumpVersion('1.14.2', 'major')).toBe('2.0.0')
  })

  it('rejects prereleases and malformed values', () => {
    expect(() => parseVersion('1.15.0-beta.1')).toThrow(/stable semantic version/)
    expect(() => parseVersion('v1.15.0')).toThrow(/stable semantic version/)
  })

  it('compares versions without lexical mistakes', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.8.0', '1.0.0')).toBeLessThan(0)
  })
})
