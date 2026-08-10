import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readCatalog, validateExampleCatalog } from './example-catalog-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const examplesRoot = join(root, 'examples')
const catalogPath = join(examplesRoot, 'catalog.json')

try {
  const catalog = readCatalog(catalogPath)
  const errors = validateExampleCatalog(catalog, examplesRoot)
  if (errors.length > 0) {
    console.error('Example catalog validation failed:')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log(`example catalog: ${catalog.examples.length} entries validated`)
  }
} catch (error) {
  console.error(`Example catalog validation failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
