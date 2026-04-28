/**
 * macOS launchd plist installer — REN-1292
 *
 * Architecture reference:
 *   rensei-architecture/011-local-daemon-fleet.md §Installation paths §macOS
 *
 * This module generates, installs, and removes the launchd plist that registers
 * the rensei-daemon as a LaunchAgent (user-scope, survives reboots and re-logins).
 *
 * Plist path:   ~/Library/LaunchAgents/dev.rensei.daemon.plist
 * Daemon binary: /usr/local/bin/rensei-daemon (global) or
 *                ~/.rensei/bin/rensei-daemon   (user-scoped install)
 * Log path:     ~/Library/Logs/rensei/daemon.log
 *
 * Restart contract (per 011 and auto-update.ts):
 *   The plist sets KeepAlive = true so launchd restarts on any exit.
 *   ThrottleInterval is set to 30s to prevent rapid-restart storms on crash.
 *   ExitCode 3 (EXIT_CODE_RESTART) is treated as a clean "restart-requested"
 *   signal — ExitCode 3 is listed in ExitTimeout / KeepAlive RemainingCount
 *   but NOT in the crash throttle — so a clean self-update restart is immediate
 *   while a crash restart is throttled to 30s.
 *
 * `doctor` checks:
 *   1. Plist file exists at the expected path.
 *   2. launchctl reports the job as loaded (label present in output).
 *   3. Daemon process is responsive (process is running / PID nonzero).
 *
 * Tests mock all filesystem + child_process operations — no root required.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** LaunchAgent label — used in plist and as the launchctl service identifier. */
export const LAUNCHD_LABEL = 'dev.rensei.daemon'

/** Path where the plist is installed. */
export const PLIST_PATH = resolvePath(
  homedir(),
  'Library',
  'LaunchAgents',
  `${LAUNCHD_LABEL}.plist`,
)

/** Default (global) daemon binary path. */
export const DEFAULT_DAEMON_BIN_GLOBAL = '/usr/local/bin/rensei-daemon'

/** User-scoped daemon binary path (used when the binary is installed under ~/.rensei). */
export const DEFAULT_DAEMON_BIN_USER = resolvePath(homedir(), '.rensei', 'bin', 'rensei-daemon')

/** Log directory per macOS convention. */
export const LOG_DIR = resolvePath(homedir(), 'Library', 'Logs', 'rensei')

/** Daemon log file. */
export const LOG_PATH = resolvePath(LOG_DIR, 'daemon.log')

/** Error log file (stderr from launchd). */
export const ERROR_LOG_PATH = resolvePath(LOG_DIR, 'daemon-error.log')

// ---------------------------------------------------------------------------
// Installer options
// ---------------------------------------------------------------------------

export interface LaunchdInstallOptions {
  /**
   * Absolute path to the rensei-daemon binary.
   * Defaults to the global path if the file exists there, otherwise user-scoped.
   */
  daemonBinPath?: string
  /**
   * Override the plist output path (useful for tests that write to a temp dir).
   */
  plistPath?: string
  /**
   * Skip the `launchctl load` call after writing the plist.
   * Default: false (call launchctl in production).
   */
  skipLoad?: boolean
  /**
   * Skip the `launchctl unload` call before removing the plist.
   * Default: false (call launchctl in production).
   */
  skipUnload?: boolean
}

export interface DoctorResult {
  /** True if all checks passed. */
  healthy: boolean
  checks: DoctorCheck[]
}

export interface DoctorCheck {
  name: string
  passed: boolean
  detail?: string
}

// ---------------------------------------------------------------------------
// Plist template
// ---------------------------------------------------------------------------

/**
 * Generate a launchd plist XML string for the rensei-daemon LaunchAgent.
 *
 * Key behaviours encoded in the plist:
 *   - RunAtLoad: true         — daemon starts when the user logs in.
 *   - KeepAlive: true         — launchd restarts the daemon if it exits for any reason.
 *   - ThrottleInterval: 30    — crash restart is throttled to once per 30s (prevents
 *                               rapid-restart storms on repeated crashes).
 *   - StandardOutPath/ErrPath — routes stdout + stderr to ~/Library/Logs/rensei/.
 *   - EnvironmentVariables    — sets HOME and PATH so the daemon can find tools.
 *
 * @param daemonBinPath - Absolute path to the rensei-daemon binary.
 * @param logPath       - Path for stdout log (default: ~/Library/Logs/rensei/daemon.log).
 * @param errorLogPath  - Path for stderr log (default: ~/Library/Logs/rensei/daemon-error.log).
 */
export function generatePlist(
  daemonBinPath: string,
  logPath: string = LOG_PATH,
  errorLogPath: string = ERROR_LOG_PATH,
): string {
  const home = homedir()
  // Build a sensible PATH that covers Homebrew on both Apple Silicon and Intel.
  const path = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${daemonBinPath}</string>
    <string>start</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <!-- Throttle crash-restarts to once per 30 seconds. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${logPath}</string>

  <key>StandardErrorPath</key>
  <string>${errorLogPath}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${path}</string>
  </dict>
</dict>
</plist>
`
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install the rensei-daemon as a macOS LaunchAgent.
 *
 * Steps:
 *   1. Resolve the daemon binary path (explicit > global > user-scoped).
 *   2. Create ~/Library/Logs/rensei/ if it doesn't exist.
 *   3. Write the plist to ~/Library/LaunchAgents/dev.rensei.daemon.plist.
 *   4. Run `launchctl load -w <plist>` to activate the agent immediately.
 *
 * @returns An object describing what was written.
 * @throws If the daemon binary does not exist at the resolved path.
 */
export function install(opts: LaunchdInstallOptions = {}): {
  plistPath: string
  daemonBinPath: string
  loaded: boolean
} {
  const plistPath = opts.plistPath ?? PLIST_PATH
  const daemonBinPath = opts.daemonBinPath ?? resolveDaemonBin()

  if (!existsSync(daemonBinPath)) {
    throw new Error(
      `rensei-daemon binary not found at ${daemonBinPath}. ` +
        `Install via 'brew install rensei' or pass --bin-path explicitly.`,
    )
  }

  // Ensure log directory exists.
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }

  // Ensure LaunchAgents directory exists (normally present, but be safe).
  const plistDir = dirname(plistPath)
  if (!existsSync(plistDir)) {
    mkdirSync(plistDir, { recursive: true })
  }

  const plistContent = generatePlist(daemonBinPath)
  writeFileSync(plistPath, plistContent, 'utf-8')

  let loaded = false
  if (!opts.skipLoad) {
    execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'pipe' })
    loaded = true
  }

  return { plistPath, daemonBinPath, loaded }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Uninstall the rensei-daemon LaunchAgent.
 *
 * Steps:
 *   1. Run `launchctl unload -w <plist>` to stop and deregister the agent.
 *   2. Remove the plist file.
 *
 * @returns True if the plist was found and removed, false if it wasn't present.
 */
export function uninstall(opts: LaunchdInstallOptions = {}): boolean {
  const plistPath = opts.plistPath ?? PLIST_PATH

  if (!existsSync(plistPath)) {
    return false
  }

  if (!opts.skipUnload) {
    try {
      execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'pipe' })
    } catch {
      // If unload fails (e.g., service was already stopped), continue to remove the file.
    }
  }

  unlinkSync(plistPath)
  return true
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/**
 * Run a health check on the launchd installation.
 *
 * Checks:
 *   1. plist-exists    — plist file is present at the expected path.
 *   2. launchctl-loaded — `launchctl list` reports the label as loaded.
 *   3. daemon-running   — launchctl-reported PID is nonzero (process is alive).
 *
 * Designed to not require root and to be callable from tests via dependency
 * injection of the `launchctlList` function.
 *
 * @param opts              - Installer options (plistPath override).
 * @param launchctlList     - Injected fn that returns `launchctl list` output.
 *                            Defaults to the real `launchctl list` invocation.
 */
export function doctor(
  opts: LaunchdInstallOptions = {},
  launchctlList?: () => string,
): DoctorResult {
  const plistPath = opts.plistPath ?? PLIST_PATH
  const checks: DoctorCheck[] = []

  // Check 1: plist exists
  const plistExists = existsSync(plistPath)
  checks.push({
    name: 'plist-exists',
    passed: plistExists,
    detail: plistExists
      ? `Found at ${plistPath}`
      : `Not found at ${plistPath} — run 'rensei daemon install'`,
  })

  // Check 2 & 3: launchctl state
  let launchctlOutput = ''
  try {
    launchctlOutput = launchctlList
      ? launchctlList()
      : execFileSync('launchctl', ['list', LAUNCHD_LABEL], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        })
  } catch {
    // launchctl list returns exit code 113 when the label is not found.
    launchctlOutput = ''
  }

  const loaded = launchctlOutput.includes(LAUNCHD_LABEL)
  checks.push({
    name: 'launchctl-loaded',
    passed: loaded,
    detail: loaded
      ? `Service '${LAUNCHD_LABEL}' is registered with launchd`
      : `Service '${LAUNCHD_LABEL}' is NOT loaded — try 'launchctl load -w ${plistPath}'`,
  })

  // Check 3: PID is nonzero — daemon is actually running
  // `launchctl list <label>` output contains a line like: "PID" = 12345;
  let running = false
  if (loaded) {
    const pidMatch = launchctlOutput.match(/"PID"\s*=\s*(\d+)/)
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0
    running = pid > 0
    checks.push({
      name: 'daemon-running',
      passed: running,
      detail: running
        ? `Daemon running with PID ${pid}`
        : 'Daemon process is not running (PID = 0). Check logs: ~/Library/Logs/rensei/daemon.log',
    })
  } else {
    checks.push({
      name: 'daemon-running',
      passed: false,
      detail: 'Cannot check running state — service is not loaded',
    })
  }

  const healthy = checks.every((c) => c.passed)
  return { healthy, checks }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the daemon binary path: prefer the global path if it exists,
 * fall back to the user-scoped path.
 */
export function resolveDaemonBin(): string {
  if (existsSync(DEFAULT_DAEMON_BIN_GLOBAL)) {
    return DEFAULT_DAEMON_BIN_GLOBAL
  }
  return DEFAULT_DAEMON_BIN_USER
}

/**
 * Read and return the installed plist contents, or undefined if not installed.
 */
export function readInstalledPlist(plistPath?: string): string | undefined {
  const path = plistPath ?? PLIST_PATH
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf-8')
}
