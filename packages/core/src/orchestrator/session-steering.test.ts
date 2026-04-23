import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  inspectGitStateForSteering,
  decideSteering,
  buildSteeringPrompt,
  runSteeringRetry,
  type SteeringGitState,
} from './session-steering.js'
import type { AgentProcess } from './types.js'
import type {
  AgentEvent,
  AgentHandle,
  AgentProvider,
  AgentProviderCapabilities,
  AgentSpawnConfig,
} from '../providers/types.js'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
const mockExecSync = vi.mocked(execSync)

beforeEach(() => {
  mockExecSync.mockReset()
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides?: Partial<AgentProcess>): AgentProcess {
  return {
    issueId: 'issue-1',
    identifier: 'REN-74',
    status: 'completed',
    startedAt: new Date(),
    completedAt: new Date(),
    pid: 123,
    lastActivityAt: new Date(),
    workType: 'development',
    worktreePath: '/tmp/worktree',
    providerSessionId: 'session-abc',
    providerName: 'codex',
    ...overrides,
  }
}

function makeProvider(overrides?: Partial<AgentProviderCapabilities>): AgentProvider {
  const capabilities: AgentProviderCapabilities = {
    supportsMessageInjection: false,
    supportsSessionResume: true,
    ...overrides,
  }
  return {
    name: 'codex',
    capabilities,
    spawn: vi.fn(),
    resume: vi.fn(),
  } as unknown as AgentProvider
}

function makeGitState(overrides?: Partial<SteeringGitState>): SteeringGitState {
  return {
    uncommittedFiles: 0,
    unpushedCommits: undefined,
    hasLocalCommits: false,
    currentBranch: 'REN-74',
    ...overrides,
  }
}

function makeSpawnConfig(): AgentSpawnConfig {
  return {
    prompt: 'original prompt',
    cwd: '/tmp/worktree',
    env: { LINEAR_SESSION_ID: 'ls-1' },
    abortController: new AbortController(),
    autonomous: true,
    sandboxEnabled: true,
  }
}

async function* streamEvents(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e
}

// ---------------------------------------------------------------------------
// inspectGitStateForSteering
// ---------------------------------------------------------------------------

describe('inspectGitStateForSteering', () => {
  it('reports uncommitted files and unpushed commits when on a feature branch', () => {
    mockExecSync
      .mockReturnValueOnce('REN-74\n' as any)             // git branch --show-current
      .mockReturnValueOnce(' M afcli/foo.go\n?? .cache\n' as any) // git status --porcelain (2 lines)
      .mockReturnValueOnce('3\n' as any)                  // git rev-list --count main..HEAD
      .mockReturnValueOnce('origin/REN-74\n' as any)      // git rev-parse --abbrev-ref @{u}
      .mockReturnValueOnce('2\n' as any)                  // git rev-list --count @{u}..HEAD

    const state = inspectGitStateForSteering('/tmp/worktree')
    expect(state.currentBranch).toBe('REN-74')
    expect(state.uncommittedFiles).toBe(2)
    expect(state.hasLocalCommits).toBe(true)
    expect(state.unpushedCommits).toBe(2)
  })

  it('leaves unpushedCommits undefined when no upstream is configured', () => {
    mockExecSync
      .mockReturnValueOnce('REN-74\n' as any)  // branch
      .mockReturnValueOnce('' as any)          // status (clean)
      .mockReturnValueOnce('0\n' as any)       // rev-list main..HEAD
      .mockImplementationOnce(() => { throw new Error('no upstream') }) // rev-parse @{u}

    const state = inspectGitStateForSteering('/tmp/worktree')
    expect(state.uncommittedFiles).toBe(0)
    expect(state.hasLocalCommits).toBe(false)
    expect(state.unpushedCommits).toBeUndefined()
  })

  it('returns safe defaults when git is not available', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    const state = inspectGitStateForSteering('/not/a/repo')
    expect(state.currentBranch).toBeUndefined()
    expect(state.uncommittedFiles).toBe(0)
    expect(state.hasLocalCommits).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// decideSteering
// ---------------------------------------------------------------------------

describe('decideSteering', () => {
  it('attempts when there are uncommitted files and provider supports resume', () => {
    const d = decideSteering({
      agent: makeAgent(),
      provider: makeProvider({ supportsSessionResume: true }),
      gitState: makeGitState({ uncommittedFiles: 3 }),
    })
    expect(d.shouldAttempt).toBe(true)
    expect(d.reason).toContain('3 uncommitted')
  })

  it('attempts when local commits exist but no PR was opened', () => {
    const d = decideSteering({
      agent: makeAgent({ pullRequestUrl: undefined }),
      provider: makeProvider(),
      gitState: makeGitState({ hasLocalCommits: true }),
    })
    expect(d.shouldAttempt).toBe(true)
    expect(d.reason).toContain('no PR URL')
  })

  it('attempts when unpushed commits exist even if worktree is clean', () => {
    const d = decideSteering({
      agent: makeAgent({ pullRequestUrl: 'https://github.com/x/y/pull/1' }),
      provider: makeProvider(),
      gitState: makeGitState({ hasLocalCommits: true, unpushedCommits: 1 }),
    })
    expect(d.shouldAttempt).toBe(true)
    expect(d.reason).toContain('1 unpushed')
  })

  it('skips when git state is clean and PR exists', () => {
    const d = decideSteering({
      agent: makeAgent({ pullRequestUrl: 'https://github.com/x/y/pull/1' }),
      provider: makeProvider(),
      gitState: makeGitState({ hasLocalCommits: true, unpushedCommits: 0 }),
    })
    expect(d.shouldAttempt).toBe(false)
    expect(d.reason).toContain('nothing to steer')
  })

  it('skips for non-code-producing work types', () => {
    const d = decideSteering({
      agent: makeAgent({ workType: 'qa' }),
      provider: makeProvider(),
      gitState: makeGitState({ uncommittedFiles: 5 }),
    })
    expect(d.shouldAttempt).toBe(false)
    expect(d.reason).toContain('not code-producing')
  })

  it('skips when provider does not support resume', () => {
    const d = decideSteering({
      agent: makeAgent(),
      provider: makeProvider({ supportsSessionResume: false }),
      gitState: makeGitState({ uncommittedFiles: 1 }),
    })
    expect(d.shouldAttempt).toBe(false)
    expect(d.reason).toContain('does not support session resume')
  })

  it('skips when provider is unavailable', () => {
    const d = decideSteering({
      agent: makeAgent(),
      provider: undefined,
      gitState: makeGitState({ uncommittedFiles: 1 }),
    })
    expect(d.shouldAttempt).toBe(false)
    expect(d.reason).toContain('provider not available')
  })

  it('skips when there is no providerSessionId (cannot resume)', () => {
    const d = decideSteering({
      agent: makeAgent({ providerSessionId: undefined }),
      provider: makeProvider(),
      gitState: makeGitState({ uncommittedFiles: 1 }),
    })
    expect(d.shouldAttempt).toBe(false)
    expect(d.reason).toContain('no provider session ID')
  })

  it('skips when agent is not in completed status', () => {
    const d = decideSteering({
      agent: makeAgent({ status: 'failed' }),
      provider: makeProvider(),
      gitState: makeGitState({ uncommittedFiles: 1 }),
    })
    expect(d.shouldAttempt).toBe(false)
    expect(d.reason).toContain('status=failed')
  })
})

// ---------------------------------------------------------------------------
// buildSteeringPrompt
// ---------------------------------------------------------------------------

describe('buildSteeringPrompt', () => {
  it('mentions uncommitted files, unpushed commits, and missing PR in the prompt', () => {
    const prompt = buildSteeringPrompt({
      identifier: 'REN-74',
      gitState: makeGitState({ uncommittedFiles: 4, hasLocalCommits: true, unpushedCommits: 2 }),
      hasPr: false,
    })
    expect(prompt).toContain('REN-74')
    expect(prompt).toContain('4 uncommitted')
    expect(prompt).toContain('2 local commit')
    expect(prompt).toContain('No pull request')
    expect(prompt).toContain('git commit')
    expect(prompt).toContain('git push')
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('gh pr view')
  })

  it('omits the commit step when only a push is needed', () => {
    const prompt = buildSteeringPrompt({
      identifier: 'REN-74',
      gitState: makeGitState({ uncommittedFiles: 0, hasLocalCommits: true, unpushedCommits: 1 }),
      hasPr: true,
    })
    expect(prompt).not.toContain('uncommitted file')
    expect(prompt).toContain('1 local commit')
    expect(prompt).toContain('git push')
    // No PR needed either since hasPr=true
    expect(prompt).not.toContain('gh pr create')
  })

  it('forbids emitting completion text without observing a PR URL', () => {
    const prompt = buildSteeringPrompt({
      identifier: 'REN-74',
      gitState: makeGitState({ uncommittedFiles: 1 }),
      hasPr: false,
    })
    expect(prompt).toMatch(/Do NOT report completion/i)
  })
})

// ---------------------------------------------------------------------------
// runSteeringRetry
// ---------------------------------------------------------------------------

describe('runSteeringRetry', () => {
  it('drains the resumed stream and reports success on result event', async () => {
    const handle: AgentHandle = {
      sessionId: 'session-abc',
      stream: streamEvents([
        { type: 'assistant_text', text: 'committing...', raw: null },
        { type: 'assistant_text', text: 'Opened https://github.com/org/repo/pull/99', raw: null },
        { type: 'result', success: true, raw: null },
      ]),
      injectMessage: async () => {},
      stop: async () => {},
    }
    const provider = makeProvider()
    ;(provider.resume as ReturnType<typeof vi.fn>).mockReturnValue(handle)

    const outcome = await runSteeringRetry({
      provider,
      providerSessionId: 'session-abc',
      baseSpawnConfig: makeSpawnConfig(),
      steeringPrompt: 'finish your work',
    })

    expect(outcome.attempted).toBe(true)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.detectedPrUrl).toBe('https://github.com/org/repo/pull/99')
    expect(outcome.eventsConsumed).toBe(3)
    expect(outcome.error).toBeUndefined()

    // Verify resume was called with the steering prompt and a fresh abort controller
    expect(provider.resume).toHaveBeenCalledTimes(1)
    const callArgs = (provider.resume as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe('session-abc')
    expect(callArgs[1].prompt).toBe('finish your work')
    expect(callArgs[1].abortController).toBeInstanceOf(AbortController)
    // The callback should be stripped to avoid double-registering on the completed agent
    expect(callArgs[1].onProcessSpawned).toBeUndefined()
  })

  it('extracts PR URLs from tool_result content too', async () => {
    const handle: AgentHandle = {
      sessionId: 's',
      stream: streamEvents([
        {
          type: 'tool_result',
          toolName: 'shell',
          content: 'https://github.com/org/repo/pull/123',
          isError: false,
          raw: null,
        },
        { type: 'result', success: true, raw: null },
      ]),
      injectMessage: async () => {},
      stop: async () => {},
    }
    const provider = makeProvider()
    ;(provider.resume as ReturnType<typeof vi.fn>).mockReturnValue(handle)

    const outcome = await runSteeringRetry({
      provider,
      providerSessionId: 's',
      baseSpawnConfig: makeSpawnConfig(),
      steeringPrompt: 'x',
    })
    expect(outcome.detectedPrUrl).toBe('https://github.com/org/repo/pull/123')
  })

  it('returns an error outcome when provider.resume throws', async () => {
    const provider = makeProvider()
    ;(provider.resume as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('kaboom')
    })

    const outcome = await runSteeringRetry({
      provider,
      providerSessionId: 's',
      baseSpawnConfig: makeSpawnConfig(),
      steeringPrompt: 'x',
    })
    expect(outcome.attempted).toBe(true)
    expect(outcome.succeeded).toBeUndefined()
    expect(outcome.error).toContain('kaboom')
  })

  it('reports failure when the result event is success=false', async () => {
    const handle: AgentHandle = {
      sessionId: 's',
      stream: streamEvents([
        { type: 'result', success: false, errors: ['nope'], raw: null },
      ]),
      injectMessage: async () => {},
      stop: async () => {},
    }
    const provider = makeProvider()
    ;(provider.resume as ReturnType<typeof vi.fn>).mockReturnValue(handle)

    const outcome = await runSteeringRetry({
      provider,
      providerSessionId: 's',
      baseSpawnConfig: makeSpawnConfig(),
      steeringPrompt: 'x',
    })
    expect(outcome.succeeded).toBe(false)
  })

  it('reports "stream ended without result" when the stream closes early', async () => {
    const handle: AgentHandle = {
      sessionId: 's',
      stream: streamEvents([
        { type: 'assistant_text', text: 'thinking', raw: null },
      ]),
      injectMessage: async () => {},
      stop: async () => {},
    }
    const provider = makeProvider()
    ;(provider.resume as ReturnType<typeof vi.fn>).mockReturnValue(handle)

    const outcome = await runSteeringRetry({
      provider,
      providerSessionId: 's',
      baseSpawnConfig: makeSpawnConfig(),
      steeringPrompt: 'x',
    })
    expect(outcome.succeeded).toBeUndefined()
    expect(outcome.reason).toContain('stream ended without result')
  })
})
