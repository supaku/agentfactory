'use client'

import { DashboardShell, SessionPage } from '@renseiai/agentfactory-dashboard'
import { usePathname } from 'next/navigation'

export default function Sessions() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage />
    </DashboardShell>
  )
}
