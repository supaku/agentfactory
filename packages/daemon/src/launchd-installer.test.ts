/**
 * launchd installer tests — REN-1292
 *
 * Tests the plist generator, install/uninstall flows, and doctor health checks.
 * All filesystem I/O uses tmp dirs. No root required; launchctl calls are mocked
 * via vi.mock so they never execute the real binary.
 *
 * Test groups:
 *   generatePlist    — XML structure, correct paths, both binary locations
 *   install          — plist written, launchctl called, binary-not-found error
 *   uninstall        — plist removed, launchctl called, idempotent when absent
 *   doctor           — all-pass, plist-missing, not-loaded, pid-zero, pid-nonzero
 *   resolveDaemonBin — global vs user-scoped fallback via constants
 *   readInstalledPlist — present vs absent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Mock child_process before any module imports that depend on it
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}))

import { execFileSync } from 'node:child_process'
const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>

import {
  generatePlist,
  install,
  uninstall,
  doctor,
  resolveDaemonBin,
  readInstalledPlist,
  LAUNCHD_LABEL,
  LOG_PATH,
  ERROR_LOG_PATH,
  DEFAULT_DAEMON_BIN_GLOBAL,
  DEFAULT_DAEMON_BIN_USER,
} from './launchd-installer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'launchd-test-'))
}

/**
 * Create a fake executable file so `existsSync(path)` returns true.
 */
function touch(filePath: string): void {
  const dir = resolve(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, '#!/bin/sh\necho stub\n', { mode: 0o755 })
}

// Reset the mock before each test
beforeEach(() => {
  mockExecFileSync.mockClear()
  mockExecFileSync.mockReturnValue(Buffer.from(''))
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// generatePlist
// ---------------------------------------------------------------------------

describe('generatePlist', () => {
  it('produces valid XML with the correct label', () => {
    const xml = generatePlist('/usr/local/bin/rensei-daemon')
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`)
  })

  it('embeds the supplied binary path', () => {
    const bin = '/custom/path/rensei-daemon'
    const xml = generatePlist(bin)
    expect(xml).toContain(`<string>${bin}</string>`)
  })

  it('uses the default log paths when none are supplied', () => {
    const xml = generatePlist('/usr/local/bin/rensei-daemon')
    expect(xml).toContain(`<string>${LOG_PATH}</string>`)
    expect(xml).toContain(`<string>${ERROR_LOG_PATH}</string>`)
  })

  it('uses overridden log paths when supplied', () => {
    const logPath = '/tmp/custom/daemon.log'
    const errPath = '/tmp/custom/daemon-error.log'
    const xml = generatePlist('/usr/local/bin/rensei-daemon', logPath, errPath)
    expect(xml).toContain(`<string>${logPath}</string>`)
    expect(xml).toContain(`<string>${errPath}</string>`)
  })

  it('includes RunAtLoad, KeepAlive, and ThrottleInterval keys', () => {
    const xml = generatePlist('/usr/local/bin/rensei-daemon')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<true/>')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<key>ThrottleInterval</key>')
    expect(xml).toContain('<integer>30</integer>')
  })

  it('sets ProgramArguments with start subcommand', () => {
    const xml = generatePlist('/usr/local/bin/rensei-daemon')
    expect(xml).toContain('<key>ProgramArguments</key>')
    expect(xml).toContain('<string>start</string>')
  })

  it('includes HOME and PATH in EnvironmentVariables', () => {
    const xml = generatePlist('/usr/local/bin/rensei-daemon')
    expect(xml).toContain('<key>EnvironmentVariables</key>')
    expect(xml).toContain('<key>HOME</key>')
    expect(xml).toContain(`<string>${homedir()}</string>`)
    expect(xml).toContain('<key>PATH</key>')
    // Both Homebrew ARM and Intel paths should be present
    expect(xml).toContain('/opt/homebrew/bin')
    expect(xml).toContain('/usr/local/bin')
  })

  it('generates valid XML for user-scoped binary path', () => {
    const userBin = resolve(homedir(), '.rensei', 'bin', 'rensei-daemon')
    const xml = generatePlist(userBin)
    expect(xml).toContain(`<string>${userBin}</string>`)
  })
})

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe('install', () => {
  let tmpDir: string
  let fakePlistPath: string
  let fakeBinPath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    fakePlistPath = resolve(tmpDir, 'dev.rensei.daemon.plist')
    fakeBinPath = resolve(tmpDir, 'rensei-daemon')
    touch(fakeBinPath)
  })

  it('writes the plist to the specified path', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    expect(existsSync(fakePlistPath)).toBe(true)
  })

  it('plist content embeds the daemon binary path', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const content = readInstalledPlist(fakePlistPath)
    expect(content).toBeDefined()
    expect(content).toContain(fakeBinPath)
  })

  it('calls launchctl load -w when skipLoad is false', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath })
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'launchctl',
      ['load', '-w', fakePlistPath],
      expect.objectContaining({ stdio: 'pipe' }),
    )
  })

  it('does NOT call launchctl when skipLoad is true', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns the correct plistPath and daemonBinPath', () => {
    const result = install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    expect(result.plistPath).toBe(fakePlistPath)
    expect(result.daemonBinPath).toBe(fakeBinPath)
    expect(result.loaded).toBe(false)
  })

  it('returns loaded:true when launchctl is called', () => {
    const result = install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath })
    expect(result.loaded).toBe(true)
  })

  it('throws if the daemon binary does not exist', () => {
    expect(() =>
      install({
        plistPath: fakePlistPath,
        daemonBinPath: resolve(tmpDir, 'nonexistent-daemon'),
        skipLoad: true,
      }),
    ).toThrow(/binary not found/)
  })

  it('creates the plist parent directory if missing', () => {
    const nestedPlistPath = resolve(tmpDir, 'nested', 'subdir', 'dev.rensei.daemon.plist')
    install({ plistPath: nestedPlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    expect(existsSync(nestedPlistPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

describe('uninstall', () => {
  let tmpDir: string
  let fakePlistPath: string
  let fakeBinPath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    fakePlistPath = resolve(tmpDir, 'dev.rensei.daemon.plist')
    fakeBinPath = resolve(tmpDir, 'rensei-daemon')
    touch(fakeBinPath)
  })

  it('removes the plist file', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    expect(existsSync(fakePlistPath)).toBe(true)

    uninstall({ plistPath: fakePlistPath, skipUnload: true })
    expect(existsSync(fakePlistPath)).toBe(false)
  })

  it('calls launchctl unload -w when skipUnload is false', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    mockExecFileSync.mockClear()
    uninstall({ plistPath: fakePlistPath })
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'launchctl',
      ['unload', '-w', fakePlistPath],
      expect.objectContaining({ stdio: 'pipe' }),
    )
  })

  it('does NOT call launchctl when skipUnload is true', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    mockExecFileSync.mockClear()
    uninstall({ plistPath: fakePlistPath, skipUnload: true })
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns false and does not throw when plist is absent (idempotent)', () => {
    const result = uninstall({ plistPath: fakePlistPath, skipUnload: true })
    expect(result).toBe(false)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns true when plist was found and removed', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const result = uninstall({ plistPath: fakePlistPath, skipUnload: true })
    expect(result).toBe(true)
  })

  it('continues to remove plist even if launchctl unload fails', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('launchctl: service not found')
    })
    const result = uninstall({ plistPath: fakePlistPath })
    expect(result).toBe(true)
    expect(existsSync(fakePlistPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor', () => {
  let tmpDir: string
  let fakePlistPath: string
  let fakeBinPath: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    fakePlistPath = resolve(tmpDir, 'dev.rensei.daemon.plist')
    fakeBinPath = resolve(tmpDir, 'rensei-daemon')
    touch(fakeBinPath)
  })

  it('reports plist-exists as failed when plist is absent', () => {
    const result = doctor({ plistPath: fakePlistPath }, () => '')
    const check = result.checks.find((c) => c.name === 'plist-exists')
    expect(check?.passed).toBe(false)
    expect(result.healthy).toBe(false)
  })

  it('reports plist-exists as passed when plist is present', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const result = doctor({ plistPath: fakePlistPath }, () => '')
    const check = result.checks.find((c) => c.name === 'plist-exists')
    expect(check?.passed).toBe(true)
  })

  it('reports launchctl-loaded as failed when service is not in launchctl output', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const result = doctor({ plistPath: fakePlistPath }, () => '')
    const check = result.checks.find((c) => c.name === 'launchctl-loaded')
    expect(check?.passed).toBe(false)
    expect(result.healthy).toBe(false)
  })

  it('reports launchctl-loaded as passed when label is in launchctl output', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const launchctlOutput = `{
  "Label" = "${LAUNCHD_LABEL}";
  "PID" = 0;
};`
    const result = doctor({ plistPath: fakePlistPath }, () => launchctlOutput)
    const check = result.checks.find((c) => c.name === 'launchctl-loaded')
    expect(check?.passed).toBe(true)
  })

  it('reports daemon-running as failed when PID is 0', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const launchctlOutput = `{
  "Label" = "${LAUNCHD_LABEL}";
  "PID" = 0;
};`
    const result = doctor({ plistPath: fakePlistPath }, () => launchctlOutput)
    const check = result.checks.find((c) => c.name === 'daemon-running')
    expect(check?.passed).toBe(false)
    expect(result.healthy).toBe(false)
  })

  it('reports daemon-running as passed when PID is nonzero', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const launchctlOutput = `{
  "Label" = "${LAUNCHD_LABEL}";
  "PID" = 12345;
};`
    const result = doctor({ plistPath: fakePlistPath }, () => launchctlOutput)
    const check = result.checks.find((c) => c.name === 'daemon-running')
    expect(check?.passed).toBe(true)
    expect(check?.detail).toContain('12345')
  })

  it('returns healthy: true when all checks pass', () => {
    install({ plistPath: fakePlistPath, daemonBinPath: fakeBinPath, skipLoad: true })
    const launchctlOutput = `{
  "Label" = "${LAUNCHD_LABEL}";
  "PID" = 99999;
};`
    const result = doctor({ plistPath: fakePlistPath }, () => launchctlOutput)
    expect(result.healthy).toBe(true)
    expect(result.checks).toHaveLength(3)
    expect(result.checks.every((c) => c.passed)).toBe(true)
  })

  it('returns all 3 check entries even when plist is missing', () => {
    const result = doctor({ plistPath: fakePlistPath }, () => '')
    expect(result.checks).toHaveLength(3)
    expect(result.checks.map((c) => c.name)).toEqual([
      'plist-exists',
      'launchctl-loaded',
      'daemon-running',
    ])
  })
})

// ---------------------------------------------------------------------------
// resolveDaemonBin
// ---------------------------------------------------------------------------

describe('resolveDaemonBin', () => {
  it('returns one of the two known binary paths', () => {
    const result = resolveDaemonBin()
    expect([DEFAULT_DAEMON_BIN_GLOBAL, DEFAULT_DAEMON_BIN_USER]).toContain(result)
  })

  it('DEFAULT_DAEMON_BIN_USER ends with .rensei/bin/rensei-daemon', () => {
    expect(DEFAULT_DAEMON_BIN_USER).toContain('.rensei/bin/rensei-daemon')
  })

  it('DEFAULT_DAEMON_BIN_GLOBAL is /usr/local/bin/rensei-daemon', () => {
    expect(DEFAULT_DAEMON_BIN_GLOBAL).toBe('/usr/local/bin/rensei-daemon')
  })
})

// ---------------------------------------------------------------------------
// readInstalledPlist
// ---------------------------------------------------------------------------

describe('readInstalledPlist', () => {
  it('returns undefined when plist is not installed', () => {
    const result = readInstalledPlist('/tmp/nonexistent-path-abc123/plist.plist')
    expect(result).toBeUndefined()
  })

  it('returns the plist content when installed', () => {
    const tmpDir = makeTmpDir()
    const plistPath = resolve(tmpDir, 'dev.rensei.daemon.plist')
    const bin = resolve(tmpDir, 'rensei-daemon')
    touch(bin)
    install({ plistPath, daemonBinPath: bin, skipLoad: true })

    const content = readInstalledPlist(plistPath)
    expect(content).toBeDefined()
    expect(content).toContain(LAUNCHD_LABEL)
  })
})
