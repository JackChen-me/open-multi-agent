/**
 * Long-lived server SIGTERM lifecycle
 *
 * Run after building the workspaces:
 *   npx tsx examples/integrations/observability-v2/server-lifecycle.ts
 *
 * Prerequisites: none. The application explicitly registers the handler.
 */
import { createServer, type Server } from 'node:http'
import { BatchingTraceSink, InMemoryTraceStore, TraceStoreExporter } from '@open-multi-agent/core/observability'
import { runDemo } from './demo-runtime.js'

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

const store = new InMemoryTraceStore()
const sink = new BatchingTraceSink(new TraceStoreExporter(store), { diagnostics: 'silent' })
const server = createServer((_request, response) => response.end('ok'))
let resolveStopped!: () => void
const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })

async function stop(): Promise<void> {
  // Stop accepting requests and wait for in-flight work before cutting off emit.
  await close(server)
  await sink.forceFlush({ timeoutMs: 2_000 })
  await sink.shutdown({ timeoutMs: 2_000 })
  resolveStopped()
}

process.once('SIGTERM', () => { void stop().catch((error) => { console.error(error); resolveStopped() }) })
await listen(server)
await runDemo(sink, 'example-server-lifecycle')
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10).unref()
await stopped
console.log('server and telemetry stopped')
