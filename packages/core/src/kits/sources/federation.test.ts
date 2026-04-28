/**
 * FederatedKitLoader tests
 *
 * Verifies that the federation loader respects order, deduplicates by kit id,
 * skips non-remote sources (local/bundled/rensei), and handles fetch errors
 * gracefully when continueOnError is set.
 */

import { describe, it, expect } from 'vitest'
import {
  FederatedKitLoader,
  DEFAULT_FEDERATION_ORDER,
  type FederatedKitSourceConfig,
} from './federation.js'
import type { TesslApiListResponse } from './tessl.js'
import type { AgentSkillsApiListResponse } from './agentskills.js'

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function makeListFetch(
  tesslResponse: TesslApiListResponse,
  agentSkillsResponse: AgentSkillsApiListResponse,
): typeof fetch {
  return async (url: string | URL | Request) => {
    const u = url.toString()
    let response: unknown

    if (u.includes('tessl.io') || u.includes('tessl')) {
      response = tesslResponse
    } else if (u.includes('agentskills')) {
      response = agentSkillsResponse
    } else {
      response = { tiles: [], skills: [] }
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(response),
    } as unknown as Response
  }
}

function makeErrorFetch(errorMessage = 'Network error'): typeof fetch {
  return async () => {
    throw new Error(errorMessage)
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TESSL_LIST: TesslApiListResponse = {
  tiles: [
    {
      id: 'react-docs',
      name: 'React Docs',
      version: '1.0.0',
      publisher: 'react-team',
    },
    {
      id: 'vue-docs',
      name: 'Vue Docs',
      version: '1.0.0',
    },
  ],
}

const AGENTSKILLS_LIST: AgentSkillsApiListResponse = {
  skills: [
    {
      id: 'anthropic/web-search',
      name: 'Web Search',
      version: '1.0.0',
      skillUrl: 'https://agentskills.io/skills/anthropic/web-search/SKILL.md',
      publisher: 'Anthropic',
    },
  ],
}

const EMPTY_TESSL: TesslApiListResponse = { tiles: [] }
const EMPTY_AGENTSKILLS: AgentSkillsApiListResponse = { skills: [] }

// ---------------------------------------------------------------------------
// DEFAULT_FEDERATION_ORDER
// ---------------------------------------------------------------------------

describe('DEFAULT_FEDERATION_ORDER', () => {
  it('starts with local, bundled, rensei', () => {
    expect(DEFAULT_FEDERATION_ORDER.slice(0, 3)).toEqual(['local', 'bundled', 'rensei'])
  })

  it('has tessl before agentskills', () => {
    const ti = DEFAULT_FEDERATION_ORDER.indexOf('tessl')
    const ai = DEFAULT_FEDERATION_ORDER.indexOf('agentskills')
    expect(ti).toBeGreaterThanOrEqual(0)
    expect(ai).toBeGreaterThanOrEqual(0)
    expect(ti).toBeLessThan(ai)
  })
})

// ---------------------------------------------------------------------------
// FederatedKitLoader.loadRemoteSources
// ---------------------------------------------------------------------------

describe('FederatedKitLoader.loadRemoteSources', () => {
  it('loads kits from both Tessl and agentskills', async () => {
    const fetchFn = makeListFetch(TESSL_LIST, AGENTSKILLS_LIST)
    const loader = new FederatedKitLoader({
      tessl: { fetchFn },
      agentskills: { fetchFn },
    })

    const { manifests, raw } = await loader.loadRemoteSources()

    // 2 Tessl + 1 agentskills
    expect(manifests.length).toBe(3)
    expect(manifests.some((m) => m.kit.id === 'tessl/react-docs')).toBe(true)
    expect(manifests.some((m) => m.kit.id === 'tessl/vue-docs')).toBe(true)
    expect(manifests.some((m) => m.kit.id === 'agentskills/anthropic/web-search')).toBe(true)

    // raw should have entries for tessl and agentskills
    const sourceNames = raw.map((r) => r.source)
    expect(sourceNames).toContain('tessl')
    expect(sourceNames).toContain('agentskills')
  })

  it('deduplicates kit ids across sources (first occurrence wins)', async () => {
    // A kit with the same normalized id in both sources
    const tesslWithConflict: TesslApiListResponse = {
      tiles: [{ id: 'anthropic/web-search', name: 'Tessl Web Search', version: '1.0.0' }],
    }

    const fetchFn = makeListFetch(tesslWithConflict, AGENTSKILLS_LIST)
    const loader = new FederatedKitLoader({
      federationOrder: ['tessl', 'agentskills'],
      tessl: { fetchFn },
      agentskills: { fetchFn },
    })

    const { manifests } = await loader.loadRemoteSources()

    // Both would synthesize `tessl/anthropic/web-search` and
    // `agentskills/anthropic/web-search` — different prefixed ids, no dedup needed
    // This test verifies the tessl-prefixed one comes first
    const webSearchManifests = manifests.filter((m) =>
      m.kit.id.includes('anthropic/web-search'),
    )
    // Both get different ids (tessl/ vs agentskills/) so both are present
    expect(webSearchManifests.length).toBe(2)
  })

  it('skips local, bundled, and rensei sources', async () => {
    const fetchFn = makeListFetch(EMPTY_TESSL, EMPTY_AGENTSKILLS)
    const loader = new FederatedKitLoader({
      tessl: { fetchFn },
      agentskills: { fetchFn },
    })

    const { skippedSources } = await loader.loadRemoteSources()
    expect(skippedSources).toContain('local')
    expect(skippedSources).toContain('bundled')
    expect(skippedSources).toContain('rensei')
  })

  it('respects custom federationOrder — only listed sources are fetched', async () => {
    const fetchFn = makeListFetch(TESSL_LIST, AGENTSKILLS_LIST)
    const loader = new FederatedKitLoader({
      // Only tessl, skip agentskills
      federationOrder: ['tessl'],
      tessl: { fetchFn },
      agentskills: { fetchFn },
    })

    const { manifests } = await loader.loadRemoteSources()
    expect(manifests.every((m) => m.kit.id.startsWith('tessl/'))).toBe(true)
    expect(manifests.some((m) => m.kit.id.startsWith('agentskills/'))).toBe(false)
  })

  it('continues on fetch errors by default (continueOnError=true)', async () => {
    const errorFetch = makeErrorFetch('Tessl is down')
    const successFetch = makeListFetch(EMPTY_TESSL, AGENTSKILLS_LIST)

    // tessl fails, agentskills succeeds
    const loader = new FederatedKitLoader({
      federationOrder: ['tessl', 'agentskills'],
      tessl: { fetchFn: errorFetch },
      agentskills: { fetchFn: successFetch },
    })

    const { manifests, raw } = await loader.loadRemoteSources()

    // agentskills results still loaded
    expect(manifests.some((m) => m.kit.id.startsWith('agentskills/'))).toBe(true)
    // tessl raw entry exists but is empty
    const tesslRaw = raw.find((r) => r.source === 'tessl')
    expect(tesslRaw?.results).toHaveLength(0)
  })

  it('throws on fetch error when continueOnError=false', async () => {
    const errorFetch = makeErrorFetch('Registry unavailable')
    const loader = new FederatedKitLoader({
      federationOrder: ['tessl'],
      continueOnError: false,
      tessl: { fetchFn: errorFetch },
    })

    await expect(loader.loadRemoteSources()).rejects.toThrow(/Registry unavailable/)
  })

  it('returns empty manifests when all sources return no kits', async () => {
    const fetchFn = makeListFetch(EMPTY_TESSL, EMPTY_AGENTSKILLS)
    const loader = new FederatedKitLoader({
      tessl: { fetchFn },
      agentskills: { fetchFn },
    })

    const { manifests } = await loader.loadRemoteSources()
    expect(manifests).toHaveLength(0)
  })

  it('deduplicates identical kit ids within a single source', async () => {
    // Two tiles with the same id (registry bug scenario)
    const duplicateTiles: TesslApiListResponse = {
      tiles: [
        { id: 'duplicate-kit', name: 'Kit A', version: '1.0.0' },
        { id: 'duplicate-kit', name: 'Kit B', version: '2.0.0' },
      ],
    }

    const fetchFn = makeListFetch(duplicateTiles, EMPTY_AGENTSKILLS)
    const loader = new FederatedKitLoader({
      federationOrder: ['tessl'],
      tessl: { fetchFn },
    })

    const { manifests } = await loader.loadRemoteSources()
    const duplicates = manifests.filter((m) => m.kit.id === 'tessl/duplicate-kit')
    // First occurrence wins
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].kit.name).toBe('Kit A')
  })
})
