import { readFileSync } from 'node:fs'

const SAFE_SOURCE_NAMES = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
  'TMPDIR',
  'npm_config_cache',
] as const

export function buildHarnessEnvironment(options: {
  readonly source?: NodeJS.ProcessEnv
  readonly deepSeekApiKey: string
  readonly isolatedHome: string
}): NodeJS.ProcessEnv {
  if (options.deepSeekApiKey.length === 0) throw new Error('DEEPSEEK_API_KEY is required for a live canary.')
  const source = options.source ?? process.env
  const environment: NodeJS.ProcessEnv = {
    HOME: options.isolatedHome,
    XDG_CONFIG_HOME: options.isolatedHome,
    CLAUDE_CONFIG_DIR: `${options.isolatedHome}/.claude`,
    CI: '1',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: options.deepSeekApiKey,
    ANTHROPIC_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_UPDATES: '1',
  }
  for (const name of SAFE_SOURCE_NAMES) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  environment['HOME'] = options.isolatedHome
  assertHarnessCredentialIsolation(environment)
  return environment
}

export function assertHarnessCredentialIsolation(environment: NodeJS.ProcessEnv): void {
  const allowedCredentialNames = new Set(['ANTHROPIC_AUTH_TOKEN'])
  const forbidden = Object.keys(environment).filter(name => {
    if (allowedCredentialNames.has(name)) return false
    return /^(?:GITHUB|GH_|ACTIONS_|RUNNER_|SSH_|NPM_|NODE_AUTH)/i.test(name)
      || /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK)/i.test(name)
  })
  if (forbidden.length > 0) {
    throw new Error(`Harness environment contains forbidden host credentials: ${forbidden.sort().join(', ')}`)
  }
  if (environment['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'] !== '1') {
    throw new Error('Claude Code subprocess credential scrubbing must be enabled.')
  }
}

export function assertProviderCredentialAbsent(options: {
  readonly environment: NodeJS.ProcessEnv
  readonly providerKey: string
  readonly boundary: 'host' | 'source'
}): void {
  const forbiddenNames = Object.keys(options.environment).filter(name =>
    /^(?:DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AWS_API_KEY|ANTHROPIC_FOUNDRY_AUTH_TOKEN)$/i.test(name),
  )
  const keyAppearsInValue = options.providerKey.length > 0
    && Object.values(options.environment).some(value => value?.includes(options.providerKey))
  if (forbiddenNames.length > 0 || keyAppearsInValue) {
    throw new Error(`${options.boundary} environment contains provider credential material.`)
  }
}

export function assertInitialProcessProviderCredentialAbsent(providerKey: string): void {
  if (process.platform !== 'linux') return
  let buffer: Buffer
  try {
    buffer = readFileSync('/proc/self/environ')
  } catch {
    throw new Error('host initial environment could not be inspected.')
  }
  try {
    const initialEnvironment: NodeJS.ProcessEnv = {}
    for (const entry of buffer.toString('utf8').split('\0')) {
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      initialEnvironment[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
    assertProviderCredentialAbsent({
      environment: initialEnvironment,
      providerKey,
      boundary: 'host',
    })
  } finally {
    buffer.fill(0)
  }
}
