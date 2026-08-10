import { createApp, SupportTicketResponse } from './index.js'

const app = createApp()
const server = app.listen(0, async () => {
  const { port } = server.address() as { port: number }
  try {
    const res = await fetch(`http://localhost:${port}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: 'Cannot login',
        body: 'I keep getting "invalid password" even after resetting it.',
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const data = await res.json()
    SupportTicketResponse.parse(data)
    console.log('Smoke test PASSED')
    console.log(JSON.stringify(data, null, 2))
    process.exit(0)
  } catch (err) {
    console.error('Smoke test FAILED:', err)
    process.exit(1)
  } finally {
    server.close()
  }
})
