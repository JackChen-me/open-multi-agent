export interface RegistryVersion {
  readonly name: string
  readonly version: string
  readonly integrity?: string
}

export interface RegistryClient {
  getVersion(packageName: string, version: string): Promise<RegistryVersion | null>
}

interface RegistryResponse {
  name?: unknown
  version?: unknown
  dist?: { integrity?: unknown }
}

export class NpmRegistryClient implements RegistryClient {
  constructor(private readonly baseUrl = 'https://registry.npmjs.org') {}

  async getVersion(packageName: string, version: string): Promise<RegistryVersion | null> {
    const encoded = encodeURIComponent(packageName)
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/${encoded}/${encodeURIComponent(version)}`, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'oma-release-bot',
      },
    })
    if (response.status === 404) return null
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000)
      throw new Error(`npm registry ${response.status} ${response.statusText}: ${body}`)
    }
    const data = await response.json() as RegistryResponse
    if (data.name !== packageName || data.version !== version) {
      throw new Error(`npm registry returned unexpected identity for ${packageName}@${version}.`)
    }
    return {
      name: packageName,
      version,
      ...(typeof data.dist?.integrity === 'string' ? { integrity: data.dist.integrity } : {}),
    }
  }
}
