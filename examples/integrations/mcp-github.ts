/**
 * MCP GitHub Tools
 *
 * Connect an MCP server over stdio and register all exposed MCP tools as
 * standard open-multi-agent tools.
 *
 * Run:
 *   npx tsx examples/integrations/mcp-github.ts
 *
 * Prerequisites:
 *   - GEMINI_API_KEY
 *   - GITHUB_TOKEN
 *   - @modelcontextprotocol/sdk installed
 *   - @modelcontextprotocol/server-github installed locally
 */

import { Agent, ToolExecutor, ToolRegistry, registerBuiltInTools } from '../../packages/core/src/index.js'
import { connectMCPTools } from '../../packages/core/src/mcp.js'

if (!process.env.GITHUB_TOKEN?.trim()) {
  console.error('Missing GITHUB_TOKEN: set a GitHub personal access token in the environment.')
  process.exit(1)
}

const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['--no-install', '@modelcontextprotocol/server-github'],
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  },
  namePrefix: 'github',
})

const registry = new ToolRegistry()
registerBuiltInTools(registry)
for (const tool of tools) registry.register(tool)
const executor = new ToolExecutor(registry)

const agent = new Agent(
  {
    name: 'github-agent',
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    tools: tools.map((tool) => tool.name),
    systemPrompt: 'Use GitHub MCP tools to answer repository questions.',
  },
  registry,
  executor,
)

try {
  const result = await agent.run(
    'List the last 3 open issues in open-multi-agent/open-multi-agent with title and number.',
  )

  console.log(result.output)
} finally {
  await disconnect()
}
