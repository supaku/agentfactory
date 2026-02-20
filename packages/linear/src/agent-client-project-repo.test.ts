import { describe, it, expect, vi } from 'vitest'
import { LinearAgentClient } from './agent-client.js'
import { TokenBucket } from './rate-limiter.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock project with configurable external links and description.
 */
function mockProject(overrides: {
  id?: string
  description?: string | null
  externalLinks?: Array<{ label?: string; url: string }>
} = {}) {
  const {
    id = 'project-1',
    description = null,
    externalLinks = [],
  } = overrides

  return {
    id,
    description,
    externalLinks: () => Promise.resolve({ nodes: externalLinks }),
  }
}

/**
 * Create a LinearAgentClient with a mocked LinearClient.
 */
function createClientWithProject(project: ReturnType<typeof mockProject>): LinearAgentClient {
  const mockLinearClient = {
    project: vi.fn().mockResolvedValue(project),
  }

  // Construct client bypassing the constructor by setting private fields directly
  const client = Object.create(LinearAgentClient.prototype)
  Object.defineProperty(client, 'client', { value: mockLinearClient, writable: false })
  Object.defineProperty(client, 'retryConfig', {
    value: { maxRetries: 0, baseDelay: 0, maxDelay: 0 },
    writable: false,
  })
  Object.defineProperty(client, 'rateLimiter', { value: new TokenBucket(), writable: false })
  Object.defineProperty(client, 'statusCache', { value: new Map(), writable: false })

  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearAgentClient.getProjectRepositoryUrl', () => {
  it('returns URL from project external link with "Repository" label', async () => {
    const project = mockProject({
      externalLinks: [
        { label: 'Repository', url: 'https://github.com/org/repo' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('https://github.com/org/repo')
  })

  it('returns URL from project external link with "GitHub" label (case-insensitive)', async () => {
    const project = mockProject({
      externalLinks: [
        { label: 'github', url: 'https://github.com/org/another-repo' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('https://github.com/org/another-repo')
  })

  it('returns URL from project external link with "REPOSITORY" label (uppercase)', async () => {
    const project = mockProject({
      externalLinks: [
        { label: 'REPOSITORY', url: 'https://github.com/org/upper-repo' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('https://github.com/org/upper-repo')
  })

  it('returns URL from project description fallback', async () => {
    const project = mockProject({
      description: 'This is a project.\nRepository: https://github.com/org/desc-repo\nMore info.',
      externalLinks: [],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('https://github.com/org/desc-repo')
  })

  it('returns URL from project description with case-insensitive matching', async () => {
    const project = mockProject({
      description: 'repository: github.com/org/lower-desc-repo',
      externalLinks: [],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('github.com/org/lower-desc-repo')
  })

  it('prefers external link over description when both are present', async () => {
    const project = mockProject({
      description: 'Repository: https://github.com/org/desc-repo',
      externalLinks: [
        { label: 'Repository', url: 'https://github.com/org/link-repo' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('https://github.com/org/link-repo')
  })

  it('returns null when no link or description match', async () => {
    const project = mockProject({
      description: 'This project has no repo URL.',
      externalLinks: [
        { label: 'Documentation', url: 'https://docs.example.com' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBeNull()
  })

  it('returns null when project has no links and no description', async () => {
    const project = mockProject({
      description: null,
      externalLinks: [],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBeNull()
  })

  it('handles projects with empty external links gracefully', async () => {
    const project = mockProject({
      description: null,
      externalLinks: [],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBeNull()
  })

  it('skips links without a label', async () => {
    const project = mockProject({
      externalLinks: [
        { url: 'https://github.com/org/no-label-repo' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBeNull()
  })

  it('finds the matching link among multiple external links', async () => {
    const project = mockProject({
      externalLinks: [
        { label: 'Documentation', url: 'https://docs.example.com' },
        { label: 'Figma', url: 'https://figma.com/project' },
        { label: 'GitHub', url: 'https://github.com/org/found-repo' },
        { label: 'Slack', url: 'https://slack.com/channel' },
      ],
    })
    const client = createClientWithProject(project)

    const result = await client.getProjectRepositoryUrl('project-1')

    expect(result).toBe('https://github.com/org/found-repo')
  })
})
