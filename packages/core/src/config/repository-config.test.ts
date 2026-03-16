import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { loadRepositoryConfig, RepositoryConfigSchema, getEffectiveAllowedProjects, getProjectConfig, getProjectPath } from './repository-config.js'

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
repository: github.com/renseiai/agentfactory
allowedProjects:
  - Agent
  - Dashboard
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
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
repository: github.com/renseiai/agentfactory
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })

  it('throws on invalid schema — missing apiVersion', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `kind: RepositoryConfig
repository: github.com/renseiai/agentfactory
`
    )
    expect(() => loadRepositoryConfig('/some/repo')).toThrow()
  })

  it('parses valid YAML with projectPaths and sharedPaths', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/renseiai/renseiai
projectPaths:
  Social: apps/social
  Family: apps/family
sharedPaths:
  - packages/ui
  - packages/lexical
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/renseiai',
      projectPaths: { Social: 'apps/social', Family: 'apps/family' },
      sharedPaths: ['packages/ui', 'packages/lexical'],
    })
  })

  it('parses valid YAML with mixed string and object projectPaths', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/org/monorepo
projectPaths:
  Social: apps/social
  Family iOS:
    path: apps/family-ios
    packageManager: none
    buildCommand: "make build"
    testCommand: "make test"
sharedPaths:
  - packages/ui
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/monorepo',
      projectPaths: {
        Social: 'apps/social',
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
        },
      },
      sharedPaths: ['packages/ui'],
    })
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

  it('validates config with projectPaths only (string shorthand)', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/monorepo',
      projectPaths: {
        Social: 'apps/social',
        Family: 'apps/family',
      },
    })
    expect(result.projectPaths).toEqual({ Social: 'apps/social', Family: 'apps/family' })
    expect(result.allowedProjects).toBeUndefined()
  })

  it('validates config with projectPaths object form', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
          validateCommand: 'make build',
        },
      },
    })
    expect(result.projectPaths).toEqual({
      Social: 'apps/social',
      'Family iOS': {
        path: 'apps/family-ios',
        packageManager: 'none',
        buildCommand: 'make build',
        testCommand: 'make test',
        validateCommand: 'make build',
      },
    })
  })

  it('validates config with mixed string and object projectPaths', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        Family: 'apps/family',
        'Family iOS': { path: 'apps/family-ios', packageManager: 'none' },
      },
    })
    expect(Object.keys(result.projectPaths!)).toEqual(['Social', 'Family', 'Family iOS'])
  })

  it('validates config with projectPaths and sharedPaths', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        Family: 'apps/family',
      },
      sharedPaths: ['packages/ui', 'packages/lexical'],
    })
    expect(result.projectPaths).toEqual({ Social: 'apps/social', Family: 'apps/family' })
    expect(result.sharedPaths).toEqual(['packages/ui', 'packages/lexical'])
  })

  it('rejects config with both allowedProjects and projectPaths', () => {
    expect(() =>
      RepositoryConfigSchema.parse({
        apiVersion: 'v1',
        kind: 'RepositoryConfig',
        allowedProjects: ['Social'],
        projectPaths: { Social: 'apps/social' },
      })
    ).toThrow(/mutually exclusive/)
  })

  it('validates config with build/test/validate commands', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/native-project',
      buildCommand: 'cargo build --release',
      testCommand: 'cargo test',
      validateCommand: 'cargo clippy -- -D warnings',
    })
    expect(result.buildCommand).toBe('cargo build --release')
    expect(result.testCommand).toBe('cargo test')
    expect(result.validateCommand).toBe('cargo clippy -- -D warnings')
  })

  it('allows omitting build/test/validate commands', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(result.buildCommand).toBeUndefined()
    expect(result.testCommand).toBeUndefined()
    expect(result.validateCommand).toBeUndefined()
  })

  it('validates config with build commands and non-Node settings', () => {
    const result = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      packageManager: 'none',
      linearCli: 'bash tools/af-linear.sh',
      buildCommand: 'cmake --build build/',
      testCommand: 'ctest --test-dir build/',
    })
    expect(result.packageManager).toBe('none')
    expect(result.linearCli).toBe('bash tools/af-linear.sh')
    expect(result.buildCommand).toBe('cmake --build build/')
    expect(result.testCommand).toBe('ctest --test-dir build/')
  })
})

describe('loadRepositoryConfig with build commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses config with build/test/validate commands', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `apiVersion: v1
kind: RepositoryConfig
repository: github.com/org/native-project
packageManager: none
buildCommand: "cargo build --release"
testCommand: "cargo test"
validateCommand: "cargo clippy -- -D warnings"
`
    )
    const result = loadRepositoryConfig('/some/repo')
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/org/native-project',
      packageManager: 'none',
      buildCommand: 'cargo build --release',
      testCommand: 'cargo test',
      validateCommand: 'cargo clippy -- -D warnings',
    })
  })
})

describe('getEffectiveAllowedProjects', () => {
  it('returns keys from projectPaths when set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social', Family: 'apps/family' },
    })
    expect(getEffectiveAllowedProjects(config)).toEqual(['Social', 'Family'])
  })

  it('returns allowedProjects when projectPaths is not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      allowedProjects: ['Agent', 'Dashboard'],
    })
    expect(getEffectiveAllowedProjects(config)).toEqual(['Agent', 'Dashboard'])
  })

  it('returns undefined when neither is set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getEffectiveAllowedProjects(config)).toBeUndefined()
  })

  it('returns keys from mixed string/object projectPaths', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        Social: 'apps/social',
        'Family iOS': { path: 'apps/family-ios', packageManager: 'none' },
      },
    })
    expect(getEffectiveAllowedProjects(config)).toEqual(['Social', 'Family iOS'])
  })
})

describe('getProjectConfig', () => {
  it('returns null when projectPaths is not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getProjectConfig(config, 'Social')).toBeNull()
  })

  it('returns null for unknown project', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    expect(getProjectConfig(config, 'Unknown')).toBeNull()
  })

  it('normalizes string shorthand to ProjectConfig', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    const result = getProjectConfig(config, 'Social')
    expect(result).toEqual({
      path: 'apps/social',
      packageManager: undefined,
      buildCommand: undefined,
      testCommand: undefined,
      validateCommand: undefined,
    })
  })

  it('returns per-project overrides from object form', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: {
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
          validateCommand: 'make build',
        },
      },
    })
    const result = getProjectConfig(config, 'Family iOS')
    expect(result).toEqual({
      path: 'apps/family-ios',
      packageManager: 'none',
      buildCommand: 'make build',
      testCommand: 'make test',
      validateCommand: 'make build',
    })
  })

  it('falls back to repo-wide defaults when per-project overrides are not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      projectPaths: { Social: 'apps/social' },
    })
    const result = getProjectConfig(config, 'Social')
    expect(result).toEqual({
      path: 'apps/social',
      packageManager: undefined,
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      validateCommand: undefined,
    })
  })

  it('per-project overrides take precedence over repo-wide defaults', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      packageManager: 'pnpm',
      projectPaths: {
        'Family iOS': {
          path: 'apps/family-ios',
          packageManager: 'none',
          buildCommand: 'make build',
          testCommand: 'make test',
        },
      },
    })
    const result = getProjectConfig(config, 'Family iOS')
    expect(result).toEqual({
      path: 'apps/family-ios',
      packageManager: 'none',
      buildCommand: 'make build',
      testCommand: 'make test',
      validateCommand: undefined,
    })
  })
})

describe('getProjectPath', () => {
  it('returns path from string shorthand', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    expect(getProjectPath(config, 'Social')).toBe('apps/social')
  })

  it('returns path from object form', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { 'Family iOS': { path: 'apps/family-ios' } },
    })
    expect(getProjectPath(config, 'Family iOS')).toBe('apps/family-ios')
  })

  it('returns undefined for unknown project', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      projectPaths: { Social: 'apps/social' },
    })
    expect(getProjectPath(config, 'Unknown')).toBeUndefined()
  })

  it('returns undefined when projectPaths is not set', () => {
    const config = RepositoryConfigSchema.parse({
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
    })
    expect(getProjectPath(config, 'Social')).toBeUndefined()
  })
})
