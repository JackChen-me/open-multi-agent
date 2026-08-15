import { describe, expect, it, vi } from 'vitest'
import {
  defineEvalSet,
  defineScorer,
  runEvalSet,
  targetFromAgent,
  targetFromPlan,
  targetFromTeam,
} from '../src/eval/index.js'
import type { EvalTargetContext } from '../src/eval/index.js'
import { Team } from '../src/team/team.js'
import type {
  AgentConfig,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  PlanArtifact,
} from '../src/types.js'

function response(text: string): LLMResponse {
  return {
    id: `response-${text}`,
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 1 },
  }
}

function adapter(text: string, seen?: LLMMessage[][]): LLMAdapter {
  return {
    name: 'eval-target-test',
    async chat(messages) {
      seen?.push(messages)
      return response(text)
    },
    async *stream() { /* unused */ },
  }
}

function agent(llm: LLMAdapter = adapter('agent output')): AgentConfig {
  return {
    name: 'worker',
    model: 'test-model',
    provider: 'openai',
    adapter: llm,
  }
}

function context(caseId = 'case-a', repeat = 2): EvalTargetContext {
  return {
    caseId,
    repeat,
    signal: new AbortController().signal,
    metadata: { runner: 'v1' },
  }
}

describe('OMA EvalTarget conveniences', () => {
  it('targetFromAgent converts input to a prompt, injects metadata, and returns the run result', async () => {
    const seen: LLMMessage[][] = []
    const target = targetFromAgent(agent(adapter('agent output', seen)), {
      metadata: { prompt_version: 'v2', model: 'caller-value' },
    })

    const output = await target(42, context())

    expect(output.output).toBe('agent output')
    expect(output.result).toMatchObject({
      success: true,
      output: 'agent output',
      tokenUsage: { input_tokens: 2, output_tokens: 1 },
      metadata: {
        eval_case: 'case-a',
        eval_repeat: '2',
        prompt_version: 'v2',
        model: 'test-model',
        provider: 'openai',
      },
    })
    expect(output.result?.identity).toBeDefined()
    expect(JSON.stringify(seen)).toContain('42')
  })

  it('propagates the convenience target identity into EvalRecord.runRef', async () => {
    const base = targetFromAgent(agent())
    let capturedIdentity: unknown
    const target = async (...args: Parameters<typeof base>) => {
      const output = await base(...args)
      capturedIdentity = output.result?.identity
      return output
    }
    const set = defineEvalSet({ name: 'agent', version: '1', cases: [{ id: 'a', input: 'hi' }] })
    const scorer = defineScorer({ name: 'ok', score: () => ({ score: 1 }) })

    const report = await runEvalSet(set, target, { scorers: [scorer] })

    expect(report.records[0]?.runRef).toEqual(capturedIdentity)
    expect(report.records[0]?.metadata).toMatchObject({
      eval_case: 'a', eval_repeat: '1', model: 'test-model', provider: 'openai',
    })
  })

  it('targetFromTeam returns the synthesized or primary team output and team fingerprints', async () => {
    const team = new Team({ name: 'team', agents: [agent(adapter('team output'))] })
    const output = await targetFromTeam(team, {
      metadata: { experiment: 'team-v1' },
      executionRouting: { strategy: 'deterministic' },
    })('hello', context())

    expect(output.output).toBe('team output')
    expect(output.result?.metadata).toEqual({
      eval_case: 'case-a',
      eval_repeat: '2',
      experiment: 'team-v1',
      models: ['test-model'],
      providers: ['openai'],
    })
    expect(output.result?.identity).toBeDefined()
  })

  it('targetFromPlan replays the fixed plan without a coordinator and returns task output', async () => {
    const chat = vi.fn(async () => response('planned output'))
    const llm: LLMAdapter = { name: 'plan-test', chat, async *stream() { /* unused */ } }
    const team = new Team({ name: 'team', agents: [agent(llm)] })
    const plan: PlanArtifact = {
      version: 1,
      goal: 'fixed goal',
      tasks: [{ id: 'task-a', title: 'Task A', description: 'Do fixed work', assignee: 'worker' }],
    }

    const output = await targetFromPlan(team, plan)('ignored input', context('plan-case', 1))

    expect(chat).toHaveBeenCalledTimes(1)
    expect(output.output).toBe('planned output')
    expect(output.result).toMatchObject({
      success: true,
      metadata: {
        eval_case: 'plan-case',
        eval_repeat: '1',
        models: ['test-model'],
        providers: ['openai'],
      },
    })
    expect(output.result?.identity).toBeDefined()
  })
})
