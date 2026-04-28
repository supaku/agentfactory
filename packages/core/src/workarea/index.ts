/**
 * Workarea module — scaffolding for WorkareaProvider (REN-1280)
 *
 * Exposes plain functions for git-worktree management and dependency linking.
 * These are consumed by the orchestrator today and will be migrated behind the
 * WorkareaProvider interface when REN-1280 ships.
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
} from './git-worktree.js'

export type {
  IncompleteWorkCheck,
  PushedWorkCheck,
  CreateWorktreeOptions,
} from './git-worktree.js'

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
