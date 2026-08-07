import { randomBytes, randomUUID } from 'node:crypto'
import type {
  CheckpointSnapshot,
  RunIdentity,
  RunIdentityOptions,
  TraceAttributeValue,
} from '../types.js'

const RUN_METADATA_KEY = /^[a-z0-9_.]{1,64}$/
const MAX_RUN_METADATA_ENTRIES = 32
const MAX_RUN_METADATA_STRING_LENGTH = 1_024
const RUN_METADATA_OVERRIDE_KEY = '_overridden'

function normalizeMetadataValue(value: unknown, key: string): TraceAttributeValue {
  if (typeof value === 'string') return value.slice(0, MAX_RUN_METADATA_STRING_LENGTH)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value

  if (Array.isArray(value)) {
    let elementType: 'string' | 'number' | 'boolean' | undefined
    const normalized: Array<string | number | boolean> = []
    for (const item of value) {
      const itemType = typeof item
      if (itemType !== 'string' && itemType !== 'number' && itemType !== 'boolean') {
        throw new Error(`metadata value for "${key}" is not a supported trace attribute.`)
      }
      if (itemType === 'number' && !Number.isFinite(item)) {
        throw new Error(`metadata value for "${key}" is not a supported trace attribute.`)
      }
      if (elementType !== undefined && itemType !== elementType) {
        throw new Error(`metadata value for "${key}" must be a homogeneous scalar array.`)
      }
      elementType = itemType
      normalized.push(itemType === 'string'
        ? (item as string).slice(0, MAX_RUN_METADATA_STRING_LENGTH)
        : item as number | boolean)
    }
    return Object.freeze(normalized) as TraceAttributeValue
  }

  throw new Error(`metadata value for "${key}" is not a supported trace attribute.`)
}

/** Validate and defensively copy caller-provided per-run metadata. */
export function validateRunMetadata(
  metadata: RunIdentityOptions['metadata'],
): Readonly<Record<string, TraceAttributeValue>> | undefined {
  if (metadata === undefined) return undefined
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('metadata must be a record of trace attribute values.')
  }

  const entries = Object.entries(metadata as Readonly<Record<string, unknown>>)
  if (entries.length > MAX_RUN_METADATA_ENTRIES) {
    throw new Error(`metadata must contain at most ${MAX_RUN_METADATA_ENTRIES} entries.`)
  }

  const normalized: Array<readonly [string, TraceAttributeValue]> = []
  for (const [key, value] of entries) {
    if (key.startsWith('oma.')) {
      throw new Error(`metadata key "${key}" uses the reserved "oma." prefix.`)
    }
    if (key === RUN_METADATA_OVERRIDE_KEY) {
      throw new Error(`metadata key "${key}" is reserved for framework restore state.`)
    }
    if (!RUN_METADATA_KEY.test(key)) {
      throw new Error(`metadata key "${key}" must match [a-z0-9_.]{1,64}.`)
    }
    normalized.push([key, normalizeMetadataValue(value, key)])
  }
  return Object.freeze(Object.fromEntries(normalized))
}

function metadataValueEqual(a: TraceAttributeValue, b: TraceAttributeValue): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return Object.is(a, b)
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

function metadataEqual(
  a: Readonly<Record<string, TraceAttributeValue>>,
  b: Readonly<Record<string, TraceAttributeValue>>,
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length
    && aKeys.every((key) => Object.hasOwn(b, key) && metadataValueEqual(a[key]!, b[key]!))
}

export interface RestoreMetadataResolution {
  readonly metadata?: Readonly<Record<string, TraceAttributeValue>>
  readonly overridden: boolean
}

/** Resolve checkpoint inheritance and explicit restore-time metadata precedence. */
export function resolveRestoreMetadata(
  snapshot: CheckpointSnapshot,
  options: RunIdentityOptions = {},
): RestoreMetadataResolution {
  const inherited = validateRunMetadata(snapshot.metadata)
  if (options.metadata === undefined) {
    return { ...(inherited !== undefined ? { metadata: inherited } : {}), overridden: false }
  }

  const requested = validateRunMetadata(options.metadata)!
  return {
    metadata: requested,
    overridden: inherited !== undefined && !metadataEqual(inherited, requested),
  }
}

function randomHex(bytes: number): string {
  let value = randomBytes(bytes).toString('hex')
  // W3C identifiers may not be all zero. randomBytes producing all zero is
  // vanishingly unlikely, but enforcing the invariant is cheap and explicit.
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString('hex')
  return value
}

export function validateRunId(runId: string): string {
  if (runId.length < 1 || runId.length > 128) {
    throw new Error('runId must contain between 1 and 128 characters.')
  }
  return runId
}

/** Create the identity for a new logical run. */
export function createRunIdentity(options: RunIdentityOptions = {}): RunIdentity {
  validateRunMetadata(options.metadata)
  return {
    runId: options.runId === undefined ? randomUUID() : validateRunId(options.runId),
    attempt: 1,
    traceId: randomHex(16),
    rootSpanId: randomHex(8),
  }
}

/** Create the next execution attempt from a supported checkpoint snapshot. */
export function createRestoreIdentity(
  snapshot: CheckpointSnapshot,
  options: RunIdentityOptions = {},
): RunIdentity {
  validateRunMetadata(options.metadata)
  const checkpointRunId = snapshot.version !== 1
    ? snapshot.identity.runId
    : snapshot.runId

  if (
    options.runId !== undefined
    && checkpointRunId !== undefined
    && options.runId !== checkpointRunId
  ) {
    throw new Error(
      `restore runId conflict: requested "${options.runId}" but checkpoint belongs to "${checkpointRunId}".`,
    )
  }

  const runId = checkpointRunId === undefined
    ? options.runId
    : checkpointRunId
  const baseAttempt = snapshot.version !== 1 ? snapshot.identity.attempt : 1
  const identity: RunIdentity = {
    runId: runId === undefined ? randomUUID() : validateRunId(runId),
    attempt: baseAttempt + 1,
    traceId: randomHex(16),
    rootSpanId: randomHex(8),
  }

  if (snapshot.version !== 1) {
    return {
      ...identity,
      links: [{
        traceId: snapshot.identity.lastTraceId,
        spanId: snapshot.identity.lastRootSpanId,
        relation: 'continued_from',
      }],
    }
  }

  return identity
}
