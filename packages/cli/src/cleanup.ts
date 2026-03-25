#!/usr/bin/env node
/**
 * AgentFactory Cleanup CLI
 *
 * Cleans up orphaned git worktrees and stale local branches.
 *
 * Usage:
 *   af-cleanup [options]
 *
 * Options:
 *   --dry-run              Show what would be cleaned up without removing anything
 *   --force                Force removal / include branches with gone remotes
 *   --path <dir>           Custom worktrees directory (default: ../{repoName}.wt)
 *   --skip-worktrees       Skip worktree cleanup
 *   --skip-branches        Skip branch cleanup
 *   --help, -h             Show this help message
 */

import { basename } from 'path'
import { runCleanup, getGitRoot, type CleanupResult } from './lib/cleanup-runner.js'

function parseArgs(): {
  dryRun: boolean
  force: boolean
  worktreePath?: string
  skipWorktrees: boolean
  skipBranches: boolean
} {
  const args = process.argv.slice(2)
  const result = {
    dryRun: false,
    force: false,
    worktreePath: undefined as string | undefined,
    skipWorktrees: false,
    skipBranches: false,
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
      case '--skip-worktrees':
        result.skipWorktrees = true
        break
      case '--skip-branches':
        result.skipBranches = true
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
AgentFactory Cleanup - Remove orphaned worktrees and stale branches

Usage:
  af-cleanup [options]

Options:
  --dry-run              Show what would be cleaned up without removing
  --force                Force worktree removal + delete branches with gone remotes
  --path <dir>           Custom worktrees directory (default: ../{repoName}.wt)
  --skip-worktrees       Skip worktree cleanup
  --skip-branches        Skip branch cleanup
  --help, -h             Show this help message

Worktree cleanup:
  Orphaned worktrees are identified by:
    - Branch no longer exists (merged/deleted)
    - Not listed in 'git worktree list' (stale directory)

Branch cleanup:
  By default, deletes local branches already merged into main.
  With --force, also deletes branches whose remote tracking branch is gone.

Examples:
  # Preview what would be cleaned up
  af-cleanup --dry-run

  # Clean up everything (merged branches + orphaned worktrees)
  af-cleanup

  # Aggressive cleanup (includes branches with gone remotes)
  af-cleanup --force

  # Only clean up branches
  af-cleanup --skip-worktrees

  # Only clean up worktrees
  af-cleanup --skip-branches
`)
}

function printSummary(result: CleanupResult): void {
  console.log('=== Summary ===\n')

  if (result.scanned > 0 || result.orphaned > 0) {
    console.log('  Worktrees:')
    console.log(`    Scanned:  ${result.scanned}`)
    console.log(`    Orphaned: ${result.orphaned}`)
    console.log(`    Cleaned:  ${result.cleaned}`)
    if (result.skipped > 0) {
      console.log(`    Skipped:  ${result.skipped} (IDE/process still open — use --force)`)
    }
    if (result.errors.length > 0) {
      console.log(`    Errors:   ${result.errors.length}`)
      for (const err of result.errors) {
        console.log(`      - ${basename(err.path)}: ${err.error}`)
      }
    }
    console.log('')
  }

  if (result.branches.scanned > 0 || result.branches.deleted > 0) {
    console.log('  Branches:')
    console.log(`    Scanned:  ${result.branches.scanned}`)
    console.log(`    Deleted:  ${result.branches.deleted}`)
    if (result.branches.errors.length > 0) {
      console.log(`    Errors:   ${result.branches.errors.length}`)
      for (const err of result.branches.errors) {
        console.log(`      - ${err.branch}: ${err.error}`)
      }
    }
    console.log('')
  }

  const totalErrors = result.errors.length + result.branches.errors.length
  if (totalErrors === 0 && result.cleaned === 0 && result.branches.deleted === 0) {
    console.log('  Nothing to clean up.\n')
  }
}

// Main execution
function main(): void {
  const args = parseArgs()

  console.log('\n=== AgentFactory Cleanup ===\n')

  if (args.dryRun) {
    console.log('[DRY RUN MODE - No changes will be made]\n')
  }

  if (args.force) {
    console.log('[FORCE MODE - Aggressive cleanup enabled]\n')
  }

  const result = runCleanup({
    dryRun: args.dryRun,
    force: args.force,
    worktreePath: args.worktreePath,
    gitRoot: getGitRoot(),
    skipWorktrees: args.skipWorktrees,
    skipBranches: args.skipBranches,
  })

  printSummary(result)

  const totalErrors = result.errors.length + result.branches.errors.length
  if (totalErrors > 0) {
    process.exit(1)
  }
}

main()
