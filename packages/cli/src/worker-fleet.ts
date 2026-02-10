#!/usr/bin/env node
/**
 * AgentFactory Worker Fleet Manager
 *
 * Spawns and manages multiple worker processes for parallel agent execution.
 * Each worker runs as a separate process with its own resources.
 *
 * Usage:
 *   af-worker-fleet [options]
 *
 * Options:
 *   -w, --workers <n>   Number of worker processes (default: CPU cores / 2)
 *   -c, --capacity <n>  Agents per worker (default: 3)
 *   --dry-run            Show configuration without starting workers
 *
 * Environment (loaded from .env.local in CWD):
 *   WORKER_FLEET_SIZE     Number of workers (override)
 *   WORKER_CAPACITY       Agents per worker (override)
 *   WORKER_API_URL        Coordinator API URL (required)
 *   WORKER_API_KEY        API key for authentication (required)
 */

import { spawn, ChildProcess } from 'child_process'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { config as loadEnv } from 'dotenv'

// Load environment variables from .env.local in CWD
loadEnv({ path: path.resolve(process.cwd(), '.env.local') })

// Resolve the directory of this script (for finding worker.js)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ANSI colors
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

// Worker color cycling
const workerColors = [
  colors.cyan,
  colors.magenta,
  colors.yellow,
  colors.green,
  colors.blue,
]

interface WorkerInfo {
  id: number
  process: ChildProcess
  color: string
  startedAt: Date
  restartCount: number
}

function parseArgs(): { workers: number; capacity: number; dryRun: boolean } {
  const args = process.argv.slice(2)
  let workers = parseInt(process.env.WORKER_FLEET_SIZE ?? '0', 10) || Math.max(1, Math.floor(os.cpus().length / 2))
  let capacity = parseInt(process.env.WORKER_CAPACITY ?? '3', 10)
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workers' || args[i] === '-w') {
      workers = parseInt(args[++i], 10)
    } else if (args[i] === '--capacity' || args[i] === '-c') {
      capacity = parseInt(args[++i], 10)
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { workers, capacity, dryRun }
}

function printHelp(): void {
  console.log(`
${colors.cyan}AgentFactory Worker Fleet Manager${colors.reset}
Spawns and manages multiple worker processes for parallel agent execution.

${colors.yellow}Usage:${colors.reset}
  af-worker-fleet [options]

${colors.yellow}Options:${colors.reset}
  -w, --workers <n>   Number of worker processes (default: CPU cores / 2)
  -c, --capacity <n>  Agents per worker (default: 3)
  --dry-run           Show configuration without starting workers
  -h, --help          Show this help message

${colors.yellow}Examples:${colors.reset}
  af-worker-fleet                     # Auto-detect optimal settings
  af-worker-fleet -w 8 -c 5           # 8 workers x 5 agents = 40 concurrent
  af-worker-fleet --workers 16        # 16 workers with default capacity

${colors.yellow}Environment (loaded from .env.local in CWD):${colors.reset}
  WORKER_FLEET_SIZE   Override number of workers
  WORKER_CAPACITY     Override agents per worker
  WORKER_API_URL      API endpoint (required)
  WORKER_API_KEY      API key for authentication (required)

${colors.yellow}System Info:${colors.reset}
  CPU Cores: ${os.cpus().length}
  Total RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB
  Free RAM:  ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB
`)
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function fleetLog(workerId: number | null, color: string, level: string, message: string): void {
  const prefix = workerId !== null ? `[W${workerId.toString().padStart(2, '0')}]` : '[FLEET]'
  const levelColor = level === 'ERR' ? colors.red : level === 'WRN' ? colors.yellow : colors.gray
  console.log(`${colors.gray}${timestamp()}${colors.reset} ${color}${prefix}${colors.reset} ${levelColor}${level}${colors.reset} ${message}`)
}

class WorkerFleet {
  private workers: Map<number, WorkerInfo> = new Map()
  private fleetConfig: { workers: number; capacity: number; dryRun: boolean }
  private shuttingDown = false
  private workerScript: string

  constructor(fleetConfig: { workers: number; capacity: number; dryRun: boolean }) {
    this.fleetConfig = fleetConfig
    // Use the compiled worker.js in the same directory
    this.workerScript = path.resolve(__dirname, 'worker.js')
  }

  async start(): Promise<void> {
    const { workers, capacity, dryRun } = this.fleetConfig
    const totalCapacity = workers * capacity

    console.log(`
${colors.cyan}================================================================${colors.reset}
${colors.cyan}  AgentFactory Worker Fleet Manager${colors.reset}
${colors.cyan}================================================================${colors.reset}
  Workers:         ${colors.green}${workers}${colors.reset}
  Capacity/Worker: ${colors.green}${capacity}${colors.reset}
  Total Capacity:  ${colors.green}${totalCapacity}${colors.reset} concurrent agents

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

    // Set up shutdown handlers
    process.on('SIGINT', () => this.shutdown('SIGINT'))
    process.on('SIGTERM', () => this.shutdown('SIGTERM'))

    // Spawn workers with staggered start to avoid thundering herd
    for (let i = 0; i < workers; i++) {
      await this.spawnWorker(i)
      if (i < workers - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    fleetLog(null, colors.green, 'INF', `All ${workers} workers started`)

    // Keep the fleet manager running
    await new Promise(() => {})
  }

  private async spawnWorker(id: number): Promise<void> {
    const color = workerColors[id % workerColors.length]
    const existingWorker = this.workers.get(id)
    const restartCount = existingWorker?.restartCount ?? 0

    fleetLog(id, color, 'INF', `Starting worker (capacity: ${this.fleetConfig.capacity})${restartCount > 0 ? ` [restart #${restartCount}]` : ''}`)

    const workerProcess = spawn(
      'node',
      [this.workerScript, '--capacity', String(this.fleetConfig.capacity)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WORKER_FLEET_ID: String(id),
        },
        cwd: process.cwd(),
      }
    )

    const workerInfo: WorkerInfo = {
      id,
      process: workerProcess,
      color,
      startedAt: new Date(),
      restartCount,
    }

    this.workers.set(id, workerInfo)

    // Handle stdout - prefix with worker ID
    workerProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          console.log(`${color}[W${id.toString().padStart(2, '0')}]${colors.reset} ${line}`)
        }
      }
    })

    // Handle stderr
    workerProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          console.log(`${color}[W${id.toString().padStart(2, '0')}]${colors.reset} ${colors.red}${line}${colors.reset}`)
        }
      }
    })

    // Handle worker exit
    workerProcess.on('exit', (code, signal) => {
      if (this.shuttingDown) {
        fleetLog(id, color, 'INF', `Worker stopped (code: ${code}, signal: ${signal})`)
        return
      }

      fleetLog(id, color, 'WRN', `Worker exited unexpectedly (code: ${code}, signal: ${signal}) - restarting in 5s`)

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

  private async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    console.log(`\n${colors.yellow}Received ${signal} - shutting down fleet...${colors.reset}`)

    for (const [id, worker] of this.workers) {
      fleetLog(id, worker.color, 'INF', 'Stopping worker...')
      worker.process.kill('SIGTERM')
    }

    // Wait for workers to exit (max 30 seconds)
    const timeout = setTimeout(() => {
      console.log(`${colors.red}Timeout waiting for workers - force killing${colors.reset}`)
      for (const worker of this.workers.values()) {
        worker.process.kill('SIGKILL')
      }
      process.exit(1)
    }, 30000)

    await Promise.all(
      Array.from(this.workers.values()).map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.process.on('exit', () => resolve())
          })
      )
    )

    clearTimeout(timeout)
    console.log(`${colors.green}All workers stopped${colors.reset}`)
    process.exit(0)
  }
}

// Main
const fleetConfig = parseArgs()

if (!process.env.WORKER_API_URL) {
  console.error(`${colors.red}Error: WORKER_API_URL environment variable is required${colors.reset}`)
  process.exit(1)
}

if (!process.env.WORKER_API_KEY) {
  console.error(`${colors.red}Error: WORKER_API_KEY environment variable is required${colors.reset}`)
  process.exit(1)
}

const fleet = new WorkerFleet(fleetConfig)
fleet.start().catch((err) => {
  console.error(`${colors.red}Fleet error: ${err instanceof Error ? err.message : String(err)}${colors.reset}`)
  process.exit(1)
})
