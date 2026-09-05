/**
 * @fileoverview A {@link MemoryStore} decorator that redacts secrets from
 * values before they reach a wrapped backend.
 *
 * Redaction elsewhere in the framework stops at the observability layer (trace
 * events, dashboard payload, `bash` output). Shared-memory writes and durable
 * checkpoint saves persist agent output verbatim, so a secret an agent emits
 * into its answer survives on disk. Wrapping the durable store closes that gap
 * at the single choke point every write passes through:
 *
 * ```ts
 * const store = new RedactingStore(new FileStore('./.oma/run.json'))
 * const team = new Team({ name: 'ops', agents, sharedMemoryStore: store })
 * // Checkpoints default to the team's shared-memory store, so this one wrap
 * // redacts both the `<agent>/…` shared keys and the checkpoint key.
 * await orchestrator.runTeam(team, goal, { checkpoint: true })
 * ```
 *
 * Redaction happens on write, so reads (and any resumed checkpoint) observe the
 * redacted value. That is the deliberate opt-in trade: a downstream agent can no
 * longer read a secret a prior agent persisted. The caller-facing run result is
 * untouched — it never passes through the store.
 */

import type { MemoryEntry, MemoryStore } from '../types.js'
import { redactSensitiveObject, redactSensitiveText } from '../utils/redaction.js'

/** Options for {@link RedactingStore}. */
export interface RedactingStoreOptions {
  /**
   * Additional value patterns (e.g. PII such as emails or national IDs) applied
   * on top of the built-in credential redaction. Non-global patterns are
   * treated as global so every match is scrubbed.
   */
  readonly patterns?: readonly RegExp[]
}

/**
 * Wraps any {@link MemoryStore}, redacting the value passed to `set` /
 * `setWithExpiry` before it is persisted. Metadata, keys, and read paths are
 * forwarded unchanged.
 *
 * This lossy decorator deliberately does not expose `compareAndSet`: exact
 * content hashes are required for durable approvals, while redaction changes
 * the reviewed content. Use a protected, non-redacting approval/checkpoint
 * store when suspendable approvals are required.
 */
export class RedactingStore implements MemoryStore {
  private readonly patterns: readonly RegExp[]

  /**
   * Present only when the wrapped store implements `setWithExpiry`, so
   * {@link SharedMemory}'s `typeof store.setWithExpiry === 'function'` probe
   * stays truthful and its no-TTL fallback path is preserved for backends
   * without expiry support.
   */
  readonly setWithExpiry?: (
    key: string,
    value: string,
    expiresAtTurn: number,
    metadata?: Record<string, unknown>,
  ) => Promise<void>

  constructor(
    private readonly inner: MemoryStore,
    options: RedactingStoreOptions = {},
  ) {
    this.patterns = options.patterns ?? []

    const innerExpiry = inner.setWithExpiry
    if (typeof innerExpiry === 'function') {
      this.setWithExpiry = (key, value, expiresAtTurn, metadata) =>
        innerExpiry.call(inner, key, this.redact(value), expiresAtTurn, metadata)
    }
  }

  async get(key: string): Promise<MemoryEntry | null> {
    return this.inner.get(key)
  }

  async set(key: string, value: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.inner.set(key, this.redact(value), metadata)
  }

  async list(): Promise<MemoryEntry[]> {
    return this.inner.list()
  }

  async delete(key: string): Promise<void> {
    await this.inner.delete(key)
  }

  async clear(): Promise<void> {
    await this.inner.clear()
  }

  /**
   * Redact a stored string value. Values that parse as a JSON object/array are
   * redacted structure-aware — so checkpoint snapshots and structured shared
   * values stay valid JSON with only secrets masked — while anything else
   * (plain agent answers, numbers, booleans) is redacted as free text.
   */
  private redact(value: string): string {
    const parsed = tryParseJsonContainer(value)
    if (parsed !== undefined) {
      return JSON.stringify(redactSensitiveObject(parsed, this.patterns))
    }
    return redactSensitiveText(value, this.patterns)
  }
}

/**
 * Returns the parsed value when `value` is a JSON object or array, else
 * `undefined`. The leading-char check avoids a throwing `JSON.parse` on the
 * common plain-string case and skips scalars (numbers/booleans/JSON string
 * literals), which carry no structure worth walking.
 */
function tryParseJsonContainer(value: string): unknown | undefined {
  const trimmed = value.trimStart()
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
