import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToolUseContext } from '../src/types.js'
import { ToolRegistry } from '../src/tool/framework.js'

const listToolsMock = vi.fn()
const callToolMock = vi.fn()
const connectMock = vi.fn()
const clientCloseMock = vi.fn()
const transportCloseMock = vi.fn()

class MockClient {
  async connect(
    transport: unknown,
    _options?: { timeout?: number },
  ): Promise<void> {
    connectMock(transport)
  }

  async listTools(
    params?: { cursor?: string },
    options?: { timeout?: number },
  ): Promise<{
    tools: Array<{
      name: string
      description: string
      inputSchema?: Record<string, unknown>
    }>
    nextCursor?: string
  }> {
    return listToolsMock(params, options)
  }

  async callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<{
    content?: Array<Record<string, unknown>>
    structuredContent?: unknown
    isError?: boolean
    toolResult?: unknown
  }> {
    return callToolMock(request, resultSchema, options)
  }

  async close(): Promise<void> {
    clientCloseMock()
  }
}

class MockStdioTransport {
  readonly config: unknown

  constructor(config: unknown) {
    this.config = config
  }

  async close(): Promise<void> {
    transportCloseMock()
  }
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: MockStdioTransport,
}))

const context: ToolUseContext = {
  agent: { name: 'test-agent', role: 'tester', model: 'test-model' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('connectMCPTools', () => {
  it('connects, discovers tools, and executes MCP calls', async () => {
    listToolsMock.mockResolvedValue({
      tools: [
        {
          name: 'search_issues',
          description: 'Search repository issues.',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
    })
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: 'found 2 issues' }],
      isError: false,
    })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
      env: { GITHUB_TOKEN: 'token' },
      namePrefix: 'github',
    })

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connected.tools).toHaveLength(1)
    expect(connected.tools[0].name).toBe('github_search_issues')

    const registry = new ToolRegistry()
    registry.register(connected.tools[0])
    const defs = registry.toToolDefs()
    expect(defs[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    })

    const result = await connected.tools[0].execute({ q: 'bug' }, context)
    expect(callToolMock).toHaveBeenCalledWith(
      {
        name: 'search_issues',
        arguments: { q: 'bug' },
      },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
    expect(result.isError).toBe(false)
    expect(result.data).toContain('found 2 issues')

    await connected.disconnect()
    expect(clientCloseMock).toHaveBeenCalledTimes(1)
    expect(transportCloseMock).not.toHaveBeenCalled()
  })

  it('aggregates paginated listTools results', async () => {
    listToolsMock.mockImplementation(
      async (params?: { cursor?: string }) => {
        if (params?.cursor === 'c1') {
          return {
            tools: [
              { name: 'b', description: 'B', inputSchema: { type: 'object' } },
            ],
          }
        }
        return {
          tools: [
            { name: 'a', description: 'A', inputSchema: { type: 'object' } },
          ],
          nextCursor: 'c1',
        }
      },
    )

    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
    })

    expect(listToolsMock).toHaveBeenCalledTimes(2)
    expect(listToolsMock.mock.calls[1][0]).toEqual({ cursor: 'c1' })
    expect(connected.tools).toHaveLength(2)
    expect(connected.tools.map((t) => t.name)).toEqual(['a', 'b'])
  })

  it('serializes non-text MCP content blocks', async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'pic', description: 'Pic', inputSchema: { type: 'object' } }],
    })
    callToolMock.mockResolvedValue({
      content: [
        {
          type: 'image',
          data: 'AAA',
          mimeType: 'image/png',
        },
      ],
      isError: false,
    })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({ command: 'npx', args: ['x'] })
    const result = await connected.tools[0].execute({}, context)
    expect(result.data).toContain('image')
    expect(result.data).toContain('base64 length=3')
    expect(result.modelOutput).toEqual([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
    }])
  })

  it('preserves MCP blob resources and HTTP resource links as file parts', async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'files', description: 'Files', inputSchema: { type: 'object' } }],
    })
    callToolMock.mockResolvedValue({
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///reports/inline.pdf',
            mimeType: 'application/pdf',
            blob: 'JVBERi0xLjQ=',
          },
        },
        {
          type: 'resource_link',
          name: 'remote.csv',
          uri: 'https://example.com/remote.csv',
          mimeType: 'text/csv',
          description: 'Remote export',
        },
      ],
      isError: false,
    })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({ command: 'npx', args: ['x'] })
    const result = await connected.tools[0].execute({}, context)

    expect(result.modelOutput).toEqual([
      { type: 'text', text: '[resource file:///reports/inline.pdf]' },
      {
        type: 'file',
        filename: 'inline.pdf',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0xLjQ=',
        },
      },
      { type: 'text', text: 'Remote export' },
      {
        type: 'file',
        filename: 'remote.csv',
        source: {
          type: 'url',
          media_type: 'text/csv',
          url: 'https://example.com/remote.csv',
        },
      },
    ])
  })

  it('keeps MCP error results text-only even when the server includes media', async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'failed_pic', description: 'Pic', inputSchema: { type: 'object' } }],
    })
    callToolMock.mockResolvedValue({
      content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
      isError: true,
    })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({ command: 'npx', args: ['x'] })
    const result = await connected.tools[0].execute({}, context)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('base64 length=3')
    expect(result.modelOutput).toBeUndefined()
  })

  it('marks tool result as error when MCP returns isError', async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'danger', description: 'Dangerous op.', inputSchema: {} }],
    })
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: 'permission denied' }],
      isError: true,
    })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
    })

    const result = await connected.tools[0].execute({}, context)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('permission denied')
  })

  it('cleans up MCP resources when discovery fails after connect', async () => {
    listToolsMock.mockRejectedValue(new Error('tools/list failed'))

    const { connectMCPTools } = await import('../src/tool/mcp.js')

    await expect(connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
    })).rejects.toThrow('tools/list failed')

    expect(clientCloseMock).toHaveBeenCalledTimes(1)
    expect(transportCloseMock).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate normalized MCP tool names', async () => {
    listToolsMock.mockResolvedValue({
      tools: [
        { name: 'repo/search', description: 'Search slash.', inputSchema: { type: 'object' } },
        { name: 'repo_search', description: 'Search underscore.', inputSchema: { type: 'object' } },
      ],
    })

    const { connectMCPTools } = await import('../src/tool/mcp.js')

    await expect(connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
    })).rejects.toThrow('Duplicate MCP tool name after normalization: "repo_search"')

    expect(clientCloseMock).toHaveBeenCalledTimes(1)
    expect(transportCloseMock).toHaveBeenCalledTimes(1)
  })

  it('serializes MCP toolResult first and falls back to structuredContent', async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'structured', description: 'Structured output.', inputSchema: {} }],
    })
    callToolMock
      .mockResolvedValueOnce({
        toolResult: { ok: true },
        content: [{ type: 'text', text: 'ignored content' }],
        structuredContent: { ok: false },
      })
      .mockResolvedValueOnce({
        structuredContent: { count: 2 },
      })

    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
    })

    const toolResult = await connected.tools[0].execute({}, context)
    expect(toolResult.data).toContain('"ok": true')
    expect(toolResult.data).not.toContain('ignored content')

    const structured = await connected.tools[0].execute({}, context)
    expect(structured.data).toContain('"count": 2')
  })

  it('forwards the tool abort signal to MCP callTool', async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'slow_tool', description: 'Slow op.', inputSchema: {} }],
    })
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })

    const controller = new AbortController()
    const { connectMCPTools } = await import('../src/tool/mcp.js')
    const connected = await connectMCPTools({
      command: 'npx',
      args: ['-y', 'mock-mcp-server'],
    })

    await connected.tools[0].execute({}, {
      ...context,
      abortSignal: controller.signal,
    })

    expect(callToolMock.mock.calls[0]?.[2]).toMatchObject({
      timeout: expect.any(Number),
      signal: controller.signal,
    })
  })
})
