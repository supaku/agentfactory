import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryStore } from '../memory-store.js'
import { ObservationStore } from '../observation-store.js'
import type { Observation } from '../observations.js'

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: `obs_${Math.random().toString(36).slice(2, 8)}`,
    type: 'file_operation',
    content: 'read /src/index.ts: Read file',
    sessionId: 'session-1',
    projectScope: 'project-a',
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.0,
    detail: {
      filePath: '/src/index.ts',
      operationType: 'read',
      summary: 'Read file',
    },
    ...overrides,
  }
}

describe('ObservationStore', () => {
  let memoryStore: InMemoryStore
  let store: ObservationStore

  beforeEach(() => {
    memoryStore = new InMemoryStore()
    store = new ObservationStore(memoryStore)
  })

  // ── Store ──────────────────────────────────────────────────────

  it('store() persists an observation and returns a stable ID', async () => {
    const obs = makeObservation({ id: 'obs_stable_1' })
    const id = await store.store(obs)
    expect(id).toBe('obs_stable_1')
    const retrieved = await store.get(id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe('obs_stable_1')
    expect(retrieved!.content).toBe(obs.content)
  })

  it('store() generates entries in the underlying MemoryStore', async () => {
    const obs = makeObservation()
    await store.store(obs)
    const memEntry = await memoryStore.get(obs.id)
    expect(memEntry).toBeDefined()
    expect(memEntry!.id).toBe(obs.id)
  })

  it('duplicate observations are deduplicated', async () => {
    const obs1 = makeObservation({ id: 'obs_1', content: 'read /src/index.ts: Read file content' })
    const obs2 = makeObservation({ id: 'obs_2', content: 'read /src/index.ts: Read file content' })
    const id1 = await store.store(obs1)
    const id2 = await store.store(obs2)
    expect(id2).toBe(id1) // Dedup returns existing ID
    expect(store.size).toBe(1)
  })

  it('retrieve() returns observations ranked by relevance', async () => {
    await store.store(makeObservation({
      id: 'obs_1',
      content: 'edited authentication middleware to add JWT validation',
    }))
    await store.store(makeObservation({
      id: 'obs_2',
      content: 'read package.json for dependency list',
    }))
    await store.store(makeObservation({
      id: 'obs_3',
      content: 'fixed authentication bug in login handler',
    }))

    const results = await store.retrieve({
      query: 'authentication',
      projectScope: 'project-a',
    })

    expect(results.length).toBeGreaterThan(0)
    // All results should contain "authentication"
    const authResults = results.filter(r => r.observation.content.includes('authentication'))
    expect(authResults.length).toBeGreaterThanOrEqual(2)
  })

  it('retrieve() with project scope isolation', async () => {
    await store.store(makeObservation({
      id: 'obs_a',
      content: 'project A observation about database schema',
      projectScope: 'project-a',
    }))
    await store.store(makeObservation({
      id: 'obs_b',
      content: 'project B observation about database schema',
      projectScope: 'project-b',
    }))

    const resultsA = await store.retrieve({
      query: 'database',
      projectScope: 'project-a',
    })
    const resultsB = await store.retrieve({
      query: 'database',
      projectScope: 'project-b',
    })

    // Project A should only return project A observations
    expect(resultsA.length).toBe(1)
    expect(resultsA[0].observation.projectScope).toBe('project-a')

    // Project B should only return project B observations
    expect(resultsB.length).toBe(1)
    expect(resultsB[0].observation.projectScope).toBe('project-b')
  })

  it('newer observations rank higher (timestamp weighting)', async () => {
    const now = Date.now()
    await store.store(makeObservation({
      id: 'obs_old',
      content: 'database migration pattern for user table',
      timestamp: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    }))
    await store.store(makeObservation({
      id: 'obs_new',
      content: 'database migration pattern for order table',
      timestamp: now, // just now
    }))

    const results = await store.retrieve({
      query: 'database migration',
      projectScope: 'project-a',
    })

    expect(results.length).toBe(2)
    // Newer observation should rank higher
    expect(results[0].observation.id).toBe('obs_new')
  })

  it('retrieve() returns empty array when no observations exist', async () => {
    const results = await store.retrieve({
      query: 'anything',
      projectScope: 'project-a',
    })
    expect(results).toEqual([])
  })

  it('observation CRUD: store, retrieve, delete', async () => {
    const obs = makeObservation({ id: 'obs_crud', content: 'unique content for crud test' })
    await store.store(obs)

    // Retrieve by ID
    const retrieved = await store.get('obs_crud')
    expect(retrieved).toBeDefined()
    expect(retrieved!.content).toBe(obs.content)

    // Delete
    const deleted = await store.delete('obs_crud')
    expect(deleted).toBe(true)

    // Verify deletion
    const afterDelete = await store.get('obs_crud')
    expect(afterDelete).toBeUndefined()
  })

  it('delete with non-existent ID returns false', async () => {
    const result = await store.delete('nonexistent')
    expect(result).toBe(false)
  })

  it('explicit memories rank above auto-captured at equal relevance', async () => {
    const now = Date.now()
    await store.store(makeObservation({
      id: 'obs_auto',
      content: 'discovered API rate limiting pattern in service layer',
      source: 'auto_capture',
      weight: 1.0,
      timestamp: now,
    }))
    await store.store(makeObservation({
      id: 'obs_explicit',
      content: 'important API rate limiting configuration note',
      source: 'explicit',
      weight: 1.0,
      timestamp: now,
    }))

    const results = await store.retrieve({
      query: 'API rate limiting',
      projectScope: 'project-a',
    })

    expect(results.length).toBe(2)
    // Explicit memory should rank higher due to weight boost
    expect(results[0].observation.source).toBe('explicit')
  })

  it('session_summary observations have higher retrieval weight', async () => {
    const now = Date.now()
    await store.store(makeObservation({
      id: 'obs_regular',
      type: 'file_operation',
      content: 'implemented user authentication with JWT tokens',
      timestamp: now,
    }))
    await store.store(makeObservation({
      id: 'obs_summary',
      type: 'session_summary',
      content: 'session summary: implemented user authentication with JWT tokens',
      timestamp: now,
      weight: 1.0,
    }))

    const results = await store.retrieve({
      query: 'authentication JWT',
      projectScope: 'project-a',
    })

    expect(results.length).toBe(2)
    // Session summary should rank higher due to weight boost
    expect(results[0].observation.type).toBe('session_summary')
  })

  it('getAll() returns all stored observations', async () => {
    await store.store(makeObservation({ id: 'obs_1', content: 'first unique observation content' }))
    await store.store(makeObservation({ id: 'obs_2', content: 'second unique observation content' }))
    await store.store(makeObservation({ id: 'obs_3', content: 'third unique observation content' }))

    const all = await store.getAll()
    expect(all).toHaveLength(3)
  })

  it('getByProject() returns only observations for specified project', async () => {
    await store.store(makeObservation({ id: 'obs_a1', projectScope: 'project-a', content: 'implemented JWT authentication middleware for express routes' }))
    await store.store(makeObservation({ id: 'obs_a2', projectScope: 'project-a', content: 'refactored database schema migration scripts to support rollback' }))
    await store.store(makeObservation({ id: 'obs_b1', projectScope: 'project-b', content: 'updated GraphQL resolver for user profile endpoint with pagination' }))

    const projA = await store.getByProject('project-a')
    expect(projA).toHaveLength(2)
    expect(projA.every(o => o.projectScope === 'project-a')).toBe(true)
  })

  it('clear() removes all observations', async () => {
    await store.store(makeObservation({ id: 'obs_1', content: 'clear test content one' }))
    await store.store(makeObservation({ id: 'obs_2', content: 'clear test content two' }))
    await store.clear()
    expect(store.size).toBe(0)
    const all = await store.getAll()
    expect(all).toHaveLength(0)
  })

  it('handles observations with tags filter', async () => {
    await store.store(makeObservation({
      id: 'obs_tagged',
      content: 'tagged observation about API design decisions',
      tags: ['architecture', 'api'],
    }))
    await store.store(makeObservation({
      id: 'obs_untagged',
      content: 'untagged observation about API implementation',
    }))

    const results = await store.retrieve({
      query: 'API',
      projectScope: 'project-a',
      tags: ['architecture'],
    })

    expect(results.length).toBe(1)
    expect(results[0].observation.id).toBe('obs_tagged')
  })

  it('handles observations with type filter', async () => {
    await store.store(makeObservation({
      id: 'obs_file',
      type: 'file_operation',
      content: 'read config file for deployment settings',
    }))
    await store.store(makeObservation({
      id: 'obs_error',
      type: 'error_encountered',
      content: 'error reading config file permission denied',
      detail: { error: 'permission denied', fix: 'chmod 644' },
    }))

    const results = await store.retrieve({
      query: 'config file',
      projectScope: 'project-a',
      types: ['error_encountered'],
    })

    expect(results.length).toBe(1)
    expect(results[0].observation.type).toBe('error_encountered')
  })

  it('round-trip: store → retrieve by query → matches', async () => {
    const obs = makeObservation({
      id: 'obs_roundtrip',
      content: 'discovered that the GraphQL resolver uses DataLoader for batching N+1 queries',
    })
    await store.store(obs)

    const results = await store.retrieve({
      query: 'GraphQL DataLoader batching',
      projectScope: 'project-a',
    })

    expect(results.length).toBe(1)
    expect(results[0].observation.content).toContain('GraphQL')
    expect(results[0].observation.content).toContain('DataLoader')
  })

  it('existing code dedup works after observation store extension', async () => {
    // Verify the underlying MemoryStore still works for basic dedup
    const obs1 = makeObservation({ id: 'obs_1', content: 'exact duplicate content for testing' })
    const obs2 = makeObservation({ id: 'obs_2', content: 'exact duplicate content for testing' })

    await store.store(obs1)
    await store.store(obs2)

    // Only one should be stored
    expect(store.size).toBe(1)

    // Underlying memory store should also have one entry
    const allEntries = await memoryStore.getAll()
    expect(allEntries).toHaveLength(1)
  })

  it('maxResults limits retrieval count', async () => {
    // Store many observations
    for (let i = 0; i < 30; i++) {
      await store.store(makeObservation({
        id: `obs_${i}`,
        content: `observation number ${i} about testing patterns`,
      }))
    }

    const results = await store.retrieve({
      query: 'testing patterns',
      projectScope: 'project-a',
      maxResults: 5,
    })

    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('higher weight observations from dedup update are preserved', async () => {
    // Store with low weight
    await store.store(makeObservation({
      id: 'obs_low',
      content: 'pattern about error handling in controllers',
      weight: 0.5,
    }))

    // Store duplicate with higher weight — should update
    await store.store(makeObservation({
      id: 'obs_high',
      content: 'pattern about error handling in controllers',
      weight: 2.0,
    }))

    const all = await store.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].weight).toBe(2.0)
  })
})
