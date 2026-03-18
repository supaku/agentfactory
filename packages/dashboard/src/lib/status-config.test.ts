import { describe, it, expect } from 'vitest'
import { getStatusConfig } from './status-config.js'
import type { SessionStatus, StatusConfig } from './status-config.js'

const allStatuses: SessionStatus[] = ['queued', 'parked', 'working', 'completed', 'failed', 'stopped']

const requiredFields: (keyof StatusConfig)[] = ['label', 'dotColor', 'textColor', 'bgColor', 'borderColor', 'glowClass']

describe('getStatusConfig', () => {
  it.each(allStatuses)('returns a config for status "%s"', (status) => {
    const config = getStatusConfig(status)
    expect(config).toBeDefined()
  })

  it.each(allStatuses)('config for "%s" has all required string fields', (status) => {
    const config = getStatusConfig(status)
    for (const field of requiredFields) {
      expect(typeof config[field]).toBe('string')
    }
  })

  it.each(allStatuses)('config for "%s" has an animate boolean', (status) => {
    const config = getStatusConfig(status)
    expect(typeof config.animate).toBe('boolean')
  })

  it('returns a label matching the status name (capitalized)', () => {
    expect(getStatusConfig('working').label).toBe('Working')
    expect(getStatusConfig('queued').label).toBe('Queued')
    expect(getStatusConfig('parked').label).toBe('Parked')
    expect(getStatusConfig('completed').label).toBe('Completed')
    expect(getStatusConfig('failed').label).toBe('Failed')
    expect(getStatusConfig('stopped').label).toBe('Stopped')
  })

  it('returns animate: true only for active statuses', () => {
    expect(getStatusConfig('working').animate).toBe(true)
    expect(getStatusConfig('queued').animate).toBe(true)
    expect(getStatusConfig('completed').animate).toBe(false)
    expect(getStatusConfig('failed').animate).toBe(false)
    expect(getStatusConfig('stopped').animate).toBe(false)
    expect(getStatusConfig('parked').animate).toBe(false)
  })

  it('falls back to queued config for unknown status', () => {
    const config = getStatusConfig('nonexistent' as SessionStatus)
    const queuedConfig = getStatusConfig('queued')
    expect(config).toEqual(queuedConfig)
  })
})
