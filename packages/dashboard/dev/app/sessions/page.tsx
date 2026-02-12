'use client'

import { DashboardShell, SessionPage } from '../../../src'
import { usePathname, useSearchParams } from 'next/navigation'

export default function Page() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('id') ?? undefined
  return (
    <DashboardShell currentPath={pathname}>
      <SessionPage sessionId={sessionId} />
    </DashboardShell>
  )
}
