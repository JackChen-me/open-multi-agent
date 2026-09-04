/**
 * Behavioral contract for {@link MemoryStore} implementations.
 *
 * `MemoryStore` is the seam with the most traffic from outside the repository:
 * it backs shared memory, checkpoint/resume, and the durable approval ledger,
 * and `docs/shared-memory.md` invites callers to implement it against Redis,
 * Postgres, or a vendor memory service. Until now the two shipped stores were
 * covered by separate bespoke tests, so nothing stated which behaviors an
 * outside implementation actually has to reproduce.
 *
 * Imports resolve through the public root barrel, so the suite describes the
 * contract using exactly the surface an external implementer sees.
 *
 * **What this suite deliberately does not require.**
 *
 * - *A defensive copy on read.* Both shipped stores hand back the live entry
 *   from their map. `MemoryEntry` is `readonly` in the type system, so "callers
 *   must not mutate what they read" is the contract; asserting either direction
 *   at runtime would freeze an implementation detail.
 * - *`list()` ordering.* Both shipped stores return insertion order, but
 *   `SharedMemory` only ever uses `list()` as a set (filter, group, delete-all).
 *   Requiring a stable order would rule out backends that cannot cheaply give
 *   one, for a guarantee no caller relies on.
 * - *Expiry enforcement.* Stores persist `expiresAtTurn` and nothing more;
 *   filtering belongs to `SharedMemory`, which owns the turn counter. A store
 *   that hides expired entries fails this suite on purpose.
 */

import { describe, expect, it } from 'vitest'
import type { MemoryStore } from '../../src/index.js'

export interface MemoryStoreContractOptions {
  /**
   * Whether a value survives a write/read round trip byte for byte. Set to
   * `false` for a store that rewrites values on the way in (`RedactingStore`)
   * or cannot read its own writes back verbatim. Round-trip cases are then
   * replaced by the weaker read-your-writes consistency check; every other
   * required invariant still runs.
   */
  readonly preservesValues?: boolean
  /**
   * Opens a second handle onto the same backing state the factory just built.
   * Supplied only by stores that claim durability, and enables the
   * cross-instance group. A store without it is not judged on durability
   * either way.
   */
  readonly reopen?: () => Promise<MemoryStore>
}

export type MemoryStoreContractFactory = () => MemoryStore | Promise<MemoryStore>

/** Present only when the implementation opted into the optional method. */
function optionalCas(store: MemoryStore) {
  return typeof store.compareAndSet === 'function' ? store.compareAndSet.bind(store) : null
}

function optionalExpiry(store: MemoryStore) {
  return typeof store.setWithExpiry === 'function' ? store.setWithExpiry.bind(store) : null
}

async function valuesByKey(store: MemoryStore): Promise<Map<string, string>> {
  return new Map((await store.list()).map((entry) => [entry.key, entry.value]))
}

/**
 * Reusable behavioral suite. Every shipped store runs it unchanged from
 * `memory-store-contract.test.ts`.
 */
export function runMemoryStoreContractSuite(
  name: string,
  createStore: MemoryStoreContractFactory,
  options: MemoryStoreContractOptions = {},
): void {
  const preservesValues = options.preservesValues ?? true

  describe(`${name} MemoryStore contract`, () => {
    // -----------------------------------------------------------------------
    // Required: read/write
    // -----------------------------------------------------------------------

    it('returns null for an absent key and a populated entry after a write', async () => {
      const store = await createStore()
      await expect(store.get('missing')).resolves.toBeNull()

      await store.set('present', 'value-1')
      const entry = await store.get('present')
      expect(entry).not.toBeNull()
      expect(entry?.key).toBe('present')
      expect(entry?.createdAt).toBeInstanceOf(Date)
      expect(Number.isNaN(entry!.createdAt.getTime())).toBe(false)

      // Read-your-writes: whatever the store chose to persist, `get` and
      // `list` must agree on it. A lossy store still owes this.
      expect((await valuesByKey(store)).get('present')).toBe(entry?.value)
      if (preservesValues) {
        expect(entry?.value).toBe('value-1')
      }
    })

    it('replaces the value on re-set and preserves the original createdAt', async () => {
      const store = await createStore()
      await store.set('key', 'first')
      const created = (await store.get('key'))!.createdAt

      await new Promise((resolve) => setTimeout(resolve, 2))
      await store.set('key', 'second')

      const updated = await store.get('key')
      expect(updated!.createdAt.getTime()).toBe(created.getTime())
      expect((await store.list()).filter((entry) => entry.key === 'key')).toHaveLength(1)
      if (preservesValues) {
        expect(updated?.value).toBe('second')
      }
    })

    // -----------------------------------------------------------------------
    // Required: metadata
    // -----------------------------------------------------------------------

    it('round-trips metadata, copies it on write, and clears it when omitted', async () => {
      const store = await createStore()
      const metadata: Record<string, unknown> = { agent: 'researcher', turn: 3, nested: { a: 1 } }
      await store.set('meta', 'value', metadata)
      expect((await store.get('meta'))?.metadata).toEqual({
        agent: 'researcher',
        turn: 3,
        nested: { a: 1 },
      })

      // The store must not retain the caller's object.
      metadata['agent'] = 'mutated'
      expect((await store.get('meta'))?.metadata).toMatchObject({ agent: 'researcher' })

      // Re-setting without metadata clears it rather than merging.
      await store.set('meta', 'value-2')
      expect((await store.get('meta'))?.metadata).toBeUndefined()

      await store.set('no-meta', 'value')
      expect((await store.get('no-meta'))?.metadata).toBeUndefined()
    })

    // -----------------------------------------------------------------------
    // Required: list
    // -----------------------------------------------------------------------

    it('lists every written key exactly once and nothing on an empty store', async () => {
      const store = await createStore()
      expect(await store.list()).toEqual([])

      await store.set('a', '1')
      await store.set('b', '2')
      await store.set('a', '1-updated')

      const keys = (await store.list()).map((entry) => entry.key)
      expect(keys).toHaveLength(2)
      expect(new Set(keys)).toEqual(new Set(['a', 'b']))
    })

    // -----------------------------------------------------------------------
    // Required: delete / clear
    // -----------------------------------------------------------------------

    it('makes delete idempotent, silent on an absent key, and invisible to reads', async () => {
      const store = await createStore()
      await store.set('doomed', 'value')
      await store.set('kept', 'value')

      await expect(store.delete('doomed')).resolves.toBeUndefined()
      await expect(store.get('doomed')).resolves.toBeNull()
      expect((await store.list()).map((entry) => entry.key)).toEqual(['kept'])

      // Deleting twice, and deleting something that never existed, are no-ops.
      await expect(store.delete('doomed')).resolves.toBeUndefined()
      await expect(store.delete('never-written')).resolves.toBeUndefined()
      expect((await store.list()).map((entry) => entry.key)).toEqual(['kept'])
    })

    it('empties the store on clear, tolerates clearing twice, and re-dates a rewritten key', async () => {
      const store = await createStore()
      await store.set('key', 'value')
      const before = (await store.get('key'))!.createdAt

      await store.clear()
      expect(await store.list()).toEqual([])
      await expect(store.get('key')).resolves.toBeNull()
      await expect(store.clear()).resolves.toBeUndefined()

      // `clear` removes the entry, so a later write starts a new lifetime
      // rather than resurrecting the old createdAt.
      await new Promise((resolve) => setTimeout(resolve, 2))
      await store.set('key', 'value')
      expect((await store.get('key'))!.createdAt.getTime()).toBeGreaterThan(before.getTime())
    })

    // -----------------------------------------------------------------------
    // Optional: compareAndSet
    // -----------------------------------------------------------------------

    describe('compareAndSet (optional)', () => {
      it('gates on the expected value and preserves createdAt on success', async (ctx) => {
        const store = await createStore()
        const cas = optionalCas(store)
        // A store may legitimately omit the method; durable approvals then fail
        // closed. Skip rather than return, so an omission reads as "skipped" in
        // the report instead of being indistinguishable from a real pass.
        if (cas === null) return ctx.skip()

        // `null` means "must not exist".
        await expect(cas('cas', null, 'first')).resolves.toBe(true)
        const created = (await store.get('cas'))!.createdAt
        const stored = (await store.get('cas'))!.value

        // The key now exists, so the create-only claim must fail and change nothing.
        await expect(cas('cas', null, 'clobbered')).resolves.toBe(false)
        expect((await store.get('cas'))?.value).toBe(stored)

        // A stale expectation must fail and change nothing.
        await expect(cas('cas', 'not-the-current-value', 'clobbered')).resolves.toBe(false)
        expect((await store.get('cas'))?.value).toBe(stored)

        // A matching expectation succeeds and keeps the original createdAt.
        await expect(cas('cas', stored, 'second')).resolves.toBe(true)
        expect((await store.get('cas'))!.createdAt.getTime()).toBe(created.getTime())
        if (preservesValues) {
          expect((await store.get('cas'))?.value).toBe('second')
        }
      })

      it('lets exactly one of two racing claims on the same expected value win', async (ctx) => {
        const store = await createStore()
        const cas = optionalCas(store)
        if (cas === null) return ctx.skip()

        await store.set('race', 'start')
        const expected = (await store.get('race'))!.value
        const results = await Promise.all([
          cas('race', expected, 'winner-a'),
          cas('race', expected, 'winner-b'),
        ])

        // This is the whole point of the method: two reviewers cannot both
        // believe they recorded the decision.
        expect(results.filter(Boolean)).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------------
    // Optional: setWithExpiry
    // -----------------------------------------------------------------------

    describe('setWithExpiry (optional)', () => {
      it('persists expiresAtTurn, never filters on it, and lets a plain set clear it', async (ctx) => {
        const store = await createStore()
        const setWithExpiry = optionalExpiry(store)
        if (setWithExpiry === null) return ctx.skip()

        await setWithExpiry('ttl', 'value', 7)
        expect((await store.get('ttl'))?.expiresAtTurn).toBe(7)

        // Turn 0 is expired for every turn counter, and the store must still
        // return it: expiry filtering belongs to SharedMemory, not here.
        await setWithExpiry('already-expired', 'value', 0)
        expect(await store.get('already-expired')).not.toBeNull()
        expect((await store.list()).map((entry) => entry.key)).toContain('already-expired')

        // A plain `set` writes a fresh entry with no expiry rather than
        // inheriting the previous one.
        await store.set('ttl', 'value-2')
        expect((await store.get('ttl'))?.expiresAtTurn).toBeUndefined()
      })

      it('preserves createdAt across an expiring update', async (ctx) => {
        const store = await createStore()
        const setWithExpiry = optionalExpiry(store)
        if (setWithExpiry === null) return ctx.skip()

        await store.set('key', 'value')
        const created = (await store.get('key'))!.createdAt
        await new Promise((resolve) => setTimeout(resolve, 2))

        await setWithExpiry('key', 'value-2', 5)
        expect((await store.get('key'))!.createdAt.getTime()).toBe(created.getTime())
      })
    })

    // -----------------------------------------------------------------------
    // Optional: durability across instances
    // -----------------------------------------------------------------------

    describe('durability (optional)', () => {
      it('replays writes and deletes to a second handle on the same backing state', async (ctx) => {
        const reopen = options.reopen
        if (reopen === undefined) return ctx.skip()
        const store = await createStore()

        await store.set('kept', 'value', { agent: 'writer' })
        await store.set('removed', 'value')
        await store.delete('removed')

        const reopened = await reopen()
        const entry = await reopened.get('kept')
        expect(entry).not.toBeNull()
        expect(entry?.metadata).toEqual({ agent: 'writer' })
        expect(entry?.createdAt).toBeInstanceOf(Date)
        await expect(reopened.get('removed')).resolves.toBeNull()
        expect((await reopened.list()).map((item) => item.key)).toEqual(['kept'])

        const expiry = optionalExpiry(store)
        if (expiry !== null) {
          await expiry('with-ttl', 'value', 9)
          expect((await (await reopen()).get('with-ttl'))?.expiresAtTurn).toBe(9)
        }
      })
    })
  })
}
