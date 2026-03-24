import { describe, it, expect } from 'vitest'
import { ConcurrencySemaphore } from './concurrency-semaphore.js'

describe('ConcurrencySemaphore', () => {
  describe('construction', () => {
    it('creates with valid maxConcurrent', () => {
      const sem = new ConcurrencySemaphore(3)
      expect(sem.activeCount).toBe(0)
      expect(sem.waitingCount).toBe(0)
    })

    it('creates with maxConcurrent = 1', () => {
      const sem = new ConcurrencySemaphore(1)
      expect(sem.activeCount).toBe(0)
    })

    it('throws when maxConcurrent is 0', () => {
      expect(() => new ConcurrencySemaphore(0)).toThrow(
        'maxConcurrent must be at least 1',
      )
    })

    it('throws when maxConcurrent is negative', () => {
      expect(() => new ConcurrencySemaphore(-1)).toThrow(
        'maxConcurrent must be at least 1',
      )
    })
  })

  describe('acquire/release basic flow', () => {
    it('acquires immediately when under capacity', async () => {
      const sem = new ConcurrencySemaphore(2)
      await sem.acquire()
      expect(sem.activeCount).toBe(1)
      await sem.acquire()
      expect(sem.activeCount).toBe(2)
    })

    it('releases correctly and decrements activeCount', async () => {
      const sem = new ConcurrencySemaphore(2)
      await sem.acquire()
      await sem.acquire()
      expect(sem.activeCount).toBe(2)
      sem.release()
      expect(sem.activeCount).toBe(1)
      sem.release()
      expect(sem.activeCount).toBe(0)
    })
  })

  describe('blocking behavior', () => {
    it('blocks acquire when at capacity', async () => {
      const sem = new ConcurrencySemaphore(1)
      await sem.acquire()
      expect(sem.activeCount).toBe(1)

      let acquired = false
      const pending = sem.acquire().then(() => {
        acquired = true
      })

      // The waiter should be queued but not yet resolved
      await Promise.resolve() // flush microtasks
      expect(acquired).toBe(false)
      expect(sem.waitingCount).toBe(1)

      // Release to unblock
      sem.release()
      await pending
      expect(acquired).toBe(true)
      expect(sem.activeCount).toBe(1)
      expect(sem.waitingCount).toBe(0)
    })
  })

  describe('FIFO waiter ordering', () => {
    it('releases waiters in FIFO order', async () => {
      const sem = new ConcurrencySemaphore(1)
      await sem.acquire()

      const order: number[] = []

      const p1 = sem.acquire().then(() => {
        order.push(1)
      })
      const p2 = sem.acquire().then(() => {
        order.push(2)
      })
      const p3 = sem.acquire().then(() => {
        order.push(3)
      })

      expect(sem.waitingCount).toBe(3)

      // Release one at a time and let the microtask queue flush
      sem.release()
      await p1
      sem.release()
      await p2
      sem.release()
      await p3

      expect(order).toEqual([1, 2, 3])
    })
  })

  describe('activeCount and waitingCount tracking', () => {
    it('tracks counts accurately through lifecycle', async () => {
      const sem = new ConcurrencySemaphore(2)
      expect(sem.activeCount).toBe(0)
      expect(sem.waitingCount).toBe(0)

      await sem.acquire()
      expect(sem.activeCount).toBe(1)
      expect(sem.waitingCount).toBe(0)

      await sem.acquire()
      expect(sem.activeCount).toBe(2)
      expect(sem.waitingCount).toBe(0)

      // Third acquire should wait
      const pending = sem.acquire()
      // Flush microtasks to make sure the promise callback has run
      await Promise.resolve()
      expect(sem.activeCount).toBe(2)
      expect(sem.waitingCount).toBe(1)

      sem.release()
      await pending
      expect(sem.activeCount).toBe(2)
      expect(sem.waitingCount).toBe(0)

      sem.release()
      expect(sem.activeCount).toBe(1)
      sem.release()
      expect(sem.activeCount).toBe(0)
    })
  })

  describe('maxConcurrent=1 enforces serial execution', () => {
    it('only one task runs at a time', async () => {
      const sem = new ConcurrencySemaphore(1)
      const log: string[] = []

      const runTask = async (name: string) => {
        await sem.acquire()
        log.push(`${name}:start`)
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10))
        log.push(`${name}:end`)
        sem.release()
      }

      await Promise.all([runTask('a'), runTask('b'), runTask('c')])

      // Each task must start after the previous one ends
      // The pattern should be: start, end, start, end, start, end
      for (let i = 0; i < log.length - 1; i += 2) {
        expect(log[i]).toMatch(/:start$/)
        expect(log[i + 1]).toMatch(/:end$/)
      }

      // Verify no two starts happen before an end
      let active = 0
      for (const entry of log) {
        if (entry.endsWith(':start')) active++
        if (entry.endsWith(':end')) active--
        expect(active).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('maxConcurrent=2 with 5 tasks verifies queuing behavior', () => {
    it('runs at most 2 tasks concurrently', async () => {
      const sem = new ConcurrencySemaphore(2)
      let peakConcurrent = 0
      let currentConcurrent = 0
      const taskOrder: string[] = []

      const runTask = async (id: number) => {
        await sem.acquire()
        currentConcurrent++
        peakConcurrent = Math.max(peakConcurrent, currentConcurrent)
        taskOrder.push(`start:${id}`)

        // Simulate varying amounts of work
        await new Promise((resolve) => setTimeout(resolve, 5 + id * 2))

        taskOrder.push(`end:${id}`)
        currentConcurrent--
        sem.release()
      }

      await Promise.all([
        runTask(1),
        runTask(2),
        runTask(3),
        runTask(4),
        runTask(5),
      ])

      // Peak concurrency should never exceed 2
      expect(peakConcurrent).toBe(2)

      // All 5 tasks should have started and ended
      expect(taskOrder.filter((e) => e.startsWith('start:'))).toHaveLength(5)
      expect(taskOrder.filter((e) => e.startsWith('end:'))).toHaveLength(5)

      // Verify at no point more than 2 tasks are active
      let active = 0
      for (const entry of taskOrder) {
        if (entry.startsWith('start:')) active++
        if (entry.startsWith('end:')) active--
        expect(active).toBeLessThanOrEqual(2)
      }
    })
  })
})
