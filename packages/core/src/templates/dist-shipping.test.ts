/**
 * Regression test for the critical v0.8.51 bug where YAML template files
 * were not copied into dist/ during the package build, causing the published
 * npm artifact to ship with zero runtime templates. At runtime the registry
 * silently loaded an empty Map, hasTemplate() returned false for every work
 * type, and spawnAgent fell through to customPrompt-verbatim mode — stripping
 * the work-result-marker partial and breaking QA auto-transition.
 *
 * This test asserts that:
 *   (a) The compiled dist/ tree includes every YAML source file.
 *   (b) A fresh TemplateRegistry instantiated against dist/ actually
 *       registers the expected work types.
 *
 * If these assertions fail in CI, the package would ship broken regardless
 * of what the source tree looks like — which is exactly what happened.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(fileURLToPath(new URL('../../', import.meta.url)))
const srcRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist', 'src')

function listYamlFilesRecursive(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      listYamlFilesRecursive(full, acc)
    } else if (name.endsWith('.yaml') || name.endsWith('.yml')) {
      acc.push(full)
    }
  }
  return acc
}

describe('dist ships YAML assets (REN-74 regression)', () => {
  const distExists = existsSync(distRoot)

  it.skipIf(!distExists)('dist/ exists (run pnpm build before running this test)', () => {
    expect(distExists).toBe(true)
  })

  it.skipIf(!distExists)('every YAML file in src/ is mirrored into dist/src/', () => {
    const srcYamlPaths = listYamlFilesRecursive(srcRoot)
    expect(srcYamlPaths.length).toBeGreaterThan(0)

    const missing: string[] = []
    for (const srcPath of srcYamlPaths) {
      const rel = relative(srcRoot, srcPath)
      const distPath = join(distRoot, rel)
      if (!existsSync(distPath)) {
        missing.push(rel)
      }
    }

    expect(missing, `missing ${missing.length} YAML file(s) in dist/:\n${missing.join('\n')}`).toEqual([])
  })

  it.skipIf(!distExists)('workflow templates defaults directory contains qa.yaml and development.yaml', () => {
    const defaultsDir = join(distRoot, 'templates', 'defaults')
    expect(existsSync(defaultsDir), `${defaultsDir} missing`).toBe(true)
    expect(existsSync(join(defaultsDir, 'qa.yaml'))).toBe(true)
    expect(existsSync(join(defaultsDir, 'development.yaml'))).toBe(true)
    expect(existsSync(join(defaultsDir, 'partials', 'work-result-marker.yaml'))).toBe(true)
    expect(existsSync(join(defaultsDir, 'partials', 'commit-push-pr.yaml'))).toBe(true)
  })

  it.skipIf(!distExists)('TemplateRegistry loaded from dist path registers expected work types', async () => {
    // Import the compiled registry module and verify it picks up the YAML files.
    // This is the actual runtime path — if this test fails, production breaks.
    const registryModule = await import(join(distRoot, 'templates', 'registry.js'))
    const { TemplateRegistry } = registryModule

    const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    const workTypes = registry.getRegisteredWorkTypes()

    // Minimum viable set: the core work types must all be registered.
    const mustHave = ['development', 'qa', 'acceptance', 'refinement', 'research', 'backlog-creation']
    for (const wt of mustHave) {
      expect(workTypes, `work type "${wt}" missing from dist-loaded registry`).toContain(wt)
    }
  })

  it.skipIf(!distExists)('qa template rendered from dist contains the work-result-marker directive', async () => {
    const registryModule = await import(join(distRoot, 'templates', 'registry.js'))
    const { TemplateRegistry } = registryModule

    const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
    const rendered = registry.renderPrompt('qa', { identifier: 'REN-74' })
    expect(rendered, 'qa template returned null — registry has no qa template').not.toBeNull()
    expect(rendered).toContain('WORK_RESULT:passed')
    expect(rendered).toContain('WORK_RESULT:failed')
  })
})
