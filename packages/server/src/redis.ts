import Redis, { RedisOptions } from 'ioredis'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[redis] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[redis] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[redis] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

let _redis: Redis | null = null

/**
 * Parse Redis URL using the modern URL class to avoid deprecated url.parse()
 * Supports redis:// and rediss:// (TLS) protocols
 */
function parseRedisUrl(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl)
  const options: RedisOptions = {}

  if (url.hostname) {
    options.host = url.hostname
  }

  if (url.port) {
    options.port = parseInt(url.port, 10)
  }

  if (url.username && url.username !== 'default') {
    options.username = decodeURIComponent(url.username)
  }

  if (url.password) {
    options.password = decodeURIComponent(url.password)
  }

  // Database number from path (e.g., redis://host/0)
  if (url.pathname && url.pathname.length > 1) {
    const db = parseInt(url.pathname.slice(1), 10)
    if (!isNaN(db)) {
      options.db = db
    }
  }

  // Enable TLS for rediss:// protocol
  if (url.protocol === 'rediss:') {
    options.tls = {}
  }

  // Parse query parameters (e.g., ?family=6)
  for (const [key, value] of url.searchParams) {
    if (key === 'family') {
      const family = parseInt(value, 10)
      if (!isNaN(family)) {
        options.family = family as 4 | 6
      }
    }
  }

  return options
}

/**
 * Check if Redis is configured via REDIS_URL
 */
export function isRedisConfigured(): boolean {
  return !!process.env.REDIS_URL
}

/**
 * Get the shared Redis client instance
 * Lazily initialized to avoid errors during build
 */
export function getRedisClient(): Redis {
  if (!_redis) {
    const redisUrl = process.env.REDIS_URL

    if (!redisUrl) {
      throw new Error('REDIS_URL not set - Redis operations will fail')
    }

    const urlOptions = parseRedisUrl(redisUrl)

    _redis = new Redis({
      ...urlOptions,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })

    _redis.on('error', (err) => {
      log.error('Redis connection error', { error: err })
    })

    _redis.on('connect', () => {
      log.info('Redis connected')
    })
  }

  return _redis
}

/**
 * Disconnect Redis client (for graceful shutdown)
 */
export async function disconnectRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit()
    _redis = null
    log.info('Redis disconnected')
  }
}

/**
 * Set a value with optional TTL (seconds)
 */
export async function redisSet<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  const redis = getRedisClient()
  const serialized = JSON.stringify(value)

  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized)
  } else {
    await redis.set(key, serialized)
  }
}

/**
 * Get a typed value
 */
export async function redisGet<T>(key: string): Promise<T | null> {
  const redis = getRedisClient()
  const value = await redis.get(key)

  if (value === null) {
    return null
  }

  return JSON.parse(value) as T
}

/**
 * Delete a key
 * @returns number of keys deleted (0 or 1)
 */
export async function redisDel(key: string): Promise<number> {
  const redis = getRedisClient()
  return redis.del(key)
}

/**
 * Check if a key exists
 */
export async function redisExists(key: string): Promise<boolean> {
  const redis = getRedisClient()
  const result = await redis.exists(key)
  return result === 1
}

/**
 * Get keys matching a pattern
 */
export async function redisKeys(pattern: string): Promise<string[]> {
  const redis = getRedisClient()
  return redis.keys(pattern)
}

// ============================================
// List Operations (for work queue)
// ============================================

/**
 * Push value to the right of a list (RPUSH)
 * @returns length of list after push
 */
export async function redisRPush(key: string, value: string): Promise<number> {
  const redis = getRedisClient()
  return redis.rpush(key, value)
}

/**
 * Pop value from the left of a list (LPOP)
 * @returns the popped value or null if list is empty
 */
export async function redisLPop(key: string): Promise<string | null> {
  const redis = getRedisClient()
  return redis.lpop(key)
}

/**
 * Get a range of elements from a list (LRANGE)
 * @param start - Start index (0-based, inclusive)
 * @param stop - Stop index (inclusive, -1 for end)
 */
export async function redisLRange(
  key: string,
  start: number,
  stop: number
): Promise<string[]> {
  const redis = getRedisClient()
  return redis.lrange(key, start, stop)
}

/**
 * Get the length of a list (LLEN)
 */
export async function redisLLen(key: string): Promise<number> {
  const redis = getRedisClient()
  return redis.llen(key)
}

/**
 * Remove elements from a list (LREM)
 * @param count - Number of occurrences to remove (0 = all)
 * @returns number of elements removed
 */
export async function redisLRem(
  key: string,
  count: number,
  value: string
): Promise<number> {
  const redis = getRedisClient()
  return redis.lrem(key, count, value)
}

// ============================================
// Set Operations (for worker sessions)
// ============================================

/**
 * Add member to a set (SADD)
 * @returns number of elements added (0 if already exists)
 */
export async function redisSAdd(key: string, member: string): Promise<number> {
  const redis = getRedisClient()
  return redis.sadd(key, member)
}

/**
 * Remove member from a set (SREM)
 * @returns number of elements removed
 */
export async function redisSRem(key: string, member: string): Promise<number> {
  const redis = getRedisClient()
  return redis.srem(key, member)
}

/**
 * Get all members of a set (SMEMBERS)
 */
export async function redisSMembers(key: string): Promise<string[]> {
  const redis = getRedisClient()
  return redis.smembers(key)
}

/**
 * Get the number of members in a set (SCARD)
 */
export async function redisSCard(key: string): Promise<number> {
  const redis = getRedisClient()
  return redis.scard(key)
}

// ============================================
// Atomic Operations
// ============================================

/**
 * Set a value only if key does not exist (SETNX)
 * @returns true if key was set, false if it already existed
 */
export async function redisSetNX(
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<boolean> {
  const redis = getRedisClient()

  if (ttlSeconds) {
    // Use SET with NX and EX options for atomic set-if-not-exists with TTL
    const result = await redis.set(key, value, 'EX', ttlSeconds, 'NX')
    return result === 'OK'
  } else {
    const result = await redis.setnx(key, value)
    return result === 1
  }
}

/**
 * Set TTL on an existing key (EXPIRE)
 * @returns true if TTL was set, false if key doesn't exist
 */
export async function redisExpire(
  key: string,
  ttlSeconds: number
): Promise<boolean> {
  const redis = getRedisClient()
  const result = await redis.expire(key, ttlSeconds)
  return result === 1
}

// ============================================
// Sorted Set Operations (for priority queue)
// ============================================

/**
 * Add member to a sorted set with score (ZADD)
 * @returns number of elements added (0 if already exists, updates score)
 */
export async function redisZAdd(
  key: string,
  score: number,
  member: string
): Promise<number> {
  const redis = getRedisClient()
  return redis.zadd(key, score, member)
}

/**
 * Remove member from a sorted set (ZREM)
 * @returns number of elements removed
 */
export async function redisZRem(key: string, member: string): Promise<number> {
  const redis = getRedisClient()
  return redis.zrem(key, member)
}

/**
 * Get members from sorted set by score range (ZRANGEBYSCORE)
 * Returns members with lowest scores first (highest priority)
 * @param min - Minimum score (use '-inf' for no minimum)
 * @param max - Maximum score (use '+inf' for no maximum)
 * @param limit - Maximum number of results
 */
export async function redisZRangeByScore(
  key: string,
  min: number | string,
  max: number | string,
  limit?: number
): Promise<string[]> {
  const redis = getRedisClient()
  if (limit !== undefined) {
    return redis.zrangebyscore(key, min, max, 'LIMIT', 0, limit)
  }
  return redis.zrangebyscore(key, min, max)
}

/**
 * Get the number of members in a sorted set (ZCARD)
 */
export async function redisZCard(key: string): Promise<number> {
  const redis = getRedisClient()
  return redis.zcard(key)
}

/**
 * Pop the member with the lowest score (ZPOPMIN)
 * @returns [member, score] or null if set is empty
 */
export async function redisZPopMin(
  key: string
): Promise<{ member: string; score: number } | null> {
  const redis = getRedisClient()
  const result = await redis.zpopmin(key)
  if (result && result.length >= 2) {
    return { member: result[0], score: parseFloat(result[1]) }
  }
  return null
}

// ============================================
// Hash Operations (for work item lookup)
// ============================================

/**
 * Set a field in a hash (HSET)
 * @returns 1 if field is new, 0 if field existed
 */
export async function redisHSet(
  key: string,
  field: string,
  value: string
): Promise<number> {
  const redis = getRedisClient()
  return redis.hset(key, field, value)
}

/**
 * Get a field from a hash (HGET)
 */
export async function redisHGet(
  key: string,
  field: string
): Promise<string | null> {
  const redis = getRedisClient()
  return redis.hget(key, field)
}

/**
 * Delete a field from a hash (HDEL)
 * @returns number of fields removed
 */
export async function redisHDel(key: string, field: string): Promise<number> {
  const redis = getRedisClient()
  return redis.hdel(key, field)
}

/**
 * Get multiple fields from a hash (HMGET)
 */
export async function redisHMGet(
  key: string,
  fields: string[]
): Promise<(string | null)[]> {
  const redis = getRedisClient()
  if (fields.length === 0) return []
  return redis.hmget(key, ...fields)
}

/**
 * Get all fields and values from a hash (HGETALL)
 */
export async function redisHGetAll(
  key: string
): Promise<Record<string, string>> {
  const redis = getRedisClient()
  return redis.hgetall(key)
}

/**
 * Get the number of fields in a hash (HLEN)
 */
export async function redisHLen(key: string): Promise<number> {
  const redis = getRedisClient()
  return redis.hlen(key)
}
