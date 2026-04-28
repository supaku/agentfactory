/**
 * Workarea module — scaffolding for WorkareaProvider (REN-1280)
 *
 * Exposes plain functions for git-worktree management and dependency linking.
 * These are consumed by the orchestrator today and will be migrated behind the
 * WorkareaProvider interface when REN-1280 ships.
 *
 * Typed public API (REN-1285):
 *   addWorktree, removeWorktreePath, listWorktrees, cleanWorktree
 *   — each returns a structured Result type, no thrown errors for expected failures.
 */

export {
  // Path helpers
  findRepoRoot,
  resolveMainRepoRoot,
  resolveWorktreePath,
  // Worktree identifier
  getWorktreeIdentifier,
  // Incomplete work checks
  checkForIncompleteWork,
  checkForPushedWorkWithoutPR,
  // Worktree validation & lifecycle
  validateWorktree,
  isMainWorktree,
  isInsideWorktreesDir,
  tryCleanupConflictingWorktree,
  handleBranchConflict,
  createWorktree,
  removeWorktree,
  // Bootstrap helpers
  bootstrapWorktreeDeps,
  configureMergiraf,
  // Typed public API (REN-1285)
  addWorktree,
  removeWorktreePath,
  listWorktrees,
  cleanWorktree,
} from './git-worktree.js'

export type {
  IncompleteWorkCheck,
  PushedWorkCheck,
  CreateWorktreeOptions,
} from './git-worktree.js'

// Result types (REN-1285)
export {
  ok,
  err,
} from './types.js'

export type {
  Result,
  AddWorktreeError,
  AddWorktreeValue,
  AddWorktreeResult,
  RemoveWorktreeError,
  RemoveWorktreeResult,
  ListWorktreesError,
  ListWorktreesResult,
  CleanWorktreeError,
  CleanWorktreeValue,
  CleanWorktreeResult,
  WorktreeEntry,
} from './types.js'

export {
  // Symlink helpers
  safeSymlink,
  linkNodeModulesContents,
  removeWorktreeNodeModules,
  verifyDependencyLinks,
  installDependencies,
  linkDependencies,
  syncDependencies,
} from './dep-linker.js'
