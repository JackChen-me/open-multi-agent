import { closeSync, readSync } from 'node:fs'

const MAX_PROVIDER_KEY_BYTES = 4_096

/** Read one bounded provider credential line from an inherited descriptor. */
export function readProviderKeyFromFd(value: string): string {
  if (!/^[0-9]+$/.test(value)) throw new Error('Provider key fd must be an integer.')
  const fd = Number(value)
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1_024) {
    throw new Error('Provider key fd is outside the allowed range.')
  }

  const buffer = Buffer.alloc(MAX_PROVIDER_KEY_BYTES + 1)
  let offset = 0
  try {
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(fd, buffer, offset, buffer.byteLength - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
  } catch {
    buffer.fill(0)
    throw new Error('Provider key fd could not be read.')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Preserve the read result; never retry or log descriptor contents.
    }
  }

  try {
    if (offset === 0) throw new Error('Provider key fd was empty.')
    if (offset > MAX_PROVIDER_KEY_BYTES) throw new Error('Provider key fd exceeded the byte limit.')
    let key = buffer.subarray(0, offset).toString('utf8')
    if (key.endsWith('\n')) key = key.slice(0, -1)
    if (key.length === 0) throw new Error('Provider key fd was empty.')
    if (key.includes('\n') || key.includes('\r') || key.includes('\0')) {
      throw new Error('Provider key fd must contain exactly one line.')
    }
    if (key.trim() !== key) throw new Error('Provider key fd contains surrounding whitespace.')
    return key
  } finally {
    buffer.fill(0)
  }
}
