'use client'

import { DashboardShell, SessionPage } from '@supaku/agentfactory-dashboard'
import { usePathname } from 'next/navigation'

export default function Sessions() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage />
    </DashboardShell>
  )
}
