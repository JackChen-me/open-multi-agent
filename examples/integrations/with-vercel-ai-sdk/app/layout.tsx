import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'OMA + Vercel AI SDK',
  description: 'Multi-agent research team powered by open-multi-agent, streamed via Vercel AI SDK',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#fafafa' }}>{children}</body>
    </html>
  )
}
