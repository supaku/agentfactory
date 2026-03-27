import { describe, it, expect } from 'vitest'
import {
  parseSecurityScanOutput,
  parseSemgrepOutput,
  parseNpmAuditOutput,
  SecurityScanEventSchema,
} from './security-scan-event.js'

describe('parseSecurityScanOutput', () => {
  it('parses a single security-scan-result fenced block', () => {
    const output = `
Some agent text here.

\`\`\`security-scan-result
{
  "scanner": "semgrep",
  "severityCounts": { "critical": 0, "high": 2, "medium": 5, "low": 12 },
  "totalFindings": 19,
  "target": "repo:org/project",
  "scanDurationMs": 45000
}
\`\`\`

More text after.
`
    const events = parseSecurityScanOutput(output)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('agent.security-scan')
    expect(events[0].scanner).toBe('semgrep')
    expect(events[0].severityCounts.high).toBe(2)
    expect(events[0].totalFindings).toBe(19)
    expect(events[0].target).toBe('repo:org/project')
    expect(events[0].scanDurationMs).toBe(45000)
    expect(events[0].timestamp).toBeTruthy()
  })

  it('parses multiple security-scan-result blocks', () => {
    const output = `
\`\`\`security-scan-result
{
  "scanner": "semgrep",
  "severityCounts": { "critical": 1, "high": 0, "medium": 0, "low": 0 },
  "totalFindings": 1,
  "target": "src/",
  "scanDurationMs": 10000
}
\`\`\`

\`\`\`security-scan-result
{
  "scanner": "npm-audit",
  "severityCounts": { "critical": 0, "high": 3, "medium": 2, "low": 1 },
  "totalFindings": 6,
  "target": "package.json",
  "scanDurationMs": 5000
}
\`\`\`
`
    const events = parseSecurityScanOutput(output)
    expect(events).toHaveLength(2)
    expect(events[0].scanner).toBe('semgrep')
    expect(events[1].scanner).toBe('npm-audit')
  })

  it('returns empty array for output with no fenced blocks', () => {
    const events = parseSecurityScanOutput('No security scan results here.')
    expect(events).toHaveLength(0)
  })

  it('skips malformed JSON blocks gracefully', () => {
    const output = `
\`\`\`security-scan-result
{ this is not valid json }
\`\`\`

\`\`\`security-scan-result
{
  "scanner": "semgrep",
  "severityCounts": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "totalFindings": 0,
  "target": ".",
  "scanDurationMs": 1000
}
\`\`\`
`
    const events = parseSecurityScanOutput(output)
    expect(events).toHaveLength(1)
    expect(events[0].scanner).toBe('semgrep')
  })

  it('handles missing fields with defaults', () => {
    const output = `
\`\`\`security-scan-result
{
  "scanner": "custom-tool"
}
\`\`\`
`
    const events = parseSecurityScanOutput(output)
    expect(events).toHaveLength(1)
    expect(events[0].scanner).toBe('custom-tool')
    expect(events[0].severityCounts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
    expect(events[0].totalFindings).toBe(0)
    expect(events[0].target).toBe('unknown')
  })
})

describe('parseSemgrepOutput', () => {
  it('parses semgrep --json output', () => {
    const semgrepJson = JSON.stringify({
      results: [
        { extra: { severity: 'ERROR' }, check_id: 'rule1' },
        { extra: { severity: 'WARNING' }, check_id: 'rule2' },
        { extra: { severity: 'WARNING' }, check_id: 'rule3' },
        { extra: { severity: 'INFO' }, check_id: 'rule4' },
      ],
    })

    const event = parseSemgrepOutput(semgrepJson, 'src/', 30000)
    expect(event.type).toBe('agent.security-scan')
    expect(event.scanner).toBe('semgrep')
    expect(event.severityCounts.critical).toBe(1)
    expect(event.severityCounts.high).toBe(2)
    expect(event.severityCounts.medium).toBe(1)
    expect(event.severityCounts.low).toBe(0)
    expect(event.totalFindings).toBe(4)
    expect(event.target).toBe('src/')
    expect(event.scanDurationMs).toBe(30000)
  })

  it('handles empty results array', () => {
    const event = parseSemgrepOutput(JSON.stringify({ results: [] }), '.', 0)
    expect(event.totalFindings).toBe(0)
    expect(event.severityCounts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
  })

  it('returns empty event for malformed input', () => {
    const event = parseSemgrepOutput('not json', '.', 0)
    expect(event.scanner).toBe('semgrep')
    expect(event.totalFindings).toBe(0)
  })
})

describe('parseNpmAuditOutput', () => {
  it('parses npm audit v2 format', () => {
    const auditJson = JSON.stringify({
      vulnerabilities: {
        lodash: { severity: 'critical' },
        express: { severity: 'high' },
        debug: { severity: 'moderate' },
        chalk: { severity: 'low' },
      },
    })

    const event = parseNpmAuditOutput(auditJson, 'package.json', 5000)
    expect(event.scanner).toBe('npm-audit')
    expect(event.severityCounts.critical).toBe(1)
    expect(event.severityCounts.high).toBe(1)
    expect(event.severityCounts.medium).toBe(1)
    expect(event.severityCounts.low).toBe(1)
    expect(event.totalFindings).toBe(4)
  })

  it('parses npm audit v1 format (advisories)', () => {
    const auditJson = JSON.stringify({
      advisories: {
        '1': { severity: 'high' },
        '2': { severity: 'high' },
      },
    })

    const event = parseNpmAuditOutput(auditJson, 'package.json', 3000)
    expect(event.severityCounts.high).toBe(2)
    expect(event.totalFindings).toBe(2)
  })

  it('parses pnpm audit metadata format', () => {
    const auditJson = JSON.stringify({
      metadata: {
        vulnerabilities: {
          critical: 0,
          high: 1,
          moderate: 3,
          low: 5,
        },
      },
    })

    const event = parseNpmAuditOutput(auditJson, 'package.json', 2000)
    expect(event.severityCounts.critical).toBe(0)
    expect(event.severityCounts.high).toBe(1)
    expect(event.severityCounts.medium).toBe(3)
    expect(event.severityCounts.low).toBe(5)
    expect(event.totalFindings).toBe(9)
  })

  it('returns empty event for malformed input', () => {
    const event = parseNpmAuditOutput('not json', '.', 0)
    expect(event.scanner).toBe('npm-audit')
    expect(event.totalFindings).toBe(0)
  })
})

describe('SecurityScanEventSchema', () => {
  it('validates a correct event', () => {
    const event = {
      type: 'agent.security-scan' as const,
      scanner: 'semgrep',
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      target: '.',
      scanDurationMs: 1000,
      timestamp: new Date().toISOString(),
    }
    expect(() => SecurityScanEventSchema.parse(event)).not.toThrow()
  })

  it('rejects negative severity counts', () => {
    const event = {
      type: 'agent.security-scan' as const,
      scanner: 'semgrep',
      severityCounts: { critical: -1, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      target: '.',
      scanDurationMs: 1000,
      timestamp: new Date().toISOString(),
    }
    expect(() => SecurityScanEventSchema.parse(event)).toThrow()
  })

  it('rejects missing scanner', () => {
    const event = {
      type: 'agent.security-scan' as const,
      scanner: '',
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      target: '.',
      scanDurationMs: 1000,
      timestamp: new Date().toISOString(),
    }
    expect(() => SecurityScanEventSchema.parse(event)).toThrow()
  })
})
