'use client'

import { DashboardShell, SettingsPage } from '../../../src'
import { usePathname } from 'next/navigation'

export default function Page() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <SettingsPage />
    </DashboardShell>
  )
}
