import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('version utilities', () => {
  describe('getVersion', () => {
    it('returns a semver-like version string', async () => {
      const { getVersion } = await import('../version.js')
      const version = getVersion()
      // Should match x.y.z pattern (since we're in the monorepo)
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe('checkForUpdate', () => {
    it('returns null when AF_NO_UPDATE_CHECK is set', async () => {
      const { checkForUpdate } = await import('../version.js')
      const original = process.env.AF_NO_UPDATE_CHECK
      process.env.AF_NO_UPDATE_CHECK = '1'
      try {
        const result = await checkForUpdate()
        expect(result).toBeNull()
      } finally {
        if (original === undefined) {
          delete process.env.AF_NO_UPDATE_CHECK
        } else {
          process.env.AF_NO_UPDATE_CHECK = original
        }
      }
    })

    it('returns null when noUpdateCheck option is true', async () => {
      const { checkForUpdate } = await import('../version.js')
      const result = await checkForUpdate({ noUpdateCheck: true })
      expect(result).toBeNull()
    })
  })

  describe('printUpdateNotification', () => {
    it('prints nothing when no update is available', async () => {
      const { printUpdateNotification } = await import('../version.js')
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      printUpdateNotification(null)
      printUpdateNotification({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false })
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('prints notification when update is available', async () => {
      const { printUpdateNotification } = await import('../version.js')
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      printUpdateNotification({ currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true })
      expect(spy).toHaveBeenCalledTimes(1)
      const output = spy.mock.calls[0][0] as string
      expect(output).toContain('Update available')
      expect(output).toContain('1.0.0')
      expect(output).toContain('2.0.0')
      spy.mockRestore()
    })
  })
})

describe('auto-updater', () => {
  describe('isAutoUpdateEnabled', () => {
    it('returns CLI flag when provided', async () => {
      const { isAutoUpdateEnabled } = await import('../auto-updater.js')
      expect(isAutoUpdateEnabled(true)).toBe(true)
      expect(isAutoUpdateEnabled(false)).toBe(false)
    })

    it('reads from AF_AUTO_UPDATE env var', async () => {
      const { isAutoUpdateEnabled } = await import('../auto-updater.js')
      const original = process.env.AF_AUTO_UPDATE
      try {
        process.env.AF_AUTO_UPDATE = 'true'
        expect(isAutoUpdateEnabled()).toBe(true)
        process.env.AF_AUTO_UPDATE = 'false'
        expect(isAutoUpdateEnabled()).toBe(false)
      } finally {
        if (original === undefined) {
          delete process.env.AF_AUTO_UPDATE
        } else {
          process.env.AF_AUTO_UPDATE = original
        }
      }
    })

    it('defaults to false', async () => {
      const { isAutoUpdateEnabled } = await import('../auto-updater.js')
      const original = process.env.AF_AUTO_UPDATE
      delete process.env.AF_AUTO_UPDATE
      try {
        expect(isAutoUpdateEnabled()).toBe(false)
      } finally {
        if (original !== undefined) {
          process.env.AF_AUTO_UPDATE = original
        }
      }
    })
  })

  describe('maybeAutoUpdate', () => {
    it('returns false when auto-update is disabled', async () => {
      const { maybeAutoUpdate } = await import('../auto-updater.js')
      const result = await maybeAutoUpdate(
        { currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true },
        { cliFlag: false },
      )
      expect(result).toBe(false)
    })

    it('returns false when no update is available', async () => {
      const { maybeAutoUpdate } = await import('../auto-updater.js')
      const result = await maybeAutoUpdate(
        { currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false },
        { cliFlag: true },
      )
      expect(result).toBe(false)
    })

    it('returns false when null update check', async () => {
      const { maybeAutoUpdate } = await import('../auto-updater.js')
      const result = await maybeAutoUpdate(null, { cliFlag: true })
      expect(result).toBe(false)
    })

    it('defers when workers are active', async () => {
      const { maybeAutoUpdate } = await import('../auto-updater.js')
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const result = await maybeAutoUpdate(
        { currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true },
        { cliFlag: true, hasActiveWorkers: async () => true },
      )
      expect(result).toBe(false)
      expect(spy).toHaveBeenCalled()
      const output = spy.mock.calls[0][0] as string
      expect(output).toContain('deferring')
      spy.mockRestore()
    })
  })
})
