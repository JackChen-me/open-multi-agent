import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
// Resolved rather than joined onto `root`: a git worktree has no local
// `node_modules` and resolves upwards to the main checkout.
const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const directory = join(root, 'packages', 'core', 'examples', 'integrations', 'observability-v2')
const examples = [
  'batching-exporter.ts',
  'in-memory-store.ts',
  'file-trace-store.ts',
  'otel-provider.ts',
  'otlp-backend.ts',
  'cli-lifecycle.ts',
  'server-lifecycle.ts',
  'serverless-lifecycle.ts',
]

for (const example of examples) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, join(directory, example)], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NO_COLOR: '1' },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${example} failed with code ${code ?? 'null'} signal ${signal ?? 'none'}`))
    })
  })
}

console.log(`observability example smoke: ${examples.length} passed`)
