import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSetNX: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisExpire: vi.fn(),
  redisSAdd: vi.fn(),
  redisSRem: vi.fn(),
  redisSMembers: vi.fn(() => []),
}))

import {
  reserveFiles,
  checkFileConflicts,
  releaseFiles,
  releaseAllSessionFiles,
  refreshFileReservationsTTL,
  getSessionFiles,
  getFileReservation,
} from './file-reservation.js'
import type { FileReservation } from './file-reservation.js'
import {
  isRedisConfigured,
  redisSetNX,
  redisGet,
  redisDel,
  redisExpire,
  redisSAdd,
  redisSRem,
  redisSMembers,
} from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSetNX = vi.mocked(redisSetNX)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisExpire = vi.mocked(redisExpire)
const mockRedisSAdd = vi.mocked(redisSAdd)
const mockRedisSRem = vi.mocked(redisSRem)
const mockRedisSMembers = vi.mocked(redisSMembers)

function makeReservation(overrides: Partial<FileReservation> = {}): FileReservation {
  return {
    sessionId: 'session-1',
    repoId: 'repo-1',
    filePath: 'src/index.ts',
    reservedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// reserveFiles
// ---------------------------------------------------------------------------

describe('reserveFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns all files as reserved when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await reserveFiles('repo-1', 'session-1', ['src/a.ts', 'src/b.ts'])
    expect(result.reserved).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.conflicts).toEqual([])
    expect(mockRedisSetNX).not.toHaveBeenCalled()
  })

  it('reserves files successfully', async () => {
    mockRedisSetNX.mockResolvedValue(true)
    mockRedisSAdd.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(true)

    const result = await reserveFiles('repo-1', 'session-1', ['src/a.ts', 'src/b.ts'])

    expect(result.reserved).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.conflicts).toEqual([])
    expect(mockRedisSetNX).toHaveBeenCalledTimes(2)
    expect(mockRedisSAdd).toHaveBeenCalledTimes(2)
    // Verify correct Redis key pattern
    expect(mockRedisSetNX).toHaveBeenCalledWith(
      'file:reservation:repo-1:src/a.ts',
      expect.any(String),
      3600,
    )
  })

  it('reports conflicts when files are held by other sessions', async () => {
    const otherReservation = makeReservation({ sessionId: 'session-2', filePath: 'src/a.ts' })

    mockRedisSetNX.mockResolvedValueOnce(false) // src/a.ts — conflict
    mockRedisGet.mockResolvedValueOnce(otherReservation) // read existing
    mockRedisSetNX.mockResolvedValueOnce(true) // src/b.ts — success

    const result = await reserveFiles('repo-1', 'session-1', ['src/a.ts', 'src/b.ts'])

    expect(result.reserved).toEqual(['src/b.ts'])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].filePath).toBe('src/a.ts')
    expect(result.conflicts[0].heldBy.sessionId).toBe('session-2')
  })

  it('treats own-session re-reservation as success (idempotent)', async () => {
    const ownReservation = makeReservation({ sessionId: 'session-1', filePath: 'src/a.ts' })

    mockRedisSetNX.mockResolvedValue(false)
    mockRedisGet.mockResolvedValue(ownReservation)

    const result = await reserveFiles('repo-1', 'session-1', ['src/a.ts'])

    expect(result.reserved).toEqual(['src/a.ts'])
    expect(result.conflicts).toEqual([])
  })

  it('reports all files conflicted when all held by others', async () => {
    const otherReservation = makeReservation({ sessionId: 'session-other' })

    mockRedisSetNX.mockResolvedValue(false)
    mockRedisGet.mockResolvedValue(otherReservation)

    const result = await reserveFiles('repo-1', 'session-1', ['src/a.ts', 'src/b.ts'])

    expect(result.reserved).toEqual([])
    expect(result.conflicts).toHaveLength(2)
  })

  it('normalizes backslash paths', async () => {
    mockRedisSetNX.mockResolvedValue(true)
    mockRedisSAdd.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(true)

    const result = await reserveFiles('repo-1', 'session-1', ['src\\utils\\helper.ts'])

    expect(result.reserved).toEqual(['src/utils/helper.ts'])
    expect(mockRedisSetNX).toHaveBeenCalledWith(
      'file:reservation:repo-1:src/utils/helper.ts',
      expect.any(String),
      3600,
    )
  })

  it('strips leading ./ from paths', async () => {
    mockRedisSetNX.mockResolvedValue(true)
    mockRedisSAdd.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(true)

    const result = await reserveFiles('repo-1', 'session-1', ['./src/a.ts'])

    expect(result.reserved).toEqual(['src/a.ts'])
  })

  it('includes reason in reservation payload', async () => {
    mockRedisSetNX.mockResolvedValue(true)
    mockRedisSAdd.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(true)

    await reserveFiles('repo-1', 'session-1', ['src/a.ts'], 'Adding new feature')

    const payload = JSON.parse(mockRedisSetNX.mock.calls[0][1])
    expect(payload.reason).toBe('Adding new feature')
  })

  it('handles errors gracefully', async () => {
    mockRedisSetNX.mockRejectedValue(new Error('Redis connection lost'))

    const result = await reserveFiles('repo-1', 'session-1', ['src/a.ts'])

    expect(result.reserved).toEqual([])
    expect(result.conflicts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkFileConflicts
// ---------------------------------------------------------------------------

describe('checkFileConflicts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns empty when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await checkFileConflicts('repo-1', 'session-1', ['src/a.ts'])
    expect(result).toEqual([])
  })

  it('returns empty when no conflicts exist', async () => {
    mockRedisGet.mockResolvedValue(null)
    const result = await checkFileConflicts('repo-1', 'session-1', ['src/a.ts'])
    expect(result).toEqual([])
  })

  it('excludes files reserved by the same session', async () => {
    const ownReservation = makeReservation({ sessionId: 'session-1' })
    mockRedisGet.mockResolvedValue(ownReservation)

    const result = await checkFileConflicts('repo-1', 'session-1', ['src/a.ts'])
    expect(result).toEqual([])
  })

  it('returns conflicts for files held by other sessions', async () => {
    const otherReservation = makeReservation({ sessionId: 'session-other' })
    mockRedisGet.mockResolvedValue(otherReservation)

    const result = await checkFileConflicts('repo-1', 'session-1', ['src/a.ts'])

    expect(result).toHaveLength(1)
    expect(result[0].filePath).toBe('src/a.ts')
    expect(result[0].heldBy.sessionId).toBe('session-other')
  })

  it('handles errors gracefully', async () => {
    mockRedisGet.mockRejectedValue(new Error('timeout'))
    const result = await checkFileConflicts('repo-1', 'session-1', ['src/a.ts'])
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// releaseFiles
// ---------------------------------------------------------------------------

describe('releaseFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await releaseFiles('repo-1', 'session-1', ['src/a.ts'])
    expect(result).toBe(0)
  })

  it('releases files owned by the session', async () => {
    const ownReservation = makeReservation({ sessionId: 'session-1' })
    mockRedisGet.mockResolvedValue(ownReservation)
    mockRedisDel.mockResolvedValue(1)
    mockRedisSRem.mockResolvedValue(1)

    const result = await releaseFiles('repo-1', 'session-1', ['src/a.ts', 'src/b.ts'])

    expect(result).toBe(2)
    expect(mockRedisDel).toHaveBeenCalledTimes(2)
    expect(mockRedisSRem).toHaveBeenCalledTimes(2)
  })

  it('skips files owned by other sessions', async () => {
    const otherReservation = makeReservation({ sessionId: 'session-other' })
    mockRedisGet.mockResolvedValue(otherReservation)

    const result = await releaseFiles('repo-1', 'session-1', ['src/a.ts'])

    expect(result).toBe(0)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('handles mixed ownership', async () => {
    const ownReservation = makeReservation({ sessionId: 'session-1' })
    const otherReservation = makeReservation({ sessionId: 'session-other' })

    mockRedisGet.mockResolvedValueOnce(ownReservation)
    mockRedisGet.mockResolvedValueOnce(otherReservation)
    mockRedisDel.mockResolvedValue(1)
    mockRedisSRem.mockResolvedValue(1)

    const result = await releaseFiles('repo-1', 'session-1', ['src/a.ts', 'src/b.ts'])

    expect(result).toBe(1)
    expect(mockRedisDel).toHaveBeenCalledTimes(1)
  })

  it('handles errors gracefully', async () => {
    mockRedisGet.mockRejectedValue(new Error('timeout'))
    const result = await releaseFiles('repo-1', 'session-1', ['src/a.ts'])
    expect(result).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// releaseAllSessionFiles
// ---------------------------------------------------------------------------

describe('releaseAllSessionFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await releaseAllSessionFiles('repo-1', 'session-1')
    expect(result).toBe(0)
  })

  it('returns 0 when session has no reserved files', async () => {
    mockRedisSMembers.mockResolvedValue([])
    const result = await releaseAllSessionFiles('repo-1', 'session-1')
    expect(result).toBe(0)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('releases all files and deletes session set', async () => {
    const ownReservation = makeReservation({ sessionId: 'session-1' })
    mockRedisSMembers.mockResolvedValue(['src/a.ts', 'src/b.ts'])
    mockRedisGet.mockResolvedValue(ownReservation)
    mockRedisDel.mockResolvedValue(1)

    const result = await releaseAllSessionFiles('repo-1', 'session-1')

    expect(result).toBe(2)
    // 2 reservation keys + 1 session set key
    expect(mockRedisDel).toHaveBeenCalledTimes(3)
    expect(mockRedisDel).toHaveBeenCalledWith('file:session:repo-1:session-1')
  })

  it('skips files no longer owned by session', async () => {
    const otherReservation = makeReservation({ sessionId: 'session-other' })
    mockRedisSMembers.mockResolvedValue(['src/a.ts'])
    mockRedisGet.mockResolvedValue(otherReservation)
    mockRedisDel.mockResolvedValue(1)

    const result = await releaseAllSessionFiles('repo-1', 'session-1')

    expect(result).toBe(0)
    // Only the session set key should be deleted
    expect(mockRedisDel).toHaveBeenCalledTimes(1)
    expect(mockRedisDel).toHaveBeenCalledWith('file:session:repo-1:session-1')
  })

  it('handles errors gracefully', async () => {
    mockRedisSMembers.mockRejectedValue(new Error('timeout'))
    const result = await releaseAllSessionFiles('repo-1', 'session-1')
    expect(result).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// refreshFileReservationsTTL
// ---------------------------------------------------------------------------

describe('refreshFileReservationsTTL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await refreshFileReservationsTTL('repo-1', 'session-1')
    expect(result).toBe(false)
  })

  it('returns false when session has no files', async () => {
    mockRedisSMembers.mockResolvedValue([])
    const result = await refreshFileReservationsTTL('repo-1', 'session-1')
    expect(result).toBe(false)
  })

  it('refreshes TTL on all reservation keys and session set', async () => {
    mockRedisSMembers.mockResolvedValue(['src/a.ts', 'src/b.ts'])
    mockRedisExpire.mockResolvedValue(true)

    const result = await refreshFileReservationsTTL('repo-1', 'session-1')

    expect(result).toBe(true)
    // 2 reservation keys + 1 session set
    expect(mockRedisExpire).toHaveBeenCalledTimes(3)
    expect(mockRedisExpire).toHaveBeenCalledWith('file:reservation:repo-1:src/a.ts', 3600)
    expect(mockRedisExpire).toHaveBeenCalledWith('file:reservation:repo-1:src/b.ts', 3600)
    expect(mockRedisExpire).toHaveBeenCalledWith('file:session:repo-1:session-1', 3600)
  })

  it('uses custom TTL when provided', async () => {
    mockRedisSMembers.mockResolvedValue(['src/a.ts'])
    mockRedisExpire.mockResolvedValue(true)

    await refreshFileReservationsTTL('repo-1', 'session-1', 7200)

    expect(mockRedisExpire).toHaveBeenCalledWith('file:reservation:repo-1:src/a.ts', 7200)
    expect(mockRedisExpire).toHaveBeenCalledWith('file:session:repo-1:session-1', 7200)
  })

  it('handles errors gracefully', async () => {
    mockRedisSMembers.mockRejectedValue(new Error('timeout'))
    const result = await refreshFileReservationsTTL('repo-1', 'session-1')
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getSessionFiles
// ---------------------------------------------------------------------------

describe('getSessionFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns empty when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getSessionFiles('repo-1', 'session-1')
    expect(result).toEqual([])
  })

  it('returns session files', async () => {
    mockRedisSMembers.mockResolvedValue(['src/a.ts', 'src/b.ts'])
    const result = await getSessionFiles('repo-1', 'session-1')
    expect(result).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('handles errors gracefully', async () => {
    mockRedisSMembers.mockRejectedValue(new Error('timeout'))
    const result = await getSessionFiles('repo-1', 'session-1')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getFileReservation
// ---------------------------------------------------------------------------

describe('getFileReservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getFileReservation('repo-1', 'src/a.ts')
    expect(result).toBeNull()
  })

  it('returns reservation when file is reserved', async () => {
    const reservation = makeReservation()
    mockRedisGet.mockResolvedValue(reservation)

    const result = await getFileReservation('repo-1', 'src/index.ts')

    expect(result).toEqual(reservation)
    expect(mockRedisGet).toHaveBeenCalledWith('file:reservation:repo-1:src/index.ts')
  })

  it('returns null when file is not reserved', async () => {
    mockRedisGet.mockResolvedValue(null)
    const result = await getFileReservation('repo-1', 'src/a.ts')
    expect(result).toBeNull()
  })

  it('handles errors gracefully', async () => {
    mockRedisGet.mockRejectedValue(new Error('timeout'))
    const result = await getFileReservation('repo-1', 'src/a.ts')
    expect(result).toBeNull()
  })
})
