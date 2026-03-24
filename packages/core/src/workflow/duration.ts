/**
 * Duration Parser
 *
 * Parses human-readable duration strings into milliseconds.
 * Supported units: "m" (minutes), "h" (hours), "d" (days).
 *
 * Examples:
 *   "30m" → 1_800_000  (30 minutes)
 *   "2h"  → 7_200_000  (2 hours)
 *   "1d"  → 86_400_000 (1 day)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UNIT_TO_MS: Record<string, number> = {
  m: 60 * 1000,          // minutes
  h: 60 * 60 * 1000,     // hours
  d: 24 * 60 * 60 * 1000, // days
}

const DURATION_REGEX = /^(\d+)(m|h|d)$/

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Error thrown for invalid duration strings.
 */
export class DurationParseError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid duration "${input}": ${reason}`)
    this.name = 'DurationParseError'
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a duration string into milliseconds.
 * Supports: "Nm" (minutes), "Nh" (hours), "Nd" (days)
 * Examples: "30m" → 1800000, "2h" → 7200000, "1d" → 86400000
 *
 * @param duration - Duration string (e.g., "30m", "2h", "1d")
 * @returns Duration in milliseconds
 * @throws DurationParseError for invalid input
 */
export function parseDuration(duration: string): number {
  if (!duration || typeof duration !== 'string') {
    throw new DurationParseError(String(duration), 'duration must be a non-empty string')
  }

  const trimmed = duration.trim()
  const match = DURATION_REGEX.exec(trimmed)

  if (!match) {
    throw new DurationParseError(
      trimmed,
      'expected format "<number><unit>" where unit is m (minutes), h (hours), or d (days)',
    )
  }

  const value = parseInt(match[1], 10)
  const unit = match[2]

  return value * UNIT_TO_MS[unit]
}
