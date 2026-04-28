/**
 * Kit composition algorithm tests
 * Covers: per-type merge rules, OS overrides, workType filtering, conflicts
 */

import { describe, it, expect } from 'vitest'
import { composeKits, resolveToolchainInstall } from './compose.js'
import type { KitManifest } from './manifest.js'
import { KIT_API_VERSION } from './manifest.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeKit(id: string, provide: KitManifest['provide'] = {}, extra: Partial<KitManifest> = {}): KitManifest {
  return {
    api: KIT_API_VERSION,
    kit: { id, version: '1.0.0', name: id },
    provide,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Commands — last-applied-wins
// ---------------------------------------------------------------------------

describe('commands composition — last-applied-wins', () => {
  it('foundation kit sets defaults; project kit overrides', () => {
    const foundation = makeKit('foundation', { commands: { build: 'npm run build', test: 'npm test' } })
    const project = makeKit('project', { commands: { build: 'pnpm build' } })
    const result = composeKits([foundation, project])
    expect(result.commands.build).toBe('pnpm build') // overridden
    expect(result.commands.test).toBe('npm test')    // kept from foundation
  })

  it('records warning when command is overridden', () => {
    const a = makeKit('a', { commands: { build: 'build-a' } })
    const b = makeKit('b', { commands: { build: 'build-b' } })
    const result = composeKits([a, b])
    expect(result.warnings.some((w) => w.includes("overrides command 'build'"))).toBe(true)
  })

  it('applies OS-specific command override over generic', () => {
    const kit = makeKit('k', {
      commands: { build: 'pnpm build' },
      commands_override: { windows: { build: '.\\build.cmd' } },
    })
    const linuxResult = composeKits([kit], { os: 'linux' })
    expect(linuxResult.commands.build).toBe('pnpm build')

    const winResult = composeKits([kit], { os: 'windows' })
    expect(winResult.commands.build).toBe('.\\build.cmd')
  })
})

// ---------------------------------------------------------------------------
// prompt_fragments — concatenated, workType filtered
// ---------------------------------------------------------------------------

describe('prompt_fragments composition', () => {
  it('concatenates fragments in apply order', () => {
    const a = makeKit('a', {
      prompt_fragments: [{ partial: 'frag-a', file: 'a.yaml' }],
    })
    const b = makeKit('b', {
      prompt_fragments: [{ partial: 'frag-b', file: 'b.yaml' }],
    })
    const result = composeKits([a, b])
    expect(result.promptFragments.map((f) => f.partial)).toEqual(['frag-a', 'frag-b'])
  })

  it('includes fragment when no when filter', () => {
    const kit = makeKit('k', {
      prompt_fragments: [{ partial: 'always', file: 'always.yaml' }],
    })
    const result = composeKits([kit], { workType: 'qa' })
    expect(result.promptFragments).toHaveLength(1)
  })

  it('filters fragments by workType', () => {
    const kit = makeKit('k', {
      prompt_fragments: [
        { partial: 'dev-only', when: ['development'], file: 'dev.yaml' },
        { partial: 'qa-only', when: ['qa'], file: 'qa.yaml' },
        { partial: 'both', when: ['development', 'qa'], file: 'both.yaml' },
      ],
    })
    const devResult = composeKits([kit], { workType: 'development' })
    expect(devResult.promptFragments.map((f) => f.partial)).toEqual(['dev-only', 'both'])

    const qaResult = composeKits([kit], { workType: 'qa' })
    expect(qaResult.promptFragments.map((f) => f.partial)).toEqual(['qa-only', 'both'])
  })
})

// ---------------------------------------------------------------------------
// tool_permissions — union
// ---------------------------------------------------------------------------

describe('tool_permissions composition — union', () => {
  it('unions permissions from all kits', () => {
    const a = makeKit('a', { tool_permissions: [{ shell: 'pnpm *' }] })
    const b = makeKit('b', { tool_permissions: [{ shell: 'node *' }, { shell: 'git *' }] })
    const result = composeKits([a, b])
    expect(result.toolPermissions).toHaveLength(3)
    expect(result.toolPermissions.map((p) => p.shell)).toContain('pnpm *')
    expect(result.toolPermissions.map((p) => p.shell)).toContain('node *')
    expect(result.toolPermissions.map((p) => p.shell)).toContain('git *')
  })

  it('does not deduplicate duplicate permissions (union is additive)', () => {
    const a = makeKit('a', { tool_permissions: [{ shell: 'pnpm *' }] })
    const b = makeKit('b', { tool_permissions: [{ shell: 'pnpm *' }] })
    const result = composeKits([a, b])
    expect(result.toolPermissions).toHaveLength(2) // not deduplicated
  })
})

// ---------------------------------------------------------------------------
// mcp_servers — concatenated; duplicate name is an error
// ---------------------------------------------------------------------------

describe('mcp_servers composition', () => {
  it('concatenates unique mcp servers', () => {
    const a = makeKit('a', { mcp_servers: [{ name: 'server-a', command: 'cmd-a' }] })
    const b = makeKit('b', { mcp_servers: [{ name: 'server-b', command: 'cmd-b' }] })
    const result = composeKits([a, b])
    expect(result.mcpServers).toHaveLength(2)
    expect(result.errors).toHaveLength(0)
  })

  it('reports error on duplicate mcp_server name', () => {
    const a = makeKit('a', { mcp_servers: [{ name: 'dup', command: 'cmd-a' }] })
    const b = makeKit('b', { mcp_servers: [{ name: 'dup', command: 'cmd-b' }] })
    const result = composeKits([a, b])
    expect(result.errors.some((e) => e.includes("'dup'"))).toBe(true)
    expect(result.mcpServers).toHaveLength(1) // first one wins; duplicate rejected
  })
})

// ---------------------------------------------------------------------------
// skills — concatenated; duplicate id/file is an error
// ---------------------------------------------------------------------------

describe('skills composition', () => {
  it('concatenates unique skills', () => {
    const a = makeKit('a', { skills: [{ file: 'skills/a/SKILL.md' }] })
    const b = makeKit('b', { skills: [{ file: 'skills/b/SKILL.md' }] })
    const result = composeKits([a, b])
    expect(result.skills).toHaveLength(2)
  })

  it('reports error on duplicate skill file', () => {
    const a = makeKit('a', { skills: [{ file: 'skills/shared/SKILL.md' }] })
    const b = makeKit('b', { skills: [{ file: 'skills/shared/SKILL.md' }] })
    const result = composeKits([a, b])
    expect(result.errors.some((e) => e.includes('skills/shared/SKILL.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// agents — concatenated; duplicate id is an error
// ---------------------------------------------------------------------------

describe('agents composition', () => {
  it('concatenates unique agents', () => {
    const a = makeKit('a', { agents: [{ id: 'agent-a', template: 'a.yaml' }] })
    const b = makeKit('b', { agents: [{ id: 'agent-b', template: 'b.yaml' }] })
    const result = composeKits([a, b])
    expect(result.agents).toHaveLength(2)
  })

  it('reports error on duplicate agent id', () => {
    const a = makeKit('a', { agents: [{ id: 'agent-x', template: 'a.yaml' }] })
    const b = makeKit('b', { agents: [{ id: 'agent-x', template: 'b.yaml' }] })
    const result = composeKits([a, b])
    expect(result.errors.some((e) => e.includes("'agent-x'"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// a2a_skills — concatenated; duplicate id is an error
// ---------------------------------------------------------------------------

describe('a2a_skills composition', () => {
  it('reports error on duplicate a2a skill id', () => {
    const a = makeKit('a', { a2a_skills: [{ id: 'reviewer', endpoint: 'a.yaml' }] })
    const b = makeKit('b', { a2a_skills: [{ id: 'reviewer', endpoint: 'b.yaml' }] })
    const result = composeKits([a, b])
    expect(result.errors.some((e) => e.includes("'reviewer'"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// workarea_config — union of clean_dirs and preserve_dirs
// ---------------------------------------------------------------------------

describe('workarea_config composition — union', () => {
  it('unions clean_dirs from all kits', () => {
    const a = makeKit('a', { workarea_config: { clean_dirs: ['dist', '.cache'] } })
    const b = makeKit('b', { workarea_config: { clean_dirs: ['.next', 'dist'] } })
    const result = composeKits([a, b])
    expect(result.workareaConfig.clean_dirs).toEqual(expect.arrayContaining(['dist', '.cache', '.next']))
    // dist is not duplicated
    expect(result.workareaConfig.clean_dirs?.filter((d) => d === 'dist')).toHaveLength(1)
  })

  it('unions preserve_dirs from all kits', () => {
    const a = makeKit('a', { workarea_config: { preserve_dirs: ['~/.npm'] } })
    const b = makeKit('b', { workarea_config: { preserve_dirs: ['~/.pnpm-store', '~/.npm'] } })
    const result = composeKits([a, b])
    expect(result.workareaConfig.preserve_dirs).toEqual(expect.arrayContaining(['~/.npm', '~/.pnpm-store']))
    expect(result.workareaConfig.preserve_dirs?.filter((d) => d === '~/.npm')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// hooks — all run; foundation hooks run first
// ---------------------------------------------------------------------------

describe('hooks composition', () => {
  it('runs hooks in kit order (foundation first)', () => {
    const foundation = makeKit('foundation', { hooks: { post_acquire: 'bin/foundation-setup.sh' } })
    const project = makeKit('project', { hooks: { post_acquire: 'bin/project-setup.sh' } })
    const result = composeKits([foundation, project])
    expect(result.hooks.post_acquire.map((h) => h.kitId)).toEqual(['foundation', 'project'])
    expect(result.hooks.post_acquire.map((h) => h.script)).toEqual([
      'bin/foundation-setup.sh',
      'bin/project-setup.sh',
    ])
  })

  it('applies OS-keyed hook override', () => {
    const kit = makeKit('k', {
      hooks: {
        post_acquire: 'bin/setup.sh',
        os: {
          windows: { post_acquire: 'bin\\setup.cmd' },
        },
      },
    })
    const linuxResult = composeKits([kit], { os: 'linux' })
    expect(linuxResult.hooks.post_acquire[0].script).toBe('bin/setup.sh')

    const winResult = composeKits([kit], { os: 'windows' })
    expect(winResult.hooks.post_acquire[0].script).toBe('bin\\setup.cmd')
  })
})

// ---------------------------------------------------------------------------
// resolveToolchainInstall
// ---------------------------------------------------------------------------

describe('resolveToolchainInstall', () => {
  it('merges toolchain install scripts for the active OS', () => {
    const kits = [
      makeKit('a', {
        toolchain_install: {
          linux: { node_22: 'nvm install 22' },
          macos: { node_22: 'brew install node@22' },
        },
      }),
      makeKit('b', {
        toolchain_install: {
          linux: { ruby_32: 'rbenv install 3.2' },
        },
      }),
    ]
    const linux = resolveToolchainInstall(kits, 'linux')
    expect(linux.node_22).toBe('nvm install 22')
    expect(linux.ruby_32).toBe('rbenv install 3.2')

    const macos = resolveToolchainInstall(kits, 'macos')
    expect(macos.node_22).toBe('brew install node@22')
    expect(macos.ruby_32).toBeUndefined()
  })

  it('later kits override earlier for same toolchain key', () => {
    const kits = [
      makeKit('a', { toolchain_install: { linux: { node_22: 'old-install' } } }),
      makeKit('b', { toolchain_install: { linux: { node_22: 'new-install' } } }),
    ]
    const result = resolveToolchainInstall(kits, 'linux')
    expect(result.node_22).toBe('new-install')
  })
})

// ---------------------------------------------------------------------------
// Conflicting kits composition (multiple AC scenarios)
// ---------------------------------------------------------------------------

describe('conflicting kits composition', () => {
  it('composes non-conflicting kits cleanly', () => {
    const ts = makeKit('ts/base', {
      commands: { build: 'pnpm build', test: 'pnpm test' },
      tool_permissions: [{ shell: 'pnpm *' }],
    })
    const nextjs = makeKit('ts/nextjs', {
      commands: { validate: 'pnpm typecheck' },
      prompt_fragments: [{ partial: 'nextjs-conventions', file: 'nextjs.yaml' }],
    })
    const result = composeKits([ts, nextjs])
    expect(result.errors).toHaveLength(0)
    expect(result.commands.build).toBe('pnpm build')
    expect(result.commands.validate).toBe('pnpm typecheck')
    expect(result.toolPermissions).toHaveLength(1)
    expect(result.promptFragments).toHaveLength(1)
  })
})
