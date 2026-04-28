/**
 * AgentSkillsKitSource adapter tests
 *
 * All HTTP is mocked via a custom fetchFn injected at construction time.
 * No network access required. Gate real network calls behind:
 *   KIT_REGISTRY_E2E=1 pnpm test
 */

import { describe, it, expect } from 'vitest'
import {
  AgentSkillsKitSource,
  agentSkillToKitManifest,
  AGENTSKILLS_API_BASE,
  type AgentSkillsApiSkill,
  type AgentSkillsApiListResponse,
} from './agentskills.js'
import { KIT_API_VERSION, validateKitManifest } from '../manifest.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SKILL_WEB_SEARCH: AgentSkillsApiSkill = {
  id: 'anthropic/web-search',
  name: 'Web Search',
  description: 'Perform web searches and retrieve structured results',
  version: '2.1.0',
  skillUrl: 'https://agentskills.io/skills/anthropic/web-search/SKILL.md',
  publisher: 'Anthropic',
  homepage: 'https://anthropic.com/skills/web-search',
  license: 'Apache-2.0',
  workTypes: ['development', 'research'],
  tags: ['web', 'search', 'anthropic'],
}

const SKILL_MINIMAL: AgentSkillsApiSkill = {
  id: 'community/simple-tool',
  name: 'Simple Tool',
  version: '0.1.0',
  skillUrl: 'https://agentskills.io/skills/community/simple-tool/SKILL.md',
}

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function makeJsonFetch<T>(response: T, status = 200): typeof fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    if (status !== 200) {
      return {
        ok: false,
        status,
        statusText: 'Error',
        json: () => Promise.resolve(response),
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(response),
    } as unknown as Response
  }
}

// ---------------------------------------------------------------------------
// agentSkillToKitManifest — normalizer
// ---------------------------------------------------------------------------

describe('agentSkillToKitManifest', () => {
  it('produces a KitManifest with the correct api version', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.api).toBe(KIT_API_VERSION)
  })

  it('sets kit.id to agentskills/<skill.id>', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.kit.id).toBe('agentskills/anthropic/web-search')
  })

  it('carries skill identity fields', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.kit.version).toBe('2.1.0')
    expect(manifest.kit.name).toBe('Web Search')
    expect(manifest.kit.description).toBe('Perform web searches and retrieve structured results')
    expect(manifest.kit.author).toBe('Anthropic')
    expect(manifest.kit.license).toBe('Apache-2.0')
    expect(manifest.kit.homepage).toBe('https://anthropic.com/skills/web-search')
  })

  it('sets authorIdentity to a DID from publisher', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.kit.authorIdentity).toMatch(/^did:web:agentskills\.io\/publishers\//)
    expect(manifest.kit.authorIdentity).toContain('Anthropic')
  })

  it('has no detect rules (always-applicable)', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.detect).toBeUndefined()
  })

  it('has no supports block (platform-agnostic)', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.supports).toBeUndefined()
  })

  it('sets composition.order to project', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.composition?.order).toBe('project')
  })

  it('sets priority to 10 (lower than Tessl)', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.kit.priority).toBe(10)
  })

  it('maps skill.skillUrl to provide.skills[0].file', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.provide?.skills).toHaveLength(1)
    expect(manifest.provide?.skills?.[0].file).toBe(
      'https://agentskills.io/skills/anthropic/web-search/SKILL.md',
    )
    expect(manifest.provide?.skills?.[0].id).toBe('anthropic/web-search')
  })

  it('has exactly one skill and no other contribution types', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    expect(manifest.provide?.skills).toHaveLength(1)
    expect(manifest.provide?.prompt_fragments).toBeUndefined()
    expect(manifest.provide?.mcp_servers).toBeUndefined()
    expect(manifest.provide?.agents).toBeUndefined()
  })

  it('handles a minimal skill with only required fields', () => {
    const manifest = agentSkillToKitManifest(SKILL_MINIMAL)
    expect(manifest.kit.id).toBe('agentskills/community/simple-tool')
    expect(manifest.provide?.skills).toHaveLength(1)
    expect(manifest.kit.authorIdentity).toBeUndefined()
  })

  it('produces a manifest that passes validateKitManifest', () => {
    const manifest = agentSkillToKitManifest(SKILL_WEB_SEARCH)
    const result = validateKitManifest(manifest)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AgentSkillsKitSource.fetchById
// ---------------------------------------------------------------------------

describe('AgentSkillsKitSource.fetchById', () => {
  it('fetches a skill by id and synthesizes a valid manifest', async () => {
    const fetchFn = makeJsonFetch(SKILL_WEB_SEARCH)
    const source = new AgentSkillsKitSource({ fetchFn })

    const result = await source.fetchById('anthropic/web-search')
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.manifest.kit.id).toBe('agentskills/anthropic/web-search')
    expect(result.sourceUrl).toContain('anthropic')
  })

  it('uses the correct endpoint URL', async () => {
    let capturedUrl = ''
    const fetchFn: typeof fetch = async (url) => {
      capturedUrl = url.toString()
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(SKILL_WEB_SEARCH),
      } as unknown as Response
    }

    const source = new AgentSkillsKitSource({ fetchFn })
    await source.fetchById('anthropic/web-search')
    expect(capturedUrl).toContain(AGENTSKILLS_API_BASE)
    expect(capturedUrl).toContain('anthropic')
  })

  it('sends Authorization header when apiToken is set', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchFn: typeof fetch = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(SKILL_WEB_SEARCH),
      } as unknown as Response
    }

    const source = new AgentSkillsKitSource({ fetchFn, apiToken: 'as-token-456' })
    await source.fetchById('anthropic/web-search')
    expect(capturedHeaders['Authorization']).toBe('Bearer as-token-456')
  })

  it('throws on non-200 HTTP responses', async () => {
    const fetchFn = makeJsonFetch({}, 404)
    const source = new AgentSkillsKitSource({ fetchFn })
    await expect(source.fetchById('nonexistent')).rejects.toThrow(/404/)
  })

  it('respects custom apiBase', async () => {
    let capturedUrl = ''
    const fetchFn: typeof fetch = async (url) => {
      capturedUrl = url.toString()
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(SKILL_WEB_SEARCH),
      } as unknown as Response
    }

    const source = new AgentSkillsKitSource({
      fetchFn,
      apiBase: 'https://staging.agentskills.example.com/api/v2',
    })
    await source.fetchById('anthropic/web-search')
    expect(capturedUrl).toContain('staging.agentskills.example.com/api/v2')
  })
})

// ---------------------------------------------------------------------------
// AgentSkillsKitSource.fetchAll — pagination + filtering
// ---------------------------------------------------------------------------

describe('AgentSkillsKitSource.fetchAll', () => {
  it('returns all skills from a single page', async () => {
    const listResponse: AgentSkillsApiListResponse = {
      skills: [SKILL_WEB_SEARCH, SKILL_MINIMAL],
    }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new AgentSkillsKitSource({ fetchFn })

    const results = await source.fetchAll()
    expect(results).toHaveLength(2)
    expect(results[0].manifest.kit.id).toBe('agentskills/anthropic/web-search')
    expect(results[1].manifest.kit.id).toBe('agentskills/community/simple-tool')
  })

  it('follows cursor pagination across pages', async () => {
    const calls: string[] = []
    const page1: AgentSkillsApiListResponse = {
      skills: [SKILL_WEB_SEARCH],
      nextCursor: 'cursor-xyz',
    }
    const page2: AgentSkillsApiListResponse = { skills: [SKILL_MINIMAL] }

    const fetchFn: typeof fetch = async (url) => {
      const u = url.toString()
      calls.push(u)
      const response = u.includes('cursor-xyz') ? page2 : page1
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(response),
      } as unknown as Response
    }

    const source = new AgentSkillsKitSource({ fetchFn })
    const results = await source.fetchAll()

    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('cursor-xyz')
    expect(results).toHaveLength(2)
  })

  it('respects maxSkills limit', async () => {
    const listResponse: AgentSkillsApiListResponse = {
      skills: [SKILL_WEB_SEARCH, SKILL_MINIMAL],
    }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new AgentSkillsKitSource({ fetchFn, maxSkills: 1 })

    const results = await source.fetchAll()
    expect(results).toHaveLength(1)
  })

  it('appends filterTags as query param', async () => {
    let capturedUrl = ''
    const listResponse: AgentSkillsApiListResponse = { skills: [] }
    const fetchFn: typeof fetch = async (url) => {
      capturedUrl = url.toString()
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(listResponse),
      } as unknown as Response
    }

    const source = new AgentSkillsKitSource({ fetchFn, filterTags: ['web', 'anthropic'] })
    await source.fetchAll()
    expect(capturedUrl).toContain('tags=web%2Canthopic'.split('%2C')[0])
    expect(capturedUrl).toContain('tags=')
  })

  it('returns empty array when registry returns no skills', async () => {
    const listResponse: AgentSkillsApiListResponse = { skills: [] }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new AgentSkillsKitSource({ fetchFn })

    const results = await source.fetchAll()
    expect(results).toHaveLength(0)
  })

  it('propagates validation errors in the result without throwing', async () => {
    // A skill with an empty id would fail validateKitManifest
    const badSkill: AgentSkillsApiSkill = {
      id: '',
      name: '',
      version: '1.0.0',
      skillUrl: 'https://agentskills.io/skills/bad/SKILL.md',
    }
    const listResponse: AgentSkillsApiListResponse = { skills: [badSkill] }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new AgentSkillsKitSource({ fetchFn })

    const results = await source.fetchAll()
    expect(results).toHaveLength(1)
    expect(results[0].valid).toBe(false)
    expect(results[0].errors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// E2E — gated behind KIT_REGISTRY_E2E=1
// ---------------------------------------------------------------------------

const runE2E = process.env.KIT_REGISTRY_E2E === '1'

describe.skipIf(!runE2E)('AgentSkillsKitSource E2E (KIT_REGISTRY_E2E=1)', () => {
  it('fetches skills from the live agentskills.io registry', async () => {
    const source = new AgentSkillsKitSource({
      maxSkills: 5,
      apiToken: process.env.AGENTSKILLS_API_TOKEN,
    })
    const results = await source.fetchAll()
    expect(Array.isArray(results)).toBe(true)
    for (const r of results) {
      expect(r.manifest.kit.id).toMatch(/^agentskills\//)
    }
  })
})
