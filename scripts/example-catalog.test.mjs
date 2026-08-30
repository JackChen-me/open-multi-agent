import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  EXAMPLE_CAPABILITIES,
  EXAMPLE_FORMATS,
  EXAMPLE_GOALS,
  EXAMPLE_LEVELS,
  EXAMPLE_SECTIONS,
  compareCatalogInventory,
  discoverDocumentedEntrypoints,
  discoverExampleUnits,
  readCatalog,
  validateCatalogDocument,
  validateExampleCatalog,
} from './example-catalog-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const examplesRoot = join(root, 'packages', 'core', 'examples')
const catalog = readCatalog(join(examplesRoot, 'catalog.json'))
const schema = readCatalog(join(examplesRoot, 'catalog.schema.json'))

function copyCatalog() {
  return JSON.parse(JSON.stringify(catalog))
}

test('the checked-in catalog covers every discovered example unit', () => {
  assert.equal(catalog.examples.length, 64)
  assert.deepEqual(validateExampleCatalog(catalog, examplesRoot), [])
})

test('the public schema and runtime validator use the same controlled vocabulary', () => {
  assert.deepEqual(schema.$defs.capability.enum, EXAMPLE_CAPABILITIES)
  assert.deepEqual(schema.$defs.example.properties.section.enum, EXAMPLE_SECTIONS)
  assert.deepEqual(
    schema.$defs.example.properties.goal.enum,
    EXAMPLE_GOALS,
  )
  assert.deepEqual(schema.$defs.example.properties.format.enum, EXAMPLE_FORMATS)
  assert.deepEqual(schema.$defs.example.properties.level.enum, EXAMPLE_LEVELS)
})

test('discovery uses standalone scripts and immediate example directories as units', () => {
  const discovered = discoverExampleUnits(examplesRoot)
  assert.equal(discovered.length, 64)
  assert.ok(discovered.includes('basics/single-agent.ts'))
  assert.ok(discovered.includes('cookbook/commission-reconciliation-recovery.ts'))
  assert.ok(discovered.includes('cookbook/market-data-integrity-verify-loop.ts'))
  assert.ok(discovered.includes('patterns/event-driven-dag.ts'))
  assert.ok(discovered.includes('patterns/durable-approval.ts'))
  assert.ok(discovered.includes('patterns/rich-tool-results.ts'))
  assert.ok(discovered.includes('integrations/trace-observability.ts'))
  assert.ok(discovered.includes('integrations/observability-v2'))
  assert.ok(!discovered.includes('integrations/observability-v2/run-viewer.ts'))
  assert.ok(!discovered.some((path) => path.startsWith('fixtures/')))
})

test('multi-file suites register every self-documented runnable entrypoint', () => {
  const observability = catalog.examples.find((entry) => entry.id === 'observability-v2')
  const engram = catalog.examples.find((entry) => entry.id === 'with-engram')
  assert.deepEqual(
    discoverDocumentedEntrypoints(observability, examplesRoot),
    [...observability.entrypoints].sort(),
  )
  assert.deepEqual(
    discoverDocumentedEntrypoints(engram, examplesRoot),
    [...engram.entrypoints].sort(),
  )
})

test('inventory comparison reports both unregistered and stale entries', () => {
  assert.deepEqual(
    compareCatalogInventory(
      [{ path: 'basics/single-agent.ts' }, { path: 'patterns/stale.ts' }],
      ['basics/single-agent.ts', 'cookbook/new-example.ts'],
    ),
    {
      missingFromCatalog: ['cookbook/new-example.ts'],
      missingFromFilesystem: ['patterns/stale.ts'],
    },
  )
})

test('full validation fails when a discovered standalone example is unregistered', () => {
  const invalid = copyCatalog()
  invalid.examples = invalid.examples.filter((entry) => entry.id !== 'single-agent')
  const errors = validateExampleCatalog(invalid, examplesRoot)
  assert.ok(errors.includes('example is missing from catalog: basics/single-agent.ts'))
})

test('full validation fails when a suite omits a documented runnable entrypoint', () => {
  const invalid = copyCatalog()
  const observability = invalid.examples.find((entry) => entry.id === 'observability-v2')
  observability.entrypoints = observability.entrypoints.filter((entrypoint) => entrypoint !== 'run-viewer.ts')
  const errors = validateExampleCatalog(invalid, examplesRoot)
  assert.ok(errors.includes(
    'observability-v2: documented runnable entrypoint is missing from catalog: run-viewer.ts',
  ))
})

test('document validation rejects duplicate identities and featured order', () => {
  const invalid = copyCatalog()
  invalid.examples[1].id = invalid.examples[0].id
  invalid.examples[1].featuredOrder = invalid.examples[0].featuredOrder
  const errors = validateCatalogDocument(invalid)
  assert.ok(errors.some((error) => error.startsWith('duplicate example id:')))
  assert.ok(errors.some((error) => error.startsWith('duplicate featuredOrder within goal:')))
})

test('models and providers entries cannot silently become goal cards', () => {
  const invalid = copyCatalog()
  const provider = invalid.examples.find((entry) => entry.section === 'models-providers')
  provider.goal = 'start-here'
  provider.featuredOrder = 1
  provider.capabilities = ['run-team']
  const errors = validateCatalogDocument(invalid)
  assert.ok(errors.some((error) => error.includes('goal is forbidden for models-providers')))
  assert.ok(errors.some((error) => error.includes('featuredOrder is forbidden for models-providers')))
  assert.ok(errors.some((error) => error.includes('must include provider-adapter')))
})
