import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { SharedMemory } from '../src/memory/shared.js'
import { RedactingStore } from '../src/memory/redacting-store.js'
import { InMemoryStore } from '../src/memory/store.js'
import { Team } from '../src/team/team.js'
import { APPROVAL_KEY_PREFIX } from '../src/approval/durable.js'
import type { MemoryEntry, MemoryStore } from '../src/types.js'

describe('SharedMemory', () => {
  it('keeps checkpoint and approval records out of agent-visible memory', async () => {
    const store = new InMemoryStore()
    const mem = new SharedMemory(store)
    await mem.write('agent', 'visible', 'value')
    await store.set('__oma_checkpoint__/latest', '{"checkpoint":true}')
    await store.set(`${APPROVAL_KEY_PREFIX}apr_test`, '{"approval":true}')

    expect((await mem.listAll()).map((entry) => entry.key)).toEqual(['agent/visible'])
    expect(await mem.read(`${APPROVAL_KEY_PREFIX}apr_test`)).toBeNull()
    expect((await mem.snapshot()).entries.map((entry) => entry.key)).toEqual(['agent/visible'])
    expect(await mem.getSummary()).not.toContain('approval')
  })

  // -------------------------------------------------------------------------
  // Write & read
  // -------------------------------------------------------------------------

  it('writes and reads a value under a namespaced key', async () => {
    const mem = new SharedMemory()
    await mem.write('researcher', 'findings', 'TS 5.5 ships const type params')

    const entry = await mem.read('researcher/findings')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('TS 5.5 ships const type params')
  })

  it('returns null for a non-existent key', async () => {
    const mem = new SharedMemory()
    expect(await mem.read('nope/nothing')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Namespace isolation
  // -------------------------------------------------------------------------

  it('isolates writes between agents', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'plan', 'plan A')
    await mem.write('bob', 'plan', 'plan B')

    const alice = await mem.read('alice/plan')
    const bob = await mem.read('bob/plan')
    expect(alice!.value).toBe('plan A')
    expect(bob!.value).toBe('plan B')
  })

  it('listByAgent returns only that agent\'s entries', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'a1', 'v1')
    await mem.write('alice', 'a2', 'v2')
    await mem.write('bob', 'b1', 'v3')

    const aliceEntries = await mem.listByAgent('alice')
    expect(aliceEntries).toHaveLength(2)
    expect(aliceEntries.every((e) => e.key.startsWith('alice/'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Redaction on persist (RedactingStore backend)
  // -------------------------------------------------------------------------

  it('masks secrets on write while preserving namespacing and metadata', async () => {
    const mem = new SharedMemory(new RedactingStore(new InMemoryStore()))
    await mem.write('alice', 'result', 'the token is sk-abcdefghijklmnop', { kind: 'answer' })

    const entry = await mem.read('alice/result')
    expect(entry).not.toBeNull()
    expect(entry!.value).not.toContain('sk-abcdefghijklmnop')
    expect(entry!.value).toContain('[redacted]')
    // Namespacing + provenance metadata survive redaction.
    expect(entry!.key).toBe('alice/result')
    expect(entry!.metadata).toMatchObject({ agent: 'alice', kind: 'answer' })
  })

  it('redacts a structured value while keeping it parseable on read', async () => {
    const mem = new SharedMemory(new RedactingStore(new InMemoryStore()))
    await mem.write('alice', 'creds', { token: 'sk-abcdefghijklmnop', ok: true })

    const entry = await mem.read('alice/creds')
    expect(entry!.value).toEqual({ token: '[redacted]', ok: true })
  })

  // -------------------------------------------------------------------------
  // Overwrite
  // -------------------------------------------------------------------------

  it('overwrites a value and preserves createdAt', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'first')
    const first = await mem.read('agent/key')

    await mem.write('agent', 'key', 'second')
    const second = await mem.read('agent/key')

    expect(second!.value).toBe('second')
    expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime())
  })

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('stores metadata alongside the value', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'val', { priority: 'high' })

    const entry = await mem.read('agent/key')
    expect(entry!.metadata).toMatchObject({ priority: 'high', agent: 'agent' })
  })

  // -------------------------------------------------------------------------
  // Structured values
  // -------------------------------------------------------------------------

  it('roundtrips JSON object values while preserving string compatibility', async () => {
    const mem = new SharedMemory()
    const value = { status: 'done', count: 2, nested: { ok: true } } as const

    await mem.write('agent', 'structured', value)

    const entry = await mem.read('agent/structured')
    expect(entry!.value).toEqual(value)
  })

  it('roundtrips JSON array values through read and list', async () => {
    const mem = new SharedMemory()
    const value = ['task-a', { ready: true }, null] as const

    await mem.write('agent', 'handoff', value)

    expect((await mem.read('agent/handoff'))!.value).toEqual(value)
    expect((await mem.listAll())[0].value).toEqual(value)
    expect((await mem.listByAgent('agent'))[0].value).toEqual(value)
  })

  it('validates structured writes against an optional Zod schema', async () => {
    const mem = new SharedMemory()
    const schema = z.object({ answer: z.number() })

    await expect(
      mem.write('agent', 'bad', { answer: 'nope' }, undefined, { schema }),
    ).rejects.toThrow(/schema validation/)
    expect(await mem.read('agent/bad')).toBeNull()
  })

  it('keeps the underlying MemoryStore boundary string-only for structured values', async () => {
    const mem = new SharedMemory()
    const store = mem.getStore()

    await mem.write('agent', 'structured', { ready: true })

    const raw = await store.get('agent/structured')
    expect(raw!.value).toBe('{"ready":true}')
    expect(typeof raw!.value).toBe('string')
  })

  it('keeps legacy plain string store entries as strings even when JSON-looking', async () => {
    const data = new Map<string, MemoryEntry>()
    const store: MemoryStore = {
      async get(key) { return data.get(key) ?? null },
      async set(key, value, metadata) {
        data.set(key, { key, value, metadata, createdAt: new Date() })
      },
      async list() { return Array.from(data.values()) },
      async delete(key) { data.delete(key) },
      async clear() { data.clear() },
    }
    data.set('legacy/json-looking', {
      key: 'legacy/json-looking',
      value: '{"ready":true}',
      createdAt: new Date(),
    })
    const mem = new SharedMemory(store)

    const entry = await mem.read('legacy/json-looking')
    expect(entry!.value).toBe('{"ready":true}')
  })

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  it('returns empty string for an empty store', async () => {
    const mem = new SharedMemory()
    expect(await mem.getSummary()).toBe('')
  })

  it('produces a markdown summary grouped by agent', async () => {
    const mem = new SharedMemory()
    await mem.write('researcher', 'findings', 'result A')
    await mem.write('coder', 'plan', 'implement X')

    const summary = await mem.getSummary()
    expect(summary).toContain('## Shared Team Memory')
    expect(summary).toContain('### researcher')
    expect(summary).toContain('### coder')
    expect(summary).toContain('findings: result A')
    expect(summary).toContain('plan: implement X')
  })

  it('truncates long values in the summary', async () => {
    const mem = new SharedMemory()
    const longValue = 'x'.repeat(300)
    await mem.write('agent', 'big', longValue)

    const summary = await mem.getSummary()
    // Summary truncates at 200 chars → 197 + '…'
    expect(summary.length).toBeLessThan(longValue.length)
    expect(summary).toContain('…')
  })

  it('filters summary to only requested task IDs', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'task:t1:result', 'output 1')
    await mem.write('bob', 'task:t2:result', 'output 2')
    await mem.write('alice', 'notes', 'not a task result')

    const summary = await mem.getSummary({ taskIds: ['t2'] })
    expect(summary).toContain('### bob')
    expect(summary).toContain('task:t2:result: output 2')
    expect(summary).not.toContain('task:t1:result: output 1')
    expect(summary).not.toContain('notes: not a task result')
  })

  // -------------------------------------------------------------------------
  // listAll
  // -------------------------------------------------------------------------

  it('listAll returns entries from all agents', async () => {
    const mem = new SharedMemory()
    await mem.write('a', 'k1', 'v1')
    await mem.write('b', 'k2', 'v2')

    const all = await mem.listAll()
    expect(all).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Custom MemoryStore injection (issue #156)
  // -------------------------------------------------------------------------

  describe('custom MemoryStore injection', () => {
    /** Recording store that forwards to an internal map and tracks every call. */
    class RecordingStore implements MemoryStore {
      readonly data = new Map<string, MemoryEntry>()
      readonly setCalls: Array<{ key: string; value: string }> = []

      async get(key: string): Promise<MemoryEntry | null> {
        return this.data.get(key) ?? null
      }
      async set(
        key: string,
        value: string,
        metadata?: Record<string, unknown>,
      ): Promise<void> {
        this.setCalls.push({ key, value })
        this.data.set(key, { key, value, metadata, createdAt: new Date() })
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

    it('routes writes through an injected MemoryStore', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('alice', 'plan', 'v1')

      expect(store.setCalls).toEqual([{ key: 'alice/plan', value: 'v1' }])
    })

    it('preserves `<agent>/<key>` namespace prefix on the underlying store', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('bob', 'notes', 'hello')

      const entry = await store.get('bob/notes')
      expect(entry?.value).toBe('hello')
    })

    it('getSummary reads from the injected store', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('alice', 'k', 'val')

      const summary = await mem.getSummary()
      expect(summary).toContain('### alice')
      expect(summary).toContain('k: val')
    })

    it('getStore returns the injected store', () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      expect(mem.getStore()).toBe(store)
    })

    it('Team wires `sharedMemoryStore` into its SharedMemory', async () => {
      const store = new RecordingStore()
      const team = new Team({
        name: 'injection-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemoryStore: store,
      })

      const sharedMem = team.getSharedMemoryInstance()
      expect(sharedMem).toBeDefined()
      await sharedMem!.write('alice', 'fact', 'committed')

      expect(store.setCalls).toEqual([{ key: 'alice/fact', value: 'committed' }])
    })

    it('Team: `sharedMemoryStore` takes precedence over `sharedMemory: false`', () => {
      const store = new RecordingStore()
      const team = new Team({
        name: 'override-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: false,
        sharedMemoryStore: store,
      })

      // Custom store wins: memory is enabled even though the boolean is false.
      expect(team.getSharedMemoryInstance()).toBeDefined()
      expect(team.getSharedMemory()).toBe(store)
    })

    it('Team: neither flag → no shared memory (backward compat)', () => {
      const team = new Team({
        name: 'no-memory-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
      })
      expect(team.getSharedMemoryInstance()).toBeUndefined()
    })

    it('Team: `sharedMemory: true` only → default InMemoryStore (backward compat)', () => {
      const team = new Team({
        name: 'default-memory-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: true,
      })
      expect(team.getSharedMemoryInstance()).toBeDefined()
      expect(team.getSharedMemory()).toBeDefined()
    })

    // -----------------------------------------------------------------------
    // Shape validation — defends against malformed `sharedMemoryStore`
    // (e.g. plain objects from untrusted JSON) reaching SharedMemory.
    // -----------------------------------------------------------------------

    it('SharedMemory throws when store is a plain object missing methods', () => {
      const plain = { foo: 'bar' } as unknown as MemoryStore
      expect(() => new SharedMemory(plain)).toThrow(TypeError)
      expect(() => new SharedMemory(plain)).toThrow(/MemoryStore interface/)
    })

    it('SharedMemory throws when store is missing a single method', () => {
      const partial = {
        get: async () => null,
        set: async () => undefined,
        list: async () => [],
        delete: async () => undefined,
        // `clear` missing
      } as unknown as MemoryStore
      expect(() => new SharedMemory(partial)).toThrow(TypeError)
    })

    it('SharedMemory throws when store is null (cast)', () => {
      expect(() => new SharedMemory(null as unknown as MemoryStore)).toThrow(TypeError)
    })

    it('Team throws early on malformed `sharedMemoryStore`', () => {
      const bogus = { not: 'a store' } as unknown as MemoryStore
      expect(
        () =>
          new Team({
            name: 'bad-team',
            agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
            sharedMemoryStore: bogus,
          }),
      ).toThrow(TypeError)
    })

    it('Team throws on falsy-but-present sharedMemoryStore (null)', () => {
      // `null` is falsy but present; a truthy gate would silently drop it.
      // The `!== undefined` gate routes it through SharedMemory's shape check
      // so config bugs fail fast instead of being silently downgraded.
      expect(
        () =>
          new Team({
            name: 'null-store-team',
            agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
            sharedMemoryStore: null as unknown as MemoryStore,
          }),
      ).toThrow(TypeError)
    })

    it('Team: omitting sharedMemoryStore entirely still honors sharedMemory: true', () => {
      // Sanity check that the `!== undefined` gate does not accidentally
      // enable memory when the field is absent.
      const team = new Team({
        name: 'absent-store-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: true,
      })
      expect(team.getSharedMemoryInstance()).toBeDefined()
    })
  })

  describe('turn-TTL (writeExpiring + advanceTurn)', () => {
    it('writeExpiring entries are readable until the turn counter reaches expiry', async () => {
      const mem = new SharedMemory()
      await mem.writeExpiring('alice', 'short-lived', 'still here', 2)

      // turn 0: readable
      expect(await mem.read('alice/short-lived')).not.toBeNull()
      mem.advanceTurn()
      // turn 1: readable
      expect(await mem.read('alice/short-lived')).not.toBeNull()
      mem.advanceTurn()
      // turn 2: expired (currentTurn 2 >= expiresAtTurn 2)
      expect(await mem.read('alice/short-lived')).toBeNull()
    })

    it('write (no TTL) entries persist regardless of turn count', async () => {
      const mem = new SharedMemory()
      await mem.write('alice', 'permanent', 'forever')
      for (let i = 0; i < 100; i++) mem.advanceTurn()
      expect(await mem.read('alice/permanent')).not.toBeNull()
    })

    it('listAll / listByAgent / getSummary all filter expired entries', async () => {
      const mem = new SharedMemory()
      await mem.write('alice', 'kept', 'alive')
      await mem.writeExpiring('alice', 'dropped', 'gone', 1)
      mem.advanceTurn() // expires the second entry

      expect(await mem.listAll()).toHaveLength(1)
      expect(await mem.listByAgent('alice')).toHaveLength(1)
      const summary = await mem.getSummary()
      expect(summary).toContain('kept')
      expect(summary).not.toContain('dropped')
    })

    it('writeExpiring degrades to plain set when the store lacks setWithExpiry', async () => {
      // Custom stores satisfying only the required MemoryStore methods (no
      // setWithExpiry) still work — the entry persists indefinitely instead
      // of expiring. Documented behaviour, exercised here.
      const data = new Map<string, MemoryEntry>()
      const customStore: MemoryStore = {
        async get(key) { return data.get(key) ?? null },
        async set(key, value, metadata) {
          data.set(key, { key, value, metadata, createdAt: new Date() })
        },
        async list() { return Array.from(data.values()) },
        async delete(key) { data.delete(key) },
        async clear() { data.clear() },
      }
      const mem = new SharedMemory(customStore)
      await mem.writeExpiring('alice', 'ttl-ignored', 'still here', 1)
      mem.advanceTurn()
      // Custom store didn't record expiry, so the entry is still readable.
      expect(await mem.read('alice/ttl-ignored')).not.toBeNull()
    })

    it('getTurnCount reflects advanceTurn calls', async () => {
      const mem = new SharedMemory()
      expect(mem.getTurnCount()).toBe(0)
      mem.advanceTurn()
      mem.advanceTurn()
      mem.advanceTurn()
      expect(mem.getTurnCount()).toBe(3)
    })

    it('writeExpiring throws RangeError on non-positive-integer ttlTurns', async () => {
      const mem = new SharedMemory()
      for (const bad of [0, -1, 1.5, NaN, Infinity]) {
        await expect(
          mem.writeExpiring('alice', 'k', 'v', bad),
        ).rejects.toThrow(RangeError)
      }
    })

    it('expired entries remain in the underlying store (no destructive cleanup on read)', async () => {
      // Race-safe: in distributed stores (Redis/Postgres), deleting on read
      // would stomp on a concurrent write. SharedMemory only filters; store
      // impls do their own GC. Regression guard for the original review.
      const mem = new SharedMemory()
      const store = mem.getStore()
      await mem.writeExpiring('alice', 'gone', 'soon', 1)
      mem.advanceTurn() // expires it

      // SharedMemory hides the expired entry from callers...
      expect(await mem.read('alice/gone')).toBeNull()
      expect(await mem.listAll()).toHaveLength(0)
      expect(await mem.getSummary()).toBe('')

      // ...but the underlying store still has it (didn't get deleted).
      expect(await store.get('alice/gone')).not.toBeNull()
      expect(await store.list()).toHaveLength(1)
    })
  })
})
