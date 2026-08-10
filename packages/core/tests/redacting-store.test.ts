import { describe, expect, it } from 'vitest'
import { RedactingStore } from '../src/memory/redacting-store.js'
import { InMemoryStore } from '../src/memory/store.js'
import type { MemoryEntry, MemoryStore } from '../src/types.js'

/** Minimal store WITHOUT `setWithExpiry`, to exercise the TTL-capability mirror. */
class NoExpiryStore implements MemoryStore {
  readonly data = new Map<string, MemoryEntry>()

  async get(key: string): Promise<MemoryEntry | null> {
    return this.data.get(key) ?? null
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
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

describe('RedactingStore', () => {
  it('does not advertise lossy compare-and-set for exact durable approvals', () => {
    const store: MemoryStore = new RedactingStore(new InMemoryStore())
    expect(store.compareAndSet).toBeUndefined()
  })

  describe('set / read', () => {
    it('redacts a plain-string value on set; get returns the redacted value', async () => {
      const inner = new InMemoryStore()
      const store = new RedactingStore(inner)

      await store.set('k', 'password=hunter2')

      expect((await store.get('k'))?.value).toBe('password=[redacted]')
      // The raw backend holds the redacted value, not the secret.
      expect((await inner.get('k'))?.value).toBe('password=[redacted]')
    })

    it('redacts a token literal embedded in free text', async () => {
      const store = new RedactingStore(new InMemoryStore())
      await store.set('k', 'the key is sk-abcdefghijklmnop done')
      const value = (await store.get('k'))?.value ?? ''
      expect(value).not.toContain('sk-abcdefghijklmnop')
      expect(value).toContain('[redacted]')
    })

    it('list() reflects redacted values', async () => {
      const store = new RedactingStore(new InMemoryStore())
      await store.set('k', 'apiKey=abc123')
      const entries = await store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.value).toBe('apiKey=[redacted]')
    })
  })

  describe('JSON payloads (structure-aware)', () => {
    it('masks secrets but keeps a JSON object parseable with structure intact', async () => {
      const store = new RedactingStore(new InMemoryStore())
      const payload = JSON.stringify({
        token: 'sk-abcdefghijklmnop',
        result: 'my key is sk-zzzzzzzzzzzzzzzz here',
        keep: 'plain value',
      })

      await store.set('k', payload)
      const stored = (await store.get('k'))?.value ?? ''
      const parsed = JSON.parse(stored) as Record<string, string>

      expect(parsed.token).toBe('[redacted]') // sensitive key name
      expect(parsed.result).not.toContain('sk-zzzzzzzzzzzzzzzz') // token literal in a leaf
      expect(parsed.result).toContain('[redacted]')
      expect(parsed.keep).toBe('plain value') // untouched
    })

    it('leaves a JSON scalar as text (no throw, no structural change)', async () => {
      const store = new RedactingStore(new InMemoryStore())
      await store.set('n', '42')
      expect((await store.get('n'))?.value).toBe('42')
    })
  })

  describe('custom patterns', () => {
    it('applies caller-supplied patterns on top of built-ins', async () => {
      const store = new RedactingStore(new InMemoryStore(), {
        patterns: [/\d{3}-\d{2}-\d{4}/],
      })
      await store.set('k', 'ssn 123-45-6789 and key sk-abcdefghijklmnop')
      const value = (await store.get('k'))?.value ?? ''
      expect(value).not.toContain('123-45-6789')
      expect(value).not.toContain('sk-abcdefghijklmnop')
    })
  })

  describe('setWithExpiry capability mirror', () => {
    it('is present and redacts when the inner store supports it', async () => {
      const inner = new InMemoryStore()
      const store = new RedactingStore(inner)

      expect(typeof store.setWithExpiry).toBe('function')
      await store.setWithExpiry?.('k', 'secret=topsecret', 5)

      const entry = await inner.get('k')
      expect(entry?.value).toBe('secret=[redacted]')
      expect(entry?.expiresAtTurn).toBe(5)
    })

    it('is absent when the inner store lacks it (preserves TTL fallback)', () => {
      const store = new RedactingStore(new NoExpiryStore())
      expect(store.setWithExpiry).toBeUndefined()
    })
  })

  describe('passthrough', () => {
    it('forwards metadata unchanged', async () => {
      const store = new RedactingStore(new InMemoryStore())
      await store.set('k', 'password=x', { agent: 'alice', kind: 'note' })
      expect((await store.get('k'))?.metadata).toEqual({ agent: 'alice', kind: 'note' })
    })

    it('forwards delete and clear', async () => {
      const store = new RedactingStore(new InMemoryStore())
      await store.set('a', 'password=1')
      await store.set('b', 'password=2')

      await store.delete('a')
      expect(await store.get('a')).toBeNull()

      await store.clear()
      expect(await store.list()).toHaveLength(0)
    })
  })
})
