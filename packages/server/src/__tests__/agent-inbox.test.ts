import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
const mockXadd = vi.fn()
const mockXreadgroup = vi.fn()
const mockXack = vi.fn()
const mockXgroup = vi.fn()
const mockXpending = vi.fn()
const mockRename = vi.fn()
const mockExpire = vi.fn()
const mockExists = vi.fn()
const mockPublish = vi.fn()

vi.mock('../redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  getRedisClient: vi.fn(() => ({
    xadd: mockXadd,
    xreadgroup: mockXreadgroup,
    xack: mockXack,
    xgroup: mockXgroup,
    xpending: mockXpending,
    rename: mockRename,
    expire: mockExpire,
    exists: mockExists,
    publish: mockPublish,
  })),
}))

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}))

import {
  publishUrgent,
  publishNormal,
  readInbox,
  ack,
  archiveInbox,
  ensureConsumerGroup,
} from '../agent-inbox.js'
import { isRedisConfigured } from '../redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'directive' as const,
    sessionId: 'session-1',
    payload: 'do something',
    userId: 'user-1',
    userName: 'Test User',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('agent-inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    // Default: consumer group creation succeeds
    mockXgroup.mockResolvedValue('OK')
    // Default: XADD returns a stream ID
    mockXadd.mockResolvedValue('1234567890-0')
    // Default: Pub/Sub publish succeeds
    mockPublish.mockResolvedValue(0)
  })

  // -----------------------------------------------------------------------
  // ensureConsumerGroup
  // -----------------------------------------------------------------------

  describe('ensureConsumerGroup', () => {
    it('creates consumer groups for both lanes', async () => {
      await ensureConsumerGroup('agent-1')

      expect(mockXgroup).toHaveBeenCalledTimes(2)
      expect(mockXgroup).toHaveBeenCalledWith(
        'CREATE',
        'agent:inbox:agent-1:urgent',
        'inbox-readers',
        '0',
        'MKSTREAM',
      )
      expect(mockXgroup).toHaveBeenCalledWith(
        'CREATE',
        'agent:inbox:agent-1:normal',
        'inbox-readers',
        '0',
        'MKSTREAM',
      )
    })

    it('ignores BUSYGROUP error (group already exists)', async () => {
      mockXgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'))

      await expect(ensureConsumerGroup('agent-2')).resolves.not.toThrow()
    })

    it('throws on non-BUSYGROUP errors', async () => {
      mockXgroup.mockRejectedValue(new Error('Connection refused'))

      await expect(ensureConsumerGroup('agent-3')).rejects.toThrow('Connection refused')
    })

    it('skips when redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      await ensureConsumerGroup('agent-4')

      expect(mockXgroup).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // publishUrgent / publishNormal
  // -----------------------------------------------------------------------

  describe('publishUrgent', () => {
    it('publishes to the urgent stream with MAXLEN trim', async () => {
      const msg = makeMessage({ type: 'stop' })
      const id = await publishUrgent('agent-1', msg)

      expect(id).toBe('1234567890-0')
      expect(mockXadd).toHaveBeenCalledWith(
        'agent:inbox:agent-1:urgent',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'data',
        JSON.stringify(msg),
      )
    })

    it('throws when XADD returns null', async () => {
      mockXadd.mockResolvedValue(null)

      await expect(publishUrgent('agent-1', makeMessage())).rejects.toThrow(
        'XADD returned null',
      )
    })

    it('throws when redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      await expect(publishUrgent('agent-1', makeMessage())).rejects.toThrow(
        'Redis not configured',
      )
    })

    it('sends a Pub/Sub nudge after publishing to the urgent lane', async () => {
      const msg = makeMessage({ type: 'stop' })
      await publishUrgent('agent-1', msg)

      expect(mockPublish).toHaveBeenCalledWith('agent:nudge:agent-1', 'urgent')
    })

    it('does not fail when the Pub/Sub nudge rejects', async () => {
      mockPublish.mockRejectedValue(new Error('no subscribers'))
      const msg = makeMessage({ type: 'directive' })

      await expect(publishUrgent('agent-1', msg)).resolves.toBe('1234567890-0')
    })
  })

  describe('publishNormal', () => {
    it('publishes to the normal stream', async () => {
      const msg = makeMessage({ type: 'hook-result' })
      await publishNormal('agent-1', msg)

      expect(mockXadd).toHaveBeenCalledWith(
        'agent:inbox:agent-1:normal',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'data',
        JSON.stringify(msg),
      )
    })

    it('does NOT send a Pub/Sub nudge for normal lane messages', async () => {
      const msg = makeMessage({ type: 'hook-result' })
      await publishNormal('agent-1', msg)

      expect(mockPublish).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // readInbox (urgent-first)
  // -----------------------------------------------------------------------

  describe('readInbox', () => {
    it('returns urgent messages first when present', async () => {
      const urgentMsg = makeMessage({ type: 'stop', payload: 'halt' })

      // First call (urgent lane) returns messages
      mockXreadgroup.mockResolvedValueOnce([
        [
          'agent:inbox:agent-1:urgent',
          [['1-0', ['data', JSON.stringify(urgentMsg)]]],
        ],
      ])

      const messages = await readInbox('agent-1', 'worker-1')

      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('stop')
      expect(messages[0].lane).toBe('urgent')
      expect(messages[0].id).toBe('1-0')

      // Normal lane should NOT be read
      expect(mockXreadgroup).toHaveBeenCalledTimes(1)
    })

    it('reads normal lane when urgent is empty', async () => {
      const normalMsg = makeMessage({ type: 'hook-result', payload: 'result data' })

      // First call (urgent lane) returns nothing
      mockXreadgroup.mockResolvedValueOnce(null)
      // Second call (normal lane) returns messages
      mockXreadgroup.mockResolvedValueOnce([
        [
          'agent:inbox:agent-1:normal',
          [['2-0', ['data', JSON.stringify(normalMsg)]]],
        ],
      ])

      const messages = await readInbox('agent-1', 'worker-1')

      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('hook-result')
      expect(messages[0].lane).toBe('normal')
      expect(mockXreadgroup).toHaveBeenCalledTimes(2)
    })

    it('returns empty array when both lanes are empty', async () => {
      mockXreadgroup.mockResolvedValue(null)

      const messages = await readInbox('agent-1', 'worker-1')

      expect(messages).toEqual([])
    })

    it('skips malformed messages and acks them', async () => {
      // Message with invalid JSON in data field
      mockXreadgroup.mockResolvedValueOnce([
        [
          'agent:inbox:agent-1:urgent',
          [
            ['1-0', ['data', '{invalid json}']],
            ['2-0', ['data', JSON.stringify(makeMessage({ type: 'stop' }))]],
          ],
        ],
      ])

      const messages = await readInbox('agent-1', 'worker-1')

      // Only the valid message should be returned
      expect(messages).toHaveLength(1)
      expect(messages[0].id).toBe('2-0')

      // Malformed message should be acked (skipped)
      expect(mockXack).toHaveBeenCalledWith(
        'agent:inbox:agent-1:urgent',
        'inbox-readers',
        '1-0',
      )
    })

    it('returns empty array when redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const messages = await readInbox('agent-1', 'worker-1')

      expect(messages).toEqual([])
    })

    it('uses correct consumer name format', async () => {
      mockXreadgroup.mockResolvedValue(null)

      await readInbox('agent-1', 'my-worker')

      expect(mockXreadgroup).toHaveBeenCalledWith(
        'GROUP',
        'inbox-readers',
        'worker:my-worker',
        'COUNT',
        '10',
        'STREAMS',
        'agent:inbox:agent-1:urgent',
        '>',
      )
    })

    it('respects custom count parameter', async () => {
      mockXreadgroup.mockResolvedValue(null)

      await readInbox('agent-1', 'worker-1', 5)

      expect(mockXreadgroup).toHaveBeenCalledWith(
        'GROUP',
        'inbox-readers',
        'worker:worker-1',
        'COUNT',
        '5',
        'STREAMS',
        expect.any(String),
        '>',
      )
    })
  })

  // -----------------------------------------------------------------------
  // ack
  // -----------------------------------------------------------------------

  describe('ack', () => {
    it('acknowledges urgent lane message', async () => {
      await ack('agent-1', 'urgent', '1-0')

      expect(mockXack).toHaveBeenCalledWith(
        'agent:inbox:agent-1:urgent',
        'inbox-readers',
        '1-0',
      )
    })

    it('acknowledges normal lane message', async () => {
      await ack('agent-1', 'normal', '2-0')

      expect(mockXack).toHaveBeenCalledWith(
        'agent:inbox:agent-1:normal',
        'inbox-readers',
        '2-0',
      )
    })

    it('skips when redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      await ack('agent-1', 'urgent', '1-0')

      expect(mockXack).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // archiveInbox
  // -----------------------------------------------------------------------

  describe('archiveInbox', () => {
    it('renames streams to archive namespace with TTL', async () => {
      mockExists.mockResolvedValue(1)
      mockXpending.mockResolvedValue([0, null, null, null])
      mockRename.mockResolvedValue('OK')
      mockExpire.mockResolvedValue(1)

      await archiveInbox('agent-1', 'session-1')

      // Should rename both lanes
      expect(mockRename).toHaveBeenCalledWith(
        'agent:inbox:agent-1:urgent',
        'agent:inbox:archive:agent-1:session-1:urgent',
      )
      expect(mockRename).toHaveBeenCalledWith(
        'agent:inbox:agent-1:normal',
        'agent:inbox:archive:agent-1:session-1:normal',
      )

      // Should set TTL (7 days)
      expect(mockExpire).toHaveBeenCalledWith(
        'agent:inbox:archive:agent-1:session-1:urgent',
        604800,
      )
      expect(mockExpire).toHaveBeenCalledWith(
        'agent:inbox:archive:agent-1:session-1:normal',
        604800,
      )
    })

    it('acks pending messages before archiving', async () => {
      mockExists.mockResolvedValue(1)
      // Simulate pending messages
      mockXpending
        .mockResolvedValueOnce([2, '1-0', '2-0', [['worker:w1', '2']]])
        .mockResolvedValueOnce([
          ['1-0', 'worker:w1', 1000, 1],
          ['2-0', 'worker:w1', 500, 1],
        ])
        // Second lane - no pending
        .mockResolvedValueOnce([0, null, null, null])
      mockRename.mockResolvedValue('OK')
      mockExpire.mockResolvedValue(1)

      await archiveInbox('agent-1', 'session-1')

      // Should ack the pending messages
      expect(mockXack).toHaveBeenCalledWith(
        'agent:inbox:agent-1:urgent',
        'inbox-readers',
        '1-0',
      )
      expect(mockXack).toHaveBeenCalledWith(
        'agent:inbox:agent-1:urgent',
        'inbox-readers',
        '2-0',
      )
    })

    it('skips non-existent streams', async () => {
      mockExists.mockResolvedValue(0)

      await archiveInbox('agent-1', 'session-1')

      expect(mockRename).not.toHaveBeenCalled()
    })

    it('skips when redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      await archiveInbox('agent-1', 'session-1')

      expect(mockExists).not.toHaveBeenCalled()
    })
  })
})
