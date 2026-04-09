/**
 * Null Issue Tracker Client
 *
 * No-op implementation of IssueTrackerClient for workers that don't have
 * direct Linear API access. Used when LINEAR_API_KEY is not set and all
 * Linear communication is delegated to the platform API.
 *
 * Returns minimal stub data so the orchestrator can function (e.g., create
 * worktrees, spawn agents) without real issue tracker access. Status updates,
 * comments, and session activities are silently dropped — the platform API
 * activity emitter handles these instead.
 */

import type {
  IssueTrackerClient,
  IssueTrackerIssue,
  IssueTrackerSession,
  SessionConfig,
  CommentChunk,
} from './issue-tracker-client.js'

/**
 * No-op session that silently drops all activity emissions.
 * When the worker runs in platform mode, activities are posted via the
 * ApiActivityEmitter instead of through an issue tracker session.
 */
class NullIssueTrackerSession implements IssueTrackerSession {
  async emitThought(): Promise<void> {}
  async emitAction(): Promise<void> {}
  async emitToolResult(): Promise<void> {}
  async emitResponse(): Promise<void> {}
  async emitError(): Promise<void> {}
  async reportEnvironmentIssue(): Promise<null> {
    return null
  }
  async setPullRequestUrl(): Promise<void> {}
  async addExternalUrl(): Promise<void> {}
  async complete(): Promise<void> {}
}

/**
 * No-op IssueTrackerClient for platform-delegated workers.
 *
 * getIssue() returns a minimal stub using the identifier passed in.
 * All mutation methods (comments, status updates) are silent no-ops.
 */
export class NullIssueTrackerClient implements IssueTrackerClient {
  async getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue> {
    return {
      id: idOrIdentifier,
      identifier: idOrIdentifier,
      title: idOrIdentifier,
      url: '',
      priority: 0,
      status: 'In Progress',
      labels: [],
    }
  }

  async isParentIssue(): Promise<boolean> {
    return false
  }

  async isChildIssue(): Promise<boolean> {
    return false
  }

  async createComment(): Promise<{ id: string }> {
    return { id: '' }
  }

  async updateIssueStatus(): Promise<void> {}

  async unassignIssue(): Promise<void> {}

  async queryIssues(): Promise<IssueTrackerIssue[]> {
    return []
  }

  async getProjectRepositoryUrl(): Promise<string | null> {
    return null
  }

  createSession(_config: SessionConfig): IssueTrackerSession {
    return new NullIssueTrackerSession()
  }

  buildCompletionComments(
    resultMessage: string,
    _planItems: unknown[],
    _sessionId: string | null,
  ): CommentChunk[] {
    return [{ body: resultMessage, partNumber: 1, totalParts: 1 }]
  }
}
