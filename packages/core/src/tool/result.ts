import type {
  ToolResult,
  ToolResultContent,
  ToolResultContentPart,
  ToolResultFilePart,
  ToolResultImagePart,
  ToolResultMediaSource,
} from '../types.js'

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`)
  }
}

/**
 * Validate and copy a media source: an absolute HTTP(S) reference or raw
 * canonical base64 with a parameterless MIME type. Shared by tool-result
 * media and by `video` content blocks, which carry the same source shape.
 */
export function copyMediaSource(value: unknown, path: string): ToolResultMediaSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be a media source object`)
  }

  const source = value as Record<string, unknown>
  assertNonEmptyString(source['media_type'], `${path}.media_type`)
  if (!MEDIA_TYPE_PATTERN.test(source['media_type'])) {
    throw new TypeError(`${path}.media_type must be a MIME type without parameters`)
  }

  if (source['type'] === 'base64') {
    assertNonEmptyString(source['data'], `${path}.data`)
    const unpadded = source['data'].replace(/=+$/, '')
    const canonical = Buffer.from(source['data'], 'base64')
      .toString('base64')
      .replace(/=+$/, '')
    if (
      unpadded.length === 0
      || source['data'].length % 4 === 1
      || !BASE64_PATTERN.test(source['data'])
      || canonical !== unpadded
    ) {
      throw new TypeError(`${path}.data must contain raw base64 data`)
    }
    return {
      type: 'base64',
      media_type: source['media_type'],
      data: source['data'],
    }
  }

  if (source['type'] === 'url') {
    assertNonEmptyString(source['url'], `${path}.url`)
    let parsed: URL
    try {
      parsed = new URL(source['url'])
    } catch {
      throw new TypeError(`${path}.url must be an absolute HTTP(S) URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError(`${path}.url must use HTTP or HTTPS`)
    }
    return {
      type: 'url',
      media_type: source['media_type'],
      url: source['url'],
    }
  }

  throw new TypeError(`${path}.type must be "base64" or "url"`)
}

/** Validate and defensively copy model-visible tool-result content. */
export function copyToolResultContent(value: unknown, path = 'modelOutput'): ToolResultContent {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be a string or a non-empty content-part array, got ${describeType(value)}`)
  }
  if (value.length === 0) {
    throw new TypeError(`${path} must not be an empty content-part array`)
  }

  return value.map((rawPart, index): ToolResultContentPart => {
    const partPath = `${path}[${index}]`
    if (rawPart === null || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      throw new TypeError(`${partPath} must be a content-part object`)
    }
    const part = rawPart as Record<string, unknown>

    if (part['type'] === 'text') {
      if (typeof part['text'] !== 'string') {
        throw new TypeError(`${partPath}.text must be a string`)
      }
      return { type: 'text', text: part['text'] }
    }

    if (part['type'] === 'image') {
      return {
        type: 'image',
        source: copyMediaSource(part['source'], `${partPath}.source`),
      }
    }

    if (part['type'] === 'file') {
      assertNonEmptyString(part['filename'], `${partPath}.filename`)
      return {
        type: 'file',
        filename: part['filename'],
        source: copyMediaSource(part['source'], `${partPath}.source`),
      }
    }

    throw new TypeError(`${partPath}.type must be "text", "image", or "file"`)
  })
}

/** Resolve the exact content a validated tool result sends to the model. */
export function modelOutputFromToolResult(result: ToolResult<any>): ToolResultContent {
  if (result.modelOutput !== undefined) return result.modelOutput
  if (typeof result.data === 'string') return result.data
  throw new TypeError('non-string ToolResult.data requires modelOutput')
}

/** Return rich content as parts, treating a legacy string as one text part. */
export function toolResultContentParts(content: ToolResultContent): readonly ToolResultContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/** Concatenate only the text carried by a model-visible tool result. */
export function toolResultText(content: ToolResultContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<ToolResultContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

/** True when a tool result includes an image or file part. */
export function toolResultHasMedia(content: ToolResultContent): boolean {
  return Array.isArray(content) && content.some(part => part.type === 'image' || part.type === 'file')
}

/** Approximate serialized size for token estimates and context-compaction thresholds. */
export function toolResultContentSize(content: ToolResultContent): number {
  if (typeof content === 'string') return content.length
  return content.reduce((total, part) => {
    if (part.type === 'text') return total + part.text.length
    const sourceSize = part.source.type === 'base64'
      ? part.source.data.length
      : part.source.url.length
    const filenameSize = part.type === 'file' ? part.filename.length : 0
    return total + sourceSize + part.source.media_type.length + filenameSize + 32
  }, 0)
}

function mediaSummary(part: ToolResultImagePart | ToolResultFilePart): string {
  const location = part.source.type === 'base64' ? 'inline data' : 'URL reference'
  if (part.type === 'image') return `[image: ${part.source.media_type}; ${location}]`
  return `[file: ${part.filename}; ${part.source.media_type}; ${location}]`
}

/**
 * Build a textual view for records and traces without persisting inline bytes
 * or reference URLs. Text parts remain exact for string-tool compatibility;
 * the exact rich content remains in conversation messages.
 */
export function summarizeToolResultContent(content: ToolResultContent): string {
  if (typeof content === 'string') return content
  return content
    .map(part => part.type === 'text' ? part.text : mediaSummary(part))
    .join('\n')
}

/** Replace rich media with placeholders before JSON-stringifying a summary prompt. */
export function stripToolResultMedia(content: ToolResultContent): ToolResultContent {
  if (typeof content === 'string') return content
  return content.map((part): ToolResultContentPart => {
    if (part.type === 'text') return part
    return { type: 'text', text: mediaSummary(part) }
  })
}
