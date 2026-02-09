/**
 * Logger utility for worker and orchestrator output
 *
 * Provides colorized, structured logging with worker/agent context.
 * Uses ANSI escape codes directly to avoid external dependencies.
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright foreground colors
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
} as const

type ColorName = keyof typeof colors

// Color palette for worker/agent identification (easy to distinguish)
const WORKER_COLORS: ColorName[] = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'brightCyan', 'brightMagenta', 'brightYellow']

// Activity type colors
const ACTIVITY_COLORS: Record<string, ColorName> = {
  thought: 'brightBlack',
  action: 'blue',
  response: 'green',
  tool_use: 'cyan',
  tool_result: 'brightBlack',
}

// Log level styling
const LEVEL_STYLES: Record<string, { color: ColorName; label: string }> = {
  debug: { color: 'brightBlack', label: 'DBG' },
  info: { color: 'brightBlue', label: 'INF' },
  success: { color: 'green', label: 'OK ' },
  warn: { color: 'yellow', label: 'WRN' },
  error: { color: 'red', label: 'ERR' },
}

export type LogLevel = keyof typeof LEVEL_STYLES

export interface LoggerContext {
  workerId?: string
  workerShortId?: string
  issueIdentifier?: string
  sessionId?: string
}

export interface LoggerOptions {
  showTimestamp?: boolean
  showLevel?: boolean
  colorEnabled?: boolean
  minLevel?: LogLevel
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  success: 2,
  warn: 3,
  error: 4,
}

// Map to track assigned colors for worker/agent IDs
const colorAssignments = new Map<string, ColorName>()
let colorIndex = 0

function getColorForId(id: string): ColorName {
  if (!colorAssignments.has(id)) {
    colorAssignments.set(id, WORKER_COLORS[colorIndex % WORKER_COLORS.length])
    colorIndex++
  }
  return colorAssignments.get(id)!
}

function colorize(text: string, ...colorNames: ColorName[]): string {
  const colorCodes = colorNames.map((c) => colors[c]).join('')
  return `${colorCodes}${text}${colors.reset}`
}

function formatTimestamp(): string {
  const now = new Date()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  const seconds = now.getSeconds().toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - 3) + '...'
}

export class Logger {
  private context: LoggerContext
  private options: Required<LoggerOptions>

  constructor(context: LoggerContext = {}, options: LoggerOptions = {}) {
    this.context = context
    this.options = {
      showTimestamp: options.showTimestamp ?? true,
      showLevel: options.showLevel ?? true,
      colorEnabled: options.colorEnabled ?? process.stdout.isTTY !== false,
      minLevel: options.minLevel ?? 'info',
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(additionalContext: LoggerContext): Logger {
    return new Logger(
      { ...this.context, ...additionalContext },
      this.options
    )
  }

  /**
   * Format the context prefix (worker ID, issue identifier)
   */
  private formatPrefix(): string {
    const parts: string[] = []

    // Worker ID with color
    if (this.context.workerShortId || this.context.workerId) {
      const id = this.context.workerShortId || this.context.workerId!.substring(0, 8)
      const color = getColorForId(this.context.workerId || id)
      if (this.options.colorEnabled) {
        parts.push(colorize(`[${id}]`, color, 'bold'))
      } else {
        parts.push(`[${id}]`)
      }
    }

    // Issue identifier with rotating color for visual distinction
    if (this.context.issueIdentifier) {
      if (this.options.colorEnabled) {
        const color = getColorForId(this.context.issueIdentifier)
        parts.push(colorize(`[${this.context.issueIdentifier}]`, color, 'bold'))
      } else {
        parts.push(`[${this.context.issueIdentifier}]`)
      }
    }

    return parts.join(' ')
  }

  /**
   * Format a log line
   */
  private formatLine(level: LogLevel, message: string, data?: Record<string, unknown>): string {
    const parts: string[] = []

    // Timestamp
    if (this.options.showTimestamp) {
      const ts = formatTimestamp()
      if (this.options.colorEnabled) {
        parts.push(colorize(ts, 'dim'))
      } else {
        parts.push(ts)
      }
    }

    // Level indicator
    if (this.options.showLevel) {
      const style = LEVEL_STYLES[level]
      if (this.options.colorEnabled) {
        parts.push(colorize(style.label, style.color))
      } else {
        parts.push(style.label)
      }
    }

    // Context prefix (worker/issue)
    const prefix = this.formatPrefix()
    if (prefix) {
      parts.push(prefix)
    }

    // Message
    parts.push(message)

    // Data (if any)
    if (data && Object.keys(data).length > 0) {
      const dataStr = this.formatData(data)
      if (this.options.colorEnabled) {
        parts.push(colorize(dataStr, 'dim'))
      } else {
        parts.push(dataStr)
      }
    }

    return parts.join(' ')
  }

  /**
   * Format data object for display
   */
  private formatData(data: Record<string, unknown>): string {
    const pairs: string[] = []
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue
      let valueStr: string
      if (typeof value === 'string') {
        valueStr = truncate(value, 50)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        valueStr = String(value)
      } else {
        valueStr = truncate(JSON.stringify(value), 50)
      }
      pairs.push(`${key}=${valueStr}`)
    }
    return pairs.length > 0 ? `{ ${pairs.join(', ')} }` : ''
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.options.minLevel]
  }

  /**
   * Core log method
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return

    const line = this.formatLine(level, message, data)
    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }

  // Convenience methods
  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data)
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data)
  }

  success(message: string, data?: Record<string, unknown>): void {
    this.log('success', message, data)
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data)
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data)
  }

  /**
   * Log an activity (thought, action, response) with appropriate styling
   */
  activity(type: string, content: string, maxLength = 80): void {
    if (!this.shouldLog('info')) return

    const parts: string[] = []

    // Timestamp
    if (this.options.showTimestamp) {
      const ts = formatTimestamp()
      if (this.options.colorEnabled) {
        parts.push(colorize(ts, 'dim'))
      } else {
        parts.push(ts)
      }
    }

    // Activity type indicator
    const activityColor = ACTIVITY_COLORS[type] || 'white'
    const typeLabel = type.substring(0, 3).toUpperCase()
    if (this.options.colorEnabled) {
      parts.push(colorize(typeLabel, activityColor))
    } else {
      parts.push(typeLabel)
    }

    // Context prefix
    const prefix = this.formatPrefix()
    if (prefix) {
      parts.push(prefix)
    }

    // Content (truncated)
    const truncatedContent = truncate(content.replace(/\n/g, ' '), maxLength)
    parts.push(truncatedContent)

    console.log(parts.join(' '))
  }

  /**
   * Log a section header/divider
   */
  section(title: string): void {
    const divider = '─'.repeat(60)
    if (this.options.colorEnabled) {
      console.log(colorize(`\n${divider}`, 'dim'))
      console.log(colorize(`  ${title}`, 'bold', 'brightWhite'))
      console.log(colorize(`${divider}`, 'dim'))
    } else {
      console.log(`\n${divider}`)
      console.log(`  ${title}`)
      console.log(divider)
    }
  }

  /**
   * Log a status change with visual indicator
   */
  status(status: string, details?: string): void {
    const statusColors: Record<string, ColorName> = {
      starting: 'yellow',
      running: 'blue',
      completed: 'green',
      stopped: 'yellow',
      failed: 'red',
      claimed: 'cyan',
      registered: 'green',
    }

    const color = statusColors[status.toLowerCase()] || 'white'
    const parts: string[] = []

    // Timestamp
    if (this.options.showTimestamp) {
      const ts = formatTimestamp()
      if (this.options.colorEnabled) {
        parts.push(colorize(ts, 'dim'))
      } else {
        parts.push(ts)
      }
    }

    // Status indicator
    if (this.options.colorEnabled) {
      parts.push(colorize('●', color))
    } else {
      parts.push('*')
    }

    // Context prefix
    const prefix = this.formatPrefix()
    if (prefix) {
      parts.push(prefix)
    }

    // Status text
    if (this.options.colorEnabled) {
      parts.push(colorize(status.toUpperCase(), color, 'bold'))
    } else {
      parts.push(status.toUpperCase())
    }

    // Details
    if (details) {
      parts.push(details)
    }

    console.log(parts.join(' '))
  }

  /**
   * Log a tool call with formatted input
   */
  toolCall(toolName: string, input?: Record<string, unknown>): void {
    if (!this.shouldLog('info')) return

    const parts: string[] = []

    // Timestamp
    if (this.options.showTimestamp) {
      const ts = formatTimestamp()
      if (this.options.colorEnabled) {
        parts.push(colorize(ts, 'dim'))
      } else {
        parts.push(ts)
      }
    }

    // Tool indicator
    if (this.options.colorEnabled) {
      parts.push(colorize('→', 'cyan'))
    } else {
      parts.push('→')
    }

    // Context prefix
    const prefix = this.formatPrefix()
    if (prefix) {
      parts.push(prefix)
    }

    // Tool name
    if (this.options.colorEnabled) {
      parts.push(colorize(toolName, 'cyan', 'bold'))
    } else {
      parts.push(toolName)
    }

    // Formatted input (key parameters)
    if (input) {
      const summary = this.formatToolInput(toolName, input)
      if (summary) {
        if (this.options.colorEnabled) {
          parts.push(colorize(summary, 'dim'))
        } else {
          parts.push(summary)
        }
      }
    }

    console.log(parts.join(' '))
  }

  /**
   * Format tool input for display (show relevant params based on tool type)
   */
  private formatToolInput(toolName: string, input: Record<string, unknown>): string {
    // Show most relevant parameter based on tool type
    const toolParams: Record<string, string[]> = {
      Read: ['file_path'],
      Write: ['file_path'],
      Edit: ['file_path', 'old_string'],
      Grep: ['pattern', 'path'],
      Glob: ['pattern'],
      Bash: ['command'],
      Task: ['subagent_type', 'description'],
      WebFetch: ['url'],
      WebSearch: ['query'],
    }

    const relevantParams = toolParams[toolName] || Object.keys(input).slice(0, 2)
    const values: string[] = []

    for (const param of relevantParams) {
      if (input[param] !== undefined) {
        const value = String(input[param])
        values.push(truncate(value, 40))
      }
    }

    return values.length > 0 ? values.join(' ') : ''
  }
}

/**
 * Create a logger instance
 */
export function createLogger(context?: LoggerContext, options?: LoggerOptions): Logger {
  return new Logger(context, options)
}

/**
 * Default logger for quick use
 */
export const logger = createLogger()
