#!/usr/bin/env node
/**
 * AgentFactory Worktree Cleanup CLI
 *
 * Thin wrapper around the cleanup runner.
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

import { basename } from 'path'
import { runCleanup, getGitRoot, type CleanupResult } from './lib/cleanup-runner.js'

function parseArgs(): {
  dryRun: boolean
  force: boolean
  worktreePath?: string
} {
  const args = process.argv.slice(2)
  const result = {
    dryRun: false,
    force: false,
    worktreePath: undefined as string | undefined,
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

function printSummary(result: CleanupResult): void {
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
}

// Main execution
function main(): void {
  const args = parseArgs()

  console.log('\n=== AgentFactory Worktree Cleanup ===\n')

  if (args.dryRun) {
    console.log('[DRY RUN MODE - No changes will be made]\n')
  }

  if (args.force) {
    console.log('[FORCE MODE - All worktrees will be removed]\n')
  }

  const result = runCleanup({
    dryRun: args.dryRun,
    force: args.force,
    worktreePath: args.worktreePath,
    gitRoot: getGitRoot(),
  })

  printSummary(result)

  if (result.errors.length > 0) {
    process.exit(1)
  }
}

main()
