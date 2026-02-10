#!/usr/bin/env node
/**
 * AgentFactory Queue Admin
 *
 * Manage the Redis work queue, sessions, claims, and workers.
 *
 * Usage:
 *   af-queue-admin <command>
 *
 * Commands:
 *   list             List all queued work items
 *   sessions         List all sessions
 *   workers          List all registered workers
 *   clear-claims     Clear stale work claims
 *   clear-queue      Clear the work queue
 *   clear-all        Clear queue, sessions, claims, and workers
 *   reset            Full state reset (claims + queue + stuck sessions)
 *   remove <id>      Remove a specific session by ID (partial match)
 *
 * Environment (loaded from .env.local in CWD):
 *   REDIS_URL        Required for Redis connection
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import {
  getRedisClient,
  redisKeys,
  redisDel,
  redisGet,
  redisSet,
  redisZRangeByScore,
  redisHGetAll,
  redisLRange,
  redisLRem,
  disconnectRedis,
} from '@supaku/agentfactory-server'

// Redis key constants
const WORK_QUEUE_KEY = 'work:queue'
const WORK_ITEMS_KEY = 'work:items'
const WORK_CLAIM_PREFIX = 'work:claim:'
const SESSION_KEY_PREFIX = 'agent:session:'
const WORKER_PREFIX = 'work:worker:'

// ANSI colors
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

function ensureRedis(): void {
  if (!process.env.REDIS_URL) {
    console.error(`${C.red}Error: REDIS_URL not set${C.reset}`)
    process.exit(1)
  }
  // Initialize the Redis client
  getRedisClient()
}

async function listQueue(): Promise<void> {
  ensureRedis()

  // Get items from sorted set (current queue format)
  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  const workItemCount = Object.keys(workItems).length

  console.log(`\n${C.cyan}Work Queue${C.reset} (${Math.max(queuedSessionIds.length, workItemCount)} items):`)
  console.log('='.repeat(60))

  if (workItemCount === 0 && queuedSessionIds.length === 0) {
    console.log('(empty)')
  } else {
    for (const [sessionId, itemJson] of Object.entries(workItems)) {
      try {
        const work = JSON.parse(itemJson) as {
          issueIdentifier?: string
          priority?: number
          queuedAt?: number
          workType?: string
          prompt?: string
          claudeSessionId?: string
        }
        console.log(`- ${work.issueIdentifier ?? sessionId.slice(0, 8)} (session: ${sessionId.slice(0, 8)}...)`)
        console.log(`  Priority: ${work.priority ?? 'none'}, WorkType: ${work.workType ?? 'development'}`)
        if (work.queuedAt) {
          console.log(`  Queued: ${new Date(work.queuedAt).toISOString()}`)
        }
        if (work.claudeSessionId) {
          console.log(`  ${C.yellow}Has claudeSessionId: ${work.claudeSessionId.substring(0, 12)}${C.reset}`)
        }
        if (work.prompt) {
          console.log(`  Prompt: "${work.prompt.slice(0, 50)}..."`)
        }
      } catch {
        console.log(`- [invalid JSON]: ${sessionId}`)
      }
    }
  }

  await disconnectRedis()
}

async function listSessions(): Promise<void> {
  ensureRedis()

  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)

  console.log(`\n${C.cyan}Sessions${C.reset} (${keys.length} total):`)
  console.log('='.repeat(60))

  if (keys.length === 0) {
    console.log('(none)')
  } else {
    for (const key of keys) {
      const session = await redisGet<{
        status: string
        issueIdentifier?: string
        issueId: string
        linearSessionId: string
        updatedAt: number
        workerId?: string
        workType?: string
      }>(key)

      if (session) {
        const statusColors: Record<string, string> = {
          pending: C.yellow,
          claimed: C.cyan,
          running: C.cyan,
          completed: C.green,
          failed: C.red,
          stopped: C.yellow,
        }
        const statusColor = statusColors[session.status] || ''

        console.log(`- ${session.issueIdentifier || session.issueId.slice(0, 8)} [${statusColor}${session.status}${C.reset}]`)
        console.log(`  Session: ${session.linearSessionId.slice(0, 12)}...`)
        if (session.workType) {
          console.log(`  WorkType: ${session.workType}`)
        }
        console.log(`  Updated: ${new Date(session.updatedAt * 1000).toISOString()}`)
        if (session.workerId) {
          console.log(`  Worker: ${session.workerId}`)
        }
      }
    }
  }

  await disconnectRedis()
}

async function listWorkersFn(): Promise<void> {
  ensureRedis()

  const keys = await redisKeys(`${WORKER_PREFIX}*`)

  console.log(`\n${C.cyan}Workers${C.reset} (${keys.length} total):`)
  console.log('='.repeat(60))

  if (keys.length === 0) {
    console.log('(none)')
  } else {
    for (const key of keys) {
      const worker = await redisGet<{
        id: string
        hostname?: string
        status: string
        capacity?: number
        activeCount?: number
        lastHeartbeat?: number
      }>(key)

      if (worker) {
        const statusColor = worker.status === 'active' ? C.green : C.yellow
        console.log(`- ${worker.id.slice(0, 12)} [${statusColor}${worker.status}${C.reset}]`)
        if (worker.hostname) {
          console.log(`  Hostname: ${worker.hostname}`)
        }
        console.log(`  Capacity: ${worker.activeCount ?? 0}/${worker.capacity ?? '?'}`)
        if (worker.lastHeartbeat) {
          const ago = Math.round((Date.now() - worker.lastHeartbeat) / 1000)
          console.log(`  Last heartbeat: ${ago}s ago`)
        }
      }
    }
  }

  await disconnectRedis()
}

async function clearClaims(): Promise<void> {
  ensureRedis()

  console.log('Clearing work claims...')
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  console.log(`Found ${claimKeys.length} claim(s)`)

  if (claimKeys.length === 0) {
    console.log('No claims to clear')
    await disconnectRedis()
    return
  }

  let deleted = 0
  for (const key of claimKeys) {
    const result = await redisDel(key)
    if (result > 0) {
      console.log(`  Deleted: ${key}`)
      deleted++
    }
  }

  console.log(`\nCleared ${deleted} claim(s)`)
  await disconnectRedis()
}

async function clearQueue(): Promise<void> {
  ensureRedis()

  console.log('Clearing work queue...')

  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  console.log(`Found ${queuedSessionIds.length} item(s) in queue sorted set`)

  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  const workItemCount = Object.keys(workItems).length
  console.log(`Found ${workItemCount} item(s) in work items hash`)

  // Show what we're clearing
  for (const [sessionId, itemJson] of Object.entries(workItems)) {
    try {
      const work = JSON.parse(itemJson) as { issueIdentifier?: string; workType?: string; claudeSessionId?: string }
      console.log(`  - ${work.issueIdentifier ?? sessionId.slice(0, 8)} (workType: ${work.workType || 'development'})`)
      if (work.claudeSessionId) {
        console.log(`    ${C.yellow}Has claudeSessionId: ${work.claudeSessionId.substring(0, 12)}${C.reset}`)
      }
    } catch {
      console.log(`  - [invalid JSON]: ${sessionId}`)
    }
  }

  let cleared = 0
  if (queuedSessionIds.length > 0) {
    await redisDel(WORK_QUEUE_KEY)
    cleared++
  }
  if (workItemCount > 0) {
    await redisDel(WORK_ITEMS_KEY)
    cleared++
  }

  const totalItems = Math.max(queuedSessionIds.length, workItemCount)
  if (cleared > 0) {
    console.log(`\nCleared ${totalItems} item(s) from work queue`)
  } else {
    console.log('\nQueue was already empty')
  }

  await disconnectRedis()
}

async function clearAll(): Promise<void> {
  ensureRedis()

  console.log('Clearing ALL state...\n')

  // Clear work queue
  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  if (queuedSessionIds.length > 0) await redisDel(WORK_QUEUE_KEY)
  if (Object.keys(workItems).length > 0) await redisDel(WORK_ITEMS_KEY)
  console.log(`Cleared ${Math.max(queuedSessionIds.length, Object.keys(workItems).length)} queue items`)

  // Clear all sessions
  const sessionKeys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  for (const key of sessionKeys) {
    await redisDel(key)
  }
  console.log(`Cleared ${sessionKeys.length} sessions`)

  // Clear all claims
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  for (const key of claimKeys) {
    await redisDel(key)
  }
  console.log(`Cleared ${claimKeys.length} claims`)

  // Clear all workers
  const workerKeys = await redisKeys(`${WORKER_PREFIX}*`)
  for (const key of workerKeys) {
    await redisDel(key)
  }
  console.log(`Cleared ${workerKeys.length} worker registrations`)

  console.log('\nAll cleared!')
  await disconnectRedis()
}

async function resetWorkState(): Promise<void> {
  ensureRedis()

  console.log('Resetting work state...')
  console.log('-'.repeat(60))

  let totalCleared = 0

  // 1. Clear work claims
  console.log('\nClearing work claims...')
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  console.log(`  Found ${claimKeys.length} claim(s)`)
  for (const key of claimKeys) {
    const result = await redisDel(key)
    if (result > 0) {
      console.log(`  Deleted: ${key}`)
      totalCleared++
    }
  }

  // 2. Clear work queue
  console.log('\nClearing work queue...')
  const queuedSessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')
  console.log(`  Found ${queuedSessionIds.length} queued item(s) in sorted set`)

  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  const workItemCount = Object.keys(workItems).length
  console.log(`  Found ${workItemCount} item(s) in work items hash`)

  for (const [sessionId, itemJson] of Object.entries(workItems)) {
    try {
      const work = JSON.parse(itemJson) as { issueIdentifier?: string; workType?: string }
      console.log(`  - ${work.issueIdentifier ?? sessionId.slice(0, 8)} (workType: ${work.workType || 'development'})`)
    } catch {
      console.log(`  - [invalid item: ${sessionId}]`)
    }
  }

  if (queuedSessionIds.length > 0 || workItemCount > 0) {
    await redisDel(WORK_QUEUE_KEY)
    await redisDel(WORK_ITEMS_KEY)
    totalCleared += Math.max(queuedSessionIds.length, workItemCount)
    console.log(`  Cleared queue and items hash`)
  }

  // 3. Reset stuck sessions
  console.log('\nResetting stuck sessions...')
  const sessionKeys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  console.log(`  Found ${sessionKeys.length} session(s)`)

  let sessionsReset = 0
  for (const key of sessionKeys) {
    const session = await redisGet<{
      linearSessionId: string
      issueIdentifier?: string
      status: string
      workerId?: string
      claudeSessionId?: string
      [key: string]: unknown
    }>(key)

    if (!session) continue

    if (session.status === 'running' || session.status === 'claimed') {
      console.log(`  Resetting: ${session.issueIdentifier || session.linearSessionId}`)
      console.log(`    Status: ${session.status}, WorkerId: ${session.workerId || 'none'}`)

      const updated = {
        ...session,
        status: 'pending',
        workerId: undefined,
        claimedAt: undefined,
        claudeSessionId: undefined,
        updatedAt: Math.floor(Date.now() / 1000),
      }

      await redisSet(key, updated, 24 * 60 * 60)
      sessionsReset++
      console.log(`    Reset to pending`)
    }
  }

  console.log('\n' + '-'.repeat(60))
  console.log(`\nReset complete:`)
  console.log(`   - Claims cleared: ${claimKeys.length}`)
  console.log(`   - Queue items cleared: ${Math.max(queuedSessionIds.length, workItemCount)}`)
  console.log(`   - Sessions reset: ${sessionsReset}`)

  await disconnectRedis()
}

async function removeSession(sessionId: string): Promise<void> {
  ensureRedis()

  let found = false

  // Find session by partial ID match
  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  for (const key of keys) {
    if (key.includes(sessionId)) {
      await redisDel(key)
      console.log(`Removed session: ${key.replace(SESSION_KEY_PREFIX, '')}`)
      found = true
    }
  }

  // Also remove from queue if present
  const workItems = await redisHGetAll(WORK_ITEMS_KEY)
  for (const [sid, itemJson] of Object.entries(workItems)) {
    if (sid.includes(sessionId)) {
      // Remove from hash via direct Redis command
      const redis = getRedisClient()
      await redis.hdel(WORK_ITEMS_KEY, sid)
      // Remove from sorted set
      const { redisZRem } = await import('@supaku/agentfactory-server')
      await redisZRem(WORK_QUEUE_KEY, sid)
      const work = JSON.parse(itemJson) as { issueIdentifier?: string }
      console.log(`Removed from queue: ${work.issueIdentifier ?? sid.slice(0, 8)}`)
      found = true
    }
  }

  // Remove claim if present
  const claimKeys = await redisKeys(`${WORK_CLAIM_PREFIX}*`)
  for (const key of claimKeys) {
    if (key.includes(sessionId)) {
      await redisDel(key)
      console.log(`Removed claim: ${key}`)
      found = true
    }
  }

  if (!found) {
    console.log(`No session found matching: ${sessionId}`)
  }

  await disconnectRedis()
}

function printUsage(): void {
  console.log(`
${C.cyan}AgentFactory Queue Admin${C.reset} - Manage Redis work queue and sessions

${C.yellow}Usage:${C.reset}
  af-queue-admin <command>

${C.yellow}Commands:${C.reset}
  list             List all queued work items
  sessions         List all sessions
  workers          List all registered workers
  clear-claims     Clear stale work claims
  clear-queue      Clear the work queue
  clear-all        Clear queue, sessions, claims, and workers
  reset            Full state reset (claims + queue + stuck sessions)
  remove <id>      Remove a specific session by ID (partial match)

${C.yellow}Examples:${C.reset}
  af-queue-admin list
  af-queue-admin sessions
  af-queue-admin clear-queue
  af-queue-admin reset
  af-queue-admin remove abc123
`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const arg = process.argv[3]

  switch (command) {
    case 'list':
      await listQueue()
      break
    case 'sessions':
      await listSessions()
      break
    case 'workers':
      await listWorkersFn()
      break
    case 'clear-claims':
      await clearClaims()
      break
    case 'clear-queue':
      await clearQueue()
      break
    case 'clear-all':
      await clearAll()
      break
    case 'reset':
      await resetWorkState()
      break
    case 'remove':
      if (!arg) {
        console.error('Usage: af-queue-admin remove <session-id>')
        process.exit(1)
      }
      await removeSession(arg)
      break
    case '--help':
    case '-h':
    case 'help':
    default:
      printUsage()
      break
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
