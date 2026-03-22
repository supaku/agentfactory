/**
 * Linear Issue Tracker Adapter
 *
 * Implements the platform-agnostic IssueTrackerClient interface from core
 * by wrapping LinearAgentClient and AgentSession.
 */

import type {
  IssueTrackerClient,
  IssueTrackerIssue,
  IssueTrackerSession,
  SessionConfig,
  CommentChunk,
} from '@renseiai/agentfactory'
import { LinearAgentClient, createLinearAgentClient } from './agent-client.js'
import { AgentSession, createAgentSession } from './agent-session.js'
import { buildCompletionComments } from './utils.js'
import type { WorkTypeStatusMappings } from '@renseiai/agentfactory'
import {
  STATUS_WORK_TYPE_MAP,
  WORK_TYPE_START_STATUS,
  WORK_TYPE_COMPLETE_STATUS,
  WORK_TYPE_FAIL_STATUS,
  TERMINAL_STATUSES,
  WORK_TYPES_REQUIRING_WORKTREE,
} from './types.js'

// Re-export for convenience
export type { WorkTypeStatusMappings }

/**
 * Wraps a Linear AgentSession to implement IssueTrackerSession.
 */
class LinearIssueTrackerSession implements IssueTrackerSession {
  constructor(private readonly session: AgentSession) {}

  async emitThought(content: string, ephemeral?: boolean): Promise<void> {
    await this.session.emitThought(content, ephemeral)
  }

  async emitAction(tool: string, input: Record<string, unknown>, ephemeral?: boolean): Promise<void> {
    await this.session.emitAction(tool, input, ephemeral)
  }

  async emitToolResult(tool: string, output: string, ephemeral?: boolean): Promise<void> {
    await this.session.emitToolResult(tool, output, ephemeral)
  }

  async emitResponse(content: string): Promise<void> {
    await this.session.emitResponse(content)
  }

  async emitError(error: Error): Promise<void> {
    await this.session.emitError(error)
  }

  async reportEnvironmentIssue(
    title: string,
    description: string,
    options?: unknown
  ): Promise<{ id: string; identifier: string; url: string } | null> {
    return this.session.reportEnvironmentIssue(title, description, options as any)
  }

  async setPullRequestUrl(url: string): Promise<void> {
    await this.session.setPullRequestUrl(url)
  }

  async addExternalUrl(url: { url: string; label: string }): Promise<void> {
    await this.session.addExternalUrl(url.label, url.url)
  }

  async complete(): Promise<void> {
    await this.session.complete()
  }
}

/**
 * Implements IssueTrackerClient by wrapping LinearAgentClient.
 * Injected into the orchestrator at construction time.
 */
export class LinearIssueTrackerClient implements IssueTrackerClient {
  readonly linearClient: LinearAgentClient

  constructor(config: { apiKey: string }) {
    this.linearClient = createLinearAgentClient({ apiKey: config.apiKey })
  }

  async getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue> {
    const issue = await this.linearClient.getIssue(idOrIdentifier)
    const state = await issue.state
    const team = await issue.team
    const project = await issue.project
    const labels = await issue.labels()

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      priority: issue.priority,
      status: state?.name,
      labels: labels.nodes.map((l: { name: string }) => l.name),
      teamName: team?.key,
      projectName: project?.name,
    }
  }

  async isParentIssue(issueId: string): Promise<boolean> {
    return this.linearClient.isParentIssue(issueId)
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const comment = await this.linearClient.createComment(issueId, body)
    return { id: comment.id }
  }

  async updateIssueStatus(issueId: string, status: string): Promise<void> {
    await this.linearClient.updateIssueStatus(issueId, status as any)
  }

  async unassignIssue(issueId: string): Promise<void> {
    await this.linearClient.unassignIssue(issueId)
  }

  async queryIssues(options: {
    project?: string
    status?: string
    maxResults?: number
  }): Promise<IssueTrackerIssue[]> {
    const filter: Record<string, unknown> = {}

    if (options.status) {
      filter.state = { name: { eqIgnoreCase: options.status } }
    }

    if (options.project) {
      const projects = await this.linearClient.linearClient.projects({
        filter: { name: { eqIgnoreCase: options.project } },
      })
      if (projects.nodes.length > 0) {
        filter.project = { id: { eq: projects.nodes[0].id } }
      }
    }

    const issues = await this.linearClient.linearClient.issues({
      filter,
      first: options.maxResults ?? 50,
    })

    const results: IssueTrackerIssue[] = []
    for (const issue of issues.nodes) {
      const state = await issue.state
      const team = await issue.team
      const project = await issue.project
      const labels = await issue.labels()

      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
        priority: issue.priority,
        status: state?.name,
        labels: labels.nodes.map((l: { name: string }) => l.name),
        teamName: team?.key,
        projectName: project?.name,
      })
    }

    return results
  }

  async getProjectRepositoryUrl(projectName: string): Promise<string | null> {
    const projects = await this.linearClient.linearClient.projects({
      filter: { name: { eqIgnoreCase: projectName } },
    })
    if (projects.nodes.length === 0) return null

    // Use the LinearAgentClient's method if available
    try {
      return await this.linearClient.getProjectRepositoryUrl(projects.nodes[0].id)
    } catch {
      return null
    }
  }

  createSession(config: SessionConfig): IssueTrackerSession {
    const session = createAgentSession({
      client: this.linearClient.linearClient,
      issueId: config.issueId,
      sessionId: config.sessionId,
      autoTransition: config.autoTransition ?? false,
    })
    return new LinearIssueTrackerSession(session)
  }

  buildCompletionComments(
    resultMessage: string,
    planItems: unknown[],
    sessionId: string | null
  ): CommentChunk[] {
    return buildCompletionComments(
      resultMessage,
      planItems as Array<{ state: string; title: string }>,
      sessionId
    )
  }
}

/**
 * Create the default Linear status mappings.
 * These map between Linear workflow statuses and agent work types.
 */
export function createLinearStatusMappings(): WorkTypeStatusMappings {
  return {
    statusToWorkType: STATUS_WORK_TYPE_MAP,
    workTypeStartStatus: WORK_TYPE_START_STATUS,
    workTypeCompleteStatus: WORK_TYPE_COMPLETE_STATUS,
    workTypeFailStatus: WORK_TYPE_FAIL_STATUS,
    terminalStatuses: TERMINAL_STATUSES,
    workTypesRequiringWorktree: WORK_TYPES_REQUIRING_WORKTREE,
  }
}
