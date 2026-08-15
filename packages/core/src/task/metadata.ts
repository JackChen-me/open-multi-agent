import type { TaskMetadata, TraceAttributeValue } from '../types.js'
import { isSensitiveName, redactSensitiveText } from '../utils/redaction.js'

const TASK_METADATA_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const MAX_TASK_METADATA_ENTRIES = 16
const MAX_TASK_METADATA_STRING_LENGTH = 1_024
const MAX_TASK_METADATA_ARRAY_LENGTH = 16

function normalizeScalar(
  value: unknown,
  key: string,
): string | number | boolean {
  if (typeof value === 'string') {
    if (value.length > MAX_TASK_METADATA_STRING_LENGTH) {
      throw new Error(
        `task metadata value for "${key}" must contain at most ` +
          `${MAX_TASK_METADATA_STRING_LENGTH} characters.`,
      )
    }
    return redactSensitiveText(value)
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`task metadata value for "${key}" is not a supported trace attribute.`)
}

function normalizeValue(value: unknown, key: string): TraceAttributeValue {
  if (!Array.isArray(value)) return normalizeScalar(value, key)
  if (value.length > MAX_TASK_METADATA_ARRAY_LENGTH) {
    throw new Error(
      `task metadata array for "${key}" must contain at most ` +
        `${MAX_TASK_METADATA_ARRAY_LENGTH} values.`,
    )
  }

  let elementType: 'string' | 'number' | 'boolean' | undefined
  const normalized: Array<string | number | boolean> = []
  for (const item of value) {
    const itemType = typeof item
    if (itemType !== 'string' && itemType !== 'number' && itemType !== 'boolean') {
      throw new Error(`task metadata array for "${key}" must contain scalar values.`)
    }
    if (elementType !== undefined && itemType !== elementType) {
      throw new Error(`task metadata array for "${key}" must be homogeneous.`)
    }
    elementType = itemType
    normalized.push(normalizeScalar(item, key))
  }
  return Object.freeze(normalized) as TraceAttributeValue
}

/** Validate, redact, and defensively copy task-scoped business metadata. */
export function validateTaskMetadata(
  metadata: TaskMetadata | undefined,
): TaskMetadata | undefined {
  if (metadata === undefined) return undefined
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('task metadata must be a record of trace attribute values.')
  }

  const entries = Object.entries(metadata as Readonly<Record<string, unknown>>)
  if (entries.length > MAX_TASK_METADATA_ENTRIES) {
    throw new Error(`task metadata must contain at most ${MAX_TASK_METADATA_ENTRIES} entries.`)
  }

  const normalized: Array<readonly [string, TraceAttributeValue]> = []
  for (const [key, value] of entries) {
    if (!TASK_METADATA_KEY.test(key)) {
      throw new Error(
        `task metadata key "${key}" must match [A-Za-z][A-Za-z0-9_.-]{0,63}.`,
      )
    }
    if (key.toLowerCase().startsWith('oma.')) {
      throw new Error(`task metadata key "${key}" uses the reserved "oma." prefix.`)
    }
    if (isSensitiveName(key)) {
      throw new Error(`task metadata key "${key}" is credential-like and is not allowed.`)
    }
    normalized.push([key, normalizeValue(value, key)])
  }

  return Object.freeze(Object.fromEntries(normalized))
}

/** Flatten task metadata into reserved trace attributes. */
export function taskMetadataTraceAttributes(
  metadata: TaskMetadata | undefined,
): Readonly<Record<string, TraceAttributeValue>> {
  if (metadata === undefined) return {}
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [`oma.task.meta.${key}`, value]),
  )
}
