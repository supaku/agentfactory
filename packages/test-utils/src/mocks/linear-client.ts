import { vi } from 'vitest'

export function createMockLinearClient() {
  return {
    getIssue: vi.fn().mockResolvedValue({
      id: 'issue-uuid-1',
      identifier: 'SUP-123',
      title: 'Test Issue',
      description: 'Test description',
      priority: 2,
      state: { id: 'state-1', name: 'In Progress' },
      team: { id: 'team-1', name: 'Engineering' },
      project: { id: 'project-1', name: 'Agent' },
      labels: { nodes: [] },
    }),
    createComment: vi.fn().mockResolvedValue(undefined),
    updateIssueStatus: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ id: 'session-1' }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    getBacklogIssues: vi.fn().mockResolvedValue([]),
    getStatusId: vi.fn().mockResolvedValue('status-id-1'),
  }
}
