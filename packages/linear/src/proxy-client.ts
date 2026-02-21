/**
 * Proxy Issue Tracker Client
 *
 * Drop-in replacement for LinearAgentClient that routes all calls
 * through the centralized dashboard proxy endpoint instead of calling
 * the issue tracker API directly.
 *
 * Used when `AGENTFACTORY_API_URL` env var is set.
 *
 * Benefits:
 * - Zero direct API credentials needed on the agent side
 * - Single shared rate limiter and circuit breaker on the proxy
 * - OAuth token resolution stays server-side
 * - Platform-agnostic: agents don't need to know Linear exists
 */

import type {
  AgentActivityCreateInput,
  AgentActivityResult,
  AgentSessionUpdateInput,
  AgentSessionUpdateResult,
  AgentSessionCreateOnIssueInput,
  AgentSessionCreateResult,
  IssueRelationCreateInput,
  IssueRelationResult,
  IssueRelationsResult,
  LinearWorkflowStatus,
  StatusMapping,
  SubIssueGraph,
  SubIssueStatus,
} from './types.js'
import type {
  ProxyRequest,
  ProxyResponse,
  IssueTrackerMethod,
  SerializedIssue,
  SerializedComment,
  SerializedViewer,
  SerializedTeam,
} from './issue-tracker-proxy.js'

export interface ProxyClientConfig {
  /** Base URL of the dashboard (e.g., 'https://my-dashboard.vercel.app') */
  apiUrl: string
  /** Worker API key for authentication */
  apiKey: string
  /** Workspace/organization ID for multi-tenant routing */
  organizationId?: string
  /** Request timeout in ms (default: 30_000) */
  timeoutMs?: number
}

/**
 * Issue tracker client that proxies all calls through the dashboard server.
 *
 * Implements the same public interface as LinearAgentClient but serializes
 * calls as JSON and sends them to POST /api/issue-tracker-proxy.
 *
 * All returned objects are plain JSON (no lazy-loaded SDK relations).
 */
export class ProxyIssueTrackerClient {
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly organizationId?: string
  private readonly timeoutMs: number

  constructor(config: ProxyClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.organizationId = config.organizationId
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  // =========================================================================
  // Issue operations
  // =========================================================================

  async getIssue(issueIdOrIdentifier: string): Promise<SerializedIssue> {
    return this.call('getIssue', [issueIdOrIdentifier])
  }

  async updateIssue(
    issueId: string,
    data: {
      title?: string
      description?: string
      stateId?: string
      assigneeId?: string | null
      priority?: number
      labelIds?: string[]
    }
  ): Promise<SerializedIssue> {
    return this.call('updateIssue', [issueId, data])
  }

  async createIssue(input: {
    title: string
    description?: string
    teamId: string
    projectId?: string
    stateId?: string
    labelIds?: string[]
    parentId?: string
    priority?: number
  }): Promise<SerializedIssue> {
    return this.call('createIssue', [input])
  }

  async unassignIssue(issueId: string): Promise<SerializedIssue> {
    return this.call('unassignIssue', [issueId])
  }

  // =========================================================================
  // Status operations
  // =========================================================================

  async getTeamStatuses(teamId: string): Promise<StatusMapping> {
    return this.call('getTeamStatuses', [teamId])
  }

  async updateIssueStatus(
    issueId: string,
    statusName: LinearWorkflowStatus
  ): Promise<SerializedIssue> {
    return this.call('updateIssueStatus', [issueId, statusName])
  }

  // =========================================================================
  // Comment operations
  // =========================================================================

  async createComment(issueId: string, body: string): Promise<SerializedComment> {
    return this.call('createComment', [issueId, body])
  }

  async getIssueComments(issueId: string): Promise<SerializedComment[]> {
    return this.call('getIssueComments', [issueId])
  }

  // =========================================================================
  // Agent session operations
  // =========================================================================

  async createAgentActivity(input: AgentActivityCreateInput): Promise<AgentActivityResult> {
    return this.call('createAgentActivity', [input])
  }

  async updateAgentSession(input: AgentSessionUpdateInput): Promise<AgentSessionUpdateResult> {
    return this.call('updateAgentSession', [input])
  }

  async createAgentSessionOnIssue(
    input: AgentSessionCreateOnIssueInput
  ): Promise<AgentSessionCreateResult> {
    return this.call('createAgentSessionOnIssue', [input])
  }

  // =========================================================================
  // Relation operations
  // =========================================================================

  async createIssueRelation(input: IssueRelationCreateInput): Promise<IssueRelationResult> {
    return this.call('createIssueRelation', [input])
  }

  async getIssueRelations(issueId: string): Promise<IssueRelationsResult> {
    return this.call('getIssueRelations', [issueId])
  }

  async deleteIssueRelation(relationId: string): Promise<{ success: boolean }> {
    return this.call('deleteIssueRelation', [relationId])
  }

  // =========================================================================
  // Sub-issue operations
  // =========================================================================

  async getSubIssues(issueIdOrIdentifier: string): Promise<SerializedIssue[]> {
    return this.call('getSubIssues', [issueIdOrIdentifier])
  }

  async getSubIssueStatuses(issueIdOrIdentifier: string): Promise<SubIssueStatus[]> {
    return this.call('getSubIssueStatuses', [issueIdOrIdentifier])
  }

  async getSubIssueGraph(issueIdOrIdentifier: string): Promise<SubIssueGraph> {
    return this.call('getSubIssueGraph', [issueIdOrIdentifier])
  }

  async isParentIssue(issueIdOrIdentifier: string): Promise<boolean> {
    return this.call('isParentIssue', [issueIdOrIdentifier])
  }

  async isChildIssue(issueIdOrIdentifier: string): Promise<boolean> {
    return this.call('isChildIssue', [issueIdOrIdentifier])
  }

  // =========================================================================
  // Project operations
  // =========================================================================

  async listProjectIssues(project: string): Promise<
    Array<{
      id: string
      identifier: string
      title: string
      description?: string
      status: string
      labels: string[]
      createdAt: number
      parentId?: string
      project?: string
      childCount: number
    }>
  > {
    return this.call('listProjectIssues', [project])
  }

  async getProjectRepositoryUrl(projectId: string): Promise<string | null> {
    return this.call('getProjectRepositoryUrl', [projectId])
  }

  // =========================================================================
  // Identity operations
  // =========================================================================

  async getViewer(): Promise<SerializedViewer> {
    return this.call('getViewer', [])
  }

  async getTeam(teamIdOrKey: string): Promise<SerializedTeam> {
    return this.call('getTeam', [teamIdOrKey])
  }

  // =========================================================================
  // Core RPC method
  // =========================================================================

  private async call<T>(method: IssueTrackerMethod, args: unknown[]): Promise<T> {
    const body: ProxyRequest = {
      method,
      args,
      organizationId: this.organizationId,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.apiUrl}/api/issue-tracker-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const result = (await response.json()) as ProxyResponse<T>

      if (!result.success) {
        const error = result.error ?? { code: 'UNKNOWN', message: 'Unknown error', retryable: false }
        const err = new Error(`[ProxyClient] ${error.code}: ${error.message}`) as Error & {
          code: string
          retryable: boolean
          status: number
        }
        err.code = error.code
        err.retryable = error.retryable
        err.status = response.status
        throw err
      }

      return result.data as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`[ProxyClient] Request timeout after ${this.timeoutMs}ms for ${method}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

/**
 * Create a proxy client if AGENTFACTORY_API_URL is set, otherwise return null.
 *
 * @param fallbackApiKey - API key to use (default: WORKER_API_KEY env var)
 * @param organizationId - Workspace ID for multi-tenant routing
 */
export function createProxyClientIfConfigured(
  fallbackApiKey?: string,
  organizationId?: string
): ProxyIssueTrackerClient | null {
  const apiUrl = process.env.AGENTFACTORY_API_URL
  if (!apiUrl) return null

  const apiKey = fallbackApiKey ?? process.env.WORKER_API_KEY
  if (!apiKey) {
    console.warn('[ProxyClient] AGENTFACTORY_API_URL set but no WORKER_API_KEY — proxy disabled')
    return null
  }

  return new ProxyIssueTrackerClient({
    apiUrl,
    apiKey,
    organizationId,
  })
}
