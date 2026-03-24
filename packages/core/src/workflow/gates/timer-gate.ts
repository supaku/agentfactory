/**
 * Timer Gate Executor
 *
 * Pure-function executor for cron-based timer gates. Evaluates whether a
 * timer gate's cron schedule has fired, and computes the next fire time.
 *
 * Implements a from-scratch 5-field cron parser supporting:
 * - Exact values: 5, 10
 * - Wildcards: *
 * - Ranges: 1-5
 * - Step values: *\/15, 1-30/5
 * - Lists: 1,3,5
 *
 * No external dependencies are used.
 */

import type { GateDefinition, WorkflowDefinition } from '../workflow-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trigger configuration for a timer gate.
 * Contains a standard 5-field cron expression.
 */
export interface TimerGateTrigger {
  /** Standard 5-field cron expression (minute hour day-of-month month day-of-week) */
  cron: string
  [key: string]: unknown
}

/**
 * Result of evaluating a timer gate against the current time.
 */
export interface TimerGateResult {
  /** Whether the cron schedule has fired (current time >= next fire time) */
  fired: boolean
  /** Epoch milliseconds of the next scheduled fire time */
  nextFireTime: number
}

// ---------------------------------------------------------------------------
// Cron Field Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field into a set of valid integer values.
 *
 * Supported syntax:
 * - `*`       — all values in [min, max]
 * - `5`       — exact value
 * - `1-5`     — inclusive range
 * - `*\/15`   — step from min
 * - `1-30/5`  — step within a range
 * - `1,3,5`   — list of values (each element can be a range or step)
 *
 * @param field - The raw cron field string
 * @param min   - Minimum valid value for this field (inclusive)
 * @param max   - Maximum valid value for this field (inclusive)
 * @returns A sorted array of unique integers that the field expands to
 * @throws Error if the field contains invalid syntax
 */
export function parseCronField(field: string, min: number, max: number): number[] {
  const result = new Set<number>()

  const parts = field.split(',')

  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === '') {
      throw new Error(`Invalid cron field: empty segment in "${field}"`)
    }

    // Check for step value (e.g., */15 or 1-30/5)
    const stepParts = trimmed.split('/')
    if (stepParts.length > 2) {
      throw new Error(`Invalid cron field: multiple '/' in "${trimmed}"`)
    }

    let rangeStart: number
    let rangeEnd: number
    let step = 1

    if (stepParts.length === 2) {
      step = parseInt(stepParts[1], 10)
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid cron step value: "${stepParts[1]}" in "${trimmed}"`)
      }
    }

    const base = stepParts[0]

    if (base === '*') {
      rangeStart = min
      rangeEnd = max
    } else if (base.includes('-')) {
      const rangeParts = base.split('-')
      if (rangeParts.length !== 2) {
        throw new Error(`Invalid cron range: "${base}" in "${trimmed}"`)
      }
      rangeStart = parseInt(rangeParts[0], 10)
      rangeEnd = parseInt(rangeParts[1], 10)
      if (isNaN(rangeStart) || isNaN(rangeEnd)) {
        throw new Error(`Invalid cron range values: "${base}" in "${trimmed}"`)
      }
      if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
        throw new Error(
          `Cron range out of bounds: ${rangeStart}-${rangeEnd} (valid: ${min}-${max})`
        )
      }
    } else {
      const value = parseInt(base, 10)
      if (isNaN(value)) {
        throw new Error(`Invalid cron value: "${base}" in "${trimmed}"`)
      }
      if (value < min || value > max) {
        throw new Error(`Cron value out of bounds: ${value} (valid: ${min}-${max})`)
      }
      rangeStart = value
      rangeEnd = value
    }

    for (let i = rangeStart; i <= rangeEnd; i += step) {
      result.add(i)
    }
  }

  return Array.from(result).sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Parsed Cron Expression
// ---------------------------------------------------------------------------

/**
 * A fully parsed 5-field cron expression, with each field expanded into
 * a sorted array of valid values.
 */
interface ParsedCron {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
}

/**
 * Parse a 5-field cron expression string into structured arrays of valid values.
 *
 * @param cronExpression - Standard 5-field cron string (e.g., "0 9 * * 1-5")
 * @returns Parsed cron with expanded field values
 * @throws Error if the expression doesn't have exactly 5 fields
 */
export function parseCronExpression(cronExpression: string): ParsedCron {
  const fields = cronExpression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${fields.length} in "${cronExpression}"`
    )
  }

  return {
    minutes: parseCronField(fields[0], 0, 59),
    hours: parseCronField(fields[1], 0, 23),
    daysOfMonth: parseCronField(fields[2], 1, 31),
    months: parseCronField(fields[3], 1, 12),
    // Day of week: 0-7 where both 0 and 7 mean Sunday
    daysOfWeek: normalizeDaysOfWeek(parseCronField(fields[4], 0, 7)),
  }
}

/**
 * Normalize day-of-week values so that 7 (Sunday) maps to 0.
 * Returns a deduplicated sorted array.
 */
function normalizeDaysOfWeek(days: number[]): number[] {
  const normalized = new Set<number>()
  for (const d of days) {
    normalized.add(d === 7 ? 0 : d)
  }
  return Array.from(normalized).sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Next Cron Fire Time Computation
// ---------------------------------------------------------------------------

/**
 * Compute the next cron fire time strictly after a given timestamp.
 *
 * Algorithm:
 * 1. Start from the minute after the `after` timestamp
 * 2. Check month, day-of-month, day-of-week, hour, minute in sequence
 * 3. If a field doesn't match, advance to the next valid value and reset
 *    all lower-order fields
 * 4. Guard against infinite loops with a maximum iteration count
 *
 * @param cronExpression - Standard 5-field cron expression
 * @param after - Epoch milliseconds; the next fire time is strictly after this
 * @returns Epoch milliseconds of the next matching cron time
 * @throws Error if no valid fire time is found within the search window
 */
export function computeNextCronFireTime(cronExpression: string, after: number): number {
  const cron = parseCronExpression(cronExpression)

  // Start from one minute after the given timestamp, zeroing out seconds/ms
  const start = new Date(after)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  let year = start.getFullYear()
  let month = start.getMonth() + 1    // 1-based
  let day = start.getDate()
  let hour = start.getHours()
  let minute = start.getMinutes()

  // Safety limit to prevent infinite loops (4 years of minutes should be plenty)
  const MAX_ITERATIONS = 4 * 366 * 24 * 60

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // --- Month ---
    if (!cron.months.includes(month)) {
      const nextMonth = findNextValue(cron.months, month)
      if (nextMonth === null || nextMonth < month) {
        // Wrap to next year
        year++
        month = cron.months[0]
      } else {
        month = nextMonth
      }
      day = 1
      hour = 0
      minute = 0
    }

    // --- Day of month ---
    const maxDay = daysInMonth(year, month)
    // Filter valid days for the actual month length
    const validDays = cron.daysOfMonth.filter(d => d <= maxDay)
    if (validDays.length === 0) {
      // No valid day in this month; advance to next month
      month++
      if (month > 12) {
        month = 1
        year++
      }
      day = 1
      hour = 0
      minute = 0
      continue
    }

    if (!validDays.includes(day)) {
      const nextDay = findNextValue(validDays, day)
      if (nextDay === null || nextDay < day) {
        // Wrap to next month
        month++
        if (month > 12) {
          month = 1
          year++
        }
        day = 1
        hour = 0
        minute = 0
        continue
      }
      day = nextDay
      hour = 0
      minute = 0
    }

    // --- Day of week ---
    const candidateDate = new Date(year, month - 1, day)
    const dow = candidateDate.getDay() // 0=Sunday
    if (!cron.daysOfWeek.includes(dow)) {
      // Advance to the next day
      day++
      if (day > maxDay) {
        month++
        if (month > 12) {
          month = 1
          year++
        }
        day = 1
      }
      hour = 0
      minute = 0
      continue
    }

    // --- Hour ---
    if (!cron.hours.includes(hour)) {
      const nextHour = findNextValue(cron.hours, hour)
      if (nextHour === null || nextHour < hour) {
        // Wrap to next day
        day++
        if (day > maxDay) {
          month++
          if (month > 12) {
            month = 1
            year++
          }
          day = 1
        }
        hour = 0
        minute = 0
        continue
      }
      hour = nextHour
      minute = 0
    }

    // --- Minute ---
    if (!cron.minutes.includes(minute)) {
      const nextMinute = findNextValue(cron.minutes, minute)
      if (nextMinute === null || nextMinute < minute) {
        // Wrap to next hour
        hour++
        if (hour > 23) {
          day++
          if (day > maxDay) {
            month++
            if (month > 12) {
              month = 1
              year++
            }
            day = 1
          }
          hour = 0
        }
        minute = 0
        continue
      }
      minute = nextMinute
    }

    // All fields match! Build the result date.
    const result = new Date(year, month - 1, day, hour, minute, 0, 0)
    return result.getTime()
  }

  throw new Error(
    `Could not find next cron fire time for "${cronExpression}" after ${new Date(after).toISOString()} within search window`
  )
}

/**
 * Find the next value >= target in a sorted array of integers.
 * Returns null if no such value exists.
 */
function findNextValue(sortedValues: number[], target: number): number | null {
  for (const v of sortedValues) {
    if (v >= target) return v
  }
  return null
}

/**
 * Get the number of days in a given month (1-based) for a given year.
 * Accounts for leap years.
 */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month gives the last day of the current month
  return new Date(year, month, 0).getDate()
}

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

/**
 * Type guard that validates whether a trigger object has the shape
 * expected for a timer gate (i.e., contains a `cron` string property).
 *
 * @param trigger - The trigger record to validate
 * @returns True if the trigger is a valid TimerGateTrigger
 */
export function isTimerGateTrigger(trigger: Record<string, unknown>): trigger is Record<string, unknown> & TimerGateTrigger {
  return (
    typeof trigger === 'object' &&
    trigger !== null &&
    'cron' in trigger &&
    typeof trigger.cron === 'string' &&
    trigger.cron.trim().length > 0
  )
}

// ---------------------------------------------------------------------------
// Gate Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a cron-based timer gate should fire.
 *
 * This is a pure function (no I/O). It parses the gate's `trigger.cron`
 * expression, computes the next fire time from the gate's activation time
 * (or from epoch 0 if no activation context), and checks whether the
 * current time has reached or passed that fire time.
 *
 * @param gate - The gate definition with type "timer" and a trigger containing a cron field
 * @param now  - Current time in epoch milliseconds (defaults to Date.now() for testability)
 * @returns TimerGateResult with fired status and next fire time
 * @throws Error if the gate is not a timer gate or has an invalid trigger
 */
export function evaluateTimerGate(gate: GateDefinition, now?: number): TimerGateResult {
  const currentTime = now ?? Date.now()

  if (gate.type !== 'timer') {
    throw new Error(`evaluateTimerGate called with non-timer gate: type="${gate.type}"`)
  }

  if (!isTimerGateTrigger(gate.trigger)) {
    throw new Error(
      `Timer gate "${gate.name}" has invalid trigger: missing or empty "cron" field`
    )
  }

  const cronExpression = gate.trigger.cron

  // Compute the next fire time relative to one "cycle" before now,
  // so we can detect whether we're currently in a fire window.
  // We look for the next fire time after (now - 60 seconds) to catch
  // the current minute's match, and compare against the current time.
  const lookbackTime = currentTime - 60_000
  const nextFireTime = computeNextCronFireTime(cronExpression, lookbackTime)

  // The gate has fired if the next fire time (computed from the lookback)
  // falls at or before the current time
  const fired = nextFireTime <= currentTime

  // Compute the actual next fire time from the current moment for the result
  const upcomingFireTime = fired
    ? computeNextCronFireTime(cronExpression, currentTime)
    : nextFireTime

  return {
    fired,
    nextFireTime: upcomingFireTime,
  }
}

// ---------------------------------------------------------------------------
// Gate Filtering
// ---------------------------------------------------------------------------

/**
 * Get all timer gates from a workflow definition that apply to a given phase.
 *
 * A gate applies to a phase if:
 * - The gate's `appliesTo` array includes the phase name, OR
 * - The gate has no `appliesTo` array (applies to all phases)
 *
 * Only gates with `type: "timer"` are returned.
 *
 * @param workflow - The workflow definition to search
 * @param phase   - The phase name to filter by
 * @returns Array of GateDefinition objects for matching timer gates
 */
export function getApplicableTimerGates(
  workflow: WorkflowDefinition,
  phase: string,
): GateDefinition[] {
  if (!workflow.gates) {
    return []
  }

  return workflow.gates.filter(gate => {
    if (gate.type !== 'timer') return false
    if (!gate.appliesTo || gate.appliesTo.length === 0) return true
    return gate.appliesTo.includes(phase)
  })
}
