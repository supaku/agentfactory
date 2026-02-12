'use client'

import { DashboardShell, PipelinePage } from '../../../src'
import { usePathname } from 'next/navigation'

export default function Page() {
  const pathname = usePathname()
  return (
    <DashboardShell currentPath={pathname}>
      <PipelinePage />
    </DashboardShell>
  )
}
