import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, resolve, sep } from 'node:path'

export const CATALOG_SCHEMA_VERSION = 1

export const EXAMPLE_SECTIONS = ['goal', 'models-providers']

export const EXAMPLE_GOALS = [
  'start-here',
  'use-case-recipes',
  'orchestration',
  'production-controls',
  'connect-your-stack',
]

export const EXAMPLE_CAPABILITIES = [
  'acp',
  'adaptive-recovery',
  'agent-pool',
  'ai-sdk',
  'conflict-detection',
  'consensus',
  'cost-control',
  'custom-tools',
  'delegation',
  'evaluation',
  'external-agents',
  'http-server',
  'local-models',
  'long-term-memory',
  'mcp',
  'multi-model',
  'multi-turn',
  'observability',
  'open-telemetry',
  'openai-compatible',
  'parallel-execution',
  'plan-replay',
  'process-backend',
  'provider-adapter',
  'reasoning-transfer',
  'retry',
  'run-agent',
  'run-team',
  'run-tasks',
  'run-viewer',
  'safety-arbitration',
  'server-lifecycle',
  'shared-memory',
  'streaming',
  'structured-output',
  'task-dependencies',
  'tool-gating',
  'tool-use',
  'trace-store',
]

export const EXAMPLE_FORMATS = ['script', 'multi-file', 'app']
export const EXAMPLE_LEVELS = ['beginner', 'intermediate', 'advanced']

const SCRIPT_DIRECTORIES = ['basics', 'cookbook', 'patterns', 'providers']
const ENTRY_KEYS = new Set([
  'id',
  'path',
  'title',
  'description',
  'section',
  'goal',
  'capabilities',
  'format',
  'level',
  'featuredOrder',
  'entrypoints',
])
const GOAL_SET = new Set(EXAMPLE_GOALS)
const CAPABILITY_SET = new Set(EXAMPLE_CAPABILITIES)
const FORMAT_SET = new Set(EXAMPLE_FORMATS)
const LEVEL_SET = new Set(EXAMPLE_LEVELS)
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function listImmediateScripts(examplesRoot, directory) {
  const absolute = join(examplesRoot, directory)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${directory}/${entry.name}`)
}

function listImmediateDirectories(examplesRoot, directory) {
  const absolute = join(examplesRoot, directory)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}`)
}

export function discoverExampleUnits(examplesRoot) {
  return [
    ...SCRIPT_DIRECTORIES.flatMap((directory) => listImmediateScripts(examplesRoot, directory)),
    ...listImmediateScripts(examplesRoot, 'integrations'),
    ...listImmediateDirectories(examplesRoot, 'integrations'),
    ...listImmediateDirectories(examplesRoot, 'production'),
  ].sort()
}

function listFilesRecursively(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) return listFilesRecursively(absolute, relative)
    return entry.isFile() ? [relative] : []
  })
}

export function discoverDocumentedEntrypoints(entry, examplesRoot) {
  if (entry.format !== 'multi-file' || !isSafeRelativePath(entry.path)) return []
  const directory = join(examplesRoot, entry.path)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []

  return listFilesRecursively(directory)
    .filter((relative) => relative.endsWith('.ts'))
    .filter((relative) => {
      const source = readFileSync(join(directory, relative), 'utf8')
      const docblock = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[0]
      if (!docblock || !/\n\s*\*\s*Run(?:\s+[^:\n]+)?\s*:/.test(docblock)) return false
      return docblock.includes(`packages/core/examples/${entry.path}/${relative}`)
    })
    .sort()
}

export function compareCatalogInventory(entries, discoveredPaths) {
  const catalogPaths = new Set(entries.map((entry) => entry.path))
  const discovered = new Set(discoveredPaths)
  return {
    missingFromCatalog: [...discovered].filter((path) => !catalogPaths.has(path)).sort(),
    missingFromFilesystem: [...catalogPaths].filter((path) => !discovered.has(path)).sort(),
  }
}

function isSafeRelativePath(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.startsWith('./') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..') &&
    posix.normalize(value) === value
}

function duplicateValues(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function validateEntryShape(entry, index) {
  const errors = []
  const label = `examples[${index}]`
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${label} must be an object`]
  }

  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) errors.push(`${label} has unknown property ${key}`)
  }

  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
    errors.push(`${label}.id must be a lowercase kebab-case string`)
  }
  if (!isSafeRelativePath(entry.path)) {
    errors.push(`${label}.path must be a normalized relative path inside examples/`)
  }
  for (const field of ['title', 'description']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      errors.push(`${label}.${field} must be a non-empty string`)
    }
  }
  if (!EXAMPLE_SECTIONS.includes(entry.section)) {
    errors.push(`${label}.section must be goal or models-providers`)
  }
  if (!FORMAT_SET.has(entry.format)) errors.push(`${label}.format is unsupported`)
  if (!LEVEL_SET.has(entry.level)) errors.push(`${label}.level is unsupported`)

  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
    errors.push(`${label}.capabilities must be a non-empty array`)
  } else {
    for (const capability of entry.capabilities) {
      if (!CAPABILITY_SET.has(capability)) {
        errors.push(`${label}.capabilities contains unsupported value ${capability}`)
      }
    }
    for (const duplicate of duplicateValues(entry.capabilities)) {
      errors.push(`${label}.capabilities repeats ${duplicate}`)
    }
  }

  if (entry.section === 'goal') {
    if (!GOAL_SET.has(entry.goal)) errors.push(`${label}.goal is required and must be supported`)
  } else if (entry.section === 'models-providers') {
    if ('goal' in entry) errors.push(`${label}.goal is forbidden for models-providers`)
    if ('featuredOrder' in entry) errors.push(`${label}.featuredOrder is forbidden for models-providers`)
    if (typeof entry.path === 'string' && !/^providers\/[a-z0-9-]+\.ts$/.test(entry.path)) {
      errors.push(`${label}.path must point to a top-level providers/*.ts file`)
    }
    if (Array.isArray(entry.capabilities) && !entry.capabilities.includes('provider-adapter')) {
      errors.push(`${label}.capabilities must include provider-adapter`)
    }
  }

  if ('featuredOrder' in entry &&
      (!Number.isInteger(entry.featuredOrder) || entry.featuredOrder < 1)) {
    errors.push(`${label}.featuredOrder must be a positive integer`)
  }

  if (entry.format === 'script') {
    if (typeof entry.path === 'string' && !entry.path.endsWith('.ts')) {
      errors.push(`${label}.path must end in .ts for script format`)
    }
    if ('entrypoints' in entry) errors.push(`${label}.entrypoints is forbidden for script format`)
  } else if (!Array.isArray(entry.entrypoints) || entry.entrypoints.length === 0) {
    errors.push(`${label}.entrypoints must be a non-empty array for ${entry.format ?? 'directory'} format`)
  } else {
    for (const entrypoint of entry.entrypoints) {
      if (!isSafeRelativePath(entrypoint)) {
        errors.push(`${label}.entrypoints contains an unsafe path ${entrypoint}`)
      }
    }
    for (const duplicate of duplicateValues(entry.entrypoints)) {
      errors.push(`${label}.entrypoints repeats ${duplicate}`)
    }
  }

  return errors
}

export function validateCatalogDocument(catalog) {
  const errors = []
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return ['catalog must be an object']
  }

  const allowedRootKeys = new Set(['$schema', 'schemaVersion', 'examples'])
  for (const key of Object.keys(catalog)) {
    if (!allowedRootKeys.has(key)) errors.push(`catalog has unknown property ${key}`)
  }
  if (catalog.$schema !== './catalog.schema.json') {
    errors.push('catalog.$schema must be ./catalog.schema.json')
  }
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    errors.push(`catalog.schemaVersion must be ${CATALOG_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(catalog.examples)) {
    errors.push('catalog.examples must be an array')
    return errors
  }

  catalog.examples.forEach((entry, index) => errors.push(...validateEntryShape(entry, index)))

  for (const duplicate of duplicateValues(catalog.examples.map((entry) => entry?.id))) {
    errors.push(`duplicate example id: ${duplicate}`)
  }
  for (const duplicate of duplicateValues(catalog.examples.map((entry) => entry?.path))) {
    errors.push(`duplicate example path: ${duplicate}`)
  }

  const featured = catalog.examples
    .filter((entry) => entry?.section === 'goal' && Number.isInteger(entry.featuredOrder))
    .map((entry) => `${entry.goal}:${entry.featuredOrder}`)
  for (const duplicate of duplicateValues(featured)) {
    errors.push(`duplicate featuredOrder within goal: ${duplicate}`)
  }

  return errors
}

function validateEntryFilesystem(entry, examplesRoot) {
  const errors = []
  if (!isSafeRelativePath(entry.path)) return errors
  const absolute = join(examplesRoot, entry.path)
  if (!existsSync(absolute)) return [`${entry.id}: path does not exist: ${entry.path}`]

  const stat = statSync(absolute)
  if (entry.format === 'script' && !stat.isFile()) {
    errors.push(`${entry.id}: script path must be a file: ${entry.path}`)
  }
  if (entry.format !== 'script' && !stat.isDirectory()) {
    errors.push(`${entry.id}: ${entry.format} path must be a directory: ${entry.path}`)
  }
  if (entry.format === 'app' && !existsSync(join(absolute, 'package.json'))) {
    errors.push(`${entry.id}: app directory must contain package.json`)
  }

  if (Array.isArray(entry.entrypoints)) {
    const directory = resolve(absolute)
    for (const entrypoint of entry.entrypoints) {
      if (!isSafeRelativePath(entrypoint)) continue
      const target = resolve(absolute, entrypoint)
      if (target !== directory && !target.startsWith(`${directory}${sep}`)) {
        errors.push(`${entry.id}: entrypoint escapes its example directory: ${entrypoint}`)
      } else if (!existsSync(target) || !statSync(target).isFile()) {
        errors.push(`${entry.id}: entrypoint does not exist as a file: ${entrypoint}`)
      }
    }
  }

  if (entry.format === 'multi-file') {
    const documented = discoverDocumentedEntrypoints(entry, examplesRoot)
    const registered = Array.isArray(entry.entrypoints) ? [...entry.entrypoints].sort() : []
    const documentedSet = new Set(documented)
    const registeredSet = new Set(registered)
    for (const entrypoint of documented.filter((path) => !registeredSet.has(path))) {
      errors.push(`${entry.id}: documented runnable entrypoint is missing from catalog: ${entrypoint}`)
    }
    for (const entrypoint of registered.filter((path) => !documentedSet.has(path))) {
      errors.push(`${entry.id}: catalog entrypoint has no self-referencing Run block: ${entrypoint}`)
    }
  }

  if (entry.path.startsWith('production/')) {
    for (const required of ['README.md', 'index.ts']) {
      if (!existsSync(join(absolute, required))) {
        errors.push(`${entry.id}: production example must contain ${required}`)
      }
    }
    const tests = join(absolute, 'tests')
    if (!existsSync(tests) || !statSync(tests).isDirectory()) {
      errors.push(`${entry.id}: production example must contain tests/`)
    }
  }

  return errors
}

export function validateExampleCatalog(catalog, examplesRoot) {
  const errors = validateCatalogDocument(catalog)
  if (!Array.isArray(catalog?.examples)) return errors

  const discovered = discoverExampleUnits(examplesRoot)
  const inventory = compareCatalogInventory(catalog.examples, discovered)
  for (const path of inventory.missingFromCatalog) {
    errors.push(`example is missing from catalog: ${path}`)
  }
  for (const path of inventory.missingFromFilesystem) {
    errors.push(`catalog path is not a discovered example unit: ${path}`)
  }
  for (const entry of catalog.examples) {
    if (entry && typeof entry === 'object') {
      errors.push(...validateEntryFilesystem(entry, examplesRoot))
    }
  }
  return errors
}

export function readCatalog(catalogPath) {
  return JSON.parse(readFileSync(catalogPath, 'utf8'))
}
