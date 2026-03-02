/**
 * Cleanup Runner -- Programmatic API for the worktree cleanup CLI.
 *
 * Exports `runCleanup()` so worktree cleanup can be invoked from code
 * without going through process.argv / process.env / process.exit.
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { resolve, basename } from 'path'

/** Delay between worktree removals (ms) to let IDEs process filesystem events. */
const IDE_SETTLE_DELAY_MS = 1500

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
  skipped: number
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
 * Check if any processes (IDEs, language servers, etc.) have files open in a
 * directory.  Uses `lsof` on macOS/Linux.  Returns a deduplicated list of
 * process command names so the caller can warn the user.
 */
function getProcessesUsingPath(dirPath: string): string[] {
  try {
    // lsof +D is recursive but can be slow on large trees.
    // We use a short timeout and suppress errors — if it fails, we treat the
    // path as free (better to over-delete than hang forever).
    const output = execSync(`lsof +D "${dirPath}" 2>/dev/null || true`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    if (!output.trim()) return []

    const commands = new Set<string>()
    for (const line of output.split('\n').slice(1)) {
      const cmd = line.split(/\s+/)[0]
      if (cmd) commands.add(cmd)
    }
    return [...commands]
  } catch {
    return []
  }
}

/**
 * Sleep synchronously for the given number of milliseconds.
 */
function sleepSync(ms: number): void {
  execSync(`sleep ${(ms / 1000).toFixed(1)}`, { stdio: 'pipe' })
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
 * Remove a single worktree with safety checks.
 *
 * SAFETY: Refuses to remove paths where .git is a directory (main working tree)
 * to prevent catastrophic data loss.
 *
 * IDE SAFETY: Detects processes (VS Code, Cursor, etc.) with open file handles
 * in the worktree.  When detected and `force` is false, the removal is skipped
 * to prevent IDE crashes caused by sudden workspace root deletion.
 */
function removeWorktree(
  worktreePath: string,
  force?: boolean,
): { success: boolean; skipped?: boolean; error?: string } {
  // Safety check: never remove the main working tree
  try {
    const gitPath = resolve(worktreePath, '.git')
    if (existsSync(gitPath) && statSync(gitPath).isDirectory()) {
      return {
        success: false,
        error: `SAFETY: ${worktreePath} is the main working tree (.git is a directory). Refusing to remove.`,
      }
    }
  } catch {
    // If we can't check, err on the side of caution
    return { success: false, error: `SAFETY: Could not verify ${worktreePath} is not the main working tree.` }
  }

  // IDE safety: check for processes with open file handles in this worktree
  const processes = getProcessesUsingPath(worktreePath)
  if (processes.length > 0 && !force) {
    return {
      success: false,
      skipped: true,
      error: `IDE/process still open: ${processes.join(', ')}. Use --force to remove anyway.`,
    }
  }
  if (processes.length > 0) {
    console.log(`\n    warning: ${processes.join(', ')} has files open — forcing removal`)
  }

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
    skipped: 0,
    errors: [],
  }

  console.log('Scanning worktrees...\n')

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
      const procs = getProcessesUsingPath(wt.path)
      const procNote = procs.length > 0 ? ` [open: ${procs.join(', ')}]` : ''
      console.log(`  Would remove: ${wt.path}${procNote}`)
    }
    console.log('')
    return result
  }

  console.log(`Cleaning up ${orphaned.length} orphaned worktree(s)...\n`)

  let removedCount = 0
  for (const wt of orphaned) {
    // Settle between removals so IDE file watchers can process previous
    // deletion events without being overwhelmed.
    if (removedCount > 0) {
      sleepSync(IDE_SETTLE_DELAY_MS)
    }

    process.stdout.write(`  Removing ${basename(wt.path)}... `)
    const removal = removeWorktree(wt.path, options.force)

    if (removal.success) {
      console.log('done')
      result.cleaned++
      removedCount++
    } else if (removal.skipped) {
      console.log(`SKIPPED: ${removal.error}`)
      result.skipped++
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
