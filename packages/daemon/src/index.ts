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
