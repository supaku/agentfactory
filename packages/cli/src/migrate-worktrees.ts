#!/usr/bin/env node
/**
 * AgentFactory Worktree Migration CLI
 *
 * Migrates worktrees from the legacy .worktrees/ directory (inside repo)
 * to the new sibling directory pattern (../{repoName}.wt/).
 *
 * Usage:
 *   af-migrate-worktrees [options]
 *
 * Options:
 *   --dry-run    Preview changes without executing
 *   --force      Move even if processes are using worktrees
 *   --help, -h   Show this help message
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, resolve } from 'path'

function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

function parseArgs(): { dryRun: boolean; force: boolean } {
  const args = process.argv.slice(2)
  const result = { dryRun: false, force: false }

  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        result.dryRun = true
        break
      case '--force':
        result.force = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Worktree Migration

Migrates worktrees from .worktrees/ (inside repo) to ../{repoName}.wt/ (sibling directory).
This prevents VSCode file watcher crashes when running multiple concurrent agents.

Usage:
  af-migrate-worktrees [options]

Options:
  --dry-run    Preview changes without executing
  --force      Move even if processes are using worktrees
  --help, -h   Show this help message
`)
}

function main(): void {
  const { dryRun, force } = parseArgs()
  const gitRoot = getGitRoot()
  const repoName = basename(gitRoot)
  const legacyDir = resolve(gitRoot, '.worktrees')
  const newDir = resolve(gitRoot, '..', `${repoName}.wt`)

  console.log('\n=== AgentFactory Worktree Migration ===\n')

  if (dryRun) {
    console.log('[DRY RUN MODE - No changes will be made]\n')
  }

  if (!existsSync(legacyDir)) {
    console.log(`No legacy worktrees directory found at ${legacyDir}`)
    console.log('Nothing to migrate.\n')
    return
  }

  // List worktree entries (skip hidden directories like .patches)
  const entries = readdirSync(legacyDir).filter(entry => {
    if (entry.startsWith('.')) return false
    try {
      return statSync(resolve(legacyDir, entry)).isDirectory()
    } catch {
      return false
    }
  })

  if (entries.length === 0) {
    console.log(`Legacy worktrees directory exists but is empty: ${legacyDir}`)
    if (!dryRun) {
      rmSync(legacyDir, { recursive: true, force: true })
      console.log('Removed empty legacy directory.\n')
    }
    return
  }

  console.log(`Found ${entries.length} worktree(s) to migrate:`)
  console.log(`  From: ${legacyDir}`)
  console.log(`  To:   ${newDir}\n`)

  // Check for running processes unless --force
  if (!force && !dryRun) {
    for (const entry of entries) {
      const entryPath = resolve(legacyDir, entry)
      try {
        const lsofOutput = execSync(`lsof +D "${entryPath}" 2>/dev/null || true`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
        if (lsofOutput) {
          console.log(`WARNING: Processes are using worktree ${entry}:`)
          console.log(`  ${lsofOutput.split('\n')[0]}`)
          console.log('  Use --force to move anyway, or stop the processes first.\n')
          process.exit(1)
        }
      } catch {
        // lsof not available or failed, skip check
      }
    }
  }

  // Ensure target directory exists
  if (!dryRun && !existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true })
  }

  let migrated = 0
  let failed = 0

  for (const entry of entries) {
    const oldPath = resolve(legacyDir, entry)
    const newPath = resolve(newDir, entry)

    console.log(`  ${entry}:`)
    console.log(`    ${oldPath} -> ${newPath}`)

    if (dryRun) {
      console.log('    [DRY RUN] Would move\n')
      migrated++
      continue
    }

    if (existsSync(newPath)) {
      console.log(`    SKIPPED: Target already exists\n`)
      failed++
      continue
    }

    try {
      // Try git worktree move first (preferred — updates git tracking)
      execSync(`git worktree move "${oldPath}" "${newPath}"`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: gitRoot,
      })
      console.log('    OK (git worktree move)\n')
      migrated++
    } catch {
      // Fallback: manual move + repair
      try {
        renameSync(oldPath, newPath)
        execSync(`git worktree repair`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          cwd: gitRoot,
        })
        console.log('    OK (manual move + repair)\n')
        migrated++
      } catch (fallbackError) {
        console.log(`    FAILED: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`)
        failed++
      }
    }
  }

  // Move .patches directory if it exists
  const legacyPatchDir = resolve(legacyDir, '.patches')
  if (existsSync(legacyPatchDir)) {
    const newPatchDir = resolve(newDir, '.patches')
    if (!dryRun) {
      try {
        renameSync(legacyPatchDir, newPatchDir)
        console.log('  Moved .patches directory\n')
      } catch (error) {
        console.log(`  Failed to move .patches: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    } else {
      console.log('  [DRY RUN] Would move .patches directory\n')
    }
  }

  // Clean up empty legacy directory
  if (!dryRun && migrated > 0) {
    try {
      const remaining = readdirSync(legacyDir)
      if (remaining.length === 0) {
        rmSync(legacyDir, { recursive: true, force: true })
        console.log(`Removed empty legacy directory: ${legacyDir}\n`)
      } else {
        console.log(`Legacy directory not empty (${remaining.length} remaining entries), keeping it.\n`)
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // Summary
  console.log('=== Summary ===\n')
  console.log(`  Migrated: ${migrated}`)
  if (failed > 0) {
    console.log(`  Failed:   ${failed}`)
  }
  console.log('')

  // Verify git tracking
  if (!dryRun && migrated > 0) {
    try {
      const worktreeList = execSync('git worktree list', {
        encoding: 'utf-8',
        cwd: gitRoot,
      }).trim()
      console.log('Git worktree list after migration:')
      console.log(worktreeList)
      console.log('')
    } catch {
      // Ignore
    }
  }

  if (failed > 0) {
    process.exit(1)
  }
}

main()
