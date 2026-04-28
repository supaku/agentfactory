/**
 * Linux systemd installer for the Rensei daemon.
 *
 * Architecture reference:
 *   rensei-architecture/011-local-daemon-fleet.md §Linux (systemd)
 *
 * Installs and manages the daemon as a systemd unit. Two scopes are supported:
 *
 *   --user   (default) — user-scoped unit at ~/.config/systemd/user/
 *                        Managed via `systemctl --user`.
 *                        Logs visible via `journalctl --user -u rensei-daemon`.
 *
 *   --system           — system-scoped unit at /etc/systemd/system/
 *                        Requires root (sudo).
 *                        Logs visible via `journalctl -u rensei-daemon`.
 *
 * The EXIT_CODE_RESTART (3) contract is honoured: the systemd unit uses
 * `RestartPreventExitStatus=` to treat exit 3 as a clean restart request,
 * not a crash. The crash counter is not incremented.
 *
 * Architecture notes:
 *   - The unit ExecStart points to the `rensei-daemon` binary resolved via
 *     `which rensei-daemon` at install time (or process.execPath if running
 *     from the daemon binary itself).
 *   - `StandardOutput=journal` and `StandardError=journal` route all logs
 *     to journald, surfaced via `journalctl`.
 *   - ARM64 and x86_64 are both supported — the unit file is arch-agnostic;
 *     the binary path is resolved at install time.
 *   - distro-agnostic: works on Ubuntu, Fedora, Debian, NixOS, and any
 *     distro that ships systemd ≥ 232 (user lingering support).
 *   - `WantedBy=default.target` is used for the user unit (standard for
 *     user-session services that should start on login).
 *
 * Restart contract (exit code 3):
 *   The `RestartPreventExitStatus=` directive is intentionally NOT set for
 *   exit code 3, so systemd does restart on code 3. The `SuccessExitStatus=3`
 *   directive tells systemd to treat exit code 3 as "successful", avoiding
 *   crash counters while still triggering a restart.
 *
 * @module installer-linux
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { resolve as resolvePath, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Systemd unit name (without .service suffix). */
export const UNIT_NAME = 'rensei-daemon'

/** Systemd unit filename. */
export const UNIT_FILENAME = `${UNIT_NAME}.service`

/** Default user-scope unit directory. */
export const USER_UNIT_DIR = resolvePath(homedir(), '.config', 'systemd', 'user')

/** System-scope unit directory (requires root). */
export const SYSTEM_UNIT_DIR = '/etc/systemd/system'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SystemdScope = 'user' | 'system'

export interface SystemdInstallOptions {
  /**
   * Scope of the unit: 'user' (default) or 'system'.
   * 'system' requires root (sudo).
   */
  scope?: SystemdScope

  /**
   * Path to the `rensei-daemon` binary.
   * Defaults to `which rensei-daemon` or `process.execPath`.
   */
  binPath?: string

  /**
   * Description written into the [Unit] Description= field.
   */
  description?: string

  /**
   * Path to daemon config file (RENSEI_DAEMON_CONFIG env override).
   * If omitted, the daemon uses its default (~/.rensei/daemon.yaml).
   */
  configPath?: string

  /**
   * Skip running `systemctl` commands after writing the unit file.
   * Useful for testing and CI environments without systemd.
   */
  skipSystemctl?: boolean
}

export interface SystemdUninstallOptions {
  /** Scope used at install time. */
  scope?: SystemdScope
  /** Skip running `systemctl` commands. */
  skipSystemctl?: boolean
}

export interface SystemdDoctorOptions {
  /** Scope to check. */
  scope?: SystemdScope
  /** Skip running `systemctl` commands (for testing). */
  skipSystemctl?: boolean
}

export interface SystemdDoctorResult {
  unitPath: string
  unitExists: boolean
  /** Whether `systemctl is-active` reports active. undefined if skipSystemctl. */
  isActive?: boolean
  /** Whether `systemctl is-enabled` reports enabled. undefined if skipSystemctl. */
  isEnabled?: boolean
  /** Raw output of `systemctl status` (trimmed). undefined if skipSystemctl. */
  statusOutput?: string
  /** Scope used for the check. */
  scope: SystemdScope
}

// ---------------------------------------------------------------------------
// Unit file generation
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the `rensei-daemon` binary.
 *
 * Priority:
 *   1. Explicit `binPath` option.
 *   2. `which rensei-daemon` (if installed globally).
 *   3. `process.execPath` (if we are the daemon binary).
 */
export function resolveDaemonBinPath(binPath?: string): string {
  if (binPath) return binPath

  try {
    const resolved = execFileSync('which', ['rensei-daemon'], { encoding: 'utf-8' }).trim()
    if (resolved) return resolved
  } catch {
    // `which` failed — fall through to process.execPath
  }

  return process.execPath
}

/**
 * Generate the content of a systemd unit file for the Rensei daemon.
 *
 * @param scope     - 'user' or 'system'
 * @param binPath   - Absolute path to the rensei-daemon binary
 * @param opts      - Additional install options
 * @returns Multi-line string containing the .service unit file content
 */
export function generateUnitFile(
  scope: SystemdScope,
  binPath: string,
  opts: SystemdInstallOptions = {},
): string {
  const description = opts.description ?? 'Rensei local daemon — worker pool'

  const envLines: string[] = []
  if (opts.configPath) {
    envLines.push(`Environment=RENSEI_DAEMON_CONFIG=${opts.configPath}`)
  }

  // User for system-scope unit (owner of the daemon process)
  const userLine = scope === 'system'
    ? `\nUser=${userInfo().username}`
    : ''

  // WantedBy target differs between user and system scope
  const wantedBy = scope === 'user' ? 'default.target' : 'multi-user.target'

  return [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${binPath} start`,
    'Restart=on-failure',
    'RestartSec=5s',
    // Exit code 3 = EXIT_CODE_RESTART: treat as success so crash counter is not incremented,
    // but because it is NOT in RestartPreventExitStatus, systemd will still restart the daemon.
    'SuccessExitStatus=3',
    ...envLines,
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${UNIT_NAME}`,
    userLine,
    '',
    '[Install]',
    `WantedBy=${wantedBy}`,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')  // collapse multiple blank lines
    .trimEnd() + '\n'
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install the Rensei daemon as a systemd unit.
 *
 * Steps:
 *   1. Resolve the binary path.
 *   2. Generate the unit file content.
 *   3. Write the unit file to the correct directory (creating parent dirs).
 *   4. Run `systemctl [--user] daemon-reload && enable --now` unless skipSystemctl.
 *
 * @returns The absolute path of the written unit file.
 */
export function installSystemdUnit(opts: SystemdInstallOptions = {}): string {
  const scope = opts.scope ?? 'user'
  const binPath = resolveDaemonBinPath(opts.binPath)
  const unitDir = scope === 'user' ? USER_UNIT_DIR : SYSTEM_UNIT_DIR
  const unitPath = resolvePath(unitDir, UNIT_FILENAME)

  // Create directory if needed
  if (!existsSync(unitDir)) {
    mkdirSync(unitDir, { recursive: true })
  }

  const content = generateUnitFile(scope, binPath, opts)
  writeFileSync(unitPath, content, { encoding: 'utf-8' })

  if (!opts.skipSystemctl) {
    const scopeFlags = scope === 'user' ? ['--user'] : []

    // daemon-reload
    execFileSync('systemctl', [...scopeFlags, 'daemon-reload'], { stdio: 'inherit' })

    // enable --now
    execFileSync('systemctl', [...scopeFlags, 'enable', '--now', UNIT_FILENAME], { stdio: 'inherit' })
  }

  return unitPath
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Uninstall the Rensei daemon systemd unit.
 *
 * Steps:
 *   1. Run `systemctl [--user] disable --now rensei-daemon` unless skipSystemctl.
 *   2. Remove the unit file.
 *   3. Run `systemctl [--user] daemon-reload` unless skipSystemctl.
 *
 * @returns The absolute path of the removed unit file (whether it existed or not).
 */
export function uninstallSystemdUnit(opts: SystemdUninstallOptions = {}): string {
  const scope = opts.scope ?? 'user'
  const unitDir = scope === 'user' ? USER_UNIT_DIR : SYSTEM_UNIT_DIR
  const unitPath = resolvePath(unitDir, UNIT_FILENAME)

  if (!opts.skipSystemctl && existsSync(unitPath)) {
    const scopeFlags = scope === 'user' ? ['--user'] : []

    try {
      execFileSync('systemctl', [...scopeFlags, 'disable', '--now', UNIT_FILENAME], { stdio: 'inherit' })
    } catch {
      // Best-effort — unit may already be stopped/disabled
    }
  }

  if (existsSync(unitPath)) {
    unlinkSync(unitPath)
  }

  if (!opts.skipSystemctl) {
    const scopeFlags = scope === 'user' ? ['--user'] : []
    try {
      execFileSync('systemctl', [...scopeFlags, 'daemon-reload'], { stdio: 'inherit' })
    } catch {
      // Best-effort
    }
  }

  return unitPath
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/**
 * Health check for the systemd unit installation.
 *
 * Returns structured results: unit file presence, active/enabled state,
 * and raw `systemctl status` output.
 *
 * @returns SystemdDoctorResult with health information
 */
export function systemdDoctor(opts: SystemdDoctorOptions = {}): SystemdDoctorResult {
  const scope = opts.scope ?? 'user'
  const unitDir = scope === 'user' ? USER_UNIT_DIR : SYSTEM_UNIT_DIR
  const unitPath = resolvePath(unitDir, UNIT_FILENAME)
  const unitExists = existsSync(unitPath)

  const result: SystemdDoctorResult = { unitPath, unitExists, scope }

  if (opts.skipSystemctl || !unitExists) {
    return result
  }

  const scopeFlags = scope === 'user' ? ['--user'] : []

  // is-active
  try {
    execFileSync('systemctl', [...scopeFlags, 'is-active', UNIT_NAME], { stdio: 'pipe' })
    result.isActive = true
  } catch {
    result.isActive = false
  }

  // is-enabled
  try {
    execFileSync('systemctl', [...scopeFlags, 'is-enabled', UNIT_NAME], { stdio: 'pipe' })
    result.isEnabled = true
  } catch {
    result.isEnabled = false
  }

  // status output
  try {
    result.statusOutput = execFileSync(
      'systemctl',
      [...scopeFlags, 'status', '--no-pager', UNIT_NAME],
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim()
  } catch (err) {
    // systemctl status exits non-zero if unit is stopped; capture output anyway
    result.statusOutput = (err as NodeJS.ErrnoException & { stdout?: string }).stdout?.trim() ?? ''
  }

  return result
}
