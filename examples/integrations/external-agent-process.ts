/**
 * Generic local processes as external agents.
 *
 * This example uses the `process` backend to run deterministic local Node.js
 * snippets as OMA team members. It needs no model API key and no optional peer
 * dependency: each agent is a subprocess, receives its prompt on stdin, writes
 * its answer to stdout, and participates in the same task DAG/shared memory as
 * any other agent.
 *
 * Run:
 *   npx tsx examples/integrations/external-agent-process.ts
 */

import { OpenMultiAgent, type AgentConfig } from '../../packages/core/src/index.js'

function processAgent(name: string, script: string): AgentConfig {
  return {
    name,
    systemPrompt: `${name} runs as a deterministic local process.`,
    backend: {
      kind: 'process',
      command: process.execPath,
      args: ['-e', script],
    },
  }
}

const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })

const team = oma.createTeam('local-process-team', {
  name: 'local-process-team',
  sharedMemory: true,
  agents: [
    processAgent('extractor', `
      process.stdin.resume()
      process.stdout.write('release notes: process backend, shared memory handoff')
    `),
    processAgent('summarizer', `
      process.stdin.setEncoding('utf8')
      let input = ''
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => {
        const sawHandoff = input.includes('shared memory handoff')
        process.stdout.write(sawHandoff ? 'summary: external process joined the DAG' : 'summary: missing handoff')
      })
    `),
  ],
})

const result = await oma.runTasks(team, [
  { title: 'Extract notes', description: 'Extract release-note facts.', assignee: 'extractor' },
  {
    title: 'Summarize notes',
    description: 'Summarize the extracted facts.',
    assignee: 'summarizer',
    dependsOn: ['Extract notes'],
  },
])

console.log(result.agentResults.get('extractor')?.output)
console.log(result.agentResults.get('summarizer')?.output)
