import { describe, it, expect } from 'vitest'
import { getWorkTypeConfig } from './work-type-config.js'
import type { WorkTypeConfig } from './work-type-config.js'

const knownWorkTypes = [
  'development',
  'bugfix',
  'feature',
  'qa',
  'qa-coordination',
  'acceptance',
  'acceptance-coordination',
  'coordination',
  'research',
  'backlog-creation',
  'inflight',
  'inflight-coordination',
  'refinement',
  'refinement-coordination',
  'refactor',
  'review',
  'docs',
]

const requiredFields: (keyof WorkTypeConfig)[] = ['label', 'color', 'bgColor', 'borderColor']

describe('getWorkTypeConfig', () => {
  it.each(knownWorkTypes)('returns a config for work type "%s"', (workType) => {
    const config = getWorkTypeConfig(workType)
    expect(config).toBeDefined()
  })

  it.each(knownWorkTypes)('config for "%s" has all required string fields', (workType) => {
    const config = getWorkTypeConfig(workType)
    for (const field of requiredFields) {
      expect(typeof config[field]).toBe('string')
    }
  })

  it.each(knownWorkTypes)('config for "%s" has non-empty label', (workType) => {
    const config = getWorkTypeConfig(workType)
    expect(config.label.length).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    expect(getWorkTypeConfig('Development')).toEqual(getWorkTypeConfig('development'))
    expect(getWorkTypeConfig('QA')).toEqual(getWorkTypeConfig('qa'))
    expect(getWorkTypeConfig('BUGFIX')).toEqual(getWorkTypeConfig('bugfix'))
  })

  it('returns default config for unknown work types', () => {
    const config = getWorkTypeConfig('nonexistent')
    expect(config.label).toBe('Unknown')
    expect(config.color).toBeDefined()
    expect(config.bgColor).toBeDefined()
    expect(config.borderColor).toBeDefined()
  })

  it('returns distinct labels for each known work type', () => {
    const labels = knownWorkTypes.map((wt) => getWorkTypeConfig(wt).label)
    const uniqueLabels = new Set(labels)
    expect(uniqueLabels.size).toBe(labels.length)
  })
})
