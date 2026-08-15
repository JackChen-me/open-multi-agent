import { describe, it, expect } from 'vitest'

/**
 * Smoke test for the package's subpath export barrels. Tests run against `src`
 * (not the published `@open-multi-agent/core/*` names), so we import each entry
 * barrel by its relative source path and assert the public symbols resolve. This
 * guards against a barrel that references a moved/renamed implementation module.
 */
describe('subpath export barrels', () => {
  it('/classifiers exposes classifyBashCommand', async () => {
    const mod = await import('../src/classifiers.js')
    expect(typeof mod.classifyBashCommand).toBe('function')
    expect(mod.classifyBashCommand('ls').level).toBe('safe')
  })

  it('/mcp exposes connectMCPTools', async () => {
    const mod = await import('../src/mcp.js')
    expect(typeof mod.connectMCPTools).toBe('function')
  })

  it('/ai-sdk exposes AISdkAdapter', async () => {
    const mod = await import('../src/ai-sdk.js')
    expect(typeof mod.AISdkAdapter).toBe('function')
  })

  it('/shell exposes LocalShellExecutor', async () => {
    const mod = await import('../src/shell.js')
    expect(typeof mod.LocalShellExecutor).toBe('function')
    expect(typeof new mod.LocalShellExecutor().exec).toBe('function')
  })

  it('/eval exposes EvalSet and offline runner entry points', async () => {
    const mod = await import('../src/eval/index.js')
    expect(typeof mod.defineEvalSet).toBe('function')
    expect(typeof mod.runEvalSet).toBe('function')
    expect(typeof mod.targetFromAgent).toBe('function')
    expect(typeof mod.evaluateGate).toBe('function')
    expect(typeof mod.InMemoryEvalStore).toBe('function')
    expect(mod).not.toHaveProperty('FileEvalStore')
  })

  it('/eval/file exposes Node-only EvalSet and report file helpers', async () => {
    const mod = await import('../src/eval/file.js')
    expect(typeof mod.loadEvalSet).toBe('function')
    expect(typeof mod.loadEvalReport).toBe('function')
    expect(typeof mod.loadGatePolicy).toBe('function')
    expect(typeof mod.writeEvalReport).toBe('function')
    expect(typeof mod.FileEvalStore).toBe('function')
  })
})
