/**
 * TesslKitSource adapter tests
 *
 * All HTTP is mocked via a custom fetchFn injected at construction time.
 * No network access required. Gate real network calls behind:
 *   KIT_REGISTRY_E2E=1 pnpm test
 */

import { describe, it, expect } from 'vitest'
import {
  TesslKitSource,
  tesslTileToKitManifest,
  TESSL_API_BASE,
  type TesslApiTile,
  type TesslApiListResponse,
} from './tessl.js'
import { KIT_API_VERSION, validateKitManifest } from '../manifest.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TILE_REACT: TesslApiTile = {
  id: 'react-docs',
  name: 'React Documentation',
  description: 'React 18 API docs as prompt fragments',
  version: '1.2.0',
  publisher: 'react-team',
  homepage: 'https://react.dev',
  license: 'MIT',
  skills: [
    { id: 'tessl/react-docs/hooks', url: 'https://registry.tessl.io/skills/react-hooks.md' },
  ],
  docs: [
    {
      id: 'tessl/react-docs/api-overview',
      url: 'https://registry.tessl.io/docs/react-api.md',
      workTypes: ['development', 'qa'],
    },
  ],
  mcpServers: [
    {
      name: 'react-context',
      command: 'node',
      args: ['servers/react-mcp.js'],
      description: 'React component graph queries',
    },
  ],
}

const TILE_MINIMAL: TesslApiTile = {
  id: 'minimal-tile',
  name: 'Minimal Tile',
  version: '0.1.0',
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
// tesslTileToKitManifest — normalizer
// ---------------------------------------------------------------------------

describe('tesslTileToKitManifest', () => {
  it('produces a KitManifest with the correct api version', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.api).toBe(KIT_API_VERSION)
  })

  it('sets kit.id to tessl/<tile.id>', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.kit.id).toBe('tessl/react-docs')
  })

  it('carries tile identity fields', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.kit.version).toBe('1.2.0')
    expect(manifest.kit.name).toBe('React Documentation')
    expect(manifest.kit.description).toBe('React 18 API docs as prompt fragments')
    expect(manifest.kit.author).toBe('react-team')
    expect(manifest.kit.license).toBe('MIT')
    expect(manifest.kit.homepage).toBe('https://react.dev')
  })

  it('sets authorIdentity to a DID from publisher', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.kit.authorIdentity).toMatch(/^did:web:registry\.tessl\.io\/publishers\//)
    expect(manifest.kit.authorIdentity).toContain('react-team')
  })

  it('has no detect rules (always-applicable)', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.detect).toBeUndefined()
  })

  it('has no supports block (platform-agnostic)', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.supports).toBeUndefined()
  })

  it('sets composition.order to project', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.composition?.order).toBe('project')
  })

  it('sets priority to 20', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.kit.priority).toBe(20)
  })

  it('maps tile.skills to provide.skills', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    expect(manifest.provide?.skills).toHaveLength(1)
    expect(manifest.provide?.skills?.[0].id).toBe('tessl/react-docs/hooks')
    expect(manifest.provide?.skills?.[0].file).toBe('https://registry.tessl.io/skills/react-hooks.md')
  })

  it('maps tile.docs to provide.prompt_fragments', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    const frags = manifest.provide?.prompt_fragments
    expect(frags).toHaveLength(1)
    expect(frags?.[0].partial).toBe('tessl/react-docs/api-overview')
    expect(frags?.[0].file).toBe('https://registry.tessl.io/docs/react-api.md')
    expect(frags?.[0].when).toEqual(['development', 'qa'])
  })

  it('maps tile.mcpServers to provide.mcp_servers', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    const servers = manifest.provide?.mcp_servers
    expect(servers).toHaveLength(1)
    expect(servers?.[0].name).toBe('react-context')
    expect(servers?.[0].command).toBe('node')
    expect(servers?.[0].args).toEqual(['servers/react-mcp.js'])
    expect(servers?.[0].description).toBe('React component graph queries')
  })

  it('handles a minimal tile with no skills/docs/servers', () => {
    const manifest = tesslTileToKitManifest(TILE_MINIMAL)
    expect(manifest.kit.id).toBe('tessl/minimal-tile')
    expect(manifest.provide).toBeUndefined()
    expect(manifest.kit.authorIdentity).toBeUndefined()
  })

  it('produces a manifest that passes validateKitManifest', () => {
    const manifest = tesslTileToKitManifest(TILE_REACT)
    const result = validateKitManifest(manifest)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TesslKitSource.fetchById
// ---------------------------------------------------------------------------

describe('TesslKitSource.fetchById', () => {
  it('fetches a tile by id and synthesizes a valid manifest', async () => {
    const fetchFn = makeJsonFetch(TILE_REACT)
    const source = new TesslKitSource({ fetchFn })

    const result = await source.fetchById('react-docs')
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.manifest.kit.id).toBe('tessl/react-docs')
    expect(result.sourceUrl).toContain('react-docs')
  })

  it('uses the correct endpoint URL', async () => {
    let capturedUrl = ''
    const fetchFn: typeof fetch = async (url) => {
      capturedUrl = url.toString()
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(TILE_REACT),
      } as unknown as Response
    }

    const source = new TesslKitSource({ fetchFn })
    await source.fetchById('react-docs')
    expect(capturedUrl).toBe(`${TESSL_API_BASE}/tiles/react-docs`)
  })

  it('sends Authorization header when apiToken is set', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchFn: typeof fetch = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(TILE_REACT),
      } as unknown as Response
    }

    const source = new TesslKitSource({ fetchFn, apiToken: 'test-token-123' })
    await source.fetchById('react-docs')
    expect(capturedHeaders['Authorization']).toBe('Bearer test-token-123')
  })

  it('throws on non-200 HTTP responses', async () => {
    const fetchFn = makeJsonFetch({}, 404)
    const source = new TesslKitSource({ fetchFn })
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
        json: () => Promise.resolve(TILE_REACT),
      } as unknown as Response
    }

    const source = new TesslKitSource({
      fetchFn,
      apiBase: 'https://custom.tessl.example.com/v2',
    })
    await source.fetchById('react-docs')
    expect(capturedUrl).toContain('custom.tessl.example.com/v2')
  })
})

// ---------------------------------------------------------------------------
// TesslKitSource.fetchAll — pagination
// ---------------------------------------------------------------------------

describe('TesslKitSource.fetchAll', () => {
  it('returns all tiles from a single page', async () => {
    const listResponse: TesslApiListResponse = {
      tiles: [TILE_REACT, TILE_MINIMAL],
    }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new TesslKitSource({ fetchFn })

    const results = await source.fetchAll()
    expect(results).toHaveLength(2)
    expect(results[0].manifest.kit.id).toBe('tessl/react-docs')
    expect(results[1].manifest.kit.id).toBe('tessl/minimal-tile')
  })

  it('follows cursor pagination across pages', async () => {
    const calls: string[] = []
    const page1: TesslApiListResponse = { tiles: [TILE_REACT], nextCursor: 'cursor-abc' }
    const page2: TesslApiListResponse = { tiles: [TILE_MINIMAL] }

    const fetchFn: typeof fetch = async (url) => {
      const u = url.toString()
      calls.push(u)
      const response = u.includes('cursor-abc') ? page2 : page1
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(response),
      } as unknown as Response
    }

    const source = new TesslKitSource({ fetchFn })
    const results = await source.fetchAll()

    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('cursor-abc')
    expect(results).toHaveLength(2)
  })

  it('respects maxTiles limit', async () => {
    const listResponse: TesslApiListResponse = {
      tiles: [TILE_REACT, TILE_MINIMAL],
    }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new TesslKitSource({ fetchFn, maxTiles: 1 })

    const results = await source.fetchAll()
    expect(results).toHaveLength(1)
    expect(results[0].manifest.kit.id).toBe('tessl/react-docs')
  })

  it('returns empty array when registry returns no tiles', async () => {
    const listResponse: TesslApiListResponse = { tiles: [] }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new TesslKitSource({ fetchFn })

    const results = await source.fetchAll()
    expect(results).toHaveLength(0)
  })

  it('propagates validation errors in the result without throwing', async () => {
    // A tile with an empty id would fail validateKitManifest
    const badTile: TesslApiTile = { id: '', name: '', version: '1.0.0' }
    const listResponse: TesslApiListResponse = { tiles: [badTile] }
    const fetchFn = makeJsonFetch(listResponse)
    const source = new TesslKitSource({ fetchFn })

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

describe.skipIf(!runE2E)('TesslKitSource E2E (KIT_REGISTRY_E2E=1)', () => {
  it('fetches tiles from the live Tessl registry', async () => {
    const source = new TesslKitSource({
      maxTiles: 5,
      apiToken: process.env.TESSL_API_TOKEN,
    })
    const results = await source.fetchAll()
    // Registry may be empty or have items — we just want no exceptions
    expect(Array.isArray(results)).toBe(true)
    for (const r of results) {
      expect(r.manifest.kit.id).toMatch(/^tessl\//)
    }
  })
})
