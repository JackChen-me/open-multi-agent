import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileStore } from '../src/memory/file-store.js'
import { RedactingStore } from '../src/memory/redacting-store.js'
import { InMemoryStore } from '../src/memory/store.js'
import type { MemoryEntry, MemoryStore } from '../src/types.js'
import { runMemoryStoreContractSuite } from './helpers/memory-store-contract.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oma-memory-contract-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const filePath = () => join(dir, 'store.json')
const redactedPath = () => join(dir, 'redacted.json')

runMemoryStoreContractSuite('InMemoryStore', () => new InMemoryStore())

runMemoryStoreContractSuite('FileStore', () => new FileStore(filePath()), {
  reopen: async () => new FileStore(filePath()),
})

// The decorator is in the suite for two reasons: it is the only shipped store
// that omits an optional method, and the only one that rewrites values on the
// way in. Both are shapes a third-party store can legitimately have, so the
// contract has to stay satisfiable under them.
runMemoryStoreContractSuite(
  'RedactingStore(FileStore)',
  () => new RedactingStore(new FileStore(redactedPath())),
  {
    preservesValues: false,
    reopen: async () => new RedactingStore(new FileStore(redactedPath())),
  },
)

/**
 * The store a competent implementer writes on a first pass against the type
 * signature alone. It satisfies the compiler and every obvious case; each
 * deviation below is one a reviewer caught in a real submission (#335) or one
 * the interface documents but the type cannot express.
 */
class NaiveStore implements MemoryStore {
  private readonly data = new Map<string, MemoryEntry>()
  private turn = 0

  async get(key: string): Promise<MemoryEntry | null> {
    const entry = this.data.get(key)
    // Bug: hides expired entries. Expiry filtering belongs to SharedMemory,
    // which owns the turn counter; a store that filters double-counts it.
    if (entry?.expiresAtTurn !== undefined && this.turn >= entry.expiresAtTurn) return null
    return entry ?? null
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    // Bug 1: resets createdAt on update, so callers cannot tell when a value
    // was first written. Bug 2: retains the caller's metadata object.
    this.data.set(key, { key, value, metadata, createdAt: new Date() })
  }

  async compareAndSet(
    key: string,
    expectedValue: string | null,
    value: string,
  ): Promise<boolean> {
    // Bug: yields to the event loop between the read and the write, so two
    // callers can both observe the same expected value and both claim success.
    const existing = this.data.get(key)
    await Promise.resolve()
    if ((existing?.value ?? null) !== expectedValue) return false
    this.data.set(key, { key, value, createdAt: existing?.createdAt ?? new Date() })
    return true
  }

  async setWithExpiry(key: string, value: string, expiresAtTurn: number): Promise<void> {
    this.data.set(key, { key, value, createdAt: new Date(), expiresAtTurn })
  }

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.data.values())
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}

describe('MemoryStore contract discrimination', () => {
  // A conformance suite that only ever passes proves nothing. Each case below
  // asserts the exact opposite of a suite case, on a store built to get that
  // one thing wrong, so the invariant is shown to be discriminating rather
  // than trivially true. The pairing is by construction, not enforced: these
  // do not re-run the suite, they pin the behavior the suite would reject.
  it('rejects a store that resets createdAt on update', async () => {
    const store = new NaiveStore()
    await store.set('key', 'first')
    const created = (await store.get('key'))!.createdAt
    await new Promise((resolve) => setTimeout(resolve, 2))
    await store.set('key', 'second')
    expect((await store.get('key'))!.createdAt.getTime()).not.toBe(created.getTime())
  })

  it('rejects a store that retains the caller metadata object', async () => {
    const store = new NaiveStore()
    const metadata: Record<string, unknown> = { agent: 'researcher' }
    await store.set('meta', 'value', metadata)
    metadata['agent'] = 'mutated'
    expect((await store.get('meta'))?.metadata).toMatchObject({ agent: 'mutated' })
  })

  it('rejects a store that filters expired entries itself', async () => {
    const store = new NaiveStore()
    await store.setWithExpiry('already-expired', 'value', 0)
    expect(await store.get('already-expired')).toBeNull()
  })

  it('rejects a store whose compareAndSet is not atomic across an await', async () => {
    const store = new NaiveStore()
    await store.set('race', 'start')
    const results = await Promise.all([
      store.compareAndSet('race', 'start', 'winner-a'),
      store.compareAndSet('race', 'start', 'winner-b'),
    ])
    expect(results.filter(Boolean)).toHaveLength(2)
  })
})

describe('MemoryStore contract coverage', () => {
  it('exercises a store that omits compareAndSet and one that provides it', () => {
    // Guards the capability probe itself: if every store under test answered
    // the same way, the optional groups would be vacuous and nobody would
    // notice.
    // Read through the interface, which is how SharedMemory probes and the
    // only view in which the decorator's omission is even expressible: the
    // concrete `RedactingStore` type declares no `compareAndSet` at all.
    const provided: MemoryStore = new FileStore(filePath())
    const omitted: MemoryStore = new RedactingStore(new FileStore(redactedPath()))
    expect(typeof provided.compareAndSet).toBe('function')
    expect(omitted.compareAndSet).toBeUndefined()
  })

  it('exercises a store that actually loses values, justifying preservesValues', async () => {
    // `preservesValues: false` above must reflect real behavior rather than a
    // precaution, or the flag would silently weaken the suite for free.
    const store = new RedactingStore(new FileStore(redactedPath()))
    await store.set('secret', 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
    const stored = (await store.get('secret'))!.value
    expect(stored).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
  })
})
