import { describe, it, expect } from 'vitest'
import { parseDuration, DurationParseError } from './duration.js'

describe('parseDuration', () => {
  // -------------------------------------------------------------------------
  // Valid inputs
  // -------------------------------------------------------------------------

  it('parses "30m" to 1800000 ms', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
  })

  it('parses "2h" to 7200000 ms', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('parses "1d" to 86400000 ms', () => {
    expect(parseDuration('1d')).toBe(86_400_000)
  })

  it('parses "90m" to 5400000 ms', () => {
    expect(parseDuration('90m')).toBe(5_400_000)
  })

  it('parses "0m" to 0', () => {
    expect(parseDuration('0m')).toBe(0)
  })

  it('parses "0h" to 0', () => {
    expect(parseDuration('0h')).toBe(0)
  })

  it('parses "0d" to 0', () => {
    expect(parseDuration('0d')).toBe(0)
  })

  it('parses large values like "365d"', () => {
    expect(parseDuration('365d')).toBe(365 * 24 * 60 * 60 * 1000)
  })

  // -------------------------------------------------------------------------
  // Invalid inputs — missing unit
  // -------------------------------------------------------------------------

  it('throws DurationParseError for "30" (missing unit)', () => {
    expect(() => parseDuration('30')).toThrow(DurationParseError)
    expect(() => parseDuration('30')).toThrow(/Invalid duration/)
  })

  it('throws DurationParseError for "m" (missing number)', () => {
    expect(() => parseDuration('m')).toThrow(DurationParseError)
  })

  it('throws DurationParseError for empty string', () => {
    expect(() => parseDuration('')).toThrow(DurationParseError)
  })

  it('throws DurationParseError for "abc" (nonsense input)', () => {
    expect(() => parseDuration('abc')).toThrow(DurationParseError)
  })

  it('throws DurationParseError for negative numbers like "-5m"', () => {
    expect(() => parseDuration('-5m')).toThrow(DurationParseError)
  })

  // -------------------------------------------------------------------------
  // Invalid inputs — unsupported units
  // -------------------------------------------------------------------------

  it('throws DurationParseError for "30s" (seconds not supported)', () => {
    expect(() => parseDuration('30s')).toThrow(DurationParseError)
  })

  it('throws DurationParseError for "2w" (weeks not supported)', () => {
    expect(() => parseDuration('2w')).toThrow(DurationParseError)
  })

  it('throws DurationParseError for "1y" (years not supported)', () => {
    expect(() => parseDuration('1y')).toThrow(DurationParseError)
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('throws DurationParseError for decimal values like "1.5h"', () => {
    expect(() => parseDuration('1.5h')).toThrow(DurationParseError)
  })

  it('throws DurationParseError for multiple units like "1h30m"', () => {
    expect(() => parseDuration('1h30m')).toThrow(DurationParseError)
  })

  it('handles whitespace around the value', () => {
    expect(parseDuration(' 30m ')).toBe(1_800_000)
  })
})
