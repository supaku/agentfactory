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
 *   start     — Start the daemon (default)
 *   stop      — Gracefully stop a running daemon
 *   status    — Print daemon status as JSON
 *   setup     — Run the first-run setup wizard
 *
 * Environment variables:
 *   RENSEI_DAEMON_CONFIG   — Override config file path (default: ~/.rensei/daemon.yaml)
 *   RENSEI_DAEMON_TOKEN    — Override registration token from config
 *   RENSEI_DAEMON_SKIP_WIZARD — Skip interactive setup wizard (1/true)
 *   RENSEI_DAEMON_REAL_REGISTRATION — Use real orchestrator API instead of stub
 */

import { Daemon } from './daemon.js'
import { runSetupWizard } from './setup-wizard.js'
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js'

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
      }))
      break
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

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Usage: rensei-daemon [start|stop|status|setup]')
      process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('[daemon] Fatal error:', err)
  process.exit(1)
})
