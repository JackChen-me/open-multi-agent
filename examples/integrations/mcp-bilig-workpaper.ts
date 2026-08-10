/**
 * MCP Bilig WorkPaper Tools
 *
 * Connect Bilig's file-backed WorkPaper MCP server over stdio and give an
 * open-multi-agent Agent the workbook tools for formula readback.
 *
 * Run:
 *   npx tsx examples/integrations/mcp-bilig-workpaper.ts
 *
 * Prerequisites:
 *   - GEMINI_API_KEY or GOOGLE_API_KEY
 *   - @modelcontextprotocol/sdk installed
 *   - npm can execute @bilig/workpaper@0.96.0 from the public registry
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, ToolExecutor, ToolRegistry, registerBuiltInTools } from '../../packages/core/src/index.js'
import { connectMCPTools } from '../../packages/core/src/mcp.js'

if (!process.env.GEMINI_API_KEY?.trim() && !process.env.GOOGLE_API_KEY?.trim()) {
  console.error('Missing GEMINI_API_KEY or GOOGLE_API_KEY: set a Gemini API key in the environment.')
  process.exit(1)
}

const biligPackage = '@bilig/workpaper@0.96.0'
const workDir = await mkdtemp(join(tmpdir(), 'oma-bilig-workpaper-'))
const workpaperPath = join(workDir, 'pricing.workpaper.json')

const { tools, disconnect } = await connectMCPTools({
  command: 'npm',
  args: [
    'exec',
    '--yes',
    '--package',
    biligPackage,
    '--',
    'bilig-workpaper-mcp',
    '--workpaper',
    workpaperPath,
    '--init-demo-workpaper',
    '--writable',
  ],
  namePrefix: 'bilig',
  requestTimeoutMs: 60_000,
})

const registry = new ToolRegistry()
registerBuiltInTools(registry)
for (const tool of tools) registry.register(tool)
const executor = new ToolExecutor(registry)

const agent = new Agent(
  {
    name: 'bilig-workpaper-agent',
    model: process.env.AGENT_MODEL ?? 'gemini-2.5-flash',
    provider: 'gemini',
    maxTurns: 8,
    parallelToolCalls: false,
    tools: tools.map((tool) => tool.name),
    // Point the built-in filesystem sandbox at the same workDir the MCP
    // server is operating on, so any verification reads the agent makes
    // (e.g. with file_read) stay inside the per-run scratch directory.
    cwd: workDir,
    systemPrompt: [
      'Use Bilig WorkPaper MCP tools to inspect and edit formula workbooks.',
      'Always verify a write by reading the recalculated output cell afterward.',
      'Keep the final answer short and include the before and after values.',
    ].join(' '),
  },
  registry,
  executor,
)

try {
  const result = await agent.run(
    [
      'Use the Bilig MCP tools on the demo pricing workbook.',
      'List sheets, read Summary!B3, set Inputs!B3 to 0.4, then read Summary!B3 again.',
      'Report whether the workbook recalculated and persisted the edit.',
    ].join(' '),
  )

  console.log(result.output)
} finally {
  await disconnect()
}
