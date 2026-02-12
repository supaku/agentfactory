'use client'

import { DashboardShell, SessionPage } from '../../../src'
import { usePathname } from 'next/navigation'

export default function Page() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage />
    </DashboardShell>
  )
}
