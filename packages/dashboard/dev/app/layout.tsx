import type { Metadata } from 'next'
import '../../src/styles/globals.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'AgentFactory Dashboard — Dev',
  description: 'Dashboard component development server',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  )
}
