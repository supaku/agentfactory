/**
 * GET /api/public/stats
 *
 * Returns aggregate statistics only - no sensitive data.
 */

import { NextResponse } from 'next/server'
import { getAllSessions, listWorkers, getTotalCapacity, getQueueLength, createLogger } from '@supaku/agentfactory-server'

const log = createLogger('api/public/stats')

export interface PublicStatsResponse {
  workersOnline: number
  agentsWorking: number
  queueDepth: number
  completedToday: number
  availableCapacity: number
  totalCostToday: number
}

function getTodayStart(): number {
  const now = new Date()
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  return Math.floor(todayStart.getTime() / 1000)
}

export function createPublicStatsHandler() {
  return async function GET() {
    try {
      // Fetch workers once and pass to getTotalCapacity to avoid
      // redundant listWorkers() calls that can return different snapshots
      const [allSessions, workers, queueLength] = await Promise.all([
        getAllSessions(),
        listWorkers(),
        getQueueLength(),
      ])

      const capacity = await getTotalCapacity(workers)

      const todayStart = getTodayStart()

      const agentsWorking = allSessions.filter(
        (s) => s.status === 'running' || s.status === 'claimed'
      ).length

      const completedToday = allSessions.filter(
        (s) =>
          s.status === 'completed' &&
          s.updatedAt >= todayStart
      ).length

      const totalCostToday = allSessions
        .filter((s) => s.updatedAt >= todayStart)
        .reduce((sum, s) => sum + (s.totalCostUsd ?? 0), 0)

      const workersOnline = workers.filter((w) => w.status === 'active').length

      const stats: PublicStatsResponse = {
        workersOnline,
        agentsWorking,
        queueDepth: queueLength,
        completedToday,
        availableCapacity: capacity.availableCapacity,
        totalCostToday: Math.round(totalCostToday * 10000) / 10000,
      }

      return NextResponse.json({
        ...stats,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error('Failed to get public stats', { error })

      return NextResponse.json(
        {
          workersOnline: 0,
          agentsWorking: 0,
          queueDepth: 0,
          completedToday: 0,
          availableCapacity: 0,
          totalCostToday: 0,
          error: 'Failed to fetch stats',
          timestamp: new Date().toISOString(),
        },
        { status: 500 }
      )
    }
  }
}
