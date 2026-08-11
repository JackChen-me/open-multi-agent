import { redactSensitiveText } from '@open-multi-agent/maintainer-bot'

export function sanitizePublicLine(value: string, maxLength = 900): string {
  const sanitized = redactSensitiveText(value)
    .replace(/<!--/g, '< !--')
    .replace(/\breasoning_content\b/gi, '[private model reasoning]')
    .replace(/(?:\/Users\/|\/home\/runner\/|\/private\/|\/tmp\/)[^\s)\]}'"]+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\s)\]}'"]+/g, '[local path]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (sanitized.length === 0) return 'No additional public-safe detail is available.'
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 13)} [truncated]`
}

export function sanitizePublicMarkdown(value: string, maxLength = 8_000): string {
  const lines = value.split(/\r?\n/).map(line => sanitizePublicLine(line, 1_000))
  const sanitized = lines.join('\n').slice(0, maxLength)
  return sanitized.length > 0 ? sanitized : 'No additional public-safe detail is available.'
}
