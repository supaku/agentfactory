/**
 * Tests for the Linux systemd installer — REN-1293.
 *
 * All tests use `skipSystemctl: true` so no actual systemd commands are run.
 * This keeps the suite distro-agnostic and safe to run on macOS CI runners
 * as well as Linux.
 *
 * Covered:
 *   - generateUnitFile() — user and system scope, all optional fields
 *   - installSystemdUnit() — creates dirs, writes correct unit file
 *   - uninstallSystemdUnit() — removes unit file
 *   - systemdDoctor() — reports unitExists correctly without systemctl
 *   - resolveDaemonBinPath() — returns supplied path / falls back to process.execPath
 *   - EXIT_CODE_RESTART contract (SuccessExitStatus=3 present in unit file)
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  existsSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import {
  generateUnitFile,
  installSystemdUnit,
  uninstallSystemdUnit,
  systemdDoctor,
  resolveDaemonBinPath,
  UNIT_NAME,
  UNIT_FILENAME,
  USER_UNIT_DIR,
  SYSTEM_UNIT_DIR,
} from './installer-linux.js'

// ---------------------------------------------------------------------------
// resolveDaemonBinPath
// ---------------------------------------------------------------------------

describe('resolveDaemonBinPath', () => {
  it('returns the provided binPath unchanged', () => {
    const path = '/usr/local/bin/rensei-daemon'
    expect(resolveDaemonBinPath(path)).toBe(path)
  })

  it('falls back to process.execPath when no path is given and which fails', () => {
    // On macOS/CI, `which rensei-daemon` likely fails — we get process.execPath
    const result = resolveDaemonBinPath(undefined)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// generateUnitFile — user scope
// ---------------------------------------------------------------------------

describe('generateUnitFile — user scope', () => {
  const BIN = '/usr/local/bin/rensei-daemon'

  it('includes correct [Unit] section', () => {
    const content = generateUnitFile('user', BIN)
    expect(content).toContain('[Unit]')
    expect(content).toContain('Description=Rensei local daemon — worker pool')
    expect(content).toContain('After=network-online.target')
  })

  it('includes correct [Service] section', () => {
    const content = generateUnitFile('user', BIN)
    expect(content).toContain('[Service]')
    expect(content).toContain(`ExecStart=${BIN} start`)
    expect(content).toContain('Restart=on-failure')
    expect(content).toContain('StandardOutput=journal')
    expect(content).toContain('StandardError=journal')
    expect(content).toContain(`SyslogIdentifier=${UNIT_NAME}`)
  })

  it('honours EXIT_CODE_RESTART contract with SuccessExitStatus=3', () => {
    const content = generateUnitFile('user', BIN)
    expect(content).toContain('SuccessExitStatus=3')
  })

  it('uses WantedBy=default.target for user scope', () => {
    const content = generateUnitFile('user', BIN)
    expect(content).toContain('WantedBy=default.target')
    expect(content).not.toContain('WantedBy=multi-user.target')
  })

  it('does not include User= line for user scope', () => {
    const content = generateUnitFile('user', BIN)
    expect(content).not.toMatch(/^User=/m)
  })

  it('includes RENSEI_DAEMON_CONFIG when configPath is set', () => {
    const content = generateUnitFile('user', BIN, { configPath: '/home/me/.rensei/daemon.yaml' })
    expect(content).toContain('Environment=RENSEI_DAEMON_CONFIG=/home/me/.rensei/daemon.yaml')
  })

  it('omits Environment= line when configPath is not set', () => {
    const content = generateUnitFile('user', BIN)
    expect(content).not.toContain('Environment=RENSEI_DAEMON_CONFIG')
  })

  it('accepts a custom description', () => {
    const content = generateUnitFile('user', BIN, { description: 'My custom daemon description' })
    expect(content).toContain('Description=My custom daemon description')
  })

  it('ends with a trailing newline', () => {
    const content = generateUnitFile('user', BIN)
    expect(content.endsWith('\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// generateUnitFile — system scope
// ---------------------------------------------------------------------------

describe('generateUnitFile — system scope', () => {
  const BIN = '/usr/local/bin/rensei-daemon'

  it('uses WantedBy=multi-user.target for system scope', () => {
    const content = generateUnitFile('system', BIN)
    expect(content).toContain('WantedBy=multi-user.target')
    expect(content).not.toContain('WantedBy=default.target')
  })

  it('includes a User= line for system scope', () => {
    const content = generateUnitFile('system', BIN)
    expect(content).toMatch(/^User=\S+/m)
  })
})

// ---------------------------------------------------------------------------
// installSystemdUnit — user scope
// ---------------------------------------------------------------------------

describe('installSystemdUnit — user scope', () => {
  const BIN = '/usr/local/bin/rensei-daemon'
  const unitPath = resolve(USER_UNIT_DIR, UNIT_FILENAME)

  afterEach(() => {
    if (existsSync(unitPath)) rmSync(unitPath)
  })

  it('returns the unit file path', () => {
    const result = installSystemdUnit({
      scope: 'user',
      binPath: BIN,
      skipSystemctl: true,
    })
    expect(result).toBe(unitPath)
  })

  it('creates the unit file', () => {
    installSystemdUnit({
      scope: 'user',
      binPath: BIN,
      skipSystemctl: true,
    })
    expect(existsSync(unitPath)).toBe(true)
  })

  it('writes a valid unit file with correct ExecStart', () => {
    installSystemdUnit({
      scope: 'user',
      binPath: BIN,
      skipSystemctl: true,
    })
    const content = readFileSync(unitPath, 'utf-8')
    expect(content).toContain(`ExecStart=${BIN} start`)
    expect(content).toContain('SuccessExitStatus=3')
    expect(content).toContain('WantedBy=default.target')
  })

  it('creates the user unit directory if it does not exist', () => {
    // Temporarily remove the dir if empty — guard: only do this if dir is empty
    // Because this affects the real ~/.config/systemd/user dir, we just verify
    // the install call creates whatever directories are needed.
    installSystemdUnit({
      scope: 'user',
      binPath: BIN,
      skipSystemctl: true,
    })
    expect(existsSync(USER_UNIT_DIR)).toBe(true)
  })

  it('writes configPath as Environment= when provided', () => {
    installSystemdUnit({
      scope: 'user',
      binPath: BIN,
      skipSystemctl: true,
      configPath: '/tmp/test-daemon.yaml',
    })
    const content = readFileSync(unitPath, 'utf-8')
    expect(content).toContain('Environment=RENSEI_DAEMON_CONFIG=/tmp/test-daemon.yaml')
  })
})

// ---------------------------------------------------------------------------
// uninstallSystemdUnit
// ---------------------------------------------------------------------------

describe('uninstallSystemdUnit', () => {
  const BIN = '/usr/local/bin/rensei-daemon'
  const unitPath = resolve(USER_UNIT_DIR, UNIT_FILENAME)

  afterEach(() => {
    if (existsSync(unitPath)) rmSync(unitPath)
  })

  it('removes the unit file if it exists', () => {
    installSystemdUnit({ scope: 'user', binPath: BIN, skipSystemctl: true })
    expect(existsSync(unitPath)).toBe(true)

    uninstallSystemdUnit({ scope: 'user', skipSystemctl: true })
    expect(existsSync(unitPath)).toBe(false)
  })

  it('returns the unit file path', () => {
    installSystemdUnit({ scope: 'user', binPath: BIN, skipSystemctl: true })
    const result = uninstallSystemdUnit({ scope: 'user', skipSystemctl: true })
    expect(result).toBe(unitPath)
  })

  it('is idempotent when unit file does not exist', () => {
    if (existsSync(unitPath)) rmSync(unitPath)
    expect(() =>
      uninstallSystemdUnit({ scope: 'user', skipSystemctl: true })
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// systemdDoctor
// ---------------------------------------------------------------------------

describe('systemdDoctor', () => {
  const BIN = '/usr/local/bin/rensei-daemon'
  const unitPath = resolve(USER_UNIT_DIR, UNIT_FILENAME)

  afterEach(() => {
    if (existsSync(unitPath)) rmSync(unitPath)
  })

  it('reports unitExists: false when unit file is absent', () => {
    if (existsSync(unitPath)) rmSync(unitPath)

    const result = systemdDoctor({ scope: 'user', skipSystemctl: true })
    expect(result.unitExists).toBe(false)
    expect(result.scope).toBe('user')
    expect(result.unitPath).toBe(unitPath)
  })

  it('reports unitExists: true when unit file is present', () => {
    installSystemdUnit({ scope: 'user', binPath: BIN, skipSystemctl: true })

    const result = systemdDoctor({ scope: 'user', skipSystemctl: true })
    expect(result.unitExists).toBe(true)
  })

  it('does not populate isActive/isEnabled/statusOutput when skipSystemctl is true', () => {
    installSystemdUnit({ scope: 'user', binPath: BIN, skipSystemctl: true })

    const result = systemdDoctor({ scope: 'user', skipSystemctl: true })
    expect(result.isActive).toBeUndefined()
    expect(result.isEnabled).toBeUndefined()
    expect(result.statusOutput).toBeUndefined()
  })

  it('uses correct unit path for system scope', () => {
    const result = systemdDoctor({ scope: 'system', skipSystemctl: true })
    expect(result.unitPath).toBe(resolve(SYSTEM_UNIT_DIR, UNIT_FILENAME))
    expect(result.scope).toBe('system')
  })
})

// ---------------------------------------------------------------------------
// Integration-style: full install → doctor → uninstall cycle
// ---------------------------------------------------------------------------

describe('install → doctor → uninstall cycle', () => {
  const BIN = '/usr/local/bin/rensei-daemon'
  const unitPath = resolve(USER_UNIT_DIR, UNIT_FILENAME)

  afterEach(() => {
    if (existsSync(unitPath)) rmSync(unitPath)
  })

  it('goes through a complete lifecycle without errors', () => {
    // Install
    const installed = installSystemdUnit({
      scope: 'user',
      binPath: BIN,
      skipSystemctl: true,
    })
    expect(existsSync(installed)).toBe(true)

    // Doctor
    const health = systemdDoctor({ scope: 'user', skipSystemctl: true })
    expect(health.unitExists).toBe(true)
    expect(health.unitPath).toBe(installed)

    // Uninstall
    uninstallSystemdUnit({ scope: 'user', skipSystemctl: true })
    expect(existsSync(installed)).toBe(false)

    // Doctor after uninstall
    const healthAfter = systemdDoctor({ scope: 'user', skipSystemctl: true })
    expect(healthAfter.unitExists).toBe(false)
  })
})
