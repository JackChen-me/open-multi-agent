import { EgressPolicyError } from '../errors.js'
import type { EgressPolicy } from '../types.js'

type FetchLike = typeof globalThis.fetch

function invalidPolicy(message: string): never {
  throw new EgressPolicyError(
    'invalid-policy',
    `Invalid egress policy: ${message}`,
  )
}

function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalidPolicy(`${label} must be an absolute HTTP(S) URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalidPolicy(`${label} must use http: or https:.`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    invalidPolicy(`${label} must not contain credentials.`)
  }
  return parsed
}

function normalizedOrigin(value: string, label: string): string {
  const parsed = parseHttpUrl(value, label)
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    invalidPolicy(`${label} must be an origin without a path, query string, or fragment.`)
  }
  return parsed.origin
}

function assertOnlyKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) {
    invalidPolicy(`${label} contains unsupported field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}.`)
  }
}

/** Validate and defensively copy a public policy object. */
export function normalizeEgressPolicy(
  policy: EgressPolicy | undefined,
): EgressPolicy | undefined {
  if (policy === undefined) return undefined
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    invalidPolicy('expected an object.')
  }
  if (policy.mode === 'offline') {
    assertOnlyKeys(policy, ['mode'], 'offline policy')
    return Object.freeze({ mode: 'offline' as const })
  }
  if (policy.mode !== 'allowlist') {
    invalidPolicy('mode must be "offline" or "allowlist".')
  }
  if (!Array.isArray(policy.allowedOrigins)) {
    invalidPolicy('allowedOrigins must be an array of exact origins.')
  }
  assertOnlyKeys(policy, ['mode', 'allowedOrigins'], 'allowlist policy')
  const origins = policy.allowedOrigins.map((value, index) => {
    if (typeof value !== 'string' || value.trim() === '') {
      invalidPolicy(`allowedOrigins[${index}] must be a non-empty string.`)
    }
    return normalizedOrigin(value, `allowedOrigins[${index}]`)
  })
  return Object.freeze({
    mode: 'allowlist' as const,
    allowedOrigins: Object.freeze([...new Set(origins)].sort()),
  })
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname)
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '[::1]' || normalized === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127
}

function originIsLoopback(origin: string): boolean {
  return isLoopbackHostname(new URL(origin).hostname)
}

/**
 * Intersect policy scopes. Omitted scopes have no effect; any denial wins.
 */
export function intersectEgressPolicies(
  ...policies: readonly (EgressPolicy | undefined)[]
): EgressPolicy | undefined {
  const normalized = policies
    .map(normalizeEgressPolicy)
    .filter((policy): policy is EgressPolicy => policy !== undefined)
  if (normalized.length === 0) return undefined

  let effective = normalized[0]!
  for (const next of normalized.slice(1)) {
    if (effective.mode === 'offline' && next.mode === 'offline') continue
    if (effective.mode === 'offline' && next.mode === 'allowlist') {
      effective = {
        mode: 'allowlist',
        allowedOrigins: next.allowedOrigins.filter(originIsLoopback),
      }
      continue
    }
    if (effective.mode === 'allowlist' && next.mode === 'offline') {
      effective = {
        mode: 'allowlist',
        allowedOrigins: effective.allowedOrigins.filter(originIsLoopback),
      }
      continue
    }
    if (effective.mode === 'allowlist' && next.mode === 'allowlist') {
      const nextOrigins = new Set(next.allowedOrigins)
      effective = {
        mode: 'allowlist',
        allowedOrigins: effective.allowedOrigins.filter(origin => nextOrigins.has(origin)),
      }
    }
  }
  return normalizeEgressPolicy(effective)
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (typeof input === 'string' || input instanceof URL) {
    return parseHttpUrl(String(input), 'request URL')
  }
  return parseHttpUrl(input.url, 'request URL')
}

/** Assert one concrete framework-owned request target before I/O starts. */
export function assertEgressAllowed(
  policy: EgressPolicy,
  target: string | URL,
  provider: string,
): void {
  const effective = normalizeEgressPolicy(policy)!
  const parsed = parseHttpUrl(String(target), 'request URL')
  const origin = parsed.origin
  const allowed = effective.mode === 'offline'
    ? isLoopbackHostname(parsed.hostname)
    : effective.allowedOrigins.includes(origin)
  if (!allowed) {
    throw new EgressPolicyError(
      'denied',
      `Egress policy denied framework-owned provider "${provider}" request to ${origin}.`,
      provider,
      origin,
    )
  }
}

/**
 * Build a fetch implementation that re-checks every request and rejects all
 * redirects. Redirect rejection avoids an allowed origin silently forwarding
 * a credential-bearing SDK request to a different origin.
 */
export function createEgressFetch(
  policy: EgressPolicy,
  provider: string,
  implementation: FetchLike = globalThis.fetch,
): FetchLike {
  const effective = normalizeEgressPolicy(policy)!
  return (async (input, init) => {
    const url = requestUrl(input)
    assertEgressAllowed(effective, url, provider)
    return implementation(input, {
      ...init,
      redirect: 'error',
    })
  }) as FetchLike
}

/** Reject an opaque or SDK-unenforceable adapter while a policy is active. */
export function rejectUnsupportedEgress(
  policy: EgressPolicy | undefined,
  provider: string,
  detail: string,
): void {
  if (policy === undefined) return
  throw new EgressPolicyError(
    'unsupported',
    `Egress policy cannot enforce provider "${provider}": ${detail}`,
    provider,
  )
}

/** Reject a provider whose actual target cannot be resolved before use. */
export function rejectUnresolvedEgressTarget(
  provider: string,
  detail: string,
): never {
  throw new EgressPolicyError(
    'unresolved-target',
    `Egress policy cannot resolve provider "${provider}" target: ${detail}`,
    provider,
  )
}
