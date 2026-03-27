/**
 * Issue Tracker Client Interface
 *
 * Platform-agnostic interface for issue tracker operations used by the orchestrator.
 * Concrete implementations (e.g., LinearIssueTrackerClient) are injected at construction time,
 * decoupling core from any specific issue tracker SDK.
 */

import type { ToolCategory } from '../tools/tool-category.js'

/**
 * Platform-agnostic issue representation.
 * All async relations (team, labels, project) are pre-resolved.
 */
export interface IssueTrackerIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  priority: number
  status?: string
  labels: string[]
  teamName?: string
  projectName?: string
  /** Parent issue ID, if this issue is a sub-issue. Used to filter child issues from backlog scans. */
  parentId?: string
}

/**
 * Configuration for creating an issue tracker session.
 */
export interface SessionConfig {
  issueId: string
  sessionId: string
  autoTransition?: boolean
}

/**
 * Platform-agnostic session for streaming agent activities to the issue tracker.
 * Wraps provider-specific session APIs (e.g., Linear AgentSession).
 */
export interface IssueTrackerSession {
  emitThought(content: string, ephemeral?: boolean): Promise<void>
  emitAction(tool: string, input: Record<string, unknown>, ephemeral?: boolean, toolCategory?: ToolCategory): Promise<void>
  emitToolResult(tool: string, output: string, ephemeral?: boolean): Promise<void>
  emitResponse(content: string): Promise<void>
  emitError(error: Error): Promise<void>
  reportEnvironmentIssue(
    title: string,
    description: string,
    options?: unknown
  ): Promise<{ id: string; identifier: string; url: string } | null>
  setPullRequestUrl(url: string): Promise<void>
  addExternalUrl(url: { url: string; label: string }): Promise<void>
  complete(): Promise<void>
}

/**
 * Comment chunk returned by buildCompletionComments.
 */
export interface CommentChunk {
  body: string
  partNumber: number
  totalParts: number
}

/**
 * Platform-agnostic issue tracker client.
 *
 * The orchestrator depends on this interface instead of a concrete Linear client.
 * Implementations are injected via `OrchestratorConfig.issueTrackerClient`.
 */
export interface IssueTrackerClient {
  // ── Issue operations ──────────────────────────────────────────────

  /** Fetch a single issue by ID or human-readable identifier */
  getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue>

  /** Check whether an issue has sub-issues (is a parent) */
  isParentIssue(issueId: string): Promise<boolean>

  /** Check whether an issue is a sub-issue (has a parent) */
  isChildIssue(issueId: string): Promise<boolean>

  /** Create a comment on an issue */
  createComment(issueId: string, body: string): Promise<{ id: string }>

  /** Update the workflow status of an issue */
  updateIssueStatus(issueId: string, status: string): Promise<void>

  /** Remove the assignee from an issue */
  unassignIssue(issueId: string): Promise<void>

  // ── Query operations ──────────────────────────────────────────────

  /**
   * Query issues matching the given filters.
   * Used by the orchestrator to find backlog issues.
   */
  queryIssues(options: {
    project?: string
    status?: string
    maxResults?: number
  }): Promise<IssueTrackerIssue[]>

  /**
   * Get the repository URL associated with a project.
   * Returns null if the project has no repository metadata.
   */
  getProjectRepositoryUrl(projectName: string): Promise<string | null>

  // ── Session operations ────────────────────────────────────────────

  /** Create an activity session for streaming agent progress */
  createSession(config: SessionConfig): IssueTrackerSession

  // ── Utilities ─────────────────────────────────────────────────────

  /**
   * Split a long completion message into multiple comment chunks
   * that fit within the issue tracker's character limits.
   */
  buildCompletionComments(
    resultMessage: string,
    planItems: unknown[],
    sessionId: string | null
  ): CommentChunk[]
}
