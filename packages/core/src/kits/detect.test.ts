/**
 * Kit detection runtime tests
 * Covers: OS/arch short-circuit, declarative detection, Phase 2 gating,
 *         fixture repo detection, concurrency limiting
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isPlatformCompatible,
  evaluateDeclarativeDetect,
  detectKits,
  selectKits,
  mergeToolchainDemands,
  isKitTrustedForExec,
} from './detect.js'
import type { FileTreeView, KitDetectTarget } from './detect.js'
import type { KitManifest } from './manifest.js'
import { KIT_API_VERSION } from './manifest.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeKit(overrides: Partial<KitManifest> = {}): KitManifest {
  return {
    api: KIT_API_VERSION,
    kit: { id: 'test/kit', version: '1.0.0', name: 'Test Kit', priority: 50 },
    ...overrides,
  }
}

/** Build a FileTreeView from a set of file paths */
function makeFileTree(existingFiles: string[], fileContents: Record<string, string> = {}): FileTreeView {
  return {
    exists: (p) => existingFiles.some((f) => f === p || f.endsWith(`/${p}`) || p === f),
    readFile: (p) => fileContents[p] ?? null,
  }
}

function makeTarget(
  files: string[],
  fileContents: Record<string, string> = {},
  meta: Partial<KitDetectTarget> = {}
): KitDetectTarget {
  return {
    fileTree: makeFileTree(files, fileContents),
    ...meta,
  }
}

// ---------------------------------------------------------------------------
// isPlatformCompatible
// ---------------------------------------------------------------------------

describe('isPlatformCompatible', () => {
  it('returns true when kit has no supports block', () => {
    const kit = makeKit()
    expect(isPlatformCompatible(kit, { os: 'linux', arch: 'x86_64' })).toBe(true)
  })

  it('returns true for matching OS and arch', () => {
    const kit = makeKit({ supports: { os: ['linux', 'macos'], arch: ['x86_64', 'arm64'] } })
    expect(isPlatformCompatible(kit, { os: 'linux', arch: 'x86_64' })).toBe(true)
    expect(isPlatformCompatible(kit, { os: 'macos', arch: 'arm64' })).toBe(true)
  })

  it('returns false for non-matching OS', () => {
    const kit = makeKit({ supports: { os: ['macos'], arch: ['arm64'] } })
    expect(isPlatformCompatible(kit, { os: 'linux', arch: 'arm64' })).toBe(false)
  })

  it('returns false for non-matching arch', () => {
    const kit = makeKit({ supports: { os: ['linux'], arch: ['arm64'] } })
    expect(isPlatformCompatible(kit, { os: 'linux', arch: 'x86_64' })).toBe(false)
  })

  it('is case-insensitive for OS and arch', () => {
    const kit = makeKit({ supports: { os: ['Linux'], arch: ['X86_64'] } })
    expect(isPlatformCompatible(kit, { os: 'linux', arch: 'x86_64' })).toBe(true)
  })

  it('returns true when target has no os/arch', () => {
    const kit = makeKit({ supports: { os: ['linux'], arch: ['x86_64'] } })
    expect(isPlatformCompatible(kit, {})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// evaluateDeclarativeDetect
// ---------------------------------------------------------------------------

describe('evaluateDeclarativeDetect', () => {
  it('returns true when kit has no detect rules (global kit)', () => {
    const kit = makeKit()
    expect(evaluateDeclarativeDetect(kit, makeTarget([]))).toBe(true)
  })

  it('matches when any file in detect.files exists', () => {
    const kit = makeKit({ detect: { files: ['package.json', 'pom.xml'] } })
    expect(evaluateDeclarativeDetect(kit, makeTarget(['package.json']))).toBe(true)
    expect(evaluateDeclarativeDetect(kit, makeTarget(['pom.xml']))).toBe(true)
    expect(evaluateDeclarativeDetect(kit, makeTarget(['build.gradle']))).toBe(false)
  })

  it('fails when no file in detect.files exists', () => {
    const kit = makeKit({ detect: { files: ['next.config.ts', 'next.config.js'] } })
    expect(evaluateDeclarativeDetect(kit, makeTarget(['package.json']))).toBe(false)
  })

  it('matches only when all files_all exist', () => {
    const kit = makeKit({ detect: { files_all: ['package.json', 'pnpm-workspace.yaml'] } })
    expect(evaluateDeclarativeDetect(kit, makeTarget(['package.json', 'pnpm-workspace.yaml']))).toBe(true)
    expect(evaluateDeclarativeDetect(kit, makeTarget(['package.json']))).toBe(false)
  })

  it('excludes match when not_files is present', () => {
    const kit = makeKit({
      detect: {
        files: ['package.json'],
        not_files: ['pom.xml'],
      },
    })
    expect(evaluateDeclarativeDetect(kit, makeTarget(['package.json']))).toBe(true)
    expect(evaluateDeclarativeDetect(kit, makeTarget(['package.json', 'pom.xml']))).toBe(false)
  })

  it('matches content_matches with json_path', () => {
    const kit = makeKit({
      detect: {
        content_matches: [{ file: 'package.json', json_path: '$.dependencies.next' }],
      },
    })
    const withNext = JSON.stringify({ dependencies: { next: '^15.0.0' } })
    const withoutNext = JSON.stringify({ dependencies: { react: '^18.0.0' } })
    expect(
      evaluateDeclarativeDetect(kit, makeTarget(['package.json'], { 'package.json': withNext }))
    ).toBe(true)
    expect(
      evaluateDeclarativeDetect(kit, makeTarget(['package.json'], { 'package.json': withoutNext }))
    ).toBe(false)
  })

  it('fails content_matches when file does not exist', () => {
    const kit = makeKit({
      detect: {
        content_matches: [{ file: 'next.config.ts', content_regex: 'nextConfig' }],
      },
    })
    expect(evaluateDeclarativeDetect(kit, makeTarget([]))).toBe(false)
  })

  it('matches content_matches with content_regex', () => {
    const kit = makeKit({
      detect: {
        content_matches: [{ file: 'next.config.ts', content_regex: 'nextConfig' }],
      },
    })
    expect(
      evaluateDeclarativeDetect(kit, makeTarget(['next.config.ts'], { 'next.config.ts': 'const nextConfig = {}' }))
    ).toBe(true)
    expect(
      evaluateDeclarativeDetect(kit, makeTarget(['next.config.ts'], { 'next.config.ts': 'module.exports = {}' }))
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isKitTrustedForExec
// ---------------------------------------------------------------------------

describe('isKitTrustedForExec', () => {
  it('returns true when trustedKitIds is undefined (no restriction)', () => {
    const kit = makeKit()
    expect(isKitTrustedForExec(kit, {})).toBe(true)
  })

  it('returns true when kit id is in trustedKitIds', () => {
    const kit = makeKit({ kit: { id: 'spring/java', version: '1.0.0', name: 'Spring' } })
    expect(isKitTrustedForExec(kit, { trustedKitIds: new Set(['spring/java']) })).toBe(true)
  })

  it('returns false when kit id is not in trustedKitIds', () => {
    const kit = makeKit({ kit: { id: 'unknown/kit', version: '1.0.0', name: 'Unknown' } })
    expect(isKitTrustedForExec(kit, { trustedKitIds: new Set(['spring/java']) })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// detectKits — integration-level
// ---------------------------------------------------------------------------

describe('detectKits', () => {
  it('short-circuits platform-incompatible kits', async () => {
    const kit = makeKit({
      supports: { os: ['macos'], arch: ['arm64'] },
      detect: { files: ['package.json'] },
    })
    const target = makeTarget(['package.json'], {}, { os: 'linux', arch: 'x86_64' })
    const results = await detectKits([kit], target, { allowExecutable: false })
    expect(results[0].result.applies).toBe(false)
    expect(results[0].phase).toBe('platform-skipped')
  })

  it('detects kit via declarative files match', async () => {
    const kit = makeKit({
      detect: { files: ['package.json', 'next.config.ts'] },
    })
    const target = makeTarget(['package.json', 'next.config.ts'])
    const results = await detectKits([kit], target, { allowExecutable: false })
    expect(results[0].result.applies).toBe(true)
    expect(results[0].phase).toBe('declarative')
  })

  it('returns applies=false for kits that do not match', async () => {
    const kit = makeKit({
      detect: { files: ['pom.xml'] },
    })
    const target = makeTarget(['package.json'])
    const results = await detectKits([kit], target, { allowExecutable: false })
    expect(results[0].result.applies).toBe(false)
  })

  it('runs multiple kits in parallel', async () => {
    const kits = [
      makeKit({ kit: { id: 'kit-a', version: '1.0.0', name: 'A' }, detect: { files: ['a.txt'] } }),
      makeKit({ kit: { id: 'kit-b', version: '1.0.0', name: 'B' }, detect: { files: ['b.txt'] } }),
      makeKit({ kit: { id: 'kit-c', version: '1.0.0', name: 'C' }, detect: { files: ['c.txt'] } }),
    ]
    const target = makeTarget(['a.txt', 'c.txt'])
    const results = await detectKits(kits, target, { allowExecutable: false })
    const byId = Object.fromEntries(results.map((r) => [r.kit.kit.id, r]))
    expect(byId['kit-a'].result.applies).toBe(true)
    expect(byId['kit-b'].result.applies).toBe(false)
    expect(byId['kit-c'].result.applies).toBe(true)
  })

  it('attaches toolchain from detect.toolchain when kit applies', async () => {
    const kit = makeKit({
      detect: {
        files: ['package.json'],
        toolchain: { node: '22' },
      },
    })
    const target = makeTarget(['package.json'])
    const results = await detectKits([kit], target, { allowExecutable: false })
    expect(results[0].result.toolchain?.node).toBe('22')
  })

  it('skips executable detection when allowExecutable=false', async () => {
    const kit = makeKit({
      detect: { files: ['package.json'], exec: 'bin/detect' },
    })
    const target = makeTarget(['package.json'])
    const results = await detectKits([kit], target, { allowExecutable: false })
    // Should still apply (executable detect disabled)
    expect(results[0].result.applies).toBe(true)
    expect(results[0].phase).toBe('declarative')
  })
})

// ---------------------------------------------------------------------------
// selectKits
// ---------------------------------------------------------------------------

describe('selectKits', () => {
  it('returns ordered kits sorted by confidence desc', () => {
    const candidates = [
      {
        kit: makeKit({ kit: { id: 'low', version: '1.0.0', name: 'Low' } }),
        result: { applies: true, confidence: 0.3 },
        phase: 'declarative' as const,
      },
      {
        kit: makeKit({ kit: { id: 'high', version: '1.0.0', name: 'High' } }),
        result: { applies: true, confidence: 0.9 },
        phase: 'declarative' as const,
      },
    ]
    const { ordered } = selectKits(candidates)
    expect(ordered[0].kit.id).toBe('high')
    expect(ordered[1].kit.id).toBe('low')
  })

  it('excludes non-applicable kits', () => {
    const candidates = [
      {
        kit: makeKit({ kit: { id: 'yes', version: '1.0.0', name: 'Y' } }),
        result: { applies: true, confidence: 0.8 },
        phase: 'declarative' as const,
      },
      {
        kit: makeKit({ kit: { id: 'no', version: '1.0.0', name: 'N' } }),
        result: { applies: false, confidence: 0 },
        phase: 'declarative' as const,
      },
    ]
    const { ordered } = selectKits(candidates)
    expect(ordered).toHaveLength(1)
    expect(ordered[0].kit.id).toBe('yes')
  })

  it('reports conflicts when conflicting kits both apply', () => {
    const candidates = [
      {
        kit: makeKit({
          kit: { id: 'maven', version: '1.0.0', name: 'Maven' },
          composition: { conflicts_with: ['gradle'] },
        }),
        result: { applies: true, confidence: 0.8 },
        phase: 'declarative' as const,
      },
      {
        kit: makeKit({ kit: { id: 'gradle', version: '1.0.0', name: 'Gradle' } }),
        result: { applies: true, confidence: 0.8 },
        phase: 'declarative' as const,
      },
    ]
    const { ordered, conflicts } = selectKits(candidates)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kitA).toBe('maven')
    expect(conflicts[0].kitB).toBe('gradle')
    // Both should be excluded from ordered
    expect(ordered).toHaveLength(0)
  })

  it('orders kits by composition group: foundation → framework → project', () => {
    const candidates = [
      {
        kit: makeKit({
          kit: { id: 'proj', version: '1.0.0', name: 'Project' },
          composition: { order: 'project' },
        }),
        result: { applies: true, confidence: 0.8 },
        phase: 'declarative' as const,
      },
      {
        kit: makeKit({
          kit: { id: 'fdn', version: '1.0.0', name: 'Foundation' },
          composition: { order: 'foundation' },
        }),
        result: { applies: true, confidence: 0.8 },
        phase: 'declarative' as const,
      },
      {
        kit: makeKit({
          kit: { id: 'fw', version: '1.0.0', name: 'Framework' },
          composition: { order: 'framework' },
        }),
        result: { applies: true, confidence: 0.8 },
        phase: 'declarative' as const,
      },
    ]
    const { ordered } = selectKits(candidates)
    expect(ordered.map((k) => k.kit.id)).toEqual(['fdn', 'fw', 'proj'])
  })
})

// ---------------------------------------------------------------------------
// mergeToolchainDemands
// ---------------------------------------------------------------------------

describe('mergeToolchainDemands', () => {
  it('merges toolchain demands from all kits', () => {
    const kits = [
      makeKit({ detect: { files: [], toolchain: { node: '22', java: '17' } } }),
      makeKit({ detect: { files: [], toolchain: { ruby: '3.2' } } }),
    ]
    const merged = mergeToolchainDemands(kits)
    expect(merged.node).toBe('22')
    expect(merged.java).toBe('17')
    expect(merged.ruby).toBe('3.2')
  })

  it('later kits override earlier for same toolchain key', () => {
    const kits = [
      makeKit({ detect: { files: [], toolchain: { node: '18' } } }),
      makeKit({ detect: { files: [], toolchain: { node: '22' } } }),
    ]
    const merged = mergeToolchainDemands(kits)
    expect(merged.node).toBe('22')
  })

  it('returns empty object when no kits have toolchain demands', () => {
    const kits = [makeKit(), makeKit()]
    const merged = mergeToolchainDemands(kits)
    expect(Object.keys(merged)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fixture repo detection: TS/Next.js repo detection
// ---------------------------------------------------------------------------

describe('fixture repo detection — TS/Next.js', () => {
  it('detects a Next.js repo from package.json + next.config.ts', async () => {
    const nextjsKit = makeKit({
      kit: { id: 'default/ts-nextjs', version: '1.0.0', name: 'TS/Next.js', priority: 80 },
      detect: {
        files: ['next.config.ts', 'next.config.js', 'next.config.mjs'],
        content_matches: [{ file: 'package.json', json_path: '$.dependencies.next' }],
      },
    })

    const packageJson = JSON.stringify({
      name: 'my-app',
      dependencies: { next: '^15.0.0', react: '^18.0.0' },
    })

    const target = makeTarget(
      ['package.json', 'next.config.ts', 'tsconfig.json'],
      { 'package.json': packageJson }
    )

    const results = await detectKits([nextjsKit], target, { allowExecutable: false })
    expect(results[0].result.applies).toBe(true)
    expect(results[0].result.confidence).toBeGreaterThan(0)
  })

  it('does NOT detect a non-Next.js repo as TS/Next.js', async () => {
    const nextjsKit = makeKit({
      kit: { id: 'default/ts-nextjs', version: '1.0.0', name: 'TS/Next.js', priority: 80 },
      detect: {
        files: ['next.config.ts', 'next.config.js', 'next.config.mjs'],
        content_matches: [{ file: 'package.json', json_path: '$.dependencies.next' }],
      },
    })

    // A plain React app (no Next.js)
    const packageJson = JSON.stringify({
      name: 'plain-react',
      dependencies: { react: '^18.0.0' },
    })

    const target = makeTarget(
      ['package.json', 'src/index.tsx'],
      { 'package.json': packageJson }
    )

    const results = await detectKits([nextjsKit], target, { allowExecutable: false })
    expect(results[0].result.applies).toBe(false)
  })

  it('rejects TS/Next.js kit for incompatible OS', async () => {
    const kit = makeKit({
      kit: { id: 'default/ts-nextjs', version: '1.0.0', name: 'TS/Next.js' },
      supports: { os: ['linux', 'macos'], arch: ['x86_64', 'arm64'] },
      detect: { files: ['package.json'] },
    })
    const target = makeTarget(['package.json'], {}, { os: 'windows', arch: 'x86_64' })
    const results = await detectKits([kit], target, { allowExecutable: false })
    expect(results[0].result.applies).toBe(false)
    expect(results[0].phase).toBe('platform-skipped')
  })
})
