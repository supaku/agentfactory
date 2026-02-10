/**
 * GET /api/sessions
 * Returns list of all agent sessions from Redis
 */

import { NextResponse } from 'next/server'
import { getAllSessions, type AgentSessionState, createLogger } from '@supaku/agentfactory-server'

const log = createLogger('api/sessions')

export interface AgentSessionResponse {
  id: string
  linearSessionId: string
  issueId: string
  identifier: string
  claudeSessionId?: string
  status: 'pending' | 'claimed' | 'running' | 'finalizing' | 'completed' | 'failed' | 'stopped'
  createdAt: string
  updatedAt: string
  worktreePath: string
  workerId?: string
  queuedAt?: string
  claimedAt?: string
  agentId?: string
}

function toResponse(session: AgentSessionState): AgentSessionResponse {
  return {
    id: session.linearSessionId,
    linearSessionId: session.linearSessionId,
    issueId: session.issueId,
    identifier: session.issueIdentifier || session.issueId.slice(0, 8),
    claudeSessionId: session.claudeSessionId || undefined,
    status: session.status,
    createdAt: new Date(session.createdAt * 1000).toISOString(),
    updatedAt: new Date(session.updatedAt * 1000).toISOString(),
    worktreePath: session.worktreePath,
    workerId: session.workerId || undefined,
    queuedAt: session.queuedAt
      ? new Date(session.queuedAt).toISOString()
      : undefined,
    claimedAt: session.claimedAt
      ? new Date(session.claimedAt * 1000).toISOString()
      : undefined,
    agentId: session.agentId || undefined,
  }
}

export function createSessionListHandler() {
  return async function GET() {
    try {
      const allSessions = await getAllSessions()
      const sessions: AgentSessionResponse[] = allSessions.map(toResponse)

      return NextResponse.json({
        sessions,
        count: sessions.length,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error('Failed to fetch sessions', { error })

      return NextResponse.json({
        sessions: [],
        count: 0,
        timestamp: new Date().toISOString(),
        error: 'Failed to fetch sessions from Redis',
      })
    }
  }
}
