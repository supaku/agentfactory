import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { loadRepositoryConfig, RepositoryConfigSchema } from './repository-config.js'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

describe('loadRepositoryConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toBeNull()
    expect(mockExistsSync).toHaveBeenCalledWith('/some/repo/.agentfactory/config.yaml')
  })

  it('parses valid YAML with all fields', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/supaku/agentfactory
allowedProjects:
  - Agent
  - Dashboard
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/supaku/agentfactory',
      allowedProjects: ['Agent', 'Dashboard'],
    })
  })

  it('parses valid YAML with only required fields', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
  })

  it('throws on invalid schema — wrong kind', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: WorkflowTemplate
repository: github.com/supaku/agentfactory
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })

  it('throws on invalid schema — missing apiVersion', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `kind: RepositoryConfig
repository: github.com/supaku/agentfactory
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })

  it('throws on invalid schema — allowedProjects is not an array', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
allowedProjects: NotAnArray
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })
})

describe('RepositoryConfigSchema', () => {
  it('validates a complete config', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/repo',
      allowedProjects: ['ProjectA', 'ProjectB'],
    })
    expect(result.apiVersion).toBe('v1')
    expect(result.kind).toBe('RepositoryConfig')
    expect(result.repository).toBe('github.com/org/repo')
    expect(result.allowedProjects).toEqual(['ProjectA', 'ProjectB'])
  })

  it('validates a minimal config with only required fields', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.apiVersion).toBe('v1')
    expect(result.kind).toBe('RepositoryConfig')
    expect(result.repository).toBeUndefined()
    expect(result.allowedProjects).toBeUndefined()
  })

  it('rejects invalid kind', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        apiVersion: 'v1',
        kind: 'InvalidKind',
      })
    ).toThrow()
  })
})
