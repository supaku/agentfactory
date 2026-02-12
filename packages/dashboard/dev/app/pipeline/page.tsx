'use client'

import { DashboardShell, PipelinePage } from '../../../src'
import { usePathname, useRouter } from 'next/navigation'

export default function Page() {
  const pathname = usePathname()
  const router = useRouter()
  return (
    <DashboardShell currentPath={pathname}>
      <PipelinePage onSessionSelect={(id) => router.push(`/sessions?id=${id}`)} />
    </DashboardShell>
  )
}
