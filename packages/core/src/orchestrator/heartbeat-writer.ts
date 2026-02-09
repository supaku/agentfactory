/**
 * Heartbeat Writer
 *
 * Periodically writes heartbeat state to the .agent/ directory.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 */

import { writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import type {
  HeartbeatState,
  HeartbeatActivityType,
  HeartbeatWriterConfig,
} from './state-types'

// Default heartbeat interval: 10 seconds
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000

/**
 * HeartbeatWriter periodically writes heartbeat state to enable crash detection
 */
export class HeartbeatWriter {
  private readonly config: Required<HeartbeatWriterConfig>
  private readonly heartbeatPath: string
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private lastActivityType: HeartbeatActivityType = 'idle'
  private lastActivityTimestamp: number
  private toolCallsCount = 0
  private currentOperation: string | null = null
  private stopped = false

  constructor(config: HeartbeatWriterConfig) {
    this.config = {
      ...config,
      intervalMs: config.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    }
    this.heartbeatPath = resolve(this.config.agentDir, 'heartbeat.json')
    this.lastActivityTimestamp = Date.now()
  }

  /**
   * Start the heartbeat writer
   * Immediately writes the first heartbeat, then starts the interval
   */
  start(): void {
    if (this.stopped) {
      throw new Error('HeartbeatWriter has been stopped and cannot be restarted')
    }

    if (this.intervalHandle) {
      return // Already running
    }

    // Ensure the directory exists
    const dir = dirname(this.heartbeatPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Write initial heartbeat
    this.writeHeartbeat()

    // Start interval
    this.intervalHandle = setInterval(() => {
      this.writeHeartbeat()
    }, this.config.intervalMs)

    // Don't prevent the process from exiting
    this.intervalHandle.unref()
  }

  /**
   * Stop the heartbeat writer
   * Should be called when the agent exits
   */
  stop(): void {
    this.stopped = true
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /**
   * Update the last activity type
   * Call this when the agent does something
   */
  updateActivity(type: HeartbeatActivityType, operation?: string): void {
    this.lastActivityType = type
    this.lastActivityTimestamp = Date.now()
    this.currentOperation = operation ?? null
    if (type === 'tool_use') {
      this.toolCallsCount++
    }
  }

  /**
   * Record a tool call
   */
  recordToolCall(toolName: string): void {
    this.updateActivity('tool_use', toolName)
  }

  /**
   * Record thinking activity
   */
  recordThinking(): void {
    this.updateActivity('thinking')
  }

  /**
   * Write the heartbeat file atomically
   */
  private writeHeartbeat(): void {
    const memoryUsage = process.memoryUsage()
    const now = Date.now()

    const state: HeartbeatState = {
      timestamp: now,
      pid: this.config.pid,
      memoryUsageMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      uptime: Math.floor((now - this.config.startTime) / 1000),
      lastActivityType: this.lastActivityType,
      lastActivityTimestamp: this.lastActivityTimestamp,
      toolCallsCount: this.toolCallsCount,
      currentOperation: this.currentOperation,
    }

    // Write atomically: temp file then rename
    const tempPath = `${this.heartbeatPath}.tmp`
    try {
      writeFileSync(tempPath, JSON.stringify(state, null, 2))
      renameSync(tempPath, this.heartbeatPath)
    } catch (error) {
      // Silently ignore write errors - heartbeat is best-effort
      // The file might be locked or the directory might have been removed
    }
  }
}

/**
 * Create a heartbeat writer for an agent
 */
export function createHeartbeatWriter(config: HeartbeatWriterConfig): HeartbeatWriter {
  return new HeartbeatWriter(config)
}

/**
 * Parse environment variable for heartbeat interval
 */
export function getHeartbeatIntervalFromEnv(): number {
  const envValue = process.env.AGENT_HEARTBEAT_INTERVAL_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS
}
