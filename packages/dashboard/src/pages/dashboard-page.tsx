'use client'

import { FleetOverview } from '../components/fleet/fleet-overview'

interface DashboardPageProps {
  onSessionSelect?: (sessionId: string) => void
}

export function DashboardPage({ onSessionSelect }: DashboardPageProps) {
  return <FleetOverview onSessionSelect={onSessionSelect} />
}
