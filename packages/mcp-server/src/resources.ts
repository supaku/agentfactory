import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getAllSessions,
  getSessionState,
  getSessionStateByIssue,
  listWorkers,
  getTotalCapacity,
} from '@supaku/agentfactory-server'

/**
 * Registers MCP resources that expose AgentFactory fleet state to MCP-aware clients.
 *
 * Resources:
 *   - fleet://agents        — Current fleet state (agents, statuses, costs)
 *   - fleet://issues/{id}   — Issue details with agent progress
 *   - fleet://logs/{id}     — Agent activity logs / session info
 */
export function registerFleetResources(server: McpServer): void {
  // 1. fleet://agents — Current fleet state
  server.resource(
    'fleet-agents',
    'fleet://agents',
    { description: 'Current fleet state including all agent sessions, workers, and capacity' },
    async (uri) => {
      const [sessions, workers, capacity] = await Promise.all([
        getAllSessions(),
        listWorkers(),
        getTotalCapacity(),
      ])

      const data = { sessions, workers, capacity }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      }
    },
  )

  // 2. fleet://issues/{id} — Issue details with agent progress
  server.resource(
    'fleet-issue',
    new ResourceTemplate('fleet://issues/{id}', { list: undefined }),
    { description: 'Issue details with agent session progress' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id
      const session = await getSessionStateByIssue(id)

      const data = session
        ? session
        : { error: 'not_found', message: `No agent session found for issue: ${id}` }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      }
    },
  )

  // 3. fleet://logs/{id} — Agent activity logs
  server.resource(
    'fleet-logs',
    new ResourceTemplate('fleet://logs/{id}', { list: undefined }),
    { description: 'Agent activity logs and session information' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id

      // Try to find the session by linearSessionId first, then fall back to issue ID
      let session = await getSessionState(id)
      if (!session) {
        session = await getSessionStateByIssue(id)
      }

      if (!session) {
        const data = { error: 'not_found', message: `No agent session found for id: ${id}` }
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(data, null, 2),
              mimeType: 'application/json',
            },
          ],
        }
      }

      const data: Record<string, unknown> = {
        ...session,
        _logHint: session.worktreePath
          ? `Activity logs may be available on disk at: ${session.worktreePath}/.agent/state.json`
          : 'No worktree path available for this session',
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(data, null, 2),
            mimeType: 'application/json',
          },
        ],
      }
    },
  )
}
