/**
 * Cleanup Runner -- Programmatic API for the worktree cleanup CLI.
 *
 * Exports `runCleanup()` so worktree cleanup can be invoked from code
 * without going through process.argv / process.env / process.exit.
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { resolve, basename } from 'path'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CleanupRunnerConfig {
  /** Show what would be cleaned up without removing (default: false) */
  dryRun?: boolean
  /** Force removal even if worktree appears active (default: false) */
  force?: boolean
  /** Custom worktrees directory (default: {gitRoot}/.worktrees) */
  worktreePath?: string
  /** Git root for default worktree path (default: auto-detect) */
  gitRoot?: string
}

export interface CleanupResult {
  scanned: number
  orphaned: number
  cleaned: number
  errors: Array<{ path: string; error: string }>
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
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
 * Core cleanup logic
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runCleanup(config?: CleanupRunnerConfig): CleanupResult {
  const gitRoot = config?.gitRoot ?? getGitRoot()

  const options: CleanupOptions = {
    dryRun: config?.dryRun ?? false,
    force: config?.force ?? false,
    worktreePath: config?.worktreePath ?? resolve(gitRoot, '.worktrees'),
  }

  return cleanup(options)
}
