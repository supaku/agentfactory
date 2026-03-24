import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
const mockPublish = vi.fn().mockResolvedValue(1)

vi.mock('./redis.js', () => ({
  redisSet: vi.fn(),
  redisGet: vi.fn(() => null),
  redisDel: vi.fn(() => 0),
  redisSAdd: vi.fn(),
  redisSRem: vi.fn(),
  redisSMembers: vi.fn(() => []),
  getRedisClient: vi.fn(() => ({ publish: mockPublish })),
}))

import {
  workflowStoreSave,
  workflowStoreGet,
  workflowStoreList,
  workflowStoreDelete,
  WORKFLOW_UPDATED_CHANNEL,
} from './workflow-store.js'
import { redisSet, redisGet, redisDel, redisSAdd, redisSRem, redisSMembers } from './redis.js'

const mockRedisSet = vi.mocked(redisSet)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisSAdd = vi.mocked(redisSAdd)
const mockRedisSRem = vi.mocked(redisSRem)
const mockRedisSMembers = vi.mocked(redisSMembers)

function makeDefinition(name = 'test-workflow') {
  return {
    apiVersion: 'v1.1',
    kind: 'WorkflowDefinition',
    metadata: { name },
    phases: [{ name: 'dev', template: 'development' }],
    transitions: [{ from: 'Backlog', to: 'dev' }],
  }
}

describe('workflow-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedisGet.mockResolvedValue(null)
    mockRedisDel.mockResolvedValue(0)
    mockRedisSMembers.mockResolvedValue([])
  })

  describe('workflowStoreSave', () => {
    it('stores a new workflow with version 1', async () => {
      const def = makeDefinition()
      const result = await workflowStoreSave('test-workflow', def)

      expect(result.id).toBe('test-workflow')
      expect(result.name).toBe('test-workflow')
      expect(result.version).toBe(1)
      expect(result.createdAt).toBeTruthy()
      expect(result.updatedAt).toBeTruthy()

      expect(mockRedisSet).toHaveBeenCalledWith(
        'af:workflows:test-workflow',
        expect.objectContaining({
          definition: def,
          version: 1,
        }),
      )
      expect(mockRedisSAdd).toHaveBeenCalledWith('af:workflows:index', 'test-workflow')
    })

    it('increments version on update', async () => {
      mockRedisGet.mockResolvedValue({
        definition: makeDefinition(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 3,
      })

      const result = await workflowStoreSave('test-workflow', makeDefinition())

      expect(result.version).toBe(4)
      expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z') // preserves original
    })

    it('publishes change notification', async () => {
      await workflowStoreSave('test-workflow', makeDefinition())

      expect(mockPublish).toHaveBeenCalledWith(
        WORKFLOW_UPDATED_CHANNEL,
        expect.stringContaining('"action":"save"'),
      )
    })

    it('does not fail if publish throws', async () => {
      mockPublish.mockRejectedValueOnce(new Error('pub/sub down'))

      const result = await workflowStoreSave('test-workflow', makeDefinition())
      expect(result.version).toBe(1) // save still succeeds
    })
  })

  describe('workflowStoreGet', () => {
    it('returns null for non-existent workflow', async () => {
      const result = await workflowStoreGet('nope')
      expect(result).toBeNull()
    })

    it('returns stored workflow', async () => {
      const stored = {
        definition: makeDefinition(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        version: 2,
      }
      mockRedisGet.mockResolvedValue(stored)

      const result = await workflowStoreGet('test-workflow')
      expect(result).toEqual(stored)
    })
  })

  describe('workflowStoreList', () => {
    it('returns empty array when no workflows', async () => {
      const result = await workflowStoreList()
      expect(result).toEqual([])
    })

    it('lists all stored workflows', async () => {
      mockRedisSMembers.mockResolvedValue(['wf-1', 'wf-2'])
      mockRedisGet
        .mockResolvedValueOnce({
          definition: makeDefinition('workflow-one'),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          version: 1,
        })
        .mockResolvedValueOnce({
          definition: makeDefinition('workflow-two'),
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          version: 3,
        })

      const result = await workflowStoreList()
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('wf-1')
      expect(result[0].name).toBe('workflow-one')
      expect(result[1].id).toBe('wf-2')
      expect(result[1].version).toBe(3)
    })

    it('cleans up stale index entries', async () => {
      mockRedisSMembers.mockResolvedValue(['exists', 'stale'])
      mockRedisGet
        .mockResolvedValueOnce({
          definition: makeDefinition('exists'),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          version: 1,
        })
        .mockResolvedValueOnce(null) // stale entry

      const result = await workflowStoreList()
      expect(result).toHaveLength(1)
      expect(mockRedisSRem).toHaveBeenCalledWith('af:workflows:index', 'stale')
    })
  })

  describe('workflowStoreDelete', () => {
    it('returns false when workflow does not exist', async () => {
      mockRedisDel.mockResolvedValue(0)
      const result = await workflowStoreDelete('nope')
      expect(result).toBe(false)
    })

    it('deletes workflow and removes from index', async () => {
      mockRedisDel.mockResolvedValue(1)

      const result = await workflowStoreDelete('test-workflow')
      expect(result).toBe(true)
      expect(mockRedisDel).toHaveBeenCalledWith('af:workflows:test-workflow')
      expect(mockRedisSRem).toHaveBeenCalledWith('af:workflows:index', 'test-workflow')
    })

    it('publishes delete notification', async () => {
      mockRedisDel.mockResolvedValue(1)

      await workflowStoreDelete('test-workflow')
      expect(mockPublish).toHaveBeenCalledWith(
        WORKFLOW_UPDATED_CHANNEL,
        expect.stringContaining('"action":"delete"'),
      )
    })
  })

  describe('WORKFLOW_UPDATED_CHANNEL', () => {
    it('has expected channel name', () => {
      expect(WORKFLOW_UPDATED_CHANNEL).toBe('af:workflows:updated')
    })
  })
})
