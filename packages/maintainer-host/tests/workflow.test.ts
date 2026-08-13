import { describe, expect, it } from 'vitest'
import { readWorkflow } from './helpers.js'

describe('GitHub Actions activation workflow', () => {
  it('keeps the trigger, concurrency, pinned actions, and least-privilege tokens deterministic', async () => {
    const workflow = await readWorkflow()
    expect(workflow).toContain('issues:')
    expect(workflow).toContain('types: [labeled]')
    expect(workflow).toContain("github.event.label.name == 'agent-ready'")
    expect(workflow).toContain('issue-${{ github.event.issue.number }}')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow.slice(workflow.indexOf('permissions:'), workflow.indexOf('concurrency:')))
      .toBe('permissions:\n  contents: read\n  issues: write\n\n')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('ref: ${{ github.workflow_sha }}')
    expect(workflow).toContain('node-version: 22.23.1')
    expect(workflow).toContain('10.9.8')
    expect(workflow).toContain('npm ci --ignore-scripts')
    expect(workflow).not.toMatch(/run:\s+npm ci\s*(?:\n|$)/)
    expect(workflow).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
    expect(workflow).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(workflow).not.toContain('actions/github-script')
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node|create-github-app-token)@v\d/)
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).not.toMatch(/(?:PERSONAL_ACCESS_TOKEN|\bPAT\b)/)
    expect(workflow).not.toContain('permission-workflows: write')
    expect(workflow.match(/secrets\.OMA_MAINTAINER_BOT_APP_PRIVATE_KEY/g)).toHaveLength(1)
    expect(workflow.match(/secrets\.GITHUB_TOKEN/g)).toHaveLength(2)

    const tokenStep = workflow.slice(
      workflow.indexOf('- name: Create repository-scoped Maintainer Bot App token'),
      workflow.indexOf('- name: Verify App, event snapshot'),
    )
    for (const permission of [
      'permission-actions: read',
      'permission-contents: write',
      'permission-issues: write',
      'permission-metadata: read',
      'permission-pull-requests: write',
    ]) expect(tokenStep).toContain(permission)
    expect(tokenStep).not.toContain('owner:')
    expect(tokenStep).not.toContain('repositories:')
    const traceUpload = workflow.slice(
      workflow.indexOf('- name: Upload bounded OMA pipeline trace'),
      workflow.indexOf('- name: Revalidate with the App'),
    )
    expect(traceUpload).toContain("if: always() && steps.prepare.outputs.should_run == 'true'")
    expect(traceUpload).toContain('continue-on-error: true')
    expect(traceUpload).toContain('artifacts/*.pipeline-trace.json')
    expect(traceUpload).toContain('if-no-files-found: warn')
    expect(traceUpload).toContain('retention-days: 7')
  })

  it('builds typed control code before App minting and preserves the two-phase STARTED then durable-claim order', async () => {
    const workflow = await readWorkflow()
    const checkout = workflow.indexOf('- name: Check out the trusted workflow commit')
    const install = workflow.indexOf('- name: Install locked dependencies before minting')
    const hostBuild = workflow.indexOf('- name: Build the deterministic host before minting')
    const appToken = workflow.indexOf('- name: Create repository-scoped Maintainer Bot App token')
    const start = workflow.indexOf('- name: Verify App, event snapshot')
    const sandbox = workflow.indexOf('- name: Install Claude Code sandbox runtime dependencies')
    const runtime = workflow.indexOf('- name: Build and preflight the production Maintainer Runtime')
    const prepare = workflow.indexOf('- name: Re-fetch, authorize, and establish the durable candidate claim')
    expect([checkout, install, hostBuild, appToken, start, sandbox, runtime, prepare])
      .toEqual([...([checkout, install, hostBuild, appToken, start, sandbox, runtime, prepare])].sort((a, b) => a - b))
    expect(workflow.slice(start, sandbox)).toContain('dist/cli.js start')
    expect(workflow.slice(start, sandbox)).toContain('--workflow-sha "$GITHUB_WORKFLOW_SHA"')
    expect(workflow.slice(start, sandbox)).toContain('--start-out "$RUNNER_TEMP/oma-maintainer/start.json"')
    expect(workflow.slice(start, sandbox)).not.toContain('DEEPSEEK_API_KEY')
    expect(workflow.slice(prepare, workflow.indexOf('- name: Run the selected'))).toContain('dist/cli.js prepare')
    expect(workflow.slice(prepare, workflow.indexOf('- name: Run the selected'))).toContain('--start "$RUNNER_TEMP/oma-maintainer/start.json"')
    expect(workflow.slice(prepare, workflow.indexOf('- name: Run the selected'))).toContain('--start-hash "${{ steps.start.outputs.start_hash }}"')
    expect(workflow).not.toContain('node -e')
    expect(workflow).not.toContain('script: |')
    expect(workflow).not.toContain('steps.backend')
  })

  it('keeps runtime assembly fail-closed and the model child free of host credentials', async () => {
    const workflow = await readWorkflow()
    expect(workflow).toContain('packages/maintainer-runtime/config/bwrap.apparmor')
    expect(workflow).toContain('npm run build -w @open-multi-agent/maintainer-runtime')
    expect(workflow).toContain('packages/maintainer-runtime/dist/cli.js sandbox-preflight')
    expect(workflow).toContain('@anthropic-ai/claude-code@2.1.220')
    const engine = workflow.slice(
      workflow.indexOf('- name: Run the selected OMA backend'),
      workflow.indexOf('- name: Revalidate with the App'),
    )
    expect(engine).toContain("steps.prepare.outputs.should_run == 'true'")
    expect(engine).toContain('DEEPSEEK_API_KEY')
    expect(engine).toContain('--provider-key-fd 3')
    expect(engine).toContain('exec env -i')
    expect(engine).toContain('--maintainer-runtime-cli packages/maintainer-runtime/dist/cli.js')
    expect(engine).not.toContain('RUNNER_TEMP="$RUNNER_TEMP"')
    expect(engine).not.toContain('npm_config_cache=')
    expect(engine).not.toContain('MAINTAINER_BOT_APP_TOKEN')
    expect(engine).not.toContain('GITHUB_TOKEN')
    expect(engine).not.toContain('NPM_TOKEN')
  })

  it('uses typed bootstrap, recovery, and terminal-exit commands with only five public statuses', async () => {
    const workflow = await readWorkflow()
    const startRecovery = workflow.slice(
      workflow.indexOf('- name: Recover typed start failure'),
      workflow.indexOf('- name: Publish non-authoritative'),
    )
    expect(startRecovery).toContain("steps.app-token.outcome == 'success' && steps.start.outcome != 'success'")
    expect(startRecovery).toContain('dist/cli.js recover-start')
    expect(startRecovery).toContain("steps.start.outputs.failure_stage || 'output-write'")
    expect(startRecovery).toContain('MAINTAINER_BOT_APP_TOKEN')
    expect(startRecovery).not.toContain('GITHUB_TOKEN')
    const bootstrap = workflow.slice(
      workflow.indexOf('- name: Publish non-authoritative'),
      workflow.indexOf('- name: Install Claude Code sandbox'),
    )
    expect(bootstrap).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(bootstrap).toContain('dist/cli.js bootstrap-failure')
    expect(bootstrap).toContain("steps.app-token.outcome != 'success'")
    expect(bootstrap).toContain("steps.start-recovery.outcome != 'success'")
    expect(bootstrap).toContain("'app-token-mint' || 'app-identity-or-recovery'")
    expect(bootstrap).not.toContain('MAINTAINER_BOT_APP_TOKEN')
    const recovery = workflow.slice(
      workflow.indexOf('- name: Recover App-authenticated'),
      workflow.indexOf('- name: Apply typed terminal exit policy'),
    )
    expect(recovery).toContain('MAINTAINER_BOT_APP_TOKEN')
    expect(recovery).toContain('dist/cli.js recover')
    expect(recovery).not.toContain('DEEPSEEK_API_KEY')
    expect(workflow).toContain('dist/cli.js exit-terminal')
    expect(workflow).not.toContain('NEEDS_HUMAN')
    expect(workflow).not.toContain('RUNNING')
    expect(workflow).not.toContain('ready_for_review')
  })
})
