import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileStore } from '../src/memory/file-store.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { Team } from '../src/team/team.js'
import { InMemoryStore } from '../src/memory/store.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  RunTaskSpec,
} from '../src/types.js'

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oma-filestore-'))
  filePath = join(dir, 'state.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileStore — basic KV semantics', () => {
  it('round-trips set/get/list/delete/clear in one instance', async () => {
    const store = new FileStore(filePath)

    expect(await store.get('missing')).toBeNull()
    expect(await store.list()).toEqual([])

    await store.set('a', 'alpha', { source: 'test' })
    await store.set('b', 'beta')

    const a = await store.get('a')
    expect(a?.value).toBe('alpha')
    expect(a?.metadata).toEqual({ source: 'test' })
    expect(a?.createdAt).toBeInstanceOf(Date)
    expect((await store.list()).map((e) => e.key)).toEqual(['a', 'b'])

    await store.delete('a')
    expect(await store.get('a')).toBeNull()
    expect((await store.list()).map((e) => e.key)).toEqual(['b'])

    await store.clear()
    expect(await store.list()).toEqual([])
  })

  it('copies metadata so later caller mutation does not leak in', async () => {
    const store = new FileStore(filePath)
    const metadata = { tag: 'v1' }
    await store.set('a', 'alpha', metadata)
    metadata.tag = 'mutated'
    expect((await store.get('a'))?.metadata).toEqual({ tag: 'v1' })
  })
})

describe('FileStore — durability across instances (survives restart)', () => {
  it('reads back values written by a previous instance on the same path', async () => {
    const writer = new FileStore(filePath)
    await writer.set('k', 'durable', { keep: true })

    // A fresh instance (new in-memory mirror) simulates a process restart.
    const reader = new FileStore(filePath)
    const entry = await reader.get('k')
    expect(entry?.value).toBe('durable')
    expect(entry?.metadata).toEqual({ keep: true })
  })

  it('preserves createdAt on update and across reload', async () => {
    const first = new FileStore(filePath)
    await first.set('k', 'v1')
    const created = (await first.get('k'))!.createdAt

    await first.set('k', 'v2') // update: createdAt must not move
    expect((await first.get('k'))!.createdAt.getTime()).toBe(created.getTime())

    const reloaded = new FileStore(filePath)
    const after = await reloaded.get('k')
    expect(after?.value).toBe('v2')
    expect(after?.createdAt.getTime()).toBe(created.getTime())
  })

  it('persists setWithExpiry expiry across reload', async () => {
    const first = new FileStore(filePath)
    await first.setWithExpiry('k', 'ttl', 7, { a: 1 })

    const reloaded = new FileStore(filePath)
    const entry = await reloaded.get('k')
    expect(entry?.value).toBe('ttl')
    expect(entry?.expiresAtTurn).toBe(7)
    expect(entry?.metadata).toEqual({ a: 1 })
  })

  it('persists delete and clear across reload', async () => {
    const first = new FileStore(filePath)
    await first.set('a', '1')
    await first.set('b', '2')
    await first.delete('a')
    expect((await new FileStore(filePath).list()).map((e) => e.key)).toEqual(['b'])

    await first.clear()
    expect(await new FileStore(filePath).list()).toEqual([])
  })
})

describe('FileStore — concurrency and atomicity', () => {
  it('does not lose writes under concurrent set()', async () => {
    const store = new FileStore(filePath)
    const keys = Array.from({ length: 25 }, (_, i) => `k${String(i)}`)

    await Promise.all(keys.map((k) => store.set(k, `v-${k}`)))

    const reloaded = new FileStore(filePath)
    const seen = (await reloaded.list()).map((e) => e.key).sort()
    expect(seen).toEqual([...keys].sort())
  })

  it('allows only one concurrent compare-and-set decision on one instance', async () => {
    const store = new FileStore(filePath)
    await store.set('approval', 'pending')

    const outcomes = await Promise.all([
      store.compareAndSet('approval', 'pending', 'approved'),
      store.compareAndSet('approval', 'pending', 'rejected'),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(['approved', 'rejected']).toContain((await store.get('approval'))?.value)
    expect((await new FileStore(filePath).get('approval'))?.value)
      .toBe((await store.get('approval'))?.value)
  })

  it('leaves no temp files behind after writes', async () => {
    const store = new FileStore(filePath)
    await Promise.all([store.set('a', '1'), store.set('b', '2'), store.set('c', '3')])
    const entries = await readdir(dir)
    expect(entries).toEqual(['state.json'])
  })

  it('writes valid, version-tagged JSON', async () => {
    const store = new FileStore(filePath)
    await store.set('a', '1')
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(Array.isArray(raw.entries)).toBe(true)
    expect(raw.entries[0]).toMatchObject({ key: 'a', value: '1' })
    expect(typeof raw.entries[0].createdAt).toBe('string')
  })
})

describe('FileStore — load edge cases', () => {
  it('treats a missing file as an empty store', async () => {
    const store = new FileStore(join(dir, 'does-not-exist.json'))
    expect(await store.list()).toEqual([])
  })

  it('throws (not silently resets) on a corrupt JSON file', async () => {
    await writeFile(filePath, 'not json at all', 'utf8')
    const store = new FileStore(filePath)
    await expect(store.list()).rejects.toThrow(/not valid JSON/)
  })

  it('throws on an unsupported file version', async () => {
    await writeFile(filePath, JSON.stringify({ version: 999, entries: [] }), 'utf8')
    const store = new FileStore(filePath)
    await expect(store.list()).rejects.toThrow(/unsupported state file version/)
  })

  it('throws on a malformed entry', async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, entries: [{ key: 'a' /* no value/createdAt */ }] }),
      'utf8',
    )
    const store = new FileStore(filePath)
    await expect(store.list()).rejects.toThrow(/malformed entry/)
  })

  it('throws on non-object metadata rather than silently corrupting it', async () => {
    const createdAt = new Date().toISOString()
    const bads: unknown[] = [null, 'a string', [1, 2]]
    for (const bad of bads) {
      await writeFile(
        filePath,
        JSON.stringify({ version: 1, entries: [{ key: 'a', value: 'v', createdAt, metadata: bad }] }),
        'utf8',
      )
      await expect(new FileStore(filePath).list()).rejects.toThrow(/non-object metadata/)
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end: FileStore as the checkpoint store survives a process restart
// ---------------------------------------------------------------------------

function textResponse(text: string, model: string): LLMResponse {
  return {
    id: `resp-${text}`,
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function scriptedAdapter(outputs: string[]) {
  let callCount = 0
  const adapter: LLMAdapter = {
    name: 'file-store-test',
    async chat(_messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
      const output = outputs[callCount] ?? `output-${String(callCount)}`
      callCount++
      return textResponse(output, options.model)
    },
    async *stream() {
      yield { type: 'done' as const, data: textResponse('stream-unused', 'mock-model') }
    },
  }
  return { adapter, calls: () => callCount }
}

function worker(name: string, adapter: LLMAdapter): AgentConfig {
  return { name, model: 'mock-model', adapter, systemPrompt: `You are ${name}.` }
}

describe('FileStore — checkpoint/resume across a simulated restart', () => {
  it('resumes from a durable checkpoint file with a fresh store instance', async () => {
    const tasks: RunTaskSpec[] = [
      { title: 'first', description: 'do first', assignee: 'worker' },
      { title: 'second', description: 'do second', assignee: 'worker', dependsOn: ['first'] },
    ]
    const scripted = scriptedAdapter(['first output', 'second output'])
    const abort = new AbortController()
    const orchestrator = new OpenMultiAgent({
      onProgress(event) {
        if (event.type === 'task_complete') abort.abort()
      },
    })

    // Run 1: shared memory in RAM, checkpoints to a durable file. Abort after
    // the first task completes — the second is left pending.
    const team = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: new InMemoryStore(),
    })
    await orchestrator.runTasks(team, tasks, {
      abortSignal: abort.signal,
      checkpoint: { store: new FileStore(filePath) },
    })
    expect(scripted.calls()).toBe(1)

    // Run 2: brand-new orchestrator, team, RAM shared memory, and — crucially —
    // a fresh FileStore reading the checkpoint back off disk.
    const resumedOrchestrator = new OpenMultiAgent()
    const resumedTeam = new Team({
      name: 'team',
      agents: [worker('worker', scripted.adapter)],
      sharedMemoryStore: new InMemoryStore(),
    })
    const restored = await resumedOrchestrator.restore(resumedTeam, {
      checkpoint: { store: new FileStore(filePath) },
    })

    // Only the remaining task ran; both end completed.
    expect(scripted.calls()).toBe(2)
    expect(restored.tasks?.map((r) => [r.title, r.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed'],
    ])
  })
})
