import { describe, it, expect } from 'vitest'
import { isProjectAllowed } from '../webhook/utils.js'

/**
 * Tests for server-level project filtering in webhook handlers.
 *
 * The `projects` config field on `WebhookConfig` gates webhook processing
 * so that a server deployed for specific Linear projects only handles
 * webhooks for those projects.
 */

describe('webhook server-level project filtering', () => {
  it('no projects config (undefined) → all webhooks pass', () => {
    const allowedProjects: string[] = [] // empty = no filter
    expect(isProjectAllowed('Social', allowedProjects)).toBe(true)
    expect(isProjectAllowed('Agent', allowedProjects)).toBe(true)
    expect(isProjectAllowed(undefined, allowedProjects)).toBe(true)
  })

  it('empty projects array → all webhooks pass', () => {
    expect(isProjectAllowed('Social', [])).toBe(true)
    expect(isProjectAllowed('Agent', [])).toBe(true)
    expect(isProjectAllowed(undefined, [])).toBe(true)
  })

  it('projects: ["Social"] → only Social issues pass', () => {
    const allowedProjects = ['Social']
    expect(isProjectAllowed('Social', allowedProjects)).toBe(true)
    expect(isProjectAllowed('Agent', allowedProjects)).toBe(false)
    expect(isProjectAllowed('Art', allowedProjects)).toBe(false)
  })

  it('issue with no project + server has projects → rejected', () => {
    const allowedProjects = ['Social']
    expect(isProjectAllowed(undefined, allowedProjects)).toBe(false)
  })

  it('non-matching project → rejected', () => {
    const allowedProjects = ['Social', 'Agent']
    expect(isProjectAllowed('Art', allowedProjects)).toBe(false)
  })

  it('multiple allowed projects → matching ones pass', () => {
    const allowedProjects = ['Social', 'Agent']
    expect(isProjectAllowed('Social', allowedProjects)).toBe(true)
    expect(isProjectAllowed('Agent', allowedProjects)).toBe(true)
    expect(isProjectAllowed('Art', allowedProjects)).toBe(false)
  })

  it('project name matching is exact (case-sensitive)', () => {
    const allowedProjects = ['Social']
    expect(isProjectAllowed('social', allowedProjects)).toBe(false)
    expect(isProjectAllowed('SOCIAL', allowedProjects)).toBe(false)
    expect(isProjectAllowed('Social', allowedProjects)).toBe(true)
  })
})
