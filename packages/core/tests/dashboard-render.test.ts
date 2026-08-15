import { describe, expect, it } from 'vitest'
import { renderTeamRunDashboard } from '../src/dashboard/render-team-run-dashboard.js'

describe('renderTeamRunDashboard', () => {
  it('does not embed unescaped script terminators in the JSON payload and keeps XSS payloads out of HTML markup', () => {
    const malicious = '"</script><img src=x onerror=alert(1)>"'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: malicious,
          status: 'pending',
          dependsOn: [],
        },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const dataOpen = 'id="oma-data">'
    const start = html.indexOf(dataOpen)
    expect(start).toBeGreaterThan(-1)
    const contentStart = start + dataOpen.length
    const end = html.indexOf('</script>', contentStart)
    expect(end).toBeGreaterThan(contentStart)
    const jsonSlice = html.slice(contentStart, end)
    expect(jsonSlice.toLowerCase()).not.toContain('</script')

    const parsed = JSON.parse(jsonSlice) as { tasks: { title: string }[] }
    expect(parsed.tasks[0]!.title).toBe(malicious)

    const beforeData = html.slice(0, start)
    expect(beforeData).not.toContain(malicious)
    expect(beforeData.toLowerCase()).not.toMatch(/\sonerror\s*=/)
  })

  it('excludes task description text from the JSON payload', () => {
    const description = 'danger: </script><svg onload=alert(1)>'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: 'task',
          description,
          status: 'pending',
          dependsOn: [],
        } as { id: string; title: string; description: string; status: 'pending'; dependsOn: string[] },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const start = html.indexOf('id="oma-data">')
    const contentStart = start + 'id="oma-data">'.length
    const end = html.indexOf('</script>', contentStart)
    const parsed = JSON.parse(html.slice(contentStart, end)) as { tasks: Array<{ description?: string }> }
    expect(parsed.tasks[0]!.description).toBeUndefined()
    expect(html).not.toContain('svg onload')
  })

  it('excludes task result text from the JSON payload', () => {
    const result = 'final output </script><img src=x onerror=alert(1)>'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: 'task',
          result,
          status: 'completed',
          dependsOn: [],
        } as { id: string; title: string; result: string; status: 'completed'; dependsOn: string[] },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const start = html.indexOf('id="oma-data">')
    const contentStart = start + 'id="oma-data">'.length
    const end = html.indexOf('</script>', contentStart)
    const parsed = JSON.parse(html.slice(contentStart, end)) as { tasks: Array<{ result?: string }> }
    expect(parsed.tasks[0]!.result).toBeUndefined()
    expect(html).not.toContain('final output')
  })

  it('does not reference remote dashboard assets', () => {
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toContain('cdn.tailwindcss.com')
    expect(html).not.toContain('fonts.googleapis.com')
  })

  it('redacts safe display fields and excludes sensitive source fields from the embedded payload', () => {
    const secret = 'sk-dashboardsecretvalue1234567890'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'password=hunter2',
      tasks: [
        {
          id: 't1',
          title: `task OPENAI_API_KEY=${secret}`,
          description: `OPENAI_API_KEY=${secret}`,
          result: `Authorization: Bearer ${secret}`,
          status: 'completed',
          dependsOn: [],
        } as { id: string; title: string; description: string; result: string; status: 'completed'; dependsOn: string[] },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const start = html.indexOf('id="oma-data">')
    const contentStart = start + 'id="oma-data">'.length
    const end = html.indexOf('</script>', contentStart)
    const parsed = JSON.parse(html.slice(contentStart, end)) as {
      tasks: Array<{ title: string; description?: string; result?: string }>
    }

    expect(html).not.toContain(secret)
    expect(parsed.tasks[0]!.title).toBe('task OPENAI_API_KEY=[redacted]')
    expect(parsed.tasks[0]!.description).toBeUndefined()
    expect(parsed.tasks[0]!.result).toBeUndefined()
    expect(html).not.toContain('hunter2')
  })

  it('emits a restrictive offline CSP and the unified viewer controls', () => {
    const html = renderTeamRunDashboard({
      success: true,
      tasks: [],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    expect(html).toContain("default-src 'none'")
    expect(html).toContain('id="waterfallTab"')
    expect(html).toContain('id="dagTab"')
    expect(html).toContain('id="details"')
    expect(html).toContain('class="masthead-primary"')
    expect(html).toContain('class="run-context"')
  })

  it('renders one linked routing summary from the decision and execution receipt', () => {
    const html = renderTeamRunDashboard({
      success: true,
      tasks: [{
        id: 'short-circuit',
        title: 'Short-circuit: alpha',
        assignee: 'alpha',
        status: 'completed',
        dependsOn: [],
        metrics: {
          startMs: 1,
          endMs: 2,
          durationMs: 1,
          tokenUsage: { input_tokens: 1, output_tokens: 1 },
          toolCalls: [],
          retries: 0,
        },
      }],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 1, output_tokens: 1 },
      routingDecision: {
        decisionId: 'decision-1',
        receiptId: 'receipt-1',
        traceSpanId: 'routing-span-1',
        source: 'router',
        mode: 'single',
        reasons: ['The goal is a single action.'],
        routerVersion: 'deterministic-v1',
      },
    })

    const start = html.indexOf('id="oma-data">') + 'id="oma-data">'.length
    const end = html.indexOf('</script>', start)
    const parsed = JSON.parse(html.slice(start, end)) as {
      routing: {
        decision: { source: string; routerVersion?: string }
        receipt: {
          id?: string
          routingDecisionId?: string
          routingDecisionSpanId?: string
          rolesExecuted: string[]
        }
      }
    }

    expect(parsed.routing.decision).toMatchObject({
      source: 'router',
      routerVersion: 'deterministic-v1',
    })
    expect(parsed.routing.receipt).toMatchObject({
      id: 'receipt-1',
      routingDecisionId: 'decision-1',
      routingDecisionSpanId: 'routing-span-1',
      rolesExecuted: ['alpha'],
    })
    expect(html).toContain('id="routingSummary" class="routing-summary"')
    expect(html).toContain('.routing-summary.visible')
    expect(html).toContain('.kind-dot.routing')
    expect(html).toContain('.wf-bar.kind-routing')
    expect(html).toContain("routingCard('Decided'")
    expect(html).toContain("routingCard('Why'")
    expect(html).toContain("routingCard('Actually ran'")
  })
})
