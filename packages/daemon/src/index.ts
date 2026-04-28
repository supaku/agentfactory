/**
 * @renseiai/daemon — local daemon package public API.
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Local daemon mode
 *   rensei-architecture/011-local-daemon-fleet.md
 *
 * Exports the daemon lifecycle class and all supporting types and utilities.
 * The CLI entry point (cli.ts) uses this module for the `rensei-daemon` binary.
 */

export * from './types.js'
export * from './config.js'
export * from './registration.js'
export * from './heartbeat.js'
export * from './worker-spawner.js'
export * from './setup-wizard.js'
export { Daemon, DAEMON_VERSION } from './daemon.js'
export type { DaemonOptions } from './daemon.js'
export {
  AutoUpdater,
  EXIT_CODE_RESTART,
  UPDATE_CDN_BASE,
  buildManifestUrl,
  buildBinaryUrl,
  buildSignatureUrl,
  resolvePlatformSuffix,
  isNewerVersion,
} from './auto-update.js'
export type {
  AutoUpdateOptions,
  AutoUpdateResult,
  BinaryVerifier,
  VersionManifest,
} from './auto-update.js'
export {
  installSystemdUnit,
  uninstallSystemdUnit,
  systemdDoctor,
  generateUnitFile,
  resolveDaemonBinPath,
  UNIT_NAME,
  UNIT_FILENAME,
  USER_UNIT_DIR,
  SYSTEM_UNIT_DIR,
} from './installer-linux.js'
export type {
  SystemdScope,
  SystemdInstallOptions,
  SystemdUninstallOptions,
  SystemdDoctorOptions,
  SystemdDoctorResult,
} from './installer-linux.js'
export {
  generatePlist,
  install as installLaunchd,
  uninstall as uninstallLaunchd,
  doctor as doctorLaunchd,
  resolveDaemonBin,
  readInstalledPlist,
  LAUNCHD_LABEL,
  PLIST_PATH,
  DEFAULT_DAEMON_BIN_GLOBAL,
  DEFAULT_DAEMON_BIN_USER,
  LOG_DIR,
  LOG_PATH,
  ERROR_LOG_PATH,
} from './launchd-installer.js'
export type {
  LaunchdInstallOptions,
  DoctorResult,
  DoctorCheck,
} from './launchd-installer.js'
