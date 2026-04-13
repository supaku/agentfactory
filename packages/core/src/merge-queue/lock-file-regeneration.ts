import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, access } from 'fs/promises'
import { join } from 'path'
import {
  type PackageManager,
  LOCK_FILES,
  GITATTRIBUTES_ENTRIES,
  getRegenerateCommand,
} from '../package-manager.js'

const exec = promisify(execCb)

// Re-export for backward compatibility
export type { PackageManager } from '../package-manager.js'

export interface RegenerationResult {
  success: boolean
  lockFile: string
  packageManager: PackageManager
  error?: string
}

export class LockFileRegeneration {
  shouldRegenerate(packageManager: PackageManager, lockFileRegenerate: boolean): boolean {
    return lockFileRegenerate && packageManager !== 'none'
  }

  getLockFileName(packageManager: PackageManager): string | null {
    if (packageManager === 'none') return null
    return LOCK_FILES[packageManager] ?? null
  }

  async regenerate(worktreePath: string, packageManager: PackageManager): Promise<RegenerationResult> {
    const lockFile = this.getLockFileName(packageManager)
    if (!lockFile) {
      return { success: false, lockFile: '', packageManager, error: `Unsupported package manager: ${packageManager}` }
    }

    const installCommand = getRegenerateCommand(packageManager)

    if (!installCommand) {
      return { success: false, lockFile: '', packageManager, error: `No install command for: ${packageManager}` }
    }

    try {
      // 1. Delete the conflicted lock file (if it exists)
      const lockFilePath = join(worktreePath, lockFile)
      try {
        await access(lockFilePath)
        await exec(`rm "${lockFile}"`, { cwd: worktreePath })
      } catch {
        // Lock file doesn't exist, that's fine
      }

      // 2. Run package manager install to regenerate
      await exec(installCommand, {
        cwd: worktreePath,
        timeout: 120_000, // 2 minute timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for install output
      })

      // 3. Stage the regenerated lock file
      await exec(`git add "${lockFile}"`, { cwd: worktreePath })

      return { success: true, lockFile, packageManager }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, lockFile, packageManager, error: message }
    }
  }

  async ensureGitAttributes(repoPath: string, packageManager: PackageManager): Promise<void> {
    if (packageManager === 'none') return
    const entry = GITATTRIBUTES_ENTRIES[packageManager]
    if (!entry) return

    const gitattributesPath = join(repoPath, '.gitattributes')
    let content = ''

    try {
      content = await readFile(gitattributesPath, 'utf-8')
    } catch {
      // File doesn't exist yet
    }

    if (content.includes(entry)) {
      return // Already configured
    }

    const newContent = content.endsWith('\n') || content === ''
      ? content + entry + '\n'
      : content + '\n' + entry + '\n'

    await writeFile(gitattributesPath, newContent, 'utf-8')
  }
}
