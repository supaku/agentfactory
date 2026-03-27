/**
 * Security Scan Event
 *
 * Defines the `SecurityScanEvent` type and parsers for extracting structured
 * vulnerability data from security scanner output (semgrep JSON, npm-audit JSON, etc.).
 *
 * The security station template instructs agents to output structured JSON in
 * fenced code blocks tagged `security-scan-result`. This module parses that output.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityScanEvent {
  type: 'agent.security-scan'
  scanner: string
  severityCounts: { critical: number; high: number; medium: number; low: number }
  totalFindings: number
  target: string
  scanDurationMs: number
  timestamp: string
}

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

export const SecurityScanEventSchema = z.object({
  type: z.literal('agent.security-scan'),
  scanner: z.string().min(1),
  severityCounts: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  }),
  totalFindings: z.number().int().nonnegative(),
  target: z.string().min(1),
  scanDurationMs: z.number().nonnegative(),
  timestamp: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Structured output parser (from agent fenced code blocks)
// ---------------------------------------------------------------------------

/**
 * Regex to extract JSON from ```security-scan-result fenced code blocks.
 * The agent outputs one block per scanner run.
 */
const FENCED_BLOCK_RE = /```security-scan-result\s*\n([\s\S]*?)```/g

/**
 * Parse structured security scan results from agent output.
 *
 * Looks for fenced code blocks tagged `security-scan-result` and parses
 * the JSON inside each block. Returns one `SecurityScanEvent` per block.
 *
 * Gracefully handles malformed output — returns partial data with zero counts
 * rather than throwing.
 */
export function parseSecurityScanOutput(rawOutput: string): SecurityScanEvent[] {
  const events: SecurityScanEvent[] = []
  const now = new Date().toISOString()

  for (const match of rawOutput.matchAll(FENCED_BLOCK_RE)) {
    const jsonStr = match[1]?.trim()
    if (!jsonStr) continue

    try {
      const parsed = JSON.parse(jsonStr)
      const event = buildEventFromParsed(parsed, now)
      events.push(event)
    } catch {
      // Malformed JSON — skip this block
    }
  }

  return events
}

/**
 * Parse semgrep --json output into a SecurityScanEvent.
 */
export function parseSemgrepOutput(rawJson: string, target: string, durationMs: number): SecurityScanEvent {
  const now = new Date().toISOString()
  try {
    const parsed = JSON.parse(rawJson)
    const results = Array.isArray(parsed.results) ? parsed.results : []

    const counts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const result of results) {
      const severity = (result.extra?.severity ?? result.severity ?? '').toLowerCase()
      if (severity === 'error' || severity === 'critical') counts.critical++
      else if (severity === 'warning' || severity === 'high') counts.high++
      else if (severity === 'medium' || severity === 'info') counts.medium++
      else counts.low++
    }

    return {
      type: 'agent.security-scan',
      scanner: 'semgrep',
      severityCounts: counts,
      totalFindings: results.length,
      target,
      scanDurationMs: durationMs,
      timestamp: now,
    }
  } catch {
    return emptyEvent('semgrep', target, durationMs, now)
  }
}

/**
 * Parse npm audit --json output into a SecurityScanEvent.
 */
export function parseNpmAuditOutput(rawJson: string, target: string, durationMs: number): SecurityScanEvent {
  const now = new Date().toISOString()
  try {
    const parsed = JSON.parse(rawJson)

    const counts = { critical: 0, high: 0, medium: 0, low: 0 }
    let totalFindings = 0

    // npm audit v2 format (npm 7+)
    if (parsed.vulnerabilities && typeof parsed.vulnerabilities === 'object') {
      for (const vuln of Object.values(parsed.vulnerabilities) as Array<{ severity?: string }>) {
        const severity = (vuln.severity ?? '').toLowerCase()
        if (severity === 'critical') counts.critical++
        else if (severity === 'high') counts.high++
        else if (severity === 'moderate' || severity === 'medium') counts.medium++
        else if (severity === 'low') counts.low++
        totalFindings++
      }
    }
    // npm audit v1 format (npm 6)
    else if (parsed.advisories && typeof parsed.advisories === 'object') {
      for (const advisory of Object.values(parsed.advisories) as Array<{ severity?: string }>) {
        const severity = (advisory.severity ?? '').toLowerCase()
        if (severity === 'critical') counts.critical++
        else if (severity === 'high') counts.high++
        else if (severity === 'moderate' || severity === 'medium') counts.medium++
        else if (severity === 'low') counts.low++
        totalFindings++
      }
    }
    // pnpm audit format (metadata.vulnerabilities summary)
    else if (parsed.metadata?.vulnerabilities) {
      const v = parsed.metadata.vulnerabilities
      counts.critical = v.critical ?? 0
      counts.high = v.high ?? 0
      counts.medium = v.moderate ?? v.medium ?? 0
      counts.low = v.low ?? 0
      totalFindings = counts.critical + counts.high + counts.medium + counts.low
    }

    return {
      type: 'agent.security-scan',
      scanner: 'npm-audit',
      severityCounts: counts,
      totalFindings,
      target,
      scanDurationMs: durationMs,
      timestamp: now,
    }
  } catch {
    return emptyEvent('npm-audit', target, durationMs, now)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEventFromParsed(parsed: unknown, timestamp: string): SecurityScanEvent {
  const obj = parsed as Record<string, unknown>

  const severityCounts = obj.severityCounts as Record<string, number> | undefined
  const counts = {
    critical: Math.max(0, Number(severityCounts?.critical) || 0),
    high: Math.max(0, Number(severityCounts?.high) || 0),
    medium: Math.max(0, Number(severityCounts?.medium) || 0),
    low: Math.max(0, Number(severityCounts?.low) || 0),
  }

  const total = counts.critical + counts.high + counts.medium + counts.low

  return {
    type: 'agent.security-scan',
    scanner: String(obj.scanner || 'unknown'),
    severityCounts: counts,
    totalFindings: Math.max(0, Number(obj.totalFindings) || total),
    target: String(obj.target || 'unknown'),
    scanDurationMs: Math.max(0, Number(obj.scanDurationMs) || 0),
    timestamp,
  }
}

function emptyEvent(scanner: string, target: string, durationMs: number, timestamp: string): SecurityScanEvent {
  return {
    type: 'agent.security-scan',
    scanner,
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    totalFindings: 0,
    target,
    scanDurationMs: durationMs,
    timestamp,
  }
}
