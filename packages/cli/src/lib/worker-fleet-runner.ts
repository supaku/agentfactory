/**
 * Worker Fleet Runner — Programmatic API for the worker fleet manager CLI.
 *
 * Spawns and manages multiple worker processes for parallel agent execution.
 * Each worker runs as a separate OS process with its own resources.
 */

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Public config interface
// ---------------------------------------------------------------------------

export interface FleetRunnerConfig {
  /** Number of worker processes (default: CPU cores / 2) */
  workers?: number
  /** Agents per worker (default: 3) */
  capacity?: number
  /** Show configuration without starting workers (default: false) */
  dryRun?: boolean
  /** Coordinator API URL (required) */
  apiUrl: string
  /** API key for authentication (required) */
  apiKey: string
  /** Path to the worker script/binary (default: auto-detect from this package) */
  workerScript?: string
  /** Linear project names for workers to accept (undefined = all) */
  projects?: string[]
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkerInfo {
  id: number
  process: ChildProcess
  color: string
  startedAt: Date
  restartCount: number
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const workerColors = [
  colors.cyan,
  colors.magenta,
  colors.yellow,
  colors.green,
  colors.blue,
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function fleetLog(
  workerId: number | null,
  color: string,
  level: string,
  message: string,
): void {
  const prefix =
    workerId !== null
      ? `[W${workerId.toString().padStart(2, '0')}]`
      : '[FLEET]'
  const levelColor =
    level === 'ERR' ? colors.red : level === 'WRN' ? colors.yellow : colors.gray
  console.log(
    `${colors.gray}${timestamp()}${colors.reset} ${color}${prefix}${colors.reset} ${levelColor}${level}${colors.reset} ${message}`,
  )
}

function getDefaultWorkerScript(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  // Runner lives in lib/, worker entry is one level up.
  // When running from compiled dist/ the .js file exists; when running from
  // source via tsx only the .ts file exists.
  const jsPath = path.resolve(__dirname, '..', 'worker.js')
  if (fs.existsSync(jsPath)) return jsPath
  return path.resolve(__dirname, '..', 'worker.ts')
}

// ---------------------------------------------------------------------------
// WorkerFleet class (internal)
// ---------------------------------------------------------------------------

class WorkerFleet {
  private workers: Map<number, WorkerInfo> = new Map()
  private readonly fleetConfig: {
    workers: number
    capacity: number
    dryRun: boolean
    apiUrl: string
    apiKey: string
    projects?: string[]
  }
  private shuttingDown = false
  private readonly workerScript: string
  private resolveRunning: (() => void) | null = null

  constructor(
    fleetConfig: {
      workers: number
      capacity: number
      dryRun: boolean
      apiUrl: string
      apiKey: string
      projects?: string[]
    },
    workerScript: string,
  ) {
    this.fleetConfig = fleetConfig
    this.workerScript = workerScript
  }

  async start(signal?: AbortSignal): Promise<void> {
    const { workers, capacity, dryRun } = this.fleetConfig
    const totalCapacity = workers * capacity

    console.log(`
${colors.cyan}================================================================${colors.reset}
${colors.cyan}  AgentFactory Worker Fleet Manager${colors.reset}
${colors.cyan}================================================================${colors.reset}
  Workers:         ${colors.green}${workers}${colors.reset}
  Capacity/Worker: ${colors.green}${capacity}${colors.reset}
  Total Capacity:  ${colors.green}${totalCapacity}${colors.reset} concurrent agents
  Projects:        ${colors.green}${this.fleetConfig.projects?.length ? this.fleetConfig.projects.join(', ') : 'all'}${colors.reset}

  System:
    CPU Cores:    ${os.cpus().length}
    Total RAM:    ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB
    Free RAM:     ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB
${colors.cyan}================================================================${colors.reset}
`)

    if (dryRun) {
      console.log(`${colors.yellow}Dry run mode - not starting workers${colors.reset}`)
      return
    }

    // Wire up AbortSignal for graceful shutdown
    const onAbort = () => this.shutdown('AbortSignal')
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // Spawn workers with staggered start to avoid thundering herd
      for (let i = 0; i < workers; i++) {
        if (signal?.aborted) break
        await this.spawnWorker(i)
        if (i < workers - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      if (signal?.aborted) return

      fleetLog(null, colors.green, 'INF', `All ${workers} workers started`)

      // Keep the fleet manager running until shutdown
      await new Promise<void>((resolve) => {
        this.resolveRunning = resolve
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async spawnWorker(id: number): Promise<void> {
    const color = workerColors[id % workerColors.length]
    const existingWorker = this.workers.get(id)
    const restartCount = existingWorker?.restartCount ?? 0

    fleetLog(
      id,
      color,
      'INF',
      `Starting worker (capacity: ${this.fleetConfig.capacity})${restartCount > 0 ? ` [restart #${restartCount}]` : ''}`,
    )

    const nodeArgs: string[] = []
    // When running a .ts worker script, register tsx so Node can load it
    if (this.workerScript.endsWith('.ts')) {
      nodeArgs.push('--import', 'tsx')
    }
    nodeArgs.push(
      this.workerScript,
      '--capacity',
      String(this.fleetConfig.capacity),
      '--api-url',
      this.fleetConfig.apiUrl,
      '--api-key',
      this.fleetConfig.apiKey,
    )
    if (this.fleetConfig.projects?.length) {
      nodeArgs.push('--projects', this.fleetConfig.projects.join(','))
    }

    const workerProcess = spawn(
      'node',
      nodeArgs,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WORKER_FLEET_ID: String(id),
        },
        cwd: process.cwd(),
      },
    )

    const workerInfo: WorkerInfo = {
      id,
      process: workerProcess,
      color,
      startedAt: new Date(),
      restartCount,
    }

    this.workers.set(id, workerInfo)

    // Handle stdout — prefix with worker ID
    workerProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          console.log(
            `${color}[W${id.toString().padStart(2, '0')}]${colors.reset} ${line}`,
          )
        }
      }
    })

    // Handle stderr
    workerProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          console.log(
            `${color}[W${id.toString().padStart(2, '0')}]${colors.reset} ${colors.red}${line}${colors.reset}`,
          )
        }
      }
    })

    // Handle worker exit
    workerProcess.on('exit', (code, sig) => {
      if (this.shuttingDown) {
        fleetLog(id, color, 'INF', `Worker stopped (code: ${code}, signal: ${sig})`)
        return
      }

      fleetLog(
        id,
        color,
        'WRN',
        `Worker exited unexpectedly (code: ${code}, signal: ${sig}) - restarting in 5s`,
      )

      const worker = this.workers.get(id)
      if (worker) {
        worker.restartCount++
      }

      setTimeout(() => {
        if (!this.shuttingDown) {
          this.spawnWorker(id)
        }
      }, 5000)
    })

    workerProcess.on('error', (err) => {
      fleetLog(id, color, 'ERR', `Worker error: ${err.message}`)
    })
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    console.log(
      `\n${colors.yellow}Received ${reason} - shutting down fleet...${colors.reset}`,
    )

    for (const [id, worker] of this.workers) {
      fleetLog(id, worker.color, 'INF', 'Stopping worker...')
      worker.process.kill('SIGTERM')
    }

    // Wait for workers to exit (max 30 seconds)
    const forceKillTimeout = setTimeout(() => {
      console.log(
        `${colors.red}Timeout waiting for workers - force killing${colors.reset}`,
      )
      for (const worker of this.workers.values()) {
        worker.process.kill('SIGKILL')
      }
    }, 30000)

    await Promise.all(
      Array.from(this.workers.values()).map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.process.on('exit', () => resolve())
          }),
      ),
    )

    clearTimeout(forceKillTimeout)
    console.log(`${colors.green}All workers stopped${colors.reset}`)

    // Resolve the running promise so start() returns
    this.resolveRunning?.()
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a fleet of worker processes.
 *
 * The caller can cancel via the optional {@link AbortSignal}. The function
 * returns once all workers have been stopped.
 */
export async function runWorkerFleet(
  config: FleetRunnerConfig,
  signal?: AbortSignal,
): Promise<void> {
  const workers =
    config.workers ?? Math.max(1, Math.floor(os.cpus().length / 2))
  const capacity = config.capacity ?? 3
  const dryRun = config.dryRun ?? false
  const workerScript = config.workerScript ?? getDefaultWorkerScript()

  const fleet = new WorkerFleet(
    {
      workers,
      capacity,
      dryRun,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      projects: config.projects?.length ? config.projects : undefined,
    },
    workerScript,
  )

  await fleet.start(signal)
}
