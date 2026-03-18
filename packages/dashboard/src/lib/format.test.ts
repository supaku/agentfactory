import { describe, it, expect } from 'vitest'
import { formatDuration, formatCost, formatTokens, formatRelativeTime } from './format.js'

describe('formatDuration', () => {
  it('returns "0s" for zero seconds', () => {
    expect(formatDuration(0)).toBe('0s')
  })

  it('returns seconds for values under 60', () => {
    expect(formatDuration(30)).toBe('30s')
    expect(formatDuration(1)).toBe('1s')
    expect(formatDuration(59)).toBe('59s')
  })

  it('returns minutes for values under 3600', () => {
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(300)).toBe('5m')
  })

  it('returns minutes and seconds when remainder exists', () => {
    expect(formatDuration(90)).toBe('1m 30s')
    expect(formatDuration(125)).toBe('2m 5s')
  })

  it('returns hours for values >= 3600', () => {
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(7200)).toBe('2h')
  })

  it('returns hours and minutes when remainder exists', () => {
    expect(formatDuration(5400)).toBe('1h 30m')
    expect(formatDuration(3660)).toBe('1h 1m')
  })
})

describe('formatCost', () => {
  it('returns "$0.00" for null, undefined, or zero', () => {
    expect(formatCost(null)).toBe('$0.00')
    expect(formatCost(undefined)).toBe('$0.00')
    expect(formatCost(0)).toBe('$0.00')
  })

  it('returns 4 decimal places for sub-cent amounts', () => {
    expect(formatCost(0.001)).toBe('$0.0010')
    expect(formatCost(0.0001)).toBe('$0.0001')
    expect(formatCost(0.0099)).toBe('$0.0099')
  })

  it('returns 2 decimal places for amounts >= $0.01', () => {
    expect(formatCost(0.01)).toBe('$0.01')
    expect(formatCost(1.23)).toBe('$1.23')
    expect(formatCost(99.99)).toBe('$99.99')
    expect(formatCost(100)).toBe('$100.00')
  })
})

describe('formatTokens', () => {
  it('returns "0" for null, undefined, or zero', () => {
    expect(formatTokens(null)).toBe('0')
    expect(formatTokens(undefined)).toBe('0')
    expect(formatTokens(0)).toBe('0')
  })

  it('returns raw number for values under 1000', () => {
    expect(formatTokens(1)).toBe('1')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(999)).toBe('999')
  })

  it('returns "k" suffix for values in thousands', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(999_999)).toBe('1000.0k')
  })

  it('returns "M" suffix for values in millions', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M')
    expect(formatTokens(1_234_567)).toBe('1.23M')
    expect(formatTokens(10_000_000)).toBe('10.00M')
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps within 60 seconds', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now)).toBe('just now')
  })

  it('returns minutes ago for timestamps within the hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago')
  })

  it('returns hours ago for timestamps within the day', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('returns days ago for timestamps older than 24 hours', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago')
  })
})
