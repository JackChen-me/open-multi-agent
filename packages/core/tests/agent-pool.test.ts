import { describe, it, expect, vi } from 'vitest'
import { AgentPool } from '../src/agent/pool.js'
import type { Agent } from '../src/agent/agent.js'
import type { AgentRunResult, AgentState } from '../src/types.js'

// ---------------------------------------------------------------------------
// Mock Agent factory
// ---------------------------------------------------------------------------

const SUCCESS_RESULT: AgentRunResult = {
  success: true,
  output: 'done',
  messages: [],
  tokenUsage: { input_tokens: 10, output_tokens: 20 },
  toolCalls: [],
}

function createMockAgent(
  name: string,
  opts?: { runResult?: AgentRunResult; state?: AgentState['status'] },
): Agent {
  const state: AgentState = {
    status: opts?.state ?? 'idle',
    messages: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
  }

  return {
    name,
    config: { name, model: 'test' },
    run: vi.fn().mockResolvedValue(opts?.runResult ?? SUCCESS_RESULT),
    getState: vi.fn().mockReturnValue(state),
    reset: vi.fn(),
  } as unknown as Agent
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentPool', () => {
  describe('registry: add / remove / get / list', () => {
    it('adds and retrieves an agent', () => {
      const pool = new AgentPool()
      const agent = createMockAgent('alice')
      pool.add(agent)

      expect(pool.get('alice')).toBe(agent)
      expect(pool.list()).toHaveLength(1)
    })

    it('throws on duplicate add', () => {
      const pool = new AgentPool()
      pool.add(createMockAgent('alice'))
      expect(() => pool.add(createMockAgent('alice'))).toThrow('already registered')
    })

    it('removes an agent', () => {
      const pool = new AgentPool()
      pool.add(createMockAgent('alice'))
      pool.remove('alice')
      expect(pool.get('alice')).toBeUndefined()
      expect(pool.list()).toHaveLength(0)
    })

    it('throws on remove of unknown agent', () => {
      const pool = new AgentPool()
      expect(() => pool.remove('unknown')).toThrow('not registered')
    })

    it('get returns undefined for unknown agent', () => {
      const pool = new AgentPool()
      expect(pool.get('unknown')).toBeUndefined()
    })
  })

  describe('run', () => {
    it('runs a prompt on a named agent', async () => {
      const pool = new AgentPool()
      const agent = createMockAgent('alice')
      pool.add(agent)

      const result = await pool.run('alice', 'hello')

      expect(result.success).toBe(true)
      expect(agent.run).toHaveBeenCalledWith('hello', undefined)
    })

    it('throws on unknown agent name', async () => {
      const pool = new AgentPool()
      await expect(pool.run('unknown', 'hello')).rejects.toThrow('not registered')
    })
  })

  describe('runParallel', () => {
    it('runs multiple agents in parallel', async () => {
      const pool = new AgentPool(5)
      pool.add(createMockAgent('a'))
      pool.add(createMockAgent('b'))

      const results = await pool.runParallel([
        { agent: 'a', prompt: 'task a' },
        { agent: 'b', prompt: 'task b' },
      ])

      expect(results.size).toBe(2)
      expect(results.get('a')!.success).toBe(true)
      expect(results.get('b')!.success).toBe(true)
    })

    it('handles agent failures gracefully', async () => {
      const pool = new AgentPool()
      const failAgent = createMockAgent('fail')
      ;(failAgent.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
      pool.add(failAgent)

      const results = await pool.runParallel([
        { agent: 'fail', prompt: 'will fail' },
      ])

      expect(results.get('fail')!.success).toBe(false)
      expect(results.get('fail')!.output).toContain('boom')
    })
  })

  describe('runAny', () => {
    it('round-robins across agents', async () => {
      const pool = new AgentPool()
      const a = createMockAgent('a')
      const b = createMockAgent('b')
      pool.add(a)
      pool.add(b)

      await pool.runAny('first')
      await pool.runAny('second')

      expect(a.run).toHaveBeenCalledTimes(1)
      expect(b.run).toHaveBeenCalledTimes(1)
    })

    it('throws on empty pool', async () => {
      const pool = new AgentPool()
      await expect(pool.runAny('hello')).rejects.toThrow('empty pool')
    })
  })

  describe('getStatus', () => {
    it('reports agent states', () => {
      const pool = new AgentPool()
      pool.add(createMockAgent('idle1', { state: 'idle' }))
      pool.add(createMockAgent('idle2', { state: 'idle' }))
      pool.add(createMockAgent('running', { state: 'running' }))
      pool.add(createMockAgent('done', { state: 'completed' }))
      pool.add(createMockAgent('err', { state: 'error' }))

      const status = pool.getStatus()

      expect(status.total).toBe(5)
      expect(status.idle).toBe(2)
      expect(status.running).toBe(1)
      expect(status.completed).toBe(1)
      expect(status.error).toBe(1)
    })
  })

  describe('shutdown', () => {
    it('resets all agents', async () => {
      const pool = new AgentPool()
      const a = createMockAgent('a')
      const b = createMockAgent('b')
      pool.add(a)
      pool.add(b)

      await pool.shutdown()

      expect(a.reset).toHaveBeenCalled()
      expect(b.reset).toHaveBeenCalled()
    })
  })

  describe('per-agent serialization (#72)', () => {
    it('serializes concurrent runs on the same agent', async () => {
      const executionLog: string[] = []

      const agent = createMockAgent('dev')
      ;(agent.run as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string) => {
        executionLog.push(`start:${prompt}`)
        await new Promise(r => setTimeout(r, 50))
        executionLog.push(`end:${prompt}`)
        return SUCCESS_RESULT
      })

      const pool = new AgentPool(5)
      pool.add(agent)

      // Fire two runs for the same agent concurrently
      await Promise.all([
        pool.run('dev', 'task1'),
        pool.run('dev', 'task2'),
      ])

      // With per-agent serialization, runs must not overlap:
      // [start:task1, end:task1, start:task2, end:task2] (or reverse order)
      // i.e. no interleaving like [start:task1, start:task2, ...]
      expect(executionLog).toHaveLength(4)
      expect(executionLog[0]).toMatch(/^start:/)
      expect(executionLog[1]).toMatch(/^end:/)
      expect(executionLog[2]).toMatch(/^start:/)
      expect(executionLog[3]).toMatch(/^end:/)
    })

    it('allows different agents to run in parallel', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const makeTimedAgent = (name: string): Agent => {
        const agent = createMockAgent(name)
        ;(agent.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise(r => setTimeout(r, 50))
          concurrent--
          return SUCCESS_RESULT
        })
        return agent
      }

      const pool = new AgentPool(5)
      pool.add(makeTimedAgent('a'))
      pool.add(makeTimedAgent('b'))

      await Promise.all([
        pool.run('a', 'x'),
        pool.run('b', 'y'),
      ])

      // Different agents should run concurrently
      expect(maxConcurrent).toBe(2)
    })

    it('releases agent lock even when run() throws', async () => {
      const agent = createMockAgent('dev')
      let callCount = 0
      ;(agent.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('first run fails')
        return SUCCESS_RESULT
      })

      const pool = new AgentPool(5)
      pool.add(agent)

      // First run fails, second should still execute (not deadlock)
      const results = await Promise.allSettled([
        pool.run('dev', 'will-fail'),
        pool.run('dev', 'should-succeed'),
      ])

      expect(results[0]!.status).toBe('rejected')
      expect(results[1]!.status).toBe('fulfilled')
    })
  })

  describe('concurrency', () => {
    it('respects maxConcurrency limit', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const makeAgent = (name: string): Agent => {
        const agent = createMockAgent(name)
        ;(agent.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise(r => setTimeout(r, 50))
          concurrent--
          return SUCCESS_RESULT
        })
        return agent
      }

      const pool = new AgentPool(2) // max 2 concurrent
      pool.add(makeAgent('a'))
      pool.add(makeAgent('b'))
      pool.add(makeAgent('c'))

      await pool.runParallel([
        { agent: 'a', prompt: 'x' },
        { agent: 'b', prompt: 'y' },
        { agent: 'c', prompt: 'z' },
      ])

      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })

    it('availableRunSlots matches maxConcurrency when idle', () => {
      const pool = new AgentPool(3)
      pool.add(createMockAgent('a'))
      expect(pool.availableRunSlots).toBe(3)
      expect(pool.runConcurrencyLimit).toBe(3)
    })

    it('availableRunSlots is zero while a run holds the pool slot', async () => {
      const pool = new AgentPool(1)
      const agent = createMockAgent('solo')
      pool.add(agent)

      let finishRun!: (value: AgentRunResult) => void
      const holdPromise = new Promise<AgentRunResult>((resolve) => {
        finishRun = resolve
      })
      vi.mocked(agent.run).mockReturnValue(holdPromise)

      const runPromise = pool.run('solo', 'hold-slot')
      await Promise.resolve()
      await Promise.resolve()
      expect(pool.availableRunSlots).toBe(0)

      finishRun(SUCCESS_RESULT)
      await runPromise
      expect(pool.availableRunSlots).toBe(1)
    })

    it('runEphemeral runs a caller-supplied Agent without touching the agentLock', async () => {
      // Registered agent's lock is held by a pending pool.run — a second
      // pool.run() against the same name would queue on the agent lock.
      // runEphemeral on a fresh Agent instance must NOT block on that lock.
      const pool = new AgentPool(3)
      const registered = createMockAgent('alice')
      pool.add(registered)

      let releaseRegistered!: (v: AgentRunResult) => void
      vi.mocked(registered.run).mockReturnValue(
        new Promise<AgentRunResult>((resolve) => {
          releaseRegistered = resolve
        }),
      )
      const heldRun = pool.run('alice', 'long running')
      await Promise.resolve()
      await Promise.resolve()

      const ephemeral = createMockAgent('alice') // same name, fresh instance
      const ephemeralResult = await pool.runEphemeral(ephemeral, 'quick task')

      expect(ephemeralResult).toBe(SUCCESS_RESULT)
      expect(ephemeral.run).toHaveBeenCalledWith('quick task', undefined)

      releaseRegistered(SUCCESS_RESULT)
      await heldRun
    })

    it('runEphemeral still respects pool semaphore', async () => {
      const pool = new AgentPool(1)
      const holder = createMockAgent('holder')
      pool.add(holder)

      let releaseHolder!: (v: AgentRunResult) => void
      vi.mocked(holder.run).mockReturnValue(
        new Promise<AgentRunResult>((resolve) => {
          releaseHolder = resolve
        }),
      )
      const heldRun = pool.run('holder', 'hold-slot')
      await Promise.resolve()
      await Promise.resolve()
      expect(pool.availableRunSlots).toBe(0)

      // Ephemeral agent should queue on the semaphore, not run immediately.
      const ephemeral = createMockAgent('ephemeral')
      let ephemeralResolved = false
      const ephemeralRun = pool.runEphemeral(ephemeral, 'p').then((r) => {
        ephemeralResolved = true
        return r
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(ephemeralResolved).toBe(false)

      releaseHolder(SUCCESS_RESULT)
      await heldRun
      await ephemeralRun
      expect(ephemeralResolved).toBe(true)
    })
  })
})
