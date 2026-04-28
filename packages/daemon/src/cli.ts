#!/usr/bin/env node
/**
 * rensei-daemon CLI entry point.
 *
 * Architecture reference:
 *   rensei-architecture/011-local-daemon-fleet.md §Installation paths
 *
 * This binary is installed as `rensei-daemon` via the package.json `bin` field.
 * The launchd plist (REN-1292) and systemd unit (REN-1293) point to this script.
 *
 * Commands:
 *   start             — Start the daemon (default)
 *   stop              — Gracefully stop a running daemon
 *   status            — Print daemon status as JSON
 *   setup             — Run the first-run setup wizard
 *   update            — Manually trigger a daemon self-update (drain → fetch → verify → swap → restart)
 *   install           — Install as a LaunchAgent (macOS) or systemd unit (Linux)
 *                       macOS: rensei-daemon install [--bin-path <path>]
 *                       Linux: rensei-daemon install [--user|--system]
 *   uninstall         — Remove the LaunchAgent (macOS) or systemd unit (Linux)
 *   doctor            — Health check for the platform installer
 *                       macOS: checks plist loaded + daemon responsive
 *                       Linux: rensei-daemon doctor [--user|--system]
 *
 * Environment variables:
 *   RENSEI_DAEMON_CONFIG   — Override config file path (default: ~/.rensei/daemon.yaml)
 *   RENSEI_DAEMON_TOKEN    — Override registration token from config
 *   RENSEI_DAEMON_SKIP_WIZARD — Skip interactive setup wizard (1/true)
 *   RENSEI_DAEMON_REAL_REGISTRATION — Use real orchestrator API instead of stub
 *
 * Restart contract (update command):
 *   After a successful binary swap the daemon exits with code 3 (EXIT_CODE_RESTART).
 *   The launchd plist / systemd unit treats code 3 as a clean "please restart me"
 *   signal and re-execs the new binary. Schedulers (nightly / on-release) are
 *   implemented by the installer services triggering `rensei-daemon update` on the
 *   configured cadence; this command is also directly callable as `rensei daemon update`
 *   for manual triggers.
 */

import { platform } from 'node:process'
import { Daemon } from './daemon.js'
import { runSetupWizard } from './setup-wizard.js'
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js'
import { AutoUpdater, EXIT_CODE_RESTART } from './auto-update.js'
import {
  installSystemdUnit,
  uninstallSystemdUnit,
  systemdDoctor,
  UNIT_FILENAME,
} from './installer-linux.js'
import type { SystemdScope } from './installer-linux.js'
import { install as launchdInstall, uninstall as launchdUninstall, doctor as launchdDoctor, PLIST_PATH } from './launchd-installer.js'

const command = process.argv[2] ?? 'start'
const configPath = process.env['RENSEI_DAEMON_CONFIG'] ?? DEFAULT_CONFIG_PATH

async function main(): Promise<void> {
  switch (command) {
    case 'setup': {
      const existing = loadConfig(configPath)
      await runSetupWizard(existing, configPath)
      break
    }

    case 'status': {
      // In a real implementation, this would IPC to the running daemon process.
      // For now, print config-derived status.
      const cfg = loadConfig(configPath)
      if (!cfg) {
        console.log(JSON.stringify({ state: 'not-configured', message: `No config at ${configPath}` }))
        process.exit(1)
      }
      console.log(JSON.stringify({
        state: 'unknown', // Would be IPC'd from the running process
        configPath,
        machineId: cfg.machine.id,
        maxSessions: cfg.capacity.maxConcurrentSessions,
        projects: cfg.projects.map((p) => p.repository),
        autoUpdate: cfg.autoUpdate,
      }))
      break
    }

    case 'update': {
      // Manual update trigger — `rensei daemon update`.
      // Starts a minimal daemon context, drains, then runs the auto-update flow.
      // This path is also used by the launchd / systemd schedulers for nightly and
      // on-release triggers.
      const cfg = loadConfig(configPath)
      if (!cfg) {
        console.error(`[daemon] No config at ${configPath}. Run 'rensei-daemon setup' first.`)
        process.exit(1)
      }

      console.log(`[daemon] Manual update triggered. Channel: ${cfg.autoUpdate.channel}`)

      const updater = new AutoUpdater({
        currentVersion: (await import('./daemon.js')).DAEMON_VERSION,
        config: cfg.autoUpdate,
      })

      updater.on('check-start', () => { console.log('[daemon] Checking for updates...') })
      updater.on('up-to-date', ({ version }: { version: string }) => {
        console.log(`[daemon] Already up-to-date (${version})`)
      })
      updater.on('download-start', ({ version, url }: { version: string; url: string }) => {
        console.log(`[daemon] Downloading ${version} from ${url}...`)
      })
      updater.on('download-complete', ({ version }: { version: string }) => {
        console.log(`[daemon] Downloaded ${version}`)
      })
      updater.on('verify-start', ({ version }: { version: string }) => {
        console.log(`[daemon] Verifying signature for ${version}...`)
      })
      updater.on('verify-failed', ({ version, reason }: { version: string; reason: string }) => {
        console.error(`[daemon] Signature verification FAILED for ${version}: ${reason}`)
        console.error('[daemon] Binary swap aborted. Audit event logged.')
      })
      updater.on('verify-ok', ({ version }: { version: string }) => {
        console.log(`[daemon] Signature verified for ${version}`)
      })
      updater.on('swap-start', ({ from, to }: { from: string; to: string; binPath: string }) => {
        console.log(`[daemon] Swapping binary: ${from} → ${to}`)
      })
      updater.on('swap-complete', ({ from, to }: { from: string; to: string }) => {
        console.log(`[daemon] Update applied: ${from} → ${to}. Restarting...`)
      })
      updater.on('error', (err: Error) => {
        console.error('[daemon] Update error:', err.message)
      })

      const result = await updater.runUpdate()
      if (!result.updated) {
        console.log(`[daemon] No update applied: ${result.reason}`)
        process.exit(0)
      }
      // runUpdate() calls process.exit(EXIT_CODE_RESTART) when not in dry-run mode.
      // We won't reach here in production — only in test dry-run mode.
      process.exit(EXIT_CODE_RESTART)
    }

    case 'start': {
      const daemon = new Daemon({ configPath })

      // Graceful shutdown on SIGTERM / SIGINT
      const shutdown = (): void => {
        console.log('[daemon] Shutting down...')
        daemon.stop()
          .then(() => { process.exit(0) })
          .catch((err: unknown) => {
            console.error('[daemon] Error during shutdown:', err)
            process.exit(1)
          })
      }
      process.once('SIGTERM', shutdown)
      process.once('SIGINT', shutdown)

      daemon.on('state-changed', (state: string) => {
        console.log(`[daemon] state → ${state}`)
      })

      daemon.on('error', (err: Error) => {
        console.error('[daemon] Error:', err.message)
      })

      await daemon.start()
      console.log('[daemon] Running. Send SIGTERM to stop gracefully.')

      // Keep process alive
      await new Promise<void>((resolve) => {
        daemon.once('state-changed', (state: string) => {
          if (state === 'stopped') resolve()
        })
      })
      break
    }

    case 'install': {
      if (platform === 'darwin') {
        // macOS: install LaunchAgent plist
        // Usage: rensei-daemon install [--bin-path <path>]
        const binPathFlag = process.argv[3] === '--bin-path' ? process.argv[4] : undefined
        try {
          const result = launchdInstall({ daemonBinPath: binPathFlag })
          console.log(`[daemon] LaunchAgent installed.`)
          console.log(`  plist: ${result.plistPath}`)
          console.log(`  binary: ${result.daemonBinPath}`)
          console.log(`  loaded: ${result.loaded}`)
          console.log(`  Daemon will start automatically at next login.`)
          console.log(`  Run 'rensei-daemon doctor' to verify.`)
        } catch (err) {
          console.error(`[daemon] Install failed: ${(err as Error).message}`)
          process.exit(1)
        }
      } else if (platform === 'linux') {
        // Linux: install systemd unit
        // Parse --system / --user flags from remaining argv
        const installArgs = process.argv.slice(3)
        let installScope: SystemdScope = 'user'
        if (installArgs.includes('--system')) {
          installScope = 'system'
        }

        console.log(`[daemon] Installing systemd unit (scope: ${installScope})...`)
        try {
          const unitPath = installSystemdUnit({ scope: installScope })
          console.log(`[daemon] Unit file written: ${unitPath}`)
          console.log(`[daemon] Unit enabled and started.`)
          if (installScope === 'user') {
            console.log(`[daemon] Logs: journalctl --user -u ${UNIT_FILENAME.replace('.service', '')}`)
          } else {
            console.log(`[daemon] Logs: journalctl -u ${UNIT_FILENAME.replace('.service', '')}`)
          }
        } catch (err) {
          console.error(`[daemon] Install failed: ${(err as Error).message}`)
          process.exit(1)
        }
      } else {
        console.error(`[daemon] install: unsupported platform '${platform}'. Supported: darwin (macOS), linux.`)
        process.exit(1)
      }
      break
    }

    case 'uninstall': {
      if (platform === 'darwin') {
        // macOS: remove LaunchAgent plist
        const removed = launchdUninstall()
        if (removed) {
          console.log(`[daemon] LaunchAgent uninstalled. Plist removed from ${PLIST_PATH}.`)
        } else {
          console.log(`[daemon] LaunchAgent plist not found at ${PLIST_PATH}. Nothing to remove.`)
        }
      } else if (platform === 'linux') {
        // Linux: remove systemd unit
        const uninstallArgs = process.argv.slice(3)
        let uninstallScope: SystemdScope = 'user'
        if (uninstallArgs.includes('--system')) {
          uninstallScope = 'system'
        }

        console.log(`[daemon] Uninstalling systemd unit (scope: ${uninstallScope})...`)
        try {
          const unitPath = uninstallSystemdUnit({ scope: uninstallScope })
          console.log(`[daemon] Unit file removed: ${unitPath}`)
        } catch (err) {
          console.error(`[daemon] Uninstall failed: ${(err as Error).message}`)
          process.exit(1)
        }
      } else {
        console.error(`[daemon] uninstall: unsupported platform '${platform}'. Supported: darwin (macOS), linux.`)
        process.exit(1)
      }
      break
    }

    case 'doctor': {
      if (platform === 'darwin') {
        // macOS: health check plist + launchctl
        const result = launchdDoctor()
        for (const check of result.checks) {
          const icon = check.passed ? 'PASS' : 'FAIL'
          console.log(`[${icon}] ${check.name}: ${check.detail ?? ''}`)
        }
        if (result.healthy) {
          console.log('\n[daemon] All checks passed. Daemon is healthy.')
        } else {
          console.error('\n[daemon] One or more checks failed. See details above.')
          process.exit(1)
        }
      } else if (platform === 'linux') {
        // Linux: health check systemd unit
        const doctorArgs = process.argv.slice(3)
        let doctorScope: SystemdScope = 'user'
        if (doctorArgs.includes('--system')) {
          doctorScope = 'system'
        }

        const health = systemdDoctor({ scope: doctorScope })
        console.log(JSON.stringify(health, null, 2))

        if (!health.unitExists) {
          console.error(`[daemon] Unit file not found at ${health.unitPath}.`)
          console.error('[daemon] Run: rensei-daemon install to install the unit.')
          process.exit(1)
        }

        if (health.isActive === false) {
          console.error('[daemon] Unit is not active.')
          process.exit(1)
        }
      } else {
        console.error(`[daemon] doctor: unsupported platform '${platform}'. Supported: darwin (macOS), linux.`)
        process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Usage: rensei-daemon [start|stop|status|setup|update|install|uninstall|doctor]')
      process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('[daemon] Fatal error:', err)
  process.exit(1)
})
