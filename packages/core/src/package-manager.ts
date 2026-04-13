/**
 * Shared package manager constants and helpers.
 *
 * Used by the orchestrator (worktree bootstrap, dep sync, helper scripts),
 * the merge queue (lockfile regeneration), and the CLI (af-add-dep).
 *
 * Framework-neutral: supports pnpm, npm, yarn, bun, and 'none' (non-Node projects).
 */

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none'

export const LOCK_FILES: Record<Exclude<PackageManager, 'none'>, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
  bun: 'bun.lockb',
}

export const INSTALL_COMMANDS: Record<Exclude<PackageManager, 'none'>, string> = {
  pnpm: 'pnpm install',
  npm: 'npm install',
  yarn: 'yarn install',
  bun: 'bun install',
}

const FROZEN_FLAGS: Record<Exclude<PackageManager, 'none'>, string> = {
  pnpm: '--frozen-lockfile',
  npm: '--ci',
  yarn: '--frozen-lockfile',
  bun: '--frozen-lockfile',
}

/** Explicit "allow lockfile changes" flags (for lockfile regeneration). */
const NO_FROZEN_FLAGS: Record<Exclude<PackageManager, 'none'>, string | null> = {
  pnpm: '--no-frozen-lockfile',
  npm: null,
  yarn: null,
  bun: null,
}

export const ADD_COMMANDS: Record<Exclude<PackageManager, 'none'>, string> = {
  pnpm: 'pnpm add',
  npm: 'npm install',
  yarn: 'yarn add',
  bun: 'bun add',
}

export const GITATTRIBUTES_ENTRIES: Record<Exclude<PackageManager, 'none'>, string> = {
  pnpm: 'pnpm-lock.yaml merge=ours',
  npm: 'package-lock.json merge=ours',
  yarn: 'yarn.lock merge=ours',
  bun: 'bun.lockb merge=ours',
}

/** Get the lockfile name for a package manager, or null for 'none'. */
export function getLockFileName(pm: PackageManager): string | null {
  if (pm === 'none') return null
  return LOCK_FILES[pm] ?? null
}

/** Get the install command for a package manager, with optional frozen-lockfile flag. */
export function getInstallCommand(pm: PackageManager, frozen?: boolean): string | null {
  if (pm === 'none') return null
  const base = INSTALL_COMMANDS[pm]
  if (!base) return null
  if (frozen) {
    const flag = FROZEN_FLAGS[pm]
    return flag ? `${base} ${flag}` : base
  }
  return base
}

/** Get the install command that explicitly allows lockfile regeneration. */
export function getRegenerateCommand(pm: PackageManager): string | null {
  if (pm === 'none') return null
  const base = INSTALL_COMMANDS[pm]
  if (!base) return null
  const flag = NO_FROZEN_FLAGS[pm]
  return flag ? `${base} ${flag}` : base
}

/** Get the "add package" command for a package manager. */
export function getAddCommand(pm: PackageManager): string | null {
  if (pm === 'none') return null
  return ADD_COMMANDS[pm] ?? null
}

/** Get the gitattributes merge=ours entry for a package manager's lockfile. */
export function getGitattributesEntry(pm: PackageManager): string | null {
  if (pm === 'none') return null
  return GITATTRIBUTES_ENTRIES[pm] ?? null
}
