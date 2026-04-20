import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryPlugin } from '../memory-plugin.js'
import { ObservationStore } from '../observation-store.js'
import { InMemoryStore } from '../memory-store.js'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

describe('createMemoryPlugin', () => {
  let store: ObservationStore
  let tools: SdkMcpToolDefinition<any>[]

  beforeEach(() => {
    store = new ObservationStore(new InMemoryStore())
    const plugin = createMemoryPlugin({ observationStore: store })
    tools = plugin.createTools({
      env: { LINEAR_SESSION_ID: 'test-session', PROJECT_NAME: 'test-project' },
      cwd: '/test',
    })
  })

  function findTool(name: string): SdkMcpToolDefinition<any> {
    const t = tools.find(t => t.name === name)
    if (!t) throw new Error(`Tool ${name} not found`)
    return t
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const t = findTool(name)
    return t.handler(args, {})
  }

  // ── Tool Registration ──────────────────────────────────────────

  it('creates 3 tools: remember, recall, forget', () => {
    expect(tools).toHaveLength(3)
    expect(tools.map(t => t.name).sort()).toEqual([
      'af_memory_forget',
      'af_memory_recall',
      'af_memory_remember',
    ])
  })

  it('returns empty tools when disabled', () => {
    const plugin = createMemoryPlugin({ enabled: false })
    const disabledTools = plugin.createTools({
      env: {},
      cwd: '/test',
    })
    expect(disabledTools).toHaveLength(0)
  })

  // ── af_memory_remember ───────────────────────────────────────���─

  it('remember stores item with content and returns ID', async () => {
    const result = await callTool('af_memory_remember', {
      content: 'This repo uses a non-standard migration pattern',
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.stored).toBe(true)
    expect(parsed.id).toBeTruthy()
    expect(parsed.content).toBe('This repo uses a non-standard migration pattern')
  })

  it('remember stores item with tags and scope', async () => {
    await callTool('af_memory_remember', {
      content: 'API uses rate limiting with Redis',
      tags: ['architecture', 'api'],
      scope: 'custom-project',
    })

    const all = await store.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].tags).toEqual(['architecture', 'api'])
    expect(all[0].projectScope).toBe('custom-project')
  })

  it('remember creates explicit memories with source: explicit', async () => {
    await callTool('af_memory_remember', {
      content: 'Important pattern discovered',
    })

    const all = await store.getAll()
    expect(all[0].source).toBe('explicit')
  })

  it('explicit memories have higher default weight than auto-captured', async () => {
    await callTool('af_memory_remember', {
      content: 'Explicitly remembered knowledge',
    })

    const all = await store.getAll()
    expect(all[0].weight).toBeGreaterThan(1.0)
  })

  // ── af_memory_recall ─────────────────────────────────────────��─

  it('recall with query returns ranked matching items', async () => {
    await callTool('af_memory_remember', {
      content: 'The database uses PostgreSQL with JSONB columns for flexible schemas',
    })
    await callTool('af_memory_remember', {
      content: 'Authentication uses OAuth 2.0 with refresh token rotation',
    })

    const result = await callTool('af_memory_recall', { query: 'database PostgreSQL' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.total).toBeGreaterThan(0)
    expect(parsed.results[0].content).toContain('PostgreSQL')
  })

  it('recall with tag filter returns only matching tags', async () => {
    await callTool('af_memory_remember', {
      content: 'API endpoint uses pagination with cursors',
      tags: ['api'],
    })
    await callTool('af_memory_remember', {
      content: 'Database connection pool size is set to 20',
      tags: ['database'],
    })

    const result = await callTool('af_memory_recall', {
      query: 'configuration',
      tags: ['api'],
    })
    const parsed = JSON.parse(result.content[0].text)
    // Only the API-tagged item should match
    for (const r of parsed.results) {
      expect(r.tags).toContain('api')
    }
  })

  it('recall with scope filter returns only matching scope', async () => {
    await callTool('af_memory_remember', {
      content: 'Project A uses Express.js for HTTP routing and middleware',
      scope: 'project-a',
    })
    await callTool('af_memory_remember', {
      content: 'Project B uses Fastify framework for high-performance HTTP handling',
      scope: 'project-b',
    })

    const result = await callTool('af_memory_recall', {
      query: 'HTTP framework',
      scope: 'project-a',
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.total).toBe(1)
    expect(parsed.results[0].content).toContain('Express')
  })

  it('recall returns empty results when no match', async () => {
    const result = await callTool('af_memory_recall', {
      query: 'nonexistent topic that nobody wrote about',
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.total).toBe(0)
    expect(parsed.results).toEqual([])
  })

  // ── af_memory_forget ─────────────────────────────────────────��─

  it('forget removes item by ID', async () => {
    const storeResult = await callTool('af_memory_remember', {
      content: 'Temporary knowledge to forget',
    })
    const { id } = JSON.parse(storeResult.content[0].text)

    const forgetResult = await callTool('af_memory_forget', { id })
    const parsed = JSON.parse(forgetResult.content[0].text)
    expect(parsed.deleted).toBe(true)

    // Verify it's gone from recall
    const allObs = await store.getAll()
    expect(allObs).toHaveLength(0)
  })

  it('forget with invalid ID returns descriptive error', async () => {
    const result = await callTool('af_memory_forget', { id: 'nonexistent-id' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.deleted).toBe(false)
    expect(parsed.error).toContain('nonexistent-id')
    expect(result.isError).toBe(true)
  })

  // ── Remember → Recall → Forget Integration ────────────────────

  it('remember → recall → matches', async () => {
    await callTool('af_memory_remember', {
      content: 'The GraphQL schema uses code-first approach with TypeGraphQL decorators',
    })

    const recallResult = await callTool('af_memory_recall', {
      query: 'GraphQL TypeGraphQL schema generation',
    })
    const parsed = JSON.parse(recallResult.content[0].text)
    expect(parsed.total).toBe(1)
    expect(parsed.results[0].content).toContain('TypeGraphQL')
  })

  it('remember → forget → recall returns empty', async () => {
    const storeResult = await callTool('af_memory_remember', {
      content: 'Stale knowledge about deprecated API endpoint',
    })
    const { id } = JSON.parse(storeResult.content[0].text)

    await callTool('af_memory_forget', { id })

    const recallResult = await callTool('af_memory_recall', {
      query: 'deprecated API',
    })
    const parsed = JSON.parse(recallResult.content[0].text)
    expect(parsed.total).toBe(0)
  })

  // ── Plugin Metadata ─────────────────────────────────────────���──

  it('plugin has correct name and description', () => {
    const plugin = createMemoryPlugin()
    expect(plugin.name).toBe('af-memory')
    expect(plugin.description).toContain('memory')
  })
})
