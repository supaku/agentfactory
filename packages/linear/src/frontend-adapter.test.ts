import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LinearFrontendAdapter } from './frontend-adapter.js'
import type { AbstractStatus } from './frontend-adapter.js'
import type { LinearAgentClient } from './agent-client.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock Linear SDK Issue object.
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
 * Create a mock Linear SDK Comment object.
 */
function mockLinearComment(overrides: {
  id?: string
  body?: string
  userId?: string
  userName?: string
  createdAt?: Date
} = {}) {
  const {
    id = 'comment-uuid-1',
    body = 'Test comment',
    userId = 'user-1',
    userName = 'Test User',
    createdAt = new Date('2025-01-15T12:00:00Z'),
  } = overrides

  return {
    id,
    body,
    createdAt,
    get user() {
      return Promise.resolve({ id: userId, name: userName })
    },
  }
}

/**
 * Create a mock LinearAgentClient with all methods stubbed.
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

  // Store the linearClient mock for direct access
  mocks.linearClientIssues = linearClient.issues
  mocks.linearClientIssueLabels = linearClient.issueLabels

  return { client, mocks }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearFrontendAdapter', () => {
  let adapter: LinearFrontendAdapter
  let mocks: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    const { client, mocks: m } = createMockClient()
    mocks = m
    adapter = new LinearFrontendAdapter(client)
  })

  // ========================================================================
  // name
  // ========================================================================

  it('has name "linear"', () => {
    expect(adapter.name).toBe('linear')
  })

  // ========================================================================
  // Status mapping
  // ========================================================================

  describe('resolveStatus', () => {
    const cases: Array<[AbstractStatus, string]> = [
      ['icebox', 'Icebox'],
      ['backlog', 'Backlog'],
      ['started', 'Started'],
      ['finished', 'Finished'],
      ['delivered', 'Delivered'],
      ['accepted', 'Accepted'],
      ['rejected', 'Rejected'],
      ['canceled', 'Canceled'],
    ]

    it.each(cases)('maps "%s" to "%s"', (abstract, expected) => {
      expect(adapter.resolveStatus(abstract)).toBe(expected)
    })
  })

  describe('abstractStatus', () => {
    const cases: Array<[string, AbstractStatus]> = [
      ['Icebox', 'icebox'],
      ['Backlog', 'backlog'],
      ['Started', 'started'],
      ['Finished', 'finished'],
      ['Delivered', 'delivered'],
      ['Accepted', 'accepted'],
      ['Rejected', 'rejected'],
      ['Canceled', 'canceled'],
    ]

    it.each(cases)('maps "%s" to "%s"', (native, expected) => {
      expect(adapter.abstractStatus(native)).toBe(expected)
    })

    it('defaults unknown statuses to "backlog"', () => {
      expect(adapter.abstractStatus('UnknownStatus')).toBe('backlog')
    })
  })

  describe('status mapping round-trip', () => {
    const allStatuses: AbstractStatus[] = [
      'icebox', 'backlog', 'started', 'finished',
      'delivered', 'accepted', 'rejected', 'canceled',
    ]

    it.each(allStatuses)('round-trips "%s" through resolve -> abstract', (status) => {
      const native = adapter.resolveStatus(status)
      const roundTripped = adapter.abstractStatus(native)
      expect(roundTripped).toBe(status)
    })
  })

  // ========================================================================
  // getIssue
  // ========================================================================

  describe('getIssue', () => {
    it('maps a Linear Issue to AbstractIssue', async () => {
      const linearIssue = mockLinearIssue({
        id: 'uuid-42',
        identifier: 'SUP-42',
        title: 'Implement feature X',
        description: 'Full description here',
        url: 'https://linear.app/team/issue/SUP-42',
        priority: 1,
        stateName: 'Started',
        labels: ['Bug', 'Urgent'],
        parentId: 'parent-uuid',
        projectName: 'Alpha',
      })
      mocks.getIssue.mockResolvedValue(linearIssue)

      const result = await adapter.getIssue('SUP-42')

      expect(mocks.getIssue).toHaveBeenCalledWith('SUP-42')
      expect(result).toEqual({
        id: 'uuid-42',
        identifier: 'SUP-42',
        title: 'Implement feature X',
        description: 'Full description here',
        url: 'https://linear.app/team/issue/SUP-42',
        status: 'started',
        priority: 1,
        labels: ['Bug', 'Urgent'],
        parentId: 'parent-uuid',
        project: 'Alpha',
        createdAt: linearIssue.createdAt,
      })
    })

    it('handles issue with no description, parent, or project', async () => {
      const linearIssue = mockLinearIssue({
        description: null,
        parentId: null,
        projectName: null,
      })
      mocks.getIssue.mockResolvedValue(linearIssue)

      const result = await adapter.getIssue('SUP-100')

      expect(result.description).toBeUndefined()
      expect(result.parentId).toBeUndefined()
      expect(result.project).toBeUndefined()
    })
  })

  // ========================================================================
  // transitionIssue
  // ========================================================================

  describe('transitionIssue', () => {
    it('delegates to updateIssueStatus for standard statuses', async () => {
      mocks.updateIssueStatus.mockResolvedValue(mockLinearIssue())

      await adapter.transitionIssue('issue-1', 'started')

      expect(mocks.updateIssueStatus).toHaveBeenCalledWith('issue-1', 'Started')
    })

    it('handles icebox status via updateIssue (not in LinearWorkflowStatus)', async () => {
      const issue = mockLinearIssue()
      mocks.getIssue.mockResolvedValue(issue)
      mocks.getTeamStatuses.mockResolvedValue({ Icebox: 'state-icebox-id' })
      mocks.updateIssue.mockResolvedValue(issue)

      await adapter.transitionIssue('issue-1', 'icebox')

      expect(mocks.updateIssue).toHaveBeenCalledWith('issue-1', { stateId: 'state-icebox-id' })
    })

    it.each([
      ['backlog', 'Backlog'],
      ['finished', 'Finished'],
      ['delivered', 'Delivered'],
      ['accepted', 'Accepted'],
      ['rejected', 'Rejected'],
      ['canceled', 'Canceled'],
    ] as [AbstractStatus, string][])('transitions "%s" using updateIssueStatus with "%s"', async (abstract, native) => {
      mocks.updateIssueStatus.mockResolvedValue(mockLinearIssue())

      await adapter.transitionIssue('issue-1', abstract)

      expect(mocks.updateIssueStatus).toHaveBeenCalledWith('issue-1', native)
    })
  })

  // ========================================================================
  // createComment
  // ========================================================================

  describe('createComment', () => {
    it('delegates to client.createComment', async () => {
      mocks.createComment.mockResolvedValue(mockLinearComment())

      await adapter.createComment('issue-1', 'Hello from adapter')

      expect(mocks.createComment).toHaveBeenCalledWith('issue-1', 'Hello from adapter')
    })
  })

  // ========================================================================
  // getIssueComments
  // ========================================================================

  describe('getIssueComments', () => {
    it('maps Linear comments to AbstractComment[]', async () => {
      const comments = [
        mockLinearComment({ id: 'c1', body: 'First', userId: 'u1', userName: 'Alice' }),
        mockLinearComment({ id: 'c2', body: 'Second', userId: 'u2', userName: 'Bob' }),
      ]
      mocks.getIssueComments.mockResolvedValue(comments)

      const result = await adapter.getIssueComments('issue-1')

      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ id: 'c1', body: 'First', userId: 'u1', userName: 'Alice' })
      expect(result[1]).toMatchObject({ id: 'c2', body: 'Second', userId: 'u2', userName: 'Bob' })
    })
  })

  // ========================================================================
  // isParentIssue
  // ========================================================================

  describe('isParentIssue', () => {
    it('delegates to client.isParentIssue', async () => {
      mocks.isParentIssue.mockResolvedValue(true)

      const result = await adapter.isParentIssue('issue-1')

      expect(mocks.isParentIssue).toHaveBeenCalledWith('issue-1')
      expect(result).toBe(true)
    })

    it('returns false when issue has no children', async () => {
      mocks.isParentIssue.mockResolvedValue(false)

      const result = await adapter.isParentIssue('issue-1')

      expect(result).toBe(false)
    })
  })

  // ========================================================================
  // getSubIssues
  // ========================================================================

  describe('getSubIssues', () => {
    it('maps sub-issues to AbstractIssue[]', async () => {
      const subIssues = [
        mockLinearIssue({ id: 'sub-1', identifier: 'SUP-101', title: 'Sub 1', stateName: 'Backlog' }),
        mockLinearIssue({ id: 'sub-2', identifier: 'SUP-102', title: 'Sub 2', stateName: 'Started' }),
      ]
      mocks.getSubIssues.mockResolvedValue(subIssues)

      const result = await adapter.getSubIssues('parent-1')

      expect(mocks.getSubIssues).toHaveBeenCalledWith('parent-1')
      expect(result).toHaveLength(2)
      expect(result[0].identifier).toBe('SUP-101')
      expect(result[0].status).toBe('backlog')
      expect(result[1].identifier).toBe('SUP-102')
      expect(result[1].status).toBe('started')
    })
  })

  // ========================================================================
  // createAgentSession
  // ========================================================================

  describe('createAgentSession', () => {
    it('delegates to createAgentSessionOnIssue and returns sessionId', async () => {
      mocks.createAgentSessionOnIssue.mockResolvedValue({
        success: true,
        sessionId: 'session-123',
      })

      const sessionId = await adapter.createAgentSession('issue-1', [
        { label: 'Dashboard', url: 'https://example.com/dash' },
      ])

      expect(mocks.createAgentSessionOnIssue).toHaveBeenCalledWith({
        issueId: 'issue-1',
        externalUrls: [{ label: 'Dashboard', url: 'https://example.com/dash' }],
      })
      expect(sessionId).toBe('session-123')
    })

    it('throws when sessionId is not returned', async () => {
      mocks.createAgentSessionOnIssue.mockResolvedValue({
        success: true,
        sessionId: undefined,
      })

      await expect(adapter.createAgentSession('issue-1')).rejects.toThrow(
        'Failed to create agent session on issue: issue-1'
      )
    })
  })

  // ========================================================================
  // updateAgentSession
  // ========================================================================

  describe('updateAgentSession', () => {
    it('delegates to client.updateAgentSession', async () => {
      mocks.updateAgentSession.mockResolvedValue({ success: true })

      await adapter.updateAgentSession('session-1', {
        externalUrls: [{ label: 'Logs', url: 'https://example.com/logs' }],
        plan: [{ content: 'Step 1', status: 'pending' }],
      })

      expect(mocks.updateAgentSession).toHaveBeenCalledWith({
        sessionId: 'session-1',
        externalUrls: [{ label: 'Logs', url: 'https://example.com/logs' }],
        plan: [{ content: 'Step 1', status: 'pending' }],
      })
    })
  })

  // ========================================================================
  // createActivity
  // ========================================================================

  describe('createActivity', () => {
    it('wraps content as ThoughtActivityContent and delegates', async () => {
      mocks.createAgentActivity.mockResolvedValue({ success: true })

      await adapter.createActivity('session-1', 'thought', 'Analyzing the codebase')

      expect(mocks.createAgentActivity).toHaveBeenCalledWith({
        agentSessionId: 'session-1',
        content: {
          type: 'thought',
          body: 'Analyzing the codebase',
        },
      })
    })
  })

  // ========================================================================
  // createIssue
  // ========================================================================

  describe('createIssue', () => {
    it('creates an issue and maps result to AbstractIssue', async () => {
      const createdIssue = mockLinearIssue({
        id: 'new-uuid',
        identifier: 'SUP-200',
        title: 'New Issue',
        stateName: 'Backlog',
      })
      mocks.getTeamStatuses.mockResolvedValue({ Backlog: 'state-backlog-id' })
      mocks.createIssue.mockResolvedValue(createdIssue)

      const result = await adapter.createIssue({
        title: 'New Issue',
        teamId: 'team-1',
        description: 'Issue description',
        status: 'backlog',
        parentId: 'parent-1',
        priority: 2,
      })

      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: 'New Issue',
        teamId: 'team-1',
        description: 'Issue description',
        stateId: 'state-backlog-id',
        parentId: 'parent-1',
        priority: 2,
        projectId: undefined,
      })
      expect(result.identifier).toBe('SUP-200')
      expect(result.status).toBe('backlog')
    })

    it('creates an issue without status resolution when status not provided', async () => {
      const createdIssue = mockLinearIssue({ id: 'new-uuid', identifier: 'SUP-201' })
      mocks.createIssue.mockResolvedValue(createdIssue)

      await adapter.createIssue({
        title: 'Simple Issue',
        teamId: 'team-1',
      })

      expect(mocks.getTeamStatuses).not.toHaveBeenCalled()
      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: 'Simple Issue',
        teamId: 'team-1',
        description: undefined,
        stateId: undefined,
        parentId: undefined,
        priority: undefined,
        projectId: undefined,
      })
    })
  })

  // ========================================================================
  // listIssuesByStatus
  // ========================================================================

  describe('listIssuesByStatus', () => {
    it('queries LinearClient with project and status filters', async () => {
      const issues = [
        mockLinearIssue({ id: 'i1', identifier: 'SUP-10', stateName: 'Backlog' }),
        mockLinearIssue({ id: 'i2', identifier: 'SUP-11', stateName: 'Backlog' }),
      ]
      mocks.linearClientIssues.mockResolvedValue({ nodes: issues })

      const result = await adapter.listIssuesByStatus('MyProject', 'backlog')

      expect(mocks.linearClientIssues).toHaveBeenCalledWith({
        filter: {
          project: { name: { eq: 'MyProject' } },
          state: { name: { eq: 'Backlog' } },
        },
      })
      expect(result).toHaveLength(2)
      expect(result[0].identifier).toBe('SUP-10')
      expect(result[1].identifier).toBe('SUP-11')
    })
  })

  // ========================================================================
  // getUnblockedIssues
  // ========================================================================

  describe('getUnblockedIssues', () => {
    it('returns only issues without incoming "blocks" relations', async () => {
      const issues = [
        mockLinearIssue({ id: 'i1', identifier: 'SUP-10', stateName: 'Backlog' }),
        mockLinearIssue({ id: 'i2', identifier: 'SUP-11', stateName: 'Backlog' }),
        mockLinearIssue({ id: 'i3', identifier: 'SUP-12', stateName: 'Backlog' }),
      ]
      mocks.linearClientIssues.mockResolvedValue({ nodes: issues })

      // i1 is unblocked, i2 is blocked, i3 is unblocked
      mocks.getIssueRelations
        .mockResolvedValueOnce({ relations: [], inverseRelations: [] })
        .mockResolvedValueOnce({
          relations: [],
          inverseRelations: [{ id: 'rel-1', type: 'blocks', issueId: 'blocker-id', relatedIssueId: 'i2' }],
        })
        .mockResolvedValueOnce({ relations: [], inverseRelations: [] })

      const result = await adapter.getUnblockedIssues('MyProject', 'backlog')

      expect(result).toHaveLength(2)
      expect(result[0].identifier).toBe('SUP-10')
      expect(result[1].identifier).toBe('SUP-12')
    })

    it('returns all issues when none are blocked', async () => {
      const issues = [
        mockLinearIssue({ id: 'i1', identifier: 'SUP-10', stateName: 'Backlog' }),
      ]
      mocks.linearClientIssues.mockResolvedValue({ nodes: issues })
      mocks.getIssueRelations.mockResolvedValue({ relations: [], inverseRelations: [] })

      const result = await adapter.getUnblockedIssues('MyProject', 'backlog')

      expect(result).toHaveLength(1)
      expect(result[0].identifier).toBe('SUP-10')
    })

    it('returns empty array when all issues are blocked', async () => {
      const issues = [
        mockLinearIssue({ id: 'i1', identifier: 'SUP-10', stateName: 'Backlog' }),
      ]
      mocks.linearClientIssues.mockResolvedValue({ nodes: issues })
      mocks.getIssueRelations.mockResolvedValue({
        relations: [],
        inverseRelations: [{ id: 'rel-1', type: 'blocks', issueId: 'blocker-id', relatedIssueId: 'i1' }],
      })

      const result = await adapter.getUnblockedIssues('MyProject', 'backlog')

      expect(result).toHaveLength(0)
    })
  })

  // ========================================================================
  // isChildIssue
  // ========================================================================

  describe('isChildIssue', () => {
    it('delegates to client.isChildIssue', async () => {
      mocks.isChildIssue.mockResolvedValue(true)

      const result = await adapter.isChildIssue('issue-1')

      expect(mocks.isChildIssue).toHaveBeenCalledWith('issue-1')
      expect(result).toBe(true)
    })

    it('returns false when issue has no parent', async () => {
      mocks.isChildIssue.mockResolvedValue(false)

      const result = await adapter.isChildIssue('issue-1')

      expect(result).toBe(false)
    })
  })

  // ========================================================================
  // createBlockerIssue
  // ========================================================================

  describe('createBlockerIssue', () => {
    it('creates a blocker issue in Icebox with blocking relation', async () => {
      const sourceIssue = mockLinearIssue({ id: 'source-1' })
      mocks.getIssue.mockResolvedValue(sourceIssue)
      mocks.getTeamStatuses.mockResolvedValue({ Icebox: 'state-icebox-id', Backlog: 'state-backlog-id' })
      mocks.linearClientIssueLabels.mockResolvedValue({
        nodes: [{ id: 'label-1', name: 'Needs Human' }, { id: 'label-2', name: 'Bug' }],
      })

      const createdIssue = mockLinearIssue({
        id: 'blocker-uuid',
        identifier: 'SUP-300',
        title: 'Human review needed',
        stateName: 'Icebox',
      })
      mocks.createIssue.mockResolvedValue(createdIssue)
      mocks.createIssueRelation.mockResolvedValue({ success: true, relationId: 'rel-1' })

      const result = await adapter.createBlockerIssue('source-1', {
        title: 'Human review needed',
        description: 'This needs human review',
      })

      expect(mocks.createIssue).toHaveBeenCalledWith({
        title: 'Human review needed',
        description: 'This needs human review',
        teamId: 'team-1',
        projectId: undefined,
        stateId: 'state-icebox-id',
        labelIds: ['label-1'],
      })
      expect(mocks.createIssueRelation).toHaveBeenCalledWith({
        issueId: 'blocker-uuid',
        relatedIssueId: 'source-1',
        type: 'blocks',
      })
      expect(result.identifier).toBe('SUP-300')
    })

    it('uses provided teamId instead of looking up from source issue', async () => {
      mocks.getTeamStatuses.mockResolvedValue({ Icebox: 'state-icebox-id' })
      mocks.linearClientIssueLabels.mockResolvedValue({ nodes: [] })

      const createdIssue = mockLinearIssue({ id: 'blocker-uuid', identifier: 'SUP-301' })
      mocks.createIssue.mockResolvedValue(createdIssue)
      mocks.createIssueRelation.mockResolvedValue({ success: true, relationId: 'rel-1' })

      await adapter.createBlockerIssue('source-1', {
        title: 'Blocker',
        teamId: 'explicit-team',
      })

      // Should NOT call getIssue since teamId was provided
      expect(mocks.getIssue).not.toHaveBeenCalled()
      expect(mocks.getTeamStatuses).toHaveBeenCalledWith('explicit-team')
    })

    it('creates issue without label when "Needs Human" label not found', async () => {
      const sourceIssue = mockLinearIssue({ id: 'source-1' })
      mocks.getIssue.mockResolvedValue(sourceIssue)
      mocks.getTeamStatuses.mockResolvedValue({ Icebox: 'state-icebox-id' })
      mocks.linearClientIssueLabels.mockResolvedValue({ nodes: [{ id: 'l1', name: 'Bug' }] })

      const createdIssue = mockLinearIssue({ id: 'blocker-uuid', identifier: 'SUP-302' })
      mocks.createIssue.mockResolvedValue(createdIssue)
      mocks.createIssueRelation.mockResolvedValue({ success: true })

      await adapter.createBlockerIssue('source-1', { title: 'Blocker' })

      // Should not include labelIds since "Needs Human" was not found
      expect(mocks.createIssue).toHaveBeenCalledWith(
        expect.not.objectContaining({ labelIds: expect.anything() })
      )
    })
  })
})
