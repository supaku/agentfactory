/**
 * In-memory journal write throughput regression test (REN-1397).
 *
 * Runs in vitest as a regression gate so CI catches perf cliffs in the
 * non-Redis-bound part of the journal write path (serializer + hash
 * marshalling + event dispatch). The acceptance-gating bench artifact
 * attached to the PR is produced by `bench/journal-bench.ts` against a
 * real Redis instance — that is the artifact gating the AC of
 * `>= 10k writes/sec sustained @ p99 < 2ms`.
 *
 * Regression thresholds checked here (in-memory, with a fake Redis client):
 *   - throughput >= 25,000 writes/sec (2.5× the acceptance throughput;
 *     loose because shared CI runners contend for CPU. The point of this
 *     gate is to catch ~10× regressions, not to enforce the AC.)
 *   - p99 latency < 5ms (loose because vitest runs other suites in
 *     parallel; the AC's tight 2ms gate is enforced by the Redis-backed
 *     bench artifact, where the worker process is dedicated)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { performance } from 'node:perf_hooks'

const fakeStore = new Map<string, Record<string, string>>()

vi.mock('./redis.js', () => {
  const isRedisConfigured = vi.fn(() => true)
  const getRedisClient = vi.fn(() => ({
    hset: async (key: string, ...args: string[]) => {
      const existing = fakeStore.get(key) ?? {}
      for (let i = 0; i < args.length; i += 2) {
        existing[args[i]] = String(args[i + 1])
      }
      fakeStore.set(key, existing)
      return 1
    },
    hgetall: async (key: string) => fakeStore.get(key) ?? {},
  }))
  const redisHGetAll = vi.fn(async (key: string) => fakeStore.get(key) ?? {})
  const redisKeys = vi.fn(async (pattern: string) => {
    const prefix = pattern.replace(/\*$/, '')
    return Array.from(fakeStore.keys()).filter((k) => k.startsWith(prefix))
  })
  return { isRedisConfigured, getRedisClient, redisHGetAll, redisKeys }
})

import {
  writeJournalEntry,
  computeIdempotencyHash,
  journalEventBus,
} from './journal.js'

beforeEach(() => {
  fakeStore.clear()
  journalEventBus.clear()
})

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

describe('journal write throughput (regression)', () => {
  it(
    'sustains >= 25k writes/sec with p99 < 5ms in-memory (loose CI threshold)',
    async () => {
      const TOTAL = 10_000
      const CONCURRENCY = 64
      const latencies = new Array<number>(TOTAL)
      let next = 0

      const start = performance.now()
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (true) {
            const idx = next++
            if (idx >= TOTAL) return
            const stepId = `step-${idx}`
            const inputHash = computeIdempotencyHash(stepId, { idx }, 'v1')
            const t0 = performance.now()
            await writeJournalEntry({
              sessionId: `bench-${idx % 100}`,
              stepId,
              status: 'completed',
              inputHash,
              startedAt: Math.floor(t0),
              completedAt: Math.floor(t0) + 1,
              outputCAS: `cas://bench/${idx}`,
              attempt: 0,
            })
            latencies[idx] = performance.now() - t0
          }
        })
      )
      const durationMs = performance.now() - start
      const writesPerSec = (TOTAL / durationMs) * 1000
      const sorted = latencies.slice().sort((a, b) => a - b)
      const p99 = quantile(sorted, 0.99)

      // Log so the bench numbers appear in CI output as part of the PR's
      // bench artifact.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          mode: 'in-memory',
          total: TOTAL,
          concurrency: CONCURRENCY,
          durationMs: Math.round(durationMs),
          writesPerSec: Math.round(writesPerSec),
          p50Ms: Math.round(quantile(sorted, 0.5) * 1000) / 1000,
          p95Ms: Math.round(quantile(sorted, 0.95) * 1000) / 1000,
          p99Ms: Math.round(p99 * 1000) / 1000,
          maxMs: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
        })
      )

      // Regression thresholds (looser than the AC, which is gated by the
      // Redis-backed bench artifact — see file header).
      expect(writesPerSec).toBeGreaterThanOrEqual(25_000)
      expect(p99).toBeLessThan(5)
    },
    30_000
  )
})
