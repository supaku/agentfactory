#!/usr/bin/env node
/**
 * AgentFactory Worktree Cleanup
 *
 * Cleans up orphaned git worktrees in the .worktrees/ directory.
 * Run this script periodically to remove worktrees from:
 * - Crashed agent sessions
 * - Completed work where cleanup failed
 * - Stale branches that have been merged/deleted
 *
 * Usage:
 *   af-cleanup [options]
 *
 * Options:
 *   --dry-run           Show what would be cleaned up without removing anything
 *   --force             Force removal even if worktree appears active
 *   --path <dir>        Custom worktrees directory (default: .worktrees)
 *   --help, -h          Show this help message
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { resolve, basename } from 'path'

/**
 * Get the git repository root directory
 */
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

interface CleanupOptions {
  dryRun: boolean
  force: boolean
  worktreePath: string
}

interface WorktreeInfo {
  path: string
  branch: string
  isOrphaned: boolean
  reason?: string
}

interface CleanupResult {
  scanned: number
  orphaned: number
  cleaned: number
  errors: Array<{ path: string; error: string }>
}

function parseArgs(): CleanupOptions {
  const args = process.argv.slice(2)
  const gitRoot = getGitRoot()
  const result: CleanupOptions = {
    dryRun: false,
    force: false,
    worktreePath: resolve(gitRoot, '.worktrees'),
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--dry-run':
        result.dryRun = true
        break
      case '--force':
        result.force = true
        break
      case '--path':
        result.worktreePath = args[++i]
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
AgentFactory Worktree Cleanup - Remove orphaned git worktrees

Usage:
  af-cleanup [options]

Options:
  --dry-run           Show what would be cleaned up without removing
  --force             Force removal even if worktree appears active
  --path <dir>        Custom worktrees directory (default: .worktrees)
  --help, -h          Show this help message

Orphaned worktrees are identified by:
  - Branch no longer exists (merged/deleted)
  - Not listed in 'git worktree list' (stale directory)
  - Lock file exists but is stale

Examples:
  # Preview what would be cleaned up
  af-cleanup --dry-run

  # Clean up orphaned worktrees
  af-cleanup

  # Force cleanup all worktrees (use with caution)
  af-cleanup --force
`)
}

/**
 * Get list of git worktrees from 'git worktree list'
 */
function getGitWorktrees(): Map<string, string> {
  const worktrees = new Map<string, string>()

  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let currentPath = ''
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9)
      } else if (line.startsWith('branch ')) {
        const branch = line.substring(7).replace('refs/heads/', '')
        worktrees.set(currentPath, branch)
      }
    }
  } catch (error) {
    console.error('Failed to list git worktrees:', error)
  }

  return worktrees
}

/**
 * Check if a git branch exists
 */
function branchExists(branchName: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Scan the worktrees directory and identify orphaned worktrees
 */
function scanWorktrees(options: CleanupOptions): WorktreeInfo[] {
  const worktreesDir = resolve(options.worktreePath)
  const result: WorktreeInfo[] = []

  if (!existsSync(worktreesDir)) {
    console.log(`Worktrees directory not found: ${worktreesDir}`)
    return result
  }

  const gitWorktrees = getGitWorktrees()
  const entries = readdirSync(worktreesDir)

  for (const entry of entries) {
    const entryPath = resolve(worktreesDir, entry)

    try {
      if (!statSync(entryPath).isDirectory()) {
        continue
      }
    } catch {
      continue
    }

    const info: WorktreeInfo = {
      path: entryPath,
      branch: entry,
      isOrphaned: false,
    }

    const isKnownWorktree = gitWorktrees.has(entryPath)
    const branchName = isKnownWorktree ? gitWorktrees.get(entryPath)! : entry

    if (options.force) {
      info.isOrphaned = true
      info.reason = 'force cleanup requested'
    } else if (!isKnownWorktree) {
      info.isOrphaned = true
      info.reason = 'not registered with git worktree'
    } else if (!branchExists(branchName)) {
      info.isOrphaned = true
      info.reason = `branch '${branchName}' no longer exists`
    }

    result.push(info)
  }

  return result
}

/**
 * Remove a single worktree
 */
function removeWorktree(worktreePath: string): { success: boolean; error?: string } {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { success: true }
  } catch {
    try {
      execSync(`rm -rf "${worktreePath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      execSync('git worktree prune', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { success: true }
    } catch (rmError) {
      return {
        success: false,
        error: rmError instanceof Error ? rmError.message : String(rmError),
      }
    }
  }
}

/**
 * Main cleanup function
 */
function cleanup(options: CleanupOptions): CleanupResult {
  const result: CleanupResult = {
    scanned: 0,
    orphaned: 0,
    cleaned: 0,
    errors: [],
  }

  console.log('Scanning worktrees...\n')

  try {
    execSync('git worktree prune', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    console.log('Note: Could not prune git worktree metadata')
  }

  const worktrees = scanWorktrees(options)
  result.scanned = worktrees.length

  if (worktrees.length === 0) {
    console.log('No worktrees found.\n')
    return result
  }

  console.log(`Found ${worktrees.length} worktree(s) in ${options.worktreePath}/\n`)

  for (const wt of worktrees) {
    const status = wt.isOrphaned ? '  orphaned' : '    active'
    const reason = wt.reason ? ` (${wt.reason})` : ''
    console.log(`  ${status}: ${basename(wt.path)}${reason}`)
  }
  console.log('')

  const orphaned = worktrees.filter((wt) => wt.isOrphaned)
  result.orphaned = orphaned.length

  if (orphaned.length === 0) {
    console.log('No orphaned worktrees to clean up.\n')
    return result
  }

  if (options.dryRun) {
    console.log(`[DRY RUN] Would clean up ${orphaned.length} orphaned worktree(s):\n`)
    for (const wt of orphaned) {
      console.log(`  Would remove: ${wt.path}`)
    }
    console.log('')
    return result
  }

  console.log(`Cleaning up ${orphaned.length} orphaned worktree(s)...\n`)

  for (const wt of orphaned) {
    process.stdout.write(`  Removing ${basename(wt.path)}... `)
    const removal = removeWorktree(wt.path)

    if (removal.success) {
      console.log('done')
      result.cleaned++
    } else {
      console.log(`FAILED: ${removal.error}`)
      result.errors.push({ path: wt.path, error: removal.error || 'Unknown error' })
    }
  }
  console.log('')

  try {
    execSync('git worktree prune', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    console.log('Pruned git worktree metadata.\n')
  } catch {
    // Ignore prune errors
  }

  return result
}

// Main execution
function main(): void {
  const options = parseArgs()

  console.log('\n=== AgentFactory Worktree Cleanup ===\n')

  if (options.dryRun) {
    console.log('[DRY RUN MODE - No changes will be made]\n')
  }

  if (options.force) {
    console.log('[FORCE MODE - All worktrees will be removed]\n')
  }

  const result = cleanup(options)

  console.log('=== Summary ===\n')
  console.log(`  Scanned:  ${result.scanned} worktree(s)`)
  console.log(`  Orphaned: ${result.orphaned}`)
  console.log(`  Cleaned:  ${result.cleaned}`)

  if (result.errors.length > 0) {
    console.log(`  Errors:   ${result.errors.length}`)
    for (const err of result.errors) {
      console.log(`    - ${basename(err.path)}: ${err.error}`)
    }
  }

  console.log('')

  if (result.errors.length > 0) {
    process.exit(1)
  }
}

main()
