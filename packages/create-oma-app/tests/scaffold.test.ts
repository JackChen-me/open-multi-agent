import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isNonEmptyDir, scaffold, TEMPLATES_DIR, toPackageName } from '../src/scaffold.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'create-oma-app-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('scaffold', () => {
  it('keeps the default demo compatible and dependent only on core', () => {
    const target = join(tmp, 'my-demo')
    scaffold({ targetDir: target, projectName: 'My Demo' })

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    // The 3-dependency promise extends here: the generated project is just core.
    expect(Object.keys(pkg.dependencies)).toEqual(['@open-multi-agent/core'])
    expect(Object.keys(pkg.devDependencies)).toEqual(['tsx'])
    expect(pkg.name).toBe('my-demo') // stamped + sanitized
    expect(pkg.engines).toEqual({ node: '>=20.0.0' })
  })

  it.each(['pr-review', 'security'] as const)('generates the %s production template with zod', (templateId) => {
    const target = join(tmp, templateId)
    scaffold({ targetDir: target, projectName: templateId, templateId })
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies)).toEqual(['@open-multi-agent/core', 'zod'])
    expect(pkg.engines).toEqual({ node: '>=20.0.0' })
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toMatch(templateId === 'pr-review' ? /PR Review Agent/ : /Security Analysis Agent/)
  })

  it.each(['demo', 'pr-review', 'security'] as const)('supports cloud and Ollama profiles for %s', (templateId) => {
    const cloud = join(tmp, `${templateId}-cloud`)
    const local = join(tmp, `${templateId}-local`)
    scaffold({ targetDir: cloud, projectName: 'cloud', templateId, providerId: 'cloud' })
    scaffold({ targetDir: local, projectName: 'local', templateId, providerId: 'ollama' })
    expect(existsSync(join(cloud, '.env'))).toBe(false)
    expect(existsSync(join(cloud, '.env.example'))).toBe(true)
    expect(existsSync(join(cloud, '.env.ollama.example'))).toBe(true)
    expect(readFileSync(join(local, '.env'), 'utf8')).toContain('OMA_RUNTIME=ollama')
  })

  it('restores dotfiles and ships the demo + env example', () => {
    const target = join(tmp, 'd')
    scaffold({ targetDir: target, projectName: 'd' })

    expect(existsSync(join(target, '.gitignore'))).toBe(true)
    expect(existsSync(join(target, '.env.example'))).toBe(true)
    expect(existsSync(join(target, '_gitignore'))).toBe(false)
    expect(existsSync(join(target, '_env.example'))).toBe(false)
    expect(existsSync(join(target, 'src/index.ts'))).toBe(true)
    expect(existsSync(join(target, 'src/demo-adapter.ts'))).toBe(true)
    expect(existsSync(join(target, 'src/report.ts'))).toBe(true)
    expect(existsSync(join(target, 'README.md'))).toBe(true)
  })

  // Landmine #1: a short, simple goal hits runTeam's single-agent short-circuit,
  // which would kill the multi-agent DAG. isSimpleGoal returns false once the
  // goal exceeds 200 chars (packages/core/src/orchestrator/orchestrator.ts), so
  // we pin the demo goal well above that.
  it('demo goal is long enough to bypass the single-agent short-circuit', () => {
    const demo = readFileSync(join(TEMPLATES_DIR, 'demo', 'src', 'index.ts'), 'utf8')
    const match = demo.match(/const goal = `([\s\S]*?)`/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBeGreaterThan(200)
  })

  // Landmine #2: a default tool preset would give the "no tools" demo agents
  // filesystem/bash access and write to disk. Assert the demo declares neither.
  it('demo agents declare no tools and set no default preset', () => {
    for (const templateId of ['demo', 'pr-review', 'security']) {
      const template = readFileSync(join(TEMPLATES_DIR, templateId, 'src', 'index.ts'), 'utf8')
      expect(template).not.toMatch(/\btools\s*:/)
      expect(template).not.toMatch(/toolPreset/)
    }
  })

  it('isNonEmptyDir distinguishes empty, non-empty, and missing dirs', () => {
    expect(isNonEmptyDir(tmp)).toBe(false) // freshly created, empty
    writeFileSync(join(tmp, 'x'), '1')
    expect(isNonEmptyDir(tmp)).toBe(true)
    expect(isNonEmptyDir(join(tmp, 'does-not-exist'))).toBe(false)
  })

  it('toPackageName sanitizes to a valid npm name', () => {
    expect(toPackageName('My Demo')).toBe('my-demo')
    expect(toPackageName('   ')).toBe('oma-demo')
    expect(toPackageName('@scope/Foo')).toBe('scope-foo')
    expect(toPackageName('Cool_App!')).toBe('cool-app')
  })
})
