#!/usr/bin/env tsx
/**
 * Regenerate the dashboard template from the create-app scaffold.
 *
 * Usage:
 *   tsx scripts/sync-dashboard-template.ts [--version <ver>]
 *
 * This script:
 * 1. Calls getTemplates() with dashboard+cli+redis options
 * 2. Writes the output to templates/dashboard/
 * 3. Pins @supaku package versions to the provided version (or reads from packages/core/package.json)
 * 4. Preserves the README.md, railway.toml, and .env.example customizations
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getTemplates } from '../packages/create-app/src/templates/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TEMPLATE_DIR = path.join(ROOT, 'templates', 'dashboard')

// Parse --version flag
function parseVersion(): string {
  const idx = process.argv.indexOf('--version')
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
  }
  // Read version from core package.json
  const corePkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'packages', 'core', 'package.json'), 'utf-8'),
  )
  return corePkg.version
}

const version = parseVersion()
console.log(`Syncing dashboard template to version ${version}`)

// Generate all scaffold files
const files = getTemplates({
  projectName: 'agentfactory-dashboard',
  teamKey: 'YOUR_TEAM',
  includeDashboard: true,
  includeCli: true,
  useRedis: true,
})

// Write scaffold files
for (const [filePath, content] of Object.entries(files)) {
  const fullPath = path.join(TEMPLATE_DIR, filePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf-8')
}

console.log(`Generated ${Object.keys(files).length} scaffold files`)

// Fix layout title
const layoutPath = path.join(TEMPLATE_DIR, 'src', 'app', 'layout.tsx')
const layoutContent = fs.readFileSync(layoutPath, 'utf-8')
fs.writeFileSync(
  layoutPath,
  layoutContent.replace(
    "title: 'agentfactory-dashboard — AgentFactory'",
    "title: 'AgentFactory Dashboard'",
  ),
)

// Pin @supaku package versions in package.json
const pkgPath = path.join(TEMPLATE_DIR, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

// Add engines field
pkg.engines = { node: '>=22.0.0' }

// Sort dependencies and pin @supaku versions
for (const depType of ['dependencies', 'devDependencies'] as const) {
  if (!pkg[depType]) continue
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(pkg[depType]).sort()) {
    let ver = pkg[depType][key]
    if (key.startsWith('@supaku/')) {
      ver = version
    }
    sorted[key] = ver
  }
  pkg[depType] = sorted
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`Pinned @supaku packages to ${version}`)

console.log('Done!')
