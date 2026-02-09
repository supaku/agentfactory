/**
 * Progress Logger
 *
 * Append-only log for debugging agent activity.
 * Format: timestamp|event_type|details
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs'
import { resolve, dirname } from 'path'
import type { ProgressLoggerConfig, ProgressEventType } from './state-types'

// Default max log size: 1MB
const DEFAULT_MAX_SIZE_BYTES = 1024 * 1024

/**
 * ProgressLogger appends events to a log file for debugging
 */
export class ProgressLogger {
  private readonly config: Required<ProgressLoggerConfig>
  private readonly logPath: string
  private stopped = false

  constructor(config: ProgressLoggerConfig) {
    this.config = {
      ...config,
      maxSizeBytes: config.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
    }
    this.logPath = resolve(this.config.agentDir, 'progress.log')
  }

  /**
   * Initialize the logger (create directory if needed)
   */
  init(): void {
    const dir = dirname(this.logPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  /**
   * Stop the logger
   */
  stop(): void {
    this.stopped = true
  }

  /**
   * Log an event
   */
  log(eventType: ProgressEventType, details: string | object): void {
    if (this.stopped) return

    const timestamp = Date.now()
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : details
    const line = `${timestamp}|${eventType}|${detailsStr}\n`

    try {
      // Check if rotation is needed
      this.maybeRotate()

      // Append to log
      appendFileSync(this.logPath, line)
    } catch (error) {
      // Silently ignore errors - progress logging is best-effort
    }
  }

  /**
   * Log agent start
   */
  logStart(details: { issueId: string; workType: string; prompt: string }): void {
    this.log('start', details)
  }

  /**
   * Log phase change
   */
  logPhase(phase: string): void {
    this.log('phase', { phase })
  }

  /**
   * Log tool call
   */
  logTool(toolName: string, input?: object): void {
    this.log('tool', { toolName, input: input ? JSON.stringify(input).substring(0, 200) : undefined })
  }

  /**
   * Log error
   */
  logError(message: string, error?: Error | unknown): void {
    this.log('error', {
      message,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  /**
   * Log recovery attempt
   */
  logRecovery(attempt: number, reason?: string): void {
    this.log('recovery', { attempt, reason })
  }

  /**
   * Log completion
   */
  logComplete(details?: { prUrl?: string; message?: string }): void {
    this.log('complete', details ?? {})
  }

  /**
   * Log stop
   */
  logStop(reason: 'user_request' | 'timeout' | 'error'): void {
    this.log('stop', { reason })
  }

  /**
   * Rotate log file if it exceeds max size
   */
  private maybeRotate(): void {
    try {
      if (!existsSync(this.logPath)) return

      const stats = statSync(this.logPath)
      if (stats.size >= this.config.maxSizeBytes) {
        // Rotate: rename current to .old
        const oldPath = `${this.logPath}.old`
        try {
          renameSync(this.logPath, oldPath)
        } catch {
          // Ignore rotation errors
        }
      }
    } catch {
      // Ignore stat errors
    }
  }
}

/**
 * Create a progress logger for an agent
 */
export function createProgressLogger(config: ProgressLoggerConfig): ProgressLogger {
  const logger = new ProgressLogger(config)
  logger.init()
  return logger
}
