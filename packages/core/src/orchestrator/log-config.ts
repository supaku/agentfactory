/**
 * Log Analysis Configuration
 *
 * Environment variable handling for session logging and analysis.
 */

/**
 * Configuration for log analysis
 */
export interface LogAnalysisConfig {
  /** Enable verbose session logging */
  loggingEnabled: boolean
  /** Auto-analyze sessions after completion */
  autoAnalyzeEnabled: boolean
  /** Days to retain logs before cleanup */
  retentionDays: number
  /** Base directory for agent logs (relative to repo root) */
  logsDir: string
}

/**
 * Default configuration values
 */
const DEFAULTS: LogAnalysisConfig = {
  loggingEnabled: false,
  autoAnalyzeEnabled: false,
  retentionDays: 7,
  logsDir: '.agent-logs',
}

/**
 * Get log analysis configuration from environment variables
 *
 * Environment variables:
 * - AGENT_SESSION_LOGGING_ENABLED: Enable verbose session logging (default: false)
 * - AGENT_AUTO_ANALYZE_ENABLED: Auto-analyze after completion (default: false)
 * - AGENT_LOG_RETENTION_DAYS: Days before cleanup (default: 7)
 * - AGENT_LOGS_DIR: Base directory for logs (default: .agent-logs)
 * - AGENT_BUG_BACKLOG: Linear project name for agent bugs (default: "Agent")
 *   Maps to LINEAR_PROJECTS.{NAME} - supports "Agent", "Social", "Test"
 */
export function getLogAnalysisConfig(): LogAnalysisConfig {
  return {
    loggingEnabled: process.env.AGENT_SESSION_LOGGING_ENABLED === 'true',
    autoAnalyzeEnabled: process.env.AGENT_AUTO_ANALYZE_ENABLED === 'true',
    retentionDays: parseInt(process.env.AGENT_LOG_RETENTION_DAYS ?? '', 10) || DEFAULTS.retentionDays,
    logsDir: process.env.AGENT_LOGS_DIR ?? DEFAULTS.logsDir,
  }
}

/**
 * Check if session logging is enabled
 */
export function isSessionLoggingEnabled(): boolean {
  return process.env.AGENT_SESSION_LOGGING_ENABLED === 'true'
}

/**
 * Check if auto-analysis is enabled
 */
export function isAutoAnalyzeEnabled(): boolean {
  return process.env.AGENT_AUTO_ANALYZE_ENABLED === 'true'
}
