/**
 * POST /api/workers/register
 *
 * Register a new worker with the coordinator.
 * Returns worker ID and configuration.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth'
import { registerWorker, createLogger } from '@supaku/agentfactory-server'

const log = createLogger('api:workers:register')

export function createWorkerRegisterHandler() {
  return async function POST(request: NextRequest) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    try {
      const body = await request.json()
      const { hostname, capacity, version } = body as { hostname: string; capacity: number; version?: string }

      if (!hostname || typeof hostname !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'hostname is required' },
          { status: 400 }
        )
      }

      if (!capacity || typeof capacity !== 'number' || capacity < 1) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'capacity must be a positive number' },
          { status: 400 }
        )
      }

      const result = await registerWorker(hostname, capacity, version)

      if (!result) {
        return NextResponse.json(
          { error: 'Service Unavailable', message: 'Failed to register worker' },
          { status: 503 }
        )
      }

      log.info('Worker registered via API', {
        workerId: result.workerId,
        hostname,
        capacity,
      })

      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      log.error('Failed to register worker', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to register worker' },
        { status: 500 }
      )
    }
  }
}
