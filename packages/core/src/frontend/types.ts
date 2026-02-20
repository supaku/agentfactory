/**
 * Frontend-agnostic types for work scheduling systems.
 *
 * These types define the contract between the orchestrator/governor
 * and any work scheduling frontend (Linear, Asana, etc.).
 * Each frontend provides an adapter implementing WorkSchedulingFrontend.
 */

/**
 * Abstract workflow statuses that map to frontend-specific names.
 * Each frontend adapter maps these to its native equivalents.
 */
export type AbstractStatus =
  | 'icebox'
  | 'backlog'
  | 'started'
  | 'finished'
  | 'delivered'
  | 'accepted'
  | 'rejected'
  | 'canceled'

/**
 * Terminal statuses where no agent work is needed.
 */
export const TERMINAL_ABSTRACT_STATUSES: AbstractStatus[] = ['accepted', 'canceled']

/**
 * Minimal issue representation shared across frontends.
 */
export interface AbstractIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  status: AbstractStatus
  priority: number
  labels: string[]
  parentId?: string
  project?: string
  createdAt: Date
}

/**
 * Minimal comment representation.
 */
export interface AbstractComment {
  id: string
  body: string
  userId?: string
  userName?: string
  createdAt: Date
}

/**
 * External URL for agent sessions.
 */
export interface ExternalUrl {
  label: string
  url: string
}

/**
 * Input for creating an issue.
 */
export interface CreateIssueInput {
  title: string
  teamId?: string
  description?: string
  projectId?: string
  status?: AbstractStatus
  labels?: string[]
  parentId?: string
  priority?: number
}

/**
 * Input for creating a blocker issue.
 */
export interface CreateBlockerInput {
  title: string
  description?: string
  teamId?: string
  projectId?: string
  assignee?: string
}

/**
 * Input for updating an agent session.
 */
export interface UpdateSessionInput {
  externalUrls?: ExternalUrl[]
  plan?: Array<{ content: string; status: 'pending' | 'inProgress' | 'completed' | 'canceled' }>
}

/**
 * The frontend-agnostic interface for work scheduling systems.
 * Each frontend (Linear, Asana, etc.) provides an adapter implementing this interface.
 */
export interface WorkSchedulingFrontend {
  readonly name: string // 'linear' | 'asana' | ...

  // Status mapping
  resolveStatus(abstract: AbstractStatus): string
  abstractStatus(nativeStatus: string): AbstractStatus

  // Read operations
  getIssue(id: string): Promise<AbstractIssue>
  listIssuesByStatus(project: string, status: AbstractStatus): Promise<AbstractIssue[]>
  getUnblockedIssues(project: string, status: AbstractStatus): Promise<AbstractIssue[]>
  getIssueComments(id: string): Promise<AbstractComment[]>
  isParentIssue(id: string): Promise<boolean>
  isChildIssue(id: string): Promise<boolean>
  getSubIssues(id: string): Promise<AbstractIssue[]>

  // Write operations
  transitionIssue(id: string, status: AbstractStatus): Promise<void>
  createComment(id: string, body: string): Promise<void>
  createIssue(data: CreateIssueInput): Promise<AbstractIssue>
  createBlockerIssue(sourceId: string, data: CreateBlockerInput): Promise<AbstractIssue>

  // Agent session operations
  createAgentSession(issueId: string, externalUrls?: ExternalUrl[]): Promise<string>
  updateAgentSession(sessionId: string, data: UpdateSessionInput): Promise<void>
  createActivity(sessionId: string, type: string, content: string): Promise<void>
}
