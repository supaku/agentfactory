import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LinearPlatformAdapter } from './platform-adapter.js'
import type { LinearAgentClient } from './agent-client.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock Linear SDK Issue object (matching the pattern from frontend-adapter.test.ts).
 */
function mockLinearIssue(overrides: {
  id?: string
  identifier?: string
  title?: string
  description?: string | null
  url?: string
  priority?: number
  createdAt?: Date
  stateName?: string
  labels?: string[]
  parentId?: string | null
  projectName?: string | null
} = {}) {
  const {
    id = 'issue-uuid-1',
    identifier = 'SUP-100',
    title = 'Test Issue',
    description = 'A test issue description',
    url = 'https://linear.app/team/issue/SUP-100',
    priority = 2,
    createdAt = new Date('2025-01-15T10:00:00Z'),
    stateName = 'Backlog',
    labels = ['Feature'],
    parentId = null,
    projectName = 'MyProject',
  } = overrides

  return {
    id,
    identifier,
    title,
    description,
    url,
    priority,
    createdAt,
    get state() {
      return Promise.resolve(stateName ? { name: stateName } : null)
    },
    labels: () => Promise.resolve({ nodes: labels.map((name) => ({ name })) }),
    get parent() {
      return Promise.resolve(parentId ? { id: parentId } : null)
    },
    get project() {
      return Promise.resolve(projectName ? { name: projectName } : null)
    },
    get team() {
      return Promise.resolve({ id: 'team-1', name: 'Engineering' })
    },
  }
}

/**
 * Create a mock LinearAgentClient for the platform adapter.
 */
function createMockClient(): {
  client: LinearAgentClient
  mocks: Record<string, ReturnType<typeof vi.fn>>
} {
  const mocks: Record<string, ReturnType<typeof vi.fn>> = {
    getIssue: vi.fn(),
    updateIssue: vi.fn(),
    getTeamStatuses: vi.fn(),
    updateIssueStatus: vi.fn(),
    createComment: vi.fn(),
    getIssueComments: vi.fn(),
    createIssue: vi.fn(),
    isParentIssue: vi.fn(),
    isChildIssue: vi.fn(),
    getSubIssues: vi.fn(),
    getIssueRelations: vi.fn(),
    createIssueRelation: vi.fn(),
    createAgentSessionOnIssue: vi.fn(),
    updateAgentSession: vi.fn(),
    createAgentActivity: vi.fn(),
  }

  const linearClient = {
    issues: vi.fn(),
    issueLabels: vi.fn(),
  }

  const client = {
    ...mocks,
    linearClient,
  } as unknown as LinearAgentClient

  mocks.linearClientIssues = linearClient.issues

  return { client, mocks }
}

// ---------------------------------------------------------------------------
// Webhook payload factories
// ---------------------------------------------------------------------------

function makeIssueUpdatePayload(overrides: {
  stateName?: string
  hasStateChange?: boolean
  action?: string
  id?: string
  identifier?: string
  title?: string
  description?: string
  labels?: Array<{ name: string }>
  parentId?: string
  projectName?: string
  createdAt?: string
} = {}) {
  const {
    stateName = 'Started',
    hasStateChange = true,
    action = 'update',
    id = 'issue-uuid-1',
    identifier = 'SUP-100',
    title = 'Test Issue',
    description = 'Issue description',
    labels = [{ name: 'Feature' }],
    parentId,
    projectName = 'MyProject',
    createdAt = '2025-01-15T10:00:00.000Z',
  } = overrides

  return {
    action,
    type: 'Issue' as const,
    data: {
      id,
      identifier,
      title,
      description,
      url: `https://linear.app/team/issue/${identifier}`,
      state: { id: 'state-1', name: stateName, type: 'started' },
      labels: labels.map((l) => ({ id: `label-${l.name}`, ...l })),
      parent: parentId ? { id: parentId, identifier: 'SUP-99', title: 'Parent' } : undefined,
      project: projectName ? { id: 'proj-1', name: projectName } : undefined,
      createdAt,
    },
    updatedFrom: hasStateChange ? { stateId: 'old-state-id' } : {},
    createdAt: '2025-01-15T12:00:00.000Z',
  }
}

function makeCommentPayload(overrides: {
  action?: string
  commentId?: string
  body?: string
  issueId?: string
  issueIdentifier?: string
  issueTitle?: string
  issueStateName?: string
  userId?: string
  userName?: string
} = {}) {
  const {
    action = 'create',
    commentId = 'comment-uuid-1',
    body = 'This is a comment',
    issueId = 'issue-uuid-1',
    issueIdentifier = 'SUP-100',
    issueTitle = 'Test Issue',
    issueStateName = 'Started',
    userId = 'user-1',
    userName = 'Test User',
  } = overrides

  return {
    action,
    type: 'Comment' as const,
    data: {
      id: commentId,
      body,
      issue: {
        id: issueId,
        identifier: issueIdentifier,
        title: issueTitle,
        url: `https://linear.app/team/issue/${issueIdentifier}`,
        state: { id: 'state-1', name: issueStateName, type: 'started' },
        labels: [{ id: 'label-1', name: 'Feature' }],
        createdAt: '2025-01-15T10:00:00.000Z',
      },
      user: { id: userId, name: userName },
    },
    createdAt: '2025-01-15T12:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearPlatformAdapter', () => {
  let adapter: LinearPlatformAdapter
  let mocks: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    const { client, mocks: m } = createMockClient()
    mocks = m
    adapter = new LinearPlatformAdapter(client)
  })

  // ========================================================================
  // name
  // ========================================================================

  it('has name "linear"', () => {
    expect(adapter.name).toBe('linear')
  })

  // ========================================================================
  // normalizeWebhookEvent — Issue updates
  // ========================================================================

  describe('normalizeWebhookEvent — issue updates', () => {
    it('returns IssueStatusChangedEvent for issue update with state change', () => {
      const payload = makeIssueUpdatePayload({ stateName: 'Started' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      expect(events).toHaveLength(1)

      const event = events![0]
      expect(event.type).toBe('issue-status-changed')
      expect(event.issueId).toBe('issue-uuid-1')
      expect(event.source).toBe('webhook')

      if (event.type === 'issue-status-changed') {
        expect(event.newStatus).toBe('Started')
        expect(event.issue.id).toBe('issue-uuid-1')
        expect(event.issue.identifier).toBe('SUP-100')
        expect(event.issue.title).toBe('Test Issue')
        expect(event.issue.status).toBe('Started')
        expect(event.issue.labels).toEqual(['Feature'])
        expect(event.issue.project).toBe('MyProject')
        expect(event.timestamp).toBeTruthy()
      }
    })

    it('returns null for issue update without state change', () => {
      const payload = makeIssueUpdatePayload({ hasStateChange: false })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).toBeNull()
    })

    it('returns null for issue create action', () => {
      const payload = makeIssueUpdatePayload({ action: 'create' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).toBeNull()
    })

    it('returns null for issue remove action', () => {
      const payload = makeIssueUpdatePayload({ action: 'remove' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).toBeNull()
    })

    it('includes parentId when issue has a parent', () => {
      const payload = makeIssueUpdatePayload({ parentId: 'parent-uuid-1' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      const event = events![0]
      if (event.type === 'issue-status-changed') {
        expect(event.issue.parentId).toBe('parent-uuid-1')
      }
    })

    it('handles issue with no description', () => {
      const payload = makeIssueUpdatePayload()
      // Remove description from data
      delete (payload.data as Record<string, unknown>).description
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      const event = events![0]
      if (event.type === 'issue-status-changed') {
        expect(event.issue.description).toBeUndefined()
      }
    })

    it('handles issue with no labels', () => {
      const payload = makeIssueUpdatePayload({ labels: [] })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      const event = events![0]
      if (event.type === 'issue-status-changed') {
        expect(event.issue.labels).toEqual([])
      }
    })

    it('parses createdAt from webhook data into milliseconds', () => {
      const payload = makeIssueUpdatePayload({ createdAt: '2025-06-01T00:00:00.000Z' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      const event = events![0]
      if (event.type === 'issue-status-changed') {
        expect(event.issue.createdAt).toBe(new Date('2025-06-01T00:00:00.000Z').getTime())
      }
    })
  })

  // ========================================================================
  // normalizeWebhookEvent — Comments
  // ========================================================================

  describe('normalizeWebhookEvent — comments', () => {
    it('returns CommentAddedEvent for comment creation', () => {
      const payload = makeCommentPayload()
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      expect(events).toHaveLength(1)

      const event = events![0]
      expect(event.type).toBe('comment-added')
      expect(event.issueId).toBe('issue-uuid-1')
      expect(event.source).toBe('webhook')

      if (event.type === 'comment-added') {
        expect(event.commentId).toBe('comment-uuid-1')
        expect(event.commentBody).toBe('This is a comment')
        expect(event.userId).toBe('user-1')
        expect(event.userName).toBe('Test User')
        expect(event.issue.identifier).toBe('SUP-100')
        expect(event.issue.status).toBe('Started')
      }
    })

    it('returns null for comment update action', () => {
      const payload = makeCommentPayload({ action: 'update' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).toBeNull()
    })

    it('returns null for comment remove action', () => {
      const payload = makeCommentPayload({ action: 'remove' })
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).toBeNull()
    })

    it('handles comment without user', () => {
      const payload = makeCommentPayload()
      delete (payload.data as Record<string, unknown>).user
      const events = adapter.normalizeWebhookEvent(payload)

      expect(events).not.toBeNull()
      const event = events![0]
      if (event.type === 'comment-added') {
        expect(event.userId).toBeUndefined()
        expect(event.userName).toBeUndefined()
      }
    })
  })

  // ========================================================================
  // normalizeWebhookEvent — Unrecognized payloads
  // ========================================================================

  describe('normalizeWebhookEvent — unrecognized payloads', () => {
    it('returns null for null payload', () => {
      expect(adapter.normalizeWebhookEvent(null)).toBeNull()
    })

    it('returns null for undefined payload', () => {
      expect(adapter.normalizeWebhookEvent(undefined)).toBeNull()
    })

    it('returns null for non-object payload', () => {
      expect(adapter.normalizeWebhookEvent('string')).toBeNull()
      expect(adapter.normalizeWebhookEvent(42)).toBeNull()
    })

    it('returns null for AgentSessionEvent payloads', () => {
      const payload = {
        action: 'created',
        type: 'AgentSessionEvent',
        data: { id: 'session-1' },
      }
      expect(adapter.normalizeWebhookEvent(payload)).toBeNull()
    })

    it('returns null for unknown resource types', () => {
      const payload = {
        action: 'update',
        type: 'Project',
        data: { id: 'proj-1' },
      }
      expect(adapter.normalizeWebhookEvent(payload)).toBeNull()
    })

    it('returns null for payload without data', () => {
      const payload = {
        action: 'update',
        type: 'Issue',
      }
      expect(adapter.normalizeWebhookEvent(payload)).toBeNull()
    })
  })

  // ========================================================================
  // scanProjectIssues
  // ========================================================================

  describe('scanProjectIssues', () => {
    it('returns GovernorIssues for all non-terminal issues', async () => {
      const issues = [
        mockLinearIssue({ id: 'i-1', identifier: 'SUP-1', stateName: 'Backlog' }),
        mockLinearIssue({ id: 'i-2', identifier: 'SUP-2', stateName: 'Started' }),
        mockLinearIssue({ id: 'i-3', identifier: 'SUP-3', stateName: 'Finished' }),
      ]

      mocks.linearClientIssues.mockResolvedValue({ nodes: issues })

      const result = await adapter.scanProjectIssues('MyProject')

      expect(result).toHaveLength(3)
      expect(result[0].id).toBe('i-1')
      expect(result[0].identifier).toBe('SUP-1')
      expect(result[0].status).toBe('Backlog')
      expect(result[1].id).toBe('i-2')
      expect(result[1].status).toBe('Started')
      expect(result[2].id).toBe('i-3')
      expect(result[2].status).toBe('Finished')
    })

    it('passes correct filter to Linear API', async () => {
      mocks.linearClientIssues.mockResolvedValue({ nodes: [] })

      await adapter.scanProjectIssues('TestProject')

      expect(mocks.linearClientIssues).toHaveBeenCalledWith({
        filter: {
          project: { name: { eq: 'TestProject' } },
          state: { name: { nin: ['Accepted', 'Canceled', 'Duplicate'] } },
        },
      })
    })

    it('returns empty array when no issues found', async () => {
      mocks.linearClientIssues.mockResolvedValue({ nodes: [] })

      const result = await adapter.scanProjectIssues('EmptyProject')

      expect(result).toEqual([])
    })

    it('resolves lazy-loaded issue properties', async () => {
      const issue = mockLinearIssue({
        labels: ['Bug', 'Urgent'],
        parentId: 'parent-1',
        projectName: 'MyProject',
      })
      mocks.linearClientIssues.mockResolvedValue({ nodes: [issue] })

      const result = await adapter.scanProjectIssues('MyProject')

      expect(result[0].labels).toEqual(['Bug', 'Urgent'])
      expect(result[0].parentId).toBe('parent-1')
      expect(result[0].project).toBe('MyProject')
    })

    it('converts createdAt Date to epoch milliseconds', async () => {
      const issue = mockLinearIssue({
        createdAt: new Date('2025-03-01T08:00:00Z'),
      })
      mocks.linearClientIssues.mockResolvedValue({ nodes: [issue] })

      const result = await adapter.scanProjectIssues('MyProject')

      expect(result[0].createdAt).toBe(new Date('2025-03-01T08:00:00Z').getTime())
    })
  })

  // ========================================================================
  // toGovernorIssue
  // ========================================================================

  describe('toGovernorIssue', () => {
    it('converts a Linear SDK Issue to GovernorIssue', async () => {
      const issue = mockLinearIssue({
        id: 'conv-1',
        identifier: 'SUP-50',
        title: 'Convert me',
        description: 'Some description',
        stateName: 'Delivered',
        labels: ['Feature', 'Frontend'],
        parentId: 'parent-2',
        projectName: 'ConvertProject',
        createdAt: new Date('2025-02-20T00:00:00Z'),
      })

      const result = await adapter.toGovernorIssue(issue)

      expect(result).toEqual({
        id: 'conv-1',
        identifier: 'SUP-50',
        title: 'Convert me',
        description: 'Some description',
        status: 'Delivered',
        labels: ['Feature', 'Frontend'],
        parentId: 'parent-2',
        project: 'ConvertProject',
        createdAt: new Date('2025-02-20T00:00:00Z').getTime(),
      })
    })

    it('handles issue with no parent', async () => {
      const issue = mockLinearIssue({ parentId: null })
      const result = await adapter.toGovernorIssue(issue)

      expect(result.parentId).toBeUndefined()
    })

    it('handles issue with no project', async () => {
      const issue = mockLinearIssue({ projectName: null })
      const result = await adapter.toGovernorIssue(issue)

      expect(result.project).toBeUndefined()
    })

    it('handles issue with no state (defaults to Backlog)', async () => {
      const issue = mockLinearIssue({ stateName: '' })
      // Simulate null state
      Object.defineProperty(issue, 'state', {
        get: () => Promise.resolve(null),
      })
      const result = await adapter.toGovernorIssue(issue)

      expect(result.status).toBe('Backlog')
    })

    it('handles issue with null description', async () => {
      const issue = mockLinearIssue({ description: null })
      const result = await adapter.toGovernorIssue(issue)

      expect(result.description).toBeUndefined()
    })

    it('throws for invalid native object', async () => {
      await expect(adapter.toGovernorIssue(null)).rejects.toThrow(
        'expected a Linear SDK Issue object'
      )
    })

    it('throws for object without id', async () => {
      await expect(adapter.toGovernorIssue({ title: 'no id' })).rejects.toThrow(
        'expected a Linear SDK Issue object'
      )
    })
  })

  // ========================================================================
  // isParentIssue (inherited from LinearFrontendAdapter)
  // ========================================================================

  describe('isParentIssue', () => {
    it('delegates to client.isParentIssue', async () => {
      mocks.isParentIssue.mockResolvedValue(true)
      const result = await adapter.isParentIssue('issue-1')

      expect(result).toBe(true)
      expect(mocks.isParentIssue).toHaveBeenCalledWith('issue-1')
    })

    it('returns false for non-parent issues', async () => {
      mocks.isParentIssue.mockResolvedValue(false)
      const result = await adapter.isParentIssue('leaf-issue')

      expect(result).toBe(false)
    })
  })

  // ========================================================================
  // Inherited methods still work
  // ========================================================================

  describe('inherits LinearFrontendAdapter', () => {
    it('resolveStatus works', () => {
      expect(adapter.resolveStatus('backlog')).toBe('Backlog')
      expect(adapter.resolveStatus('started')).toBe('Started')
    })

    it('abstractStatus works', () => {
      expect(adapter.abstractStatus('Backlog')).toBe('backlog')
      expect(adapter.abstractStatus('Finished')).toBe('finished')
    })
  })
})
