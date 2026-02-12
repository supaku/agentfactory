'use client'

import { DashboardShell, DashboardPage as FleetPage } from '../../src'
import { usePathname, useRouter } from 'next/navigation'

export default function Page() {
  const pathname = usePathname()
  const router = useRouter()
  return (
    <DashboardShell currentPath={pathname}>
      <FleetPage onSessionSelect={(id) => router.push(`/sessions?id=${id}`)} />
    </DashboardShell>
  )
}
