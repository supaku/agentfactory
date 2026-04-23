#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets (YAML templates, workflow definitions,
 * partials) from src/ to dist/src/ after tsc has emitted the JS output.
 *
 * Background: tsc only compiles `.ts` files. The runtime template registry
 * and workflow loader read `.yaml` files at paths resolved relative to the
 * compiled `.js` file (e.g., `dist/src/templates/defaults/qa.yaml`). Without
 * this copy step the published npm package ships JS but no YAML, so the
 * template registry silently loads zero templates and `spawnAgent` falls
 * through to customPrompt-verbatim mode. That path strips qa/development
 * templates — including the work-result-marker partial — and every
 * template-gated instruction is lost in production.
 *
 * Extensions copied:
 *   - .yaml / .yml  (templates, partials, workflow defs)
 *
 * This script preserves directory structure, skips node_modules/dist, and
 * is idempotent.
 */
import { readdir, mkdir, copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSET_EXTS = ['.yaml', '.yml']
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__'])

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const srcRoot = join(packageRoot, 'src')
const destRoot = join(packageRoot, 'dist', 'src')

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      files.push(...(await walk(join(dir, entry.name))))
    } else if (entry.isFile()) {
      if (ASSET_EXTS.some(ext => entry.name.endsWith(ext))) {
        files.push(join(dir, entry.name))
      }
    }
  }
  return files
}

async function main() {
  if (!existsSync(srcRoot)) {
    console.error(`[copy-assets] src/ does not exist at ${srcRoot} — nothing to copy`)
    return
  }
  if (!existsSync(destRoot)) {
    console.error(`[copy-assets] dist/src/ does not exist — run tsc first`)
    process.exit(1)
  }

  const files = await walk(srcRoot)
  let copied = 0
  for (const source of files) {
    const rel = relative(srcRoot, source)
    const dest = join(destRoot, rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(source, dest)
    copied++
  }

  console.log(`[copy-assets] copied ${copied} asset file(s) from src/ to dist/src/`)
}

main().catch(err => {
  console.error('[copy-assets] failed:', err)
  process.exit(1)
})
