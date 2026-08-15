import { describe, it, expect } from 'vitest'
import { Scheduler } from '../src/orchestrator/scheduler.js'
import type { SchedulingStrategy } from '../src/orchestrator/scheduler.js'
import { TaskQueue } from '../src/task/queue.js'
import { createTask } from '../src/task/task.js'
import type { AgentConfig, Task, TaskRequirements } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(name: string, systemPrompt?: string): AgentConfig {
  return { name, model: 'test-model', systemPrompt }
}

function pendingTask(
  title: string,
  opts?: {
    assignee?: string
    dependsOn?: string[]
    requires?: TaskRequirements
  },
): Task {
  return createTask({ title, description: title, assignee: opts?.assignee, ...opts })
}

// ---------------------------------------------------------------------------
// round-robin
// ---------------------------------------------------------------------------

describe('Scheduler: round-robin', () => {
  it('distributes tasks evenly across agents', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b'), agent('c')]
    const tasks = [
      pendingTask('t1'),
      pendingTask('t2'),
      pendingTask('t3'),
      pendingTask('t4'),
      pendingTask('t5'),
      pendingTask('t6'),
    ]

    const assignments = s.schedule(tasks, agents)

    expect(assignments.get(tasks[0]!.id)).toBe('a')
    expect(assignments.get(tasks[1]!.id)).toBe('b')
    expect(assignments.get(tasks[2]!.id)).toBe('c')
    expect(assignments.get(tasks[3]!.id)).toBe('a')
    expect(assignments.get(tasks[4]!.id)).toBe('b')
    expect(assignments.get(tasks[5]!.id)).toBe('c')
  })

  it('skips already-assigned tasks', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const tasks = [
      pendingTask('t1', { assignee: 'a' }),
      pendingTask('t2'),
    ]

    const assignments = s.schedule(tasks, agents)

    // Only t2 should be assigned
    expect(assignments.size).toBe(1)
    expect(assignments.has(tasks[1]!.id)).toBe(true)
  })

  it('returns empty map when no agents', () => {
    const s = new Scheduler('round-robin')
    const tasks = [
      pendingTask('t1'),
      pendingTask('t2', { requires: {} }),
    ]
    expect(s.schedule(tasks, []).size).toBe(0)
  })

  it('cursor advances across calls', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const t1 = [pendingTask('t1')]
    const t2 = [pendingTask('t2')]

    const a1 = s.schedule(t1, agents)
    const a2 = s.schedule(t2, agents)

    expect(a1.get(t1[0]!.id)).toBe('a')
    expect(a2.get(t2[0]!.id)).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// least-busy
// ---------------------------------------------------------------------------

describe('Scheduler: least-busy', () => {
  it('assigns to agent with fewest in_progress tasks', () => {
    const s = new Scheduler('least-busy')
    const agents = [agent('a'), agent('b')]

    // Create some in-progress tasks for agent 'a'
    const inProgress: Task = {
      ...pendingTask('busy'),
      status: 'in_progress',
      assignee: 'a',
    }
    const newTask = pendingTask('new')
    const allTasks = [inProgress, newTask]

    const assignments = s.schedule(allTasks, agents)

    // 'b' has 0 in-progress, 'a' has 1 → assign to 'b'
    expect(assignments.get(newTask.id)).toBe('b')
  })

  it('balances load across batch', () => {
    const s = new Scheduler('least-busy')
    const agents = [agent('a'), agent('b')]
    const tasks = [pendingTask('t1'), pendingTask('t2'), pendingTask('t3'), pendingTask('t4')]

    const assignments = s.schedule(tasks, agents)

    // Should alternate: a, b, a, b
    const values = [...assignments.values()]
    const aCount = values.filter(v => v === 'a').length
    const bCount = values.filter(v => v === 'b').length
    expect(aCount).toBe(2)
    expect(bCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// capability-match
// ---------------------------------------------------------------------------

describe('Scheduler: capability-match', () => {
  it('matches task keywords to agent system prompt', () => {
    const s = new Scheduler('capability-match')
    const agents = [
      agent('researcher', 'You are a research expert who analyzes data and writes reports'),
      agent('coder', 'You are a software engineer who writes TypeScript code'),
    ]
    const tasks = [
      pendingTask('Write TypeScript code for the API'),
      pendingTask('Research and analyze market data'),
    ]

    const assignments = s.schedule(tasks, agents)

    expect(assignments.get(tasks[0]!.id)).toBe('coder')
    expect(assignments.get(tasks[1]!.id)).toBe('researcher')
  })

  it('matches Chinese tasks to the corresponding Chinese agents', () => {
    const s = new Scheduler('capability-match')
    const agents = [
      agent('营销专家', '制定品牌策略和市场推广方案'),
      agent('代码评审员', '分析代码质量并生成评审报告'),
      agent('数据分析师', '分析销售数据并生成趋势报告'),
    ]
    const tasks = [
      pendingTask('分析代码质量并生成评审报告'),
      pendingTask('分析销售数据并生成趋势报告'),
      pendingTask('制定品牌策略和市场推广方案'),
    ]

    const assignments = s.schedule(tasks, agents)

    expect(assignments.get(tasks[0]!.id)).toBe('代码评审员')
    expect(assignments.get(tasks[1]!.id)).toBe('数据分析师')
    expect(assignments.get(tasks[2]!.id)).toBe('营销专家')
  })

  it('round-robins zero-score tasks and advances the cursor across calls', () => {
    const s = new Scheduler('capability-match')
    const agents = [agent('alpha'), agent('beta')]
    const tasks = [
      pendingTask('x'),
      pendingTask('y'),
      pendingTask('z'),
    ]

    const assignments = s.schedule(tasks, agents)
    const nextTask = pendingTask('q')
    const nextAssignments = s.schedule([nextTask], agents)

    expect([...assignments.values()]).toEqual(['alpha', 'beta', 'alpha'])
    expect(nextAssignments.get(nextTask.id)).toBe('beta')
  })
})

// ---------------------------------------------------------------------------
// dependency-first
// ---------------------------------------------------------------------------

describe('Scheduler: dependency-first', () => {
  it('prioritises tasks that unblock more dependents', () => {
    const s = new Scheduler('dependency-first')
    const agents = [agent('a')]

    // t1 blocks t2 and t3; t2 blocks nothing
    const t1 = pendingTask('t1')
    const t2 = pendingTask('t2')
    const t3 = { ...pendingTask('t3'), dependsOn: [t1.id] }
    const t4 = { ...pendingTask('t4'), dependsOn: [t1.id] }

    const allTasks = [t2, t1, t3, t4] // t2 first in input order

    const assignments = s.schedule(allTasks, agents)

    // t1 should be assigned first (unblocks 2 others)
    const entries = [...assignments.entries()]
    expect(entries[0]![0]).toBe(t1.id)
  })

  it('returns empty map for empty task list', () => {
    const s = new Scheduler('dependency-first')
    const assignments = s.schedule([], [agent('a')])
    expect(assignments.size).toBe(0)
  })
})

describe('Scheduler: compatibility strategies', () => {
  it('preserves the established behavior of all four pre-composite strategies', () => {
    const agents = [
      agent('a', 'Research and analyze evidence'),
      agent('b', 'Implement TypeScript code'),
    ]

    const roundRobinTasks = [pendingTask('one'), pendingTask('two')]
    expect([
      ...new Scheduler('round-robin')
        .schedule(roundRobinTasks, agents)
        .values(),
    ]).toEqual(['a', 'b'])

    const busy: Task = {
      ...pendingTask('busy'),
      status: 'in_progress',
      assignee: 'a',
    }
    const leastBusyTask = pendingTask('new')
    expect(
      new Scheduler('least-busy')
        .schedule([busy, leastBusyTask], agents)
        .get(leastBusyTask.id),
    ).toBe('b')

    const capabilityTask = pendingTask('Implement TypeScript code')
    expect(
      new Scheduler('capability-match')
        .schedule([capabilityTask], agents)
        .get(capabilityTask.id),
    ).toBe('b')

    const critical = pendingTask('critical')
    const ordinary = pendingTask('ordinary')
    const dependent = { ...pendingTask('dependent'), dependsOn: [critical.id] }
    expect([
      ...new Scheduler('dependency-first')
        .schedule([ordinary, critical, dependent], agents)
        .keys(),
    ][0]).toBe(critical.id)
  })

  it.each([
    'round-robin',
    'least-busy',
    'capability-match',
    'dependency-first',
    'composite',
  ] satisfies SchedulingStrategy[])(
    '%s applies hard requirements before strategy-specific ranking',
    (strategy) => {
      const scheduler = new Scheduler(strategy)
      const agents: AgentConfig[] = [
        {
          ...agent('ineligible'),
          capabilities: ['typescript'],
          tools: ['file_read'],
          provider: 'openai',
        },
        {
          ...agent('eligible'),
          capabilities: ['typescript'],
          tools: ['file_edit'],
          provider: 'anthropic',
        },
      ]
      const task = pendingTask('Restricted', {
        requires: {
          requiredTools: ['file_edit'],
          requiredCapabilities: ['typescript'],
          requiredBackend: 'llm',
          requiredProvider: 'anthropic',
        },
      })

      expect(scheduler.schedule([task], agents).get(task.id)).toBe('eligible')
    },
  )

  it.each([
    'round-robin',
    'least-busy',
    'capability-match',
    'dependency-first',
    'composite',
  ] satisfies SchedulingStrategy[])(
    '%s fails closed when no agent satisfies hard requirements',
    (strategy) => {
      const task = pendingTask('Restricted', {
        requires: { requiredCapabilities: ['missing'] },
      })

      expect(() => new Scheduler(strategy).schedule([task], [agent('worker')]))
        .toThrow('NO_ELIGIBLE_AGENT')
    },
  )
})

// ---------------------------------------------------------------------------
// composite
// ---------------------------------------------------------------------------

describe('Scheduler: composite', () => {
  it('prioritises the most critical task and selects its highest-fit eligible agent', () => {
    const s = new Scheduler('composite')
    const agents: AgentConfig[] = [
      { ...agent('researcher'), capabilities: ['worker', 'research'] },
      { ...agent('coder'), capabilities: ['worker', 'typescript'] },
    ]
    const low = pendingTask('General task')
    const critical = pendingTask('Implement TypeScript service', {
      requires: { requiredCapabilities: ['worker'] },
    })
    const dependentA = { ...pendingTask('Dependent A'), dependsOn: [critical.id] }
    const dependentB = { ...pendingTask('Dependent B'), dependsOn: [critical.id] }

    const assignments = s.schedule(
      [low, critical, dependentA, dependentB],
      agents,
    )

    expect([...assignments.keys()][0]).toBe(critical.id)
    expect(assignments.get(critical.id)).toBe('coder')
  })

  it('prefers the lower-load agent when fit is tied', () => {
    const s = new Scheduler('composite')
    const agents = [agent('alpha'), agent('beta')]
    const busy: Task = {
      ...pendingTask('Existing work'),
      status: 'in_progress',
      assignee: 'alpha',
    }
    const task = pendingTask('Unrelated neutral task')

    const assignments = s.schedule([busy, task], agents)

    expect(assignments.get(task.id)).toBe('beta')
  })

  it('honours configured fit and load weights', () => {
    const agents: AgentConfig[] = [
      { ...agent('coder'), capabilities: ['typescript'] },
      agent('idle'),
    ]
    const busy: Task = {
      ...pendingTask('Existing work'),
      status: 'in_progress',
      assignee: 'coder',
    }
    const task = pendingTask('Implement TypeScript')

    const fitOnly = new Scheduler('composite', {}, {
      weights: { fit: 1, load: 0 },
    }).schedule([busy, task], agents)
    const loadOnly = new Scheduler('composite', {}, {
      weights: { fit: 0, load: 1 },
    }).schedule([busy, task], agents)

    expect(fitOnly.get(task.id)).toBe('coder')
    expect(loadOnly.get(task.id)).toBe('idle')
  })

  it('fails closed when nobody is eligible', () => {
    const warnings: unknown[] = []
    const s = new Scheduler('composite', {}, {
      onWarning: (warning) => warnings.push(warning),
    })
    const agents = [agent('busy'), agent('idle')]
    const busy: Task = {
      ...pendingTask('Existing work'),
      status: 'in_progress',
      assignee: 'busy',
    }
    const task = pendingTask('Restricted task', {
      requires: { requiredCapabilities: ['missing'] },
    })

    expect(() => s.schedule([busy, task], agents)).toThrow('NO_ELIGIBLE_AGENT')
    expect(warnings).toEqual([])
  })
})

describe('Scheduler: one ready task at a time', () => {
  const agents = [
    agent('researcher', 'Research and analyze evidence'),
    agent('coder', 'Implement TypeScript code'),
  ]

  it('round-robin advances its cursor across single-task calls', () => {
    const scheduler = new Scheduler('round-robin')
    const first = pendingTask('first')
    const second = pendingTask('second')

    expect(scheduler.scheduleTask(first, agents, [first, second])).toBe('researcher')
    expect(scheduler.scheduleTask(second, agents, [first, second])).toBe('coder')
  })

  it('least-busy reads current in-progress load from the full snapshot', () => {
    const scheduler = new Scheduler('least-busy')
    const busy: Task = {
      ...pendingTask('busy'),
      status: 'in_progress',
      assignee: 'researcher',
    }
    const ready = pendingTask('ready')

    expect(scheduler.scheduleTask(ready, agents, [busy, ready])).toBe('coder')
  })

  it('capability-match preserves hard eligibility for a single ready task', () => {
    const scheduler = new Scheduler('capability-match')
    const ready = pendingTask('Implement TypeScript code')
    const impossible = pendingTask('Edit a file', {
      requires: { requiredTools: ['file_edit'] },
    })

    expect(scheduler.scheduleTask(ready, agents, [ready])).toBe('coder')
    expect(() => scheduler.scheduleTask(impossible, agents, [impossible]))
      .toThrow('NO_ELIGIBLE_AGENT')
  })

  it('dependency-first assigns each ready task while retaining cursor fairness', () => {
    const scheduler = new Scheduler('dependency-first')
    const critical = pendingTask('critical')
    const dependent = { ...pendingTask('dependent'), dependsOn: [critical.id] }
    const later = pendingTask('later')

    expect(scheduler.orderReadyTasks(
      [later, critical],
      [later, critical, dependent],
    ).map((task) => task.id)).toEqual([critical.id, later.id])
    expect(scheduler.scheduleTask(critical, agents, [critical, dependent, later]))
      .toBe('researcher')
    expect(scheduler.scheduleTask(later, agents, [critical, dependent, later]))
      .toBe('coder')
  })

  it('composite reads current load from the full snapshot for one ready task', () => {
    const scheduler = new Scheduler('composite', {}, {
      weights: { fit: 0, load: 1 },
    })
    const busy: Task = {
      ...pendingTask('busy'),
      status: 'in_progress',
      assignee: 'researcher',
    }
    const ready = pendingTask('ready')

    expect(scheduler.scheduleTask(ready, agents, [busy, ready])).toBe('coder')
  })
})

// ---------------------------------------------------------------------------
// autoAssign
// ---------------------------------------------------------------------------

describe('Scheduler: autoAssign', () => {
  it('updates queue tasks with assignees', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const queue = new TaskQueue()

    const t1 = pendingTask('t1')
    const t2 = pendingTask('t2')
    queue.add(t1)
    queue.add(t2)

    s.autoAssign(queue, agents)

    const tasks = queue.list()
    const assignees = tasks.map(t => t.assignee)
    expect(assignees).toContain('a')
    expect(assignees).toContain('b')
  })

  it('does not overwrite existing assignees', () => {
    const s = new Scheduler('round-robin')
    const agents = [agent('a'), agent('b')]
    const queue = new TaskQueue()

    const t1 = pendingTask('t1', { assignee: 'x' })
    queue.add(t1)

    s.autoAssign(queue, agents)

    expect(queue.list()[0]!.assignee).toBe('x')
  })
})
