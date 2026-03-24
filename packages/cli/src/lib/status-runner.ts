/**
 * Status Runner -- Programmatic API for the af-status CLI.
 *
 * Provides fleet status via the AgentFactory public API.
 * In TTY mode, spawns the Go `af-status` binary for rich inline output.
 * In piped/JSON mode, fetches stats directly from Node.js.
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StatusRunnerConfig {
  /** Output raw JSON instead of human-readable format */
  json?: boolean
  /** Enable auto-refresh watch mode */
  watch?: boolean
  /** Watch interval (e.g., "1s", "5s") — only used with watch */
  interval?: string
  /** API base URL override */
  url?: string
}

// ---------------------------------------------------------------------------
// ANSI colors (same as agent-runner)
// ---------------------------------------------------------------------------

export const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseURL(override?: string): string {
  return override ?? process.env.WORKER_API_URL ?? 'http://localhost:3000'
}

async function fetchStats(baseURL: string): Promise<unknown> {
  const url = `${baseURL.replace(/\/+$/, '')}/api/public/stats`
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`API request failed: ${resp.status} ${resp.statusText}`)
  }
  return resp.json()
}

function resolveGoBinary(): string {
  // Go binary lives in packages/tui/bin/af-status relative to the CLI package
  return path.resolve(__dirname, '../../tui/bin/af-status')
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function showJSON(baseURL: string): Promise<void> {
  const stats = await fetchStats(baseURL)
  console.log(JSON.stringify(stats, null, 2))
}

function spawnGoBinary(config: StatusRunnerConfig, baseURL: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const binPath = resolveGoBinary()
    const args: string[] = ['--url', baseURL]

    if (config.json) args.push('--json')
    if (config.watch) args.push('--watch')
    if (config.interval) args.push('--interval', config.interval)

    const child = spawn(binPath, args, {
      stdio: 'inherit',
    })

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Go binary not built yet — fall back to Node.js JSON output
        console.error(`${C.yellow}Go binary not found at ${binPath}${C.reset}`)
        console.error(`${C.gray}Falling back to JSON output. Build with: cd packages/tui && make build-status${C.reset}`)
        showJSON(baseURL).then(resolve, reject)
      } else {
        reject(err)
      }
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`af-status exited with code ${code}`))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runStatus(config: StatusRunnerConfig): Promise<void> {
  const baseURL = getBaseURL(config.url)
  const isTTY = process.stdout.isTTY ?? false

  // If piped (non-TTY) and not explicitly requesting watch, default to JSON
  if (!isTTY && !config.watch) {
    await showJSON(baseURL)
    return
  }

  // If --json flag without watch, just fetch and print
  if (config.json && !config.watch) {
    await showJSON(baseURL)
    return
  }

  // TTY mode or watch mode — delegate to Go binary
  await spawnGoBinary(config, baseURL)
}
