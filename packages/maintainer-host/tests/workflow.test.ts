import { describe, expect, it } from 'vitest'
import { readWorkflow } from './helpers.js'

describe('GitHub Actions activation workflow', () => {
  it('uses the exact label trigger, issue concurrency, pinned runtime, and a dedicated App writer token', async () => {
    const workflow = await readWorkflow()
    expect(workflow).toContain('issues:')
    expect(workflow).toContain('types: [labeled]')
    expect(workflow).toContain("github.event.label.name == 'agent-ready'")
    expect(workflow).toContain('issue-${{ github.event.issue.number }}')
    expect(workflow).toContain('cancel-in-progress: false')
    const workflowPermissions = workflow.slice(workflow.indexOf('permissions:'), workflow.indexOf('concurrency:'))
    expect(workflowPermissions).toBe('permissions:\n  contents: read\n  issues: write\n\n')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('node-version: 22.23.1')
    expect(workflow).toContain('10.9.8')
    expect(workflow).toContain('vars.OMA_MAINTAINER_BOT_APP_WRITER_ENABLED')
    expect(workflow).toContain('vars.OMA_MAINTAINER_BOT_APP_CLIENT_ID')
    expect(workflow).toContain('secrets.OMA_MAINTAINER_BOT_APP_PRIVATE_KEY')
    expect(workflow).toContain('vars.OMA_MAINTAINER_BOT_APP_ID')
    expect(workflow).toContain('vars.OMA_MAINTAINER_BOT_APP_SLUG')
    expect(workflow).toContain('vars.OMA_MAINTAINER_BOT_APP_INSTALLATION_ID')
    expect(workflow).toContain('vars.OMA_MAINTAINER_BOT_APP_BOT_USER_ID')
    expect(workflow.match(/secrets\.OMA_MAINTAINER_BOT_APP_PRIVATE_KEY/g)).toHaveLength(1)
    expect(workflow.match(/secrets\.GITHUB_TOKEN/g)).toHaveLength(2)
    expect(workflow).not.toContain('OMA_MAINTAINER_BOT_PR_CREATION_ENABLED')
    expect(workflow).not.toContain('--pr-creation-attested')
    expect(workflow).not.toContain('MAINTAINER_BOT_GITHUB_TOKEN')
    expect(workflow).not.toContain('--claim-id "${{')
    expect(workflow).not.toContain("const baseSha = '${{")
    expect(workflow).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
    expect(workflow).toContain('actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b')
    expect(workflow).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1')
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node|github-script|create-github-app-token)@v\d/)
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).not.toMatch(/(?:PERSONAL_ACCESS_TOKEN|\bPAT\b)/)
    expect(workflow).not.toContain('permission-workflows: write')
    expect(workflow).toContain("const terminalClaim = sameClaim && !runningClaim")
    expect(workflow).toContain("terminalClaim ? previous.status : 'FAILED'")
    expect(workflow).toContain('process.env.GITHUB_WORKFLOW_SHA')
    expect(workflow).toContain('workflowSha !== baseSha')
    expect(workflow.match(/const isExpectedGraphQlBotActor = actor =>/g)).toHaveLength(2)
    expect(workflow.match(/author \{ __typename login \.\.\. on Bot \{ databaseId \} \}/g)).toHaveLength(3)
    expect(workflow.match(/editor \{ __typename login \.\.\. on Bot \{ databaseId \} \}/g)).toHaveLength(3)
    expect(workflow.match(/!isExpectedGraphQlBotActor\(/g)).toHaveLength(6)
    expect(workflow).not.toContain('viewerDidAuthor')
    expect(workflow).toContain('comment.user?.id !== expected.botUserId')
    expect(workflow).toContain('updated.user?.id !== botUserId')

    const tokenStep = workflow.slice(
      workflow.indexOf('- name: Create repository-scoped Maintainer Bot App token'),
      workflow.indexOf('- name: Verify App identity'),
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

    const prepare = workflow.slice(
      workflow.indexOf('- name: Re-fetch, authorize'),
      workflow.indexOf('- name: Run the selected OMA backend'),
    )
    expect(prepare).toContain('MAINTAINER_BOT_APP_TOKEN')
    expect(prepare).toContain('OMA_EXPECTED_APP_ID: ${{ vars.OMA_MAINTAINER_BOT_APP_ID }}')
    expect(prepare).toContain('OMA_ACTUAL_APP_SLUG: ${{ steps.app-token.outputs.app-slug }}')
    expect(prepare).toContain('OMA_ACTUAL_APP_INSTALLATION_ID: ${{ steps.app-token.outputs.installation-id }}')
    expect(prepare).not.toContain('secrets.GITHUB_TOKEN')
    expect(prepare).not.toContain('DEEPSEEK_API_KEY')
    const engine = workflow.slice(workflow.indexOf('- name: Run the selected OMA backend'), workflow.indexOf('- name: Revalidate'))
    expect(engine).toContain('DEEPSEEK_API_KEY')
    expect(engine).toContain('--provider-key-fd 3')
    expect(engine).toContain('exec env -i')
    expect(engine).toContain('--claude-code-harness-cli')
    expect(engine).not.toContain('MAINTAINER_BOT_APP_TOKEN')
    expect(engine).not.toContain('GITHUB_TOKEN')
    expect(engine).not.toContain('NPM_TOKEN')
    const finalize = workflow.slice(workflow.indexOf('- name: Revalidate'), workflow.indexOf('- name: Publish App-authenticated'))
    expect(finalize).toContain('MAINTAINER_BOT_APP_TOKEN')
    expect(finalize).toContain('steps.app-token.outputs.token')
    expect(finalize).not.toContain('secrets.GITHUB_TOKEN')
    expect(finalize).not.toContain('DEEPSEEK_API_KEY')

    const bootstrap = workflow.slice(
      workflow.indexOf('- name: Publish pre-model App configuration failure'),
      workflow.indexOf('- name: Check out'),
    )
    expect(bootstrap).toContain('secrets.GITHUB_TOKEN')
    expect(bootstrap).toContain('has no durable run claim')
    expect(workflow).toContain('oma-maintainer-bot-status:v2')
    expect(workflow).toContain("comment.user?.login === 'github-actions[bot]'")
    expect(workflow).not.toContain('ready_for_review')
    expect(workflow).toContain('Select the single configured execution backend')
    expect(workflow).toContain("['legacy','claude-code']")
    expect(workflow).toContain('@anthropic-ai/claude-code@2.1.220')
    expect(workflow).toContain('sandbox-preflight')
  })
})
