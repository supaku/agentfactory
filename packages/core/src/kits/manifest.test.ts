/**
 * Kit manifest schema parser + validator tests
 * Covers: TOML parsing, validation, OS/arch, detect rules
 */

import { describe, it, expect } from 'vitest'
import {
  parseKitManifest,
  validateKitManifest,
  KIT_API_VERSION,
  parseToml,
  type KitManifest,
} from './manifest.js'

// ---------------------------------------------------------------------------
// parseToml
// ---------------------------------------------------------------------------

describe('parseToml', () => {
  it('parses basic key-value pairs', () => {
    const toml = `
api = "rensei.dev/v1"
count = 42
flag = true
`
    const result = parseToml(toml)
    expect(result.api).toBe('rensei.dev/v1')
    expect(result.count).toBe(42)
    expect(result.flag).toBe(true)
  })

  it('parses [section] tables', () => {
    const toml = `
[kit]
id = "test/kit"
version = "1.0.0"
`
    const result = parseToml(toml)
    expect((result.kit as Record<string, unknown>).id).toBe('test/kit')
    expect((result.kit as Record<string, unknown>).version).toBe('1.0.0')
  })

  it('parses array values', () => {
    const toml = `
[supports]
os = ["linux", "macos"]
arch = ["x86_64", "arm64"]
`
    const result = parseToml(toml)
    const supports = result.supports as Record<string, unknown>
    expect(supports.os).toEqual(['linux', 'macos'])
    expect(supports.arch).toEqual(['x86_64', 'arm64'])
  })

  it('parses [[array-of-tables]]', () => {
    const toml = `
[[provide.tool_permissions]]
shell = "pnpm *"

[[provide.tool_permissions]]
shell = "node *"
`
    const result = parseToml(toml)
    const provide = result.provide as Record<string, unknown>
    const perms = provide.tool_permissions as Array<Record<string, unknown>>
    expect(perms).toHaveLength(2)
    expect(perms[0].shell).toBe('pnpm *')
    expect(perms[1].shell).toBe('node *')
  })

  it('parses nested [provide.commands] table', () => {
    const toml = `
[provide.commands]
build = "pnpm build"
test = "pnpm test"
`
    const result = parseToml(toml)
    const provide = result.provide as Record<string, unknown>
    const cmds = provide.commands as Record<string, unknown>
    expect(cmds.build).toBe('pnpm build')
    expect(cmds.test).toBe('pnpm test')
  })

  it('strips inline comments', () => {
    const toml = `
api = "rensei.dev/v1" # this is a comment
count = 5 # another comment
`
    const result = parseToml(toml)
    expect(result.api).toBe('rensei.dev/v1')
    expect(result.count).toBe(5)
  })

  it('handles single-quoted strings', () => {
    const toml = `
[detect]
exec = 'bin/detect'
`
    const result = parseToml(toml)
    const detect = result.detect as Record<string, unknown>
    expect(detect.exec).toBe('bin/detect')
  })
})

// ---------------------------------------------------------------------------
// parseKitManifest
// ---------------------------------------------------------------------------

describe('parseKitManifest', () => {
  it('parses a minimal valid kit.toml', () => {
    const toml = `
api = "rensei.dev/v1"

[kit]
id = "test/minimal"
version = "1.0.0"
name = "Minimal Kit"
`
    const manifest = parseKitManifest(toml)
    expect(manifest.api).toBe(KIT_API_VERSION)
    expect(manifest.kit.id).toBe('test/minimal')
  })

  it('parses a full kit.toml with all sections', () => {
    const toml = `
api = "rensei.dev/v1"

[kit]
id = "ts/nextjs"
version = "1.0.0"
name = "TypeScript/Next.js"
priority = 80

[supports]
os = ["linux", "macos", "windows"]
arch = ["x86_64", "arm64"]

[detect]
files = ["package.json", "next.config.ts", "next.config.js", "next.config.mjs"]
exec = "bin/detect"

[detect.toolchain]
node = "22"

[provide.commands]
build = "pnpm build"
test = "pnpm test"
validate = "pnpm typecheck"

[[provide.tool_permissions]]
shell = "pnpm *"

[[provide.prompt_fragments]]
partial = "ts-conventions"
when = ["development", "qa"]
file = "partials/ts-conventions.yaml"

[[provide.mcp_servers]]
name = "ts-context"
command = "./bin/ts-mcp"

[[provide.skills]]
file = "skills/ts-debugging/SKILL.md"

[[provide.agents]]
id = "ts-test-fixer"
template = "agents/ts-test-fixer.yaml"
work_types = ["qa"]

[[provide.a2a_skills]]
id = "ts-pr-reviewer"
description = "Reviews TS/Next.js PRs"
endpoint = "agents/ts-pr-reviewer.yaml"

[[provide.intelligence_extractors]]
name = "ts-export-extractor"
language = "typescript"
emits = ["export", "type"]

[provide.workarea_config]
clean_dirs = [".next", "dist"]
preserve_dirs = ["~/.npm"]

[provide.toolchain_install.linux]
node_22 = "nvm install 22"

[provide.toolchain_install.macos]
node_22 = "brew install node@22"

[provide.hooks]
post_acquire = "bin/setup.sh"
pre_release = "bin/teardown.sh"

[composition]
order = "framework"
conflicts_with = ["spring/java"]
composes_with = ["docker-compose"]
`
    const manifest = parseKitManifest(toml)
    expect(manifest.kit.id).toBe('ts/nextjs')
    expect(manifest.supports?.os).toEqual(['linux', 'macos', 'windows'])
    expect(manifest.detect?.files).toContain('package.json')
    expect(manifest.detect?.toolchain?.node).toBe('22')
    expect(manifest.provide?.commands?.build).toBe('pnpm build')
    expect(manifest.provide?.tool_permissions).toHaveLength(1)
    expect(manifest.provide?.prompt_fragments).toHaveLength(1)
    expect(manifest.provide?.mcp_servers).toHaveLength(1)
    expect(manifest.provide?.skills).toHaveLength(1)
    expect(manifest.provide?.agents).toHaveLength(1)
    expect(manifest.provide?.a2a_skills).toHaveLength(1)
    expect(manifest.provide?.intelligence_extractors).toHaveLength(1)
    expect(manifest.provide?.workarea_config?.clean_dirs).toContain('.next')
    expect(manifest.provide?.toolchain_install?.linux?.node_22).toBe('nvm install 22')
    expect(manifest.provide?.hooks?.post_acquire).toBe('bin/setup.sh')
    expect(manifest.composition?.order).toBe('framework')
  })
})

// ---------------------------------------------------------------------------
// validateKitManifest
// ---------------------------------------------------------------------------

describe('validateKitManifest', () => {
  function minimalManifest(overrides: Partial<KitManifest> = {}): KitManifest {
    return {
      api: KIT_API_VERSION,
      kit: {
        id: 'test/kit',
        version: '1.0.0',
        name: 'Test Kit',
      },
      ...overrides,
    }
  }

  it('validates a minimal valid manifest', () => {
    const result = validateKitManifest(minimalManifest())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects wrong api version', () => {
    const result = validateKitManifest({
      ...minimalManifest(),
      api: 'rensei.dev/v0' as typeof KIT_API_VERSION,
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('api'))).toBe(true)
  })

  it('rejects invalid semver in kit.version', () => {
    const result = validateKitManifest(
      minimalManifest({ kit: { id: 'x', version: 'not-semver', name: 'X' } })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('version'))).toBe(true)
  })

  it('rejects empty kit.id', () => {
    const result = validateKitManifest(
      minimalManifest({ kit: { id: '', version: '1.0.0', name: 'X' } })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('kit.id'))).toBe(true)
  })

  it('rejects empty kit.name', () => {
    const result = validateKitManifest(
      minimalManifest({ kit: { id: 'x', version: '1.0.0', name: '' } })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('kit.name'))).toBe(true)
  })

  it('rejects empty supports.os', () => {
    const result = validateKitManifest(
      minimalManifest({ supports: { os: [], arch: ['x86_64'] } })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('supports.os'))).toBe(true)
  })

  it('rejects duplicate mcp_server names', () => {
    const manifest = minimalManifest({
      provide: {
        mcp_servers: [
          { name: 'dup', command: 'cmd1' },
          { name: 'dup', command: 'cmd2' },
        ],
      },
    })
    const result = validateKitManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("'dup'"))).toBe(true)
  })

  it('rejects duplicate agent ids', () => {
    const manifest = minimalManifest({
      provide: {
        agents: [
          { id: 'my-agent', template: 'a.yaml' },
          { id: 'my-agent', template: 'b.yaml' },
        ],
      },
    })
    const result = validateKitManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("'my-agent'"))).toBe(true)
  })

  it('rejects duplicate a2a_skill ids', () => {
    const manifest = minimalManifest({
      provide: {
        a2a_skills: [
          { id: 'skill-a', endpoint: 'a.yaml' },
          { id: 'skill-a', endpoint: 'b.yaml' },
        ],
      },
    })
    const result = validateKitManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("'skill-a'"))).toBe(true)
  })

  it('collects multiple errors before returning', () => {
    const result = validateKitManifest({
      api: 'rensei.dev/v0' as typeof KIT_API_VERSION,
      kit: { id: '', version: 'bad', name: '' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})
