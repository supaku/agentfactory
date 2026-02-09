import {
  LinearClient,
  AgentActivitySignal as LinearAgentActivitySignal,
  IssueRelationType as LinearIssueRelationType,
} from '@linear/sdk'
import type { Issue, Comment } from '@linear/sdk'
import type {
  LinearAgentClientConfig,
  LinearWorkflowStatus,
  StatusMapping,
  RetryConfig,
  AgentActivityCreateInput,
  AgentActivityResult,
  AgentSessionUpdateInput,
  AgentSessionUpdateResult,
  AgentSessionCreateOnIssueInput,
  AgentSessionCreateResult,
  IssueRelationCreateInput,
  IssueRelationResult,
  IssueRelationBatchResult,
  IssueRelationInfo,
  IssueRelationsResult,
  IssueRelationType,
  SubIssueGraphNode,
  SubIssueGraph,
  SubIssueStatus,
} from './types'
import { LinearApiError, LinearStatusTransitionError } from './errors'
import { withRetry, DEFAULT_RETRY_CONFIG } from './retry'

/**
 * Core Linear Agent Client
 * Wraps @linear/sdk with retry logic and helper methods
 */
export class LinearAgentClient {
  private readonly client: LinearClient
  private readonly retryConfig: Required<RetryConfig>
  private statusCache: Map<string, StatusMapping> = new Map()

  constructor(config: LinearAgentClientConfig) {
    this.client = new LinearClient({
      apiKey: config.apiKey,
      ...(config.baseUrl && { apiUrl: config.baseUrl }),
    })
    this.retryConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.retry,
    }
  }

  /**
   * Get the underlying LinearClient instance
   */
  get linearClient(): LinearClient {
    return this.client
  }

  /**
   * Execute an operation with retry logic
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      config: this.retryConfig,
      onRetry: ({ attempt, delay }) => {
        console.log(
          `[LinearAgentClient] Retry attempt ${attempt + 1}/${this.retryConfig.maxRetries}, ` +
            `waiting ${delay}ms`
        )
      },
    })
  }

  /**
   * Fetch an issue by ID or identifier (e.g., "SUP-50")
   */
  async getIssue(issueIdOrIdentifier: string): Promise<Issue> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueIdOrIdentifier)
      if (!issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }
      return issue
    })
  }

  /**
   * Update an issue's properties
   */
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
  ): Promise<Issue> {
    return this.withRetry(async () => {
      const payload = await this.client.updateIssue(issueId, data)
      if (!payload.success) {
        throw new LinearApiError(`Failed to update issue: ${issueId}`, 400, payload)
      }
      return this.client.issue(issueId)
    })
  }

  /**
   * Remove the assignee from an issue (unassign)
   * Used when agent completes work to enable clean handoff visibility
   */
  async unassignIssue(issueId: string): Promise<Issue> {
    return this.withRetry(async () => {
      // Linear SDK expects null to clear assignee
      const payload = await this.client.updateIssue(issueId, {
        assigneeId: null,
      })
      if (!payload.success) {
        throw new LinearApiError(`Failed to unassign issue: ${issueId}`, 400, payload)
      }
      return this.client.issue(issueId)
    })
  }

  /**
   * Get workflow states for a team (cached)
   */
  async getTeamStatuses(teamId: string): Promise<StatusMapping> {
    if (this.statusCache.has(teamId)) {
      return this.statusCache.get(teamId)!
    }

    return this.withRetry(async () => {
      const team = await this.client.team(teamId)
      const states = await team.states()

      const mapping: StatusMapping = {}
      for (const state of states.nodes) {
        mapping[state.name] = state.id
      }

      this.statusCache.set(teamId, mapping)
      return mapping
    })
  }

  /**
   * Update issue status by name (e.g., "Started", "Finished")
   */
  async updateIssueStatus(
    issueId: string,
    statusName: LinearWorkflowStatus
  ): Promise<Issue> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueId)
      const team = await issue.team

      if (!team) {
        throw new LinearApiError(`Cannot find team for issue: ${issueId}`, 400)
      }

      const statuses = await this.getTeamStatuses(team.id)
      const stateId = statuses[statusName]

      if (!stateId) {
        const currentState = await issue.state
        throw new LinearStatusTransitionError(
          `Status "${statusName}" not found in team "${team.name}"`,
          issueId,
          currentState?.name ?? 'unknown',
          statusName
        )
      }

      return this.updateIssue(issueId, { stateId })
    })
  }

  /**
   * Create a comment on an issue
   */
  async createComment(issueId: string, body: string): Promise<Comment> {
    return this.withRetry(async () => {
      const payload = await this.client.createComment({
        issueId,
        body,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create comment on issue: ${issueId}`,
          400,
          payload
        )
      }

      const comment = await payload.comment
      if (!comment) {
        throw new LinearApiError(
          `Comment created but not returned for issue: ${issueId}`,
          500
        )
      }

      return comment
    })
  }

  /**
   * Get comments for an issue
   */
  async getIssueComments(issueId: string): Promise<Comment[]> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueId)
      const comments = await issue.comments()
      return comments.nodes
    })
  }

  /**
   * Create a new issue
   */
  async createIssue(input: {
    title: string
    description?: string
    teamId: string
    projectId?: string
    stateId?: string
    labelIds?: string[]
    parentId?: string
    priority?: number
  }): Promise<Issue> {
    return this.withRetry(async () => {
      const payload = await this.client.createIssue(input)

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create issue: ${input.title}`,
          400,
          payload
        )
      }

      const issue = await payload.issue
      if (!issue) {
        throw new LinearApiError(
          `Issue created but not returned: ${input.title}`,
          500
        )
      }

      return issue
    })
  }

  /**
   * Get the authenticated user (the agent)
   */
  async getViewer() {
    return this.withRetry(() => this.client.viewer)
  }

  /**
   * Get a team by ID or key
   */
  async getTeam(teamIdOrKey: string) {
    return this.withRetry(() => this.client.team(teamIdOrKey))
  }

  /**
   * Create an agent activity using the native Linear Agent API
   *
   * @param input - The activity input containing session ID, content, and options
   * @returns Result indicating success and the created activity ID
   */
  async createAgentActivity(
    input: AgentActivityCreateInput
  ): Promise<AgentActivityResult> {
    return this.withRetry(async () => {
      const signalMap: Record<string, LinearAgentActivitySignal> = {
        auth: LinearAgentActivitySignal.Auth,
        continue: LinearAgentActivitySignal.Continue,
        select: LinearAgentActivitySignal.Select,
        stop: LinearAgentActivitySignal.Stop,
      }

      const payload = await this.client.createAgentActivity({
        agentSessionId: input.agentSessionId,
        content: input.content,
        ephemeral: input.ephemeral,
        id: input.id,
        signal: input.signal ? signalMap[input.signal] : undefined,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create agent activity for session: ${input.agentSessionId}`,
          400,
          payload
        )
      }

      const activity = await payload.agentActivity
      return {
        success: true,
        activityId: activity?.id,
      }
    })
  }

  /**
   * Update an agent session
   *
   * Use this to set the externalUrl (linking to agent dashboard/logs)
   * within 10 seconds of receiving a webhook to avoid appearing unresponsive.
   *
   * @param input - The session update input containing sessionId and updates
   * @returns Result indicating success and the session ID
   */
  async updateAgentSession(
    input: AgentSessionUpdateInput
  ): Promise<AgentSessionUpdateResult> {
    return this.withRetry(async () => {
      const payload = await this.client.updateAgentSession(input.sessionId, {
        externalUrls: input.externalUrls,
        externalLink: input.externalLink,
        plan: input.plan,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to update agent session: ${input.sessionId}`,
          400,
          payload
        )
      }

      const session = await payload.agentSession
      return {
        success: true,
        sessionId: session?.id,
      }
    })
  }

  /**
   * Create an agent session on an issue
   *
   * Use this to programmatically create a Linear AgentSession when status transitions
   * occur without explicit agent mention/delegation (e.g., Icebox -> Backlog).
   *
   * This enables the Linear Agent Session UI to show real-time activities even when
   * the agent work is triggered by status changes rather than user mentions.
   *
   * @param input - The session creation input containing issueId and optional external URLs
   * @returns Result indicating success and the created session ID
   */
  async createAgentSessionOnIssue(
    input: AgentSessionCreateOnIssueInput
  ): Promise<AgentSessionCreateResult> {
    return this.withRetry(async () => {
      const payload = await this.client.agentSessionCreateOnIssue({
        issueId: input.issueId,
        externalUrls: input.externalUrls,
        externalLink: input.externalLink,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create agent session on issue: ${input.issueId}`,
          400,
          payload
        )
      }

      const session = await payload.agentSession
      return {
        success: true,
        sessionId: session?.id,
      }
    })
  }

  // ============================================================================
  // ISSUE RELATION METHODS
  // ============================================================================

  /**
   * Create a relation between two issues
   *
   * @param input - The relation input containing issue IDs and relation type
   * @returns Result indicating success and the created relation ID
   *
   * Relation types:
   * - 'related': General association between issues
   * - 'blocks': Source issue blocks the related issue from progressing
   * - 'duplicate': Source issue is a duplicate of the related issue
   */
  async createIssueRelation(
    input: IssueRelationCreateInput
  ): Promise<IssueRelationResult> {
    return this.withRetry(async () => {
      // Map our string type to the SDK's enum
      const typeMap: Record<IssueRelationType, LinearIssueRelationType> = {
        related: LinearIssueRelationType.Related,
        blocks: LinearIssueRelationType.Blocks,
        duplicate: LinearIssueRelationType.Duplicate,
      }

      const payload = await this.client.createIssueRelation({
        issueId: input.issueId,
        relatedIssueId: input.relatedIssueId,
        type: typeMap[input.type],
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create issue relation: ${input.issueId} -> ${input.relatedIssueId}`,
          400,
          payload
        )
      }

      const relation = await payload.issueRelation
      return {
        success: true,
        relationId: relation?.id,
      }
    })
  }

  /**
   * Create multiple relations from a source issue to multiple target issues
   *
   * @param input - Batch input containing source issue, target issues, and relation type
   * @returns Batch result with successful relation IDs and any errors
   */
  async createIssueRelationsBatch(input: {
    sourceIssueId: string
    targetIssueIds: string[]
    type: IssueRelationType
  }): Promise<IssueRelationBatchResult> {
    const relationIds: string[] = []
    const errors: Array<{ targetIssueId: string; error: string }> = []

    for (const targetIssueId of input.targetIssueIds) {
      try {
        const result = await this.createIssueRelation({
          issueId: input.sourceIssueId,
          relatedIssueId: targetIssueId,
          type: input.type,
        })
        if (result.relationId) {
          relationIds.push(result.relationId)
        }
      } catch (error) {
        errors.push({
          targetIssueId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      success: errors.length === 0,
      relationIds,
      errors,
    }
  }

  /**
   * Get all relations for an issue (both outgoing and incoming)
   *
   * @param issueId - The issue ID or identifier (e.g., "SUP-123")
   * @returns Relations result with both directions of relationships
   */
  async getIssueRelations(issueId: string): Promise<IssueRelationsResult> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueId)
      if (!issue) {
        throw new LinearApiError(`Issue not found: ${issueId}`, 404)
      }

      // Get outgoing relations (this issue -> other issues)
      const relationsConnection = await issue.relations()
      const relations: IssueRelationInfo[] = []

      for (const relation of relationsConnection.nodes) {
        const relatedIssue = await relation.relatedIssue
        relations.push({
          id: relation.id,
          type: relation.type,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          relatedIssueId: relatedIssue?.id ?? '',
          relatedIssueIdentifier: relatedIssue?.identifier,
          createdAt: relation.createdAt,
        })
      }

      // Get incoming relations (other issues -> this issue)
      const inverseRelationsConnection = await issue.inverseRelations()
      const inverseRelations: IssueRelationInfo[] = []

      for (const relation of inverseRelationsConnection.nodes) {
        const sourceIssue = await relation.issue
        inverseRelations.push({
          id: relation.id,
          type: relation.type,
          issueId: sourceIssue?.id ?? '',
          issueIdentifier: sourceIssue?.identifier,
          relatedIssueId: issue.id,
          relatedIssueIdentifier: issue.identifier,
          createdAt: relation.createdAt,
        })
      }

      return { relations, inverseRelations }
    })
  }

  /**
   * Delete an issue relation
   *
   * @param relationId - The relation ID to delete
   * @returns Result indicating success
   */
  async deleteIssueRelation(relationId: string): Promise<{ success: boolean }> {
    return this.withRetry(async () => {
      const payload = await this.client.deleteIssueRelation(relationId)

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to delete issue relation: ${relationId}`,
          400,
          payload
        )
      }

      return { success: true }
    })
  }

  // ============================================================================
  // SUB-ISSUE METHODS (for coordination work type)
  // ============================================================================

  /**
   * Fetch all child issues (sub-issues) of a parent issue
   *
   * @param issueIdOrIdentifier - The parent issue ID or identifier (e.g., "SUP-100")
   * @returns Array of child issues
   */
  async getSubIssues(issueIdOrIdentifier: string): Promise<Issue[]> {
    return this.withRetry(async () => {
      const parentIssue = await this.client.issue(issueIdOrIdentifier)
      if (!parentIssue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const children = await parentIssue.children()
      return children.nodes
    })
  }

  /**
   * Check if an issue has a parent (is a child/sub-issue)
   *
   * @param issueIdOrIdentifier - The issue ID or identifier
   * @returns True if the issue has a parent issue
   */
  async isChildIssue(issueIdOrIdentifier: string): Promise<boolean> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueIdOrIdentifier)
      if (!issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const parent = await issue.parent
      return parent != null
    })
  }

  /**
   * Check if an issue has child issues (is a parent issue)
   *
   * @param issueIdOrIdentifier - The issue ID or identifier
   * @returns True if the issue has at least one child issue
   */
  async isParentIssue(issueIdOrIdentifier: string): Promise<boolean> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueIdOrIdentifier)
      if (!issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const children = await issue.children()
      return children.nodes.length > 0
    })
  }

  /**
   * Get lightweight sub-issue statuses (no blocking relations)
   *
   * Returns identifier, title, and status for each sub-issue.
   * Used by QA and acceptance agents to validate sub-issue completion
   * without the overhead of fetching the full dependency graph.
   *
   * @param issueIdOrIdentifier - The parent issue ID or identifier
   * @returns Array of sub-issue statuses
   */
  async getSubIssueStatuses(issueIdOrIdentifier: string): Promise<SubIssueStatus[]> {
    return this.withRetry(async () => {
      const parentIssue = await this.client.issue(issueIdOrIdentifier)
      if (!parentIssue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const children = await parentIssue.children()
      const results: SubIssueStatus[] = []

      for (const child of children.nodes) {
        const state = await child.state
        results.push({
          identifier: child.identifier,
          title: child.title,
          status: state?.name ?? 'Unknown',
        })
      }

      return results
    })
  }

  /**
   * Get sub-issues with their blocking relations for dependency graph building
   *
   * Builds a complete dependency graph of a parent issue's children, including
   * which sub-issues block which other sub-issues. This is used by the coordinator
   * agent to determine execution order.
   *
   * @param issueIdOrIdentifier - The parent issue ID or identifier
   * @returns The sub-issue dependency graph
   */
  async getSubIssueGraph(issueIdOrIdentifier: string): Promise<SubIssueGraph> {
    return this.withRetry(async () => {
      const parentIssue = await this.client.issue(issueIdOrIdentifier)
      if (!parentIssue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const children = await parentIssue.children()
      const subIssueIds = new Set(children.nodes.map((c) => c.id))
      const subIssueIdentifiers = new Map<string, string>()

      // Build identifier map for all sub-issues
      for (const child of children.nodes) {
        subIssueIdentifiers.set(child.id, child.identifier)
      }

      const graphNodes: SubIssueGraphNode[] = []

      for (const child of children.nodes) {
        const state = await child.state
        const labels = await child.labels()

        // Get relations to find blocking dependencies
        const relations = await child.relations()
        const inverseRelations = await child.inverseRelations()

        const blockedBy: string[] = []
        const blocks: string[] = []

        // Check inverse relations - other issues blocking this one
        for (const rel of inverseRelations.nodes) {
          if (rel.type === 'blocks') {
            const sourceIssue = await rel.issue
            if (sourceIssue && subIssueIds.has(sourceIssue.id)) {
              blockedBy.push(sourceIssue.identifier)
            }
          }
        }

        // Check outgoing relations - this issue blocking others
        for (const rel of relations.nodes) {
          if (rel.type === 'blocks') {
            const relatedIssue = await rel.relatedIssue
            if (relatedIssue && subIssueIds.has(relatedIssue.id)) {
              blocks.push(relatedIssue.identifier)
            }
          }
        }

        graphNodes.push({
          issue: {
            id: child.id,
            identifier: child.identifier,
            title: child.title,
            description: child.description ?? undefined,
            status: state?.name,
            priority: child.priority,
            labels: labels.nodes.map((l) => l.name),
            url: child.url,
          },
          blockedBy,
          blocks,
        })
      }

      return {
        parentId: parentIssue.id,
        parentIdentifier: parentIssue.identifier,
        subIssues: graphNodes,
      }
    })
  }
}

/**
 * Create a configured LinearAgentClient instance
 */
export function createLinearAgentClient(
  config: LinearAgentClientConfig
): LinearAgentClient {
  return new LinearAgentClient(config)
}
