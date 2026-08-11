import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('GitHub-hosted harness canary workflow', () => {
  it('is manual, read-only, pinned, credential-isolated, and does not alter the production workflow', async () => {
    const workflow = await readFile(resolve(process.cwd(), '../../.github/workflows/maintainer-harness-canary.yml'), 'utf8')
    const cli = await readFile(resolve(process.cwd(), 'src/cli.ts'), 'utf8')
    const validationSandbox = await readFile(resolve(process.cwd(), 'src/validation-sandbox.ts'), 'utf8')
    const boundedProcess = await readFile(resolve(process.cwd(), 'src/bounded-process.ts'), 'utf8')
    const appArmorProfile = await readFile(resolve(process.cwd(), 'config/bwrap.apparmor'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('runs-on: ubuntu-24.04')
    const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'))
    expect(triggers).not.toMatch(/^\s+(?:push|pull_request|issues|schedule):/m)
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('issues: read')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toContain('issues: write')
    expect(workflow).not.toContain('pull-requests: write')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('@anthropic-ai/claude-code@2.1.220')
    expect(workflow).toContain('sudo apt-get install --yes --no-install-recommends apparmor bubblewrap socat')
    expect(workflow).toContain("test \"$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)\" = '1'")
    expect(workflow.match(/apparmor_restrict_unprivileged_userns/g)).toHaveLength(2)
    expect(workflow).toContain('sudo apparmor_parser --replace /etc/apparmor.d/bwrap')
    expect(workflow.indexOf('apparmor_parser --replace')).toBeLessThan(workflow.indexOf('dist/cli.js sandbox-preflight'))
    expect(workflow).not.toContain('systemctl reload apparmor')
    expect(workflow).not.toMatch(/sysctl\s+(?:-[\w-]+\s+)*kernel\.apparmor_restrict_unprivileged_userns\s*=/)
    expect(workflow).not.toContain('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    expect(appArmorProfile).toBe(`abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`)
    expect(workflow.indexOf('sandbox-preflight')).toBeLessThan(workflow.indexOf('DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}'))
    expect(workflow).toContain('dist/cli.js sandbox-preflight')
    expect(validationSandbox).toContain("export const BUBBLEWRAP_PATH = '/usr/bin/bwrap'")
    for (const contract of [
      "'--unshare-pid'",
      "'--unshare-net'",
      "'--cap-drop', 'ALL'",
      "'--proc', '/proc'",
      "'--tmpfs', '/tmp'",
      "'--tmpfs', '/home'",
      "'--ro-bind', repoRoot, SANDBOX_REPO_ROOT",
      "'--clearenv'",
    ]) expect(validationSandbox).toContain(contract)
    expect(validationSandbox).not.toContain("new NodeCommandRunner()).run(options.command.command")
    expect(validationSandbox).toContain('new BoundedProcessRunner()')
    expect(boundedProcess).toContain("shell: false")
    expect(boundedProcess).toContain('outputBytes += value.byteLength')
    expect(boundedProcess).toContain("signalProcessTree(child, 'SIGTERM')")
    expect(boundedProcess).toContain("signalProcessTree(child, 'SIGKILL')")
    expect(boundedProcess).toContain('CONVERGENCE_GRACE_MS')
    expect(workflow).not.toContain('@anthropic-ai/claude-code@latest')
    expect(workflow).toContain('DEEPSEEK_API_KEY')
    expect(workflow).toMatch(/exec 3<<<"\$\{DEEPSEEK_API_KEY:[^\n]+\}"[\s\S]*unset DEEPSEEK_API_KEY[\s\S]*exec env -i[\s\S]*--provider-key-fd 3/)
    expect(cli).toContain('readProviderKeyFromFd')
    expect(cli).toContain('preflightValidationSandbox')
    expect(cli).toContain('JSON.stringify(error.diagnostic)')
    expect(cli).not.toContain('validationSandboxProcessRunner')
    expect(cli).not.toContain("process.env['DEEPSEEK_API_KEY']")
    expect(workflow).toContain('materialEvidence: comments.map')
    expect(workflow).toContain('if-no-files-found: warn')
    expect(workflow).not.toContain('OMA_MAINTAINER_BOT_APP_PRIVATE_KEY')
    expect(workflow).not.toContain('create-github-app-token')
    expect(workflow).not.toContain('git push')
    expect(workflow).not.toContain('gh pr')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.issue\.(?:title|body)/)
    expect(workflow).not.toMatch(/run:.*\$\{\{\s*inputs\.issue_number/m)
    for (const action of ['actions/checkout', 'actions/setup-node', 'actions/github-script', 'actions/upload-artifact']) {
      expect(workflow).not.toMatch(new RegExp(`uses: ${action.replace('/', '\\/')}@v\\d`))
    }
  })
})
