/**
 * Config endpoint — exposes server configuration to workers.
 *
 * Workers query this during registration to auto-inherit project scope
 * when not explicitly configured via --projects flag.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../middleware/worker-auth.js'
import type { RouteHandler } from '../types.js'

export function createConfigHandler(projects?: string[]): { GET: RouteHandler } {
  return {
    GET: async (request: NextRequest) => {
      const authError = requireWorkerAuth(request)
      if (authError) return authError

      return NextResponse.json({
        projects: projects ?? [],
      })
    },
  }
}
