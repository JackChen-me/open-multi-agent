import { describe, expect, it } from 'vitest'
import { GitHubRestClient } from '../src/github.js'
import { APP_BOT_USER_ID, APP_SLUG } from './helpers.js'

describe('GitHub issue comment authorship', () => {
  it('preserves GraphQL Bot database identity when actor login omits the REST suffix', async () => {
    let requestBody: { query?: string } | undefined
    const actor = {
      __typename: 'Bot',
      login: APP_SLUG,
      databaseId: APP_BOT_USER_ID,
    }
    const client = new GitHubRestClient({
      token: 'test-installation-token',
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as { query?: string }
        return new Response(JSON.stringify({
          data: {
            node: {
              author: actor,
              editor: actor,
              createdViaEmail: false,
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await expect(client.getIssueCommentAuthorship('IC_test')).resolves.toEqual({
      author: { databaseId: APP_BOT_USER_ID, login: APP_SLUG, type: 'Bot' },
      editor: { databaseId: APP_BOT_USER_ID, login: APP_SLUG, type: 'Bot' },
      createdViaEmail: false,
    })
    expect(requestBody?.query).toContain('... on Bot { databaseId }')
    expect(requestBody?.query).not.toContain('viewerDidAuthor')
  })

  it('deletes only the explicitly selected issue comment through the REST contract', async () => {
    let method: string | undefined
    let path: string | undefined
    const client = new GitHubRestClient({
      token: 'test-installation-token',
      baseUrl: 'https://api.example.test',
      fetchImpl: async (input, init) => {
        method = init?.method
        path = String(input)
        return new Response(null, { status: 204 })
      },
    })
    await expect(client.deleteIssueComment('open-multi-agent/open-multi-agent', 42)).resolves.toBeUndefined()
    expect(method).toBe('DELETE')
    expect(path).toBe('https://api.example.test/repos/open-multi-agent/open-multi-agent/issues/comments/42')
  })
})
