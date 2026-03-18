import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  getAgentDir,
  getStatePath,
  getHeartbeatPath,
  getTodosPath,
  isHeartbeatFresh,
  readWorktreeState,
  readHeartbeat,
  checkRecovery,
  createInitialState,
  buildRecoveryPrompt,
  getHeartbeatTimeoutFromEnv,
  getMaxRecoveryAttemptsFromEnv,
} from './state-recovery.js'
import type { HeartbeatState, WorktreeState, TodosState } from './state-types.js'

const WORKTREE = '/tmp/test-worktree'

function makeState(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    issueId: 'uuid-123',
    issueIdentifier: 'SUP-42',
    linearSessionId: 'session-1',
    providerSessionId: null,
    workType: 'development',
    prompt: 'Fix the bug',
    startedAt: 1000,
    status: 'running',
    currentPhase: null,
    lastUpdatedAt: 2000,
    recoveryAttempts: 0,
    workerId: null,
    pid: 1234,
    taskListId: 'SUP-42-DEV',
    ...overrides,
  }
}

function makeHeartbeat(overrides: Partial<HeartbeatState> = {}): HeartbeatState {
  return {
    timestamp: Date.now(),
    pid: 1234,
    memoryUsageMB: 128,
    uptime: 60,
    lastActivityType: 'tool_use',
    lastActivityTimestamp: Date.now(),
    toolCallsCount: 10,
    currentOperation: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getAgentDir', () => {
  it('returns .agent directory under worktree path', () => {
    expect(getAgentDir(WORKTREE)).toBe(resolve(WORKTREE, '.agent'))
  })
})

describe('getStatePath', () => {
  it('returns state.json path under .agent directory', () => {
    expect(getStatePath(WORKTREE)).toBe(resolve(WORKTREE, '.agent', 'state.json'))
  })
})

describe('getHeartbeatPath', () => {
  it('returns heartbeat.json path under .agent directory', () => {
    expect(getHeartbeatPath(WORKTREE)).toBe(resolve(WORKTREE, '.agent', 'heartbeat.json'))
  })
})

describe('getTodosPath', () => {
  it('returns todos.json path under .agent directory', () => {
    expect(getTodosPath(WORKTREE)).toBe(resolve(WORKTREE, '.agent', 'todos.json'))
  })
})

describe('isHeartbeatFresh', () => {
  it('returns false for null heartbeat', () => {
    expect(isHeartbeatFresh(null)).toBe(false)
  })

  it('returns true when heartbeat is within timeout', () => {
    const heartbeat = makeHeartbeat({ timestamp: Date.now() - 1000 })
    expect(isHeartbeatFresh(heartbeat, 30000)).toBe(true)
  })

  it('returns false when heartbeat is older than timeout', () => {
    const heartbeat = makeHeartbeat({ timestamp: Date.now() - 60000 })
    expect(isHeartbeatFresh(heartbeat, 30000)).toBe(false)
  })

  it('uses default timeout of 30000ms when not specified', () => {
    const fresh = makeHeartbeat({ timestamp: Date.now() - 10000 })
    const stale = makeHeartbeat({ timestamp: Date.now() - 31000 })
    expect(isHeartbeatFresh(fresh)).toBe(true)
    expect(isHeartbeatFresh(stale)).toBe(false)
  })
})

describe('readWorktreeState', () => {
  it('returns parsed state when file exists', () => {
    const state = makeState()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(state))

    const result = readWorktreeState(WORKTREE)
    expect(result).toEqual(state)
    expect(existsSync).toHaveBeenCalledWith(getStatePath(WORKTREE))
  })

  it('returns null when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)

    expect(readWorktreeState(WORKTREE)).toBeNull()
  })

  it('returns null when file contains invalid JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not json')

    expect(readWorktreeState(WORKTREE)).toBeNull()
  })
})

describe('readHeartbeat', () => {
  it('returns parsed heartbeat when file exists', () => {
    const heartbeat = makeHeartbeat()
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(heartbeat))

    const result = readHeartbeat(WORKTREE)
    expect(result).toEqual(heartbeat)
    expect(existsSync).toHaveBeenCalledWith(getHeartbeatPath(WORKTREE))
  })

  it('returns null when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)

    expect(readHeartbeat(WORKTREE)).toBeNull()
  })
})

describe('checkRecovery', () => {
  it('returns no_state when .agent directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(false)
    expect(result.agentAlive).toBe(false)
    expect(result.reason).toBe('no_state')
    expect(result.message).toContain('No .agent directory')
  })

  it('returns no_state when state.json does not exist', () => {
    // .agent dir exists, but state.json does not
    vi.mocked(existsSync).mockImplementation((path) => {
      if (String(path).endsWith('.agent')) return true
      return false
    })

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(false)
    expect(result.reason).toBe('no_state')
    expect(result.message).toContain('No state.json')
  })

  it('returns invalid_state when issueId is missing', () => {
    const state = makeState({ issueId: '' })
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(state))

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(false)
    expect(result.reason).toBe('invalid_state')
    expect(result.state).toEqual(state)
  })

  it('returns invalid_state when issueIdentifier is missing', () => {
    const state = makeState({ issueIdentifier: '' })
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(state))

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(false)
    expect(result.reason).toBe('invalid_state')
  })

  it('returns agent_alive when heartbeat is fresh', () => {
    const state = makeState()
    const heartbeat = makeHeartbeat({ timestamp: Date.now(), pid: 9999 })

    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).includes('heartbeat')) return JSON.stringify(heartbeat)
      return JSON.stringify(state)
    })

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(false)
    expect(result.agentAlive).toBe(true)
    expect(result.reason).toBe('agent_alive')
    expect(result.message).toContain('PID: 9999')
  })

  it('returns max_attempts when recovery attempts exhausted', () => {
    const state = makeState({ recoveryAttempts: 3 })
    const heartbeat = makeHeartbeat({ timestamp: Date.now() - 60000 })

    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).includes('heartbeat')) return JSON.stringify(heartbeat)
      return JSON.stringify(state)
    })

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(false)
    expect(result.reason).toBe('max_attempts')
    expect(result.message).toContain('3/3')
  })

  it('respects custom maxRecoveryAttempts', () => {
    const state = makeState({ recoveryAttempts: 1 })
    const heartbeat = makeHeartbeat({ timestamp: Date.now() - 60000 })

    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).includes('heartbeat')) return JSON.stringify(heartbeat)
      return JSON.stringify(state)
    })

    const result = checkRecovery(WORKTREE, { maxRecoveryAttempts: 1 })
    expect(result.canRecover).toBe(false)
    expect(result.reason).toBe('max_attempts')
  })

  it('returns recoverable when state is valid and agent is not alive', () => {
    const state = makeState({ recoveryAttempts: 0 })
    const heartbeat = makeHeartbeat({ timestamp: Date.now() - 60000 })

    vi.mocked(existsSync).mockImplementation((path) => {
      // todos.json does not exist
      if (String(path).includes('todos')) return false
      return true
    })
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).includes('heartbeat')) return JSON.stringify(heartbeat)
      return JSON.stringify(state)
    })

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(true)
    expect(result.agentAlive).toBe(false)
    expect(result.state).toEqual(state)
    expect(result.message).toContain('Recovery possible')
    expect(result.message).toContain('1/3')
  })

  it('includes todos when present in recoverable result', () => {
    const state = makeState({ recoveryAttempts: 1 })
    const heartbeat = makeHeartbeat({ timestamp: Date.now() - 60000 })
    const todos: TodosState = {
      updatedAt: Date.now(),
      items: [{ content: 'Fix tests', status: 'pending', activeForm: 'Fixing tests' }],
    }

    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).includes('heartbeat')) return JSON.stringify(heartbeat)
      if (String(path).includes('todos')) return JSON.stringify(todos)
      return JSON.stringify(state)
    })

    const result = checkRecovery(WORKTREE)
    expect(result.canRecover).toBe(true)
    expect(result.todos).toEqual(todos)
    expect(result.message).toContain('2/3')
  })
})

describe('createInitialState', () => {
  it('creates state with all required fields', () => {
    const before = Date.now()
    const state = createInitialState({
      issueId: 'uuid-1',
      issueIdentifier: 'SUP-10',
      linearSessionId: 'sess-1',
      workType: 'development',
      prompt: 'Do the thing',
    })
    const after = Date.now()

    expect(state.issueId).toBe('uuid-1')
    expect(state.issueIdentifier).toBe('SUP-10')
    expect(state.linearSessionId).toBe('sess-1')
    expect(state.providerSessionId).toBeNull()
    expect(state.workType).toBe('development')
    expect(state.prompt).toBe('Do the thing')
    expect(state.startedAt).toBeGreaterThanOrEqual(before)
    expect(state.startedAt).toBeLessThanOrEqual(after)
    expect(state.status).toBe('initializing')
    expect(state.currentPhase).toBeNull()
    expect(state.lastUpdatedAt).toBe(state.startedAt)
    expect(state.recoveryAttempts).toBe(0)
    expect(state.workerId).toBeNull()
    expect(state.pid).toBeNull()
    expect(state.taskListId).toBe('SUP-10-DEV')
  })

  it('sets workerId and pid when provided', () => {
    const state = createInitialState({
      issueId: 'uuid-2',
      issueIdentifier: 'SUP-20',
      linearSessionId: null,
      workType: 'qa',
      prompt: 'Run QA',
      workerId: 'worker-1',
      pid: 5678,
    })

    expect(state.workerId).toBe('worker-1')
    expect(state.pid).toBe(5678)
    expect(state.taskListId).toBe('SUP-20-QA')
  })

  it('generates correct taskListId for different work types', () => {
    const cases: Array<[string, string]> = [
      ['research', 'RES'],
      ['backlog-creation', 'BC'],
      ['development', 'DEV'],
      ['coordination', 'COORD'],
      ['qa', 'QA'],
      ['acceptance', 'AC'],
      ['refinement', 'REF'],
    ]

    for (const [workType, suffix] of cases) {
      const state = createInitialState({
        issueId: 'id',
        issueIdentifier: 'X-1',
        linearSessionId: null,
        workType: workType as any,
        prompt: 'test',
      })
      expect(state.taskListId).toBe(`X-1-${suffix}`)
    }
  })
})

describe('buildRecoveryPrompt', () => {
  it('includes issue identifier and work type', () => {
    const state = makeState()
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).toContain('SUP-42')
    expect(prompt).toContain('development')
  })

  it('includes recovery attempt number', () => {
    const state = makeState({ recoveryAttempts: 2 })
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).toContain('Recovery attempt: 3')
  })

  it('includes current phase when present', () => {
    const state = makeState({ currentPhase: 'testing' })
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).toContain('Last phase: testing')
  })

  it('omits phase line when currentPhase is null', () => {
    const state = makeState({ currentPhase: null })
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).not.toContain('Last phase:')
  })

  it('includes original prompt', () => {
    const state = makeState({ prompt: 'Implement feature X' })
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).toContain('Original prompt: Implement feature X')
  })

  it('includes task list ID', () => {
    const state = makeState()
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).toContain('Task list ID: SUP-42-DEV')
  })

  it('includes todos when provided', () => {
    const state = makeState()
    const todos: TodosState = {
      updatedAt: Date.now(),
      items: [
        { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
        { content: 'Update docs', status: 'in_progress', activeForm: 'Updating docs' },
        { content: 'Deploy', status: 'pending', activeForm: 'Deploying' },
      ],
    }
    const prompt = buildRecoveryPrompt(state, todos)

    expect(prompt).toContain('PREVIOUS TODO LIST')
    expect(prompt).toContain('[completed] Write tests')
    expect(prompt).toContain('[in_progress] Update docs')
    expect(prompt).toContain('[pending] Deploy')
  })

  it('omits todo section when todos is undefined', () => {
    const state = makeState()
    const prompt = buildRecoveryPrompt(state)

    expect(prompt).not.toContain('PREVIOUS TODO LIST')
  })

  it('omits todo section when todos has no items', () => {
    const state = makeState()
    const todos: TodosState = { updatedAt: Date.now(), items: [] }
    const prompt = buildRecoveryPrompt(state, todos)

    expect(prompt).not.toContain('PREVIOUS TODO LIST')
  })
})

describe('getHeartbeatTimeoutFromEnv', () => {
  const originalEnv = process.env.AGENT_HEARTBEAT_TIMEOUT_MS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_HEARTBEAT_TIMEOUT_MS
    } else {
      process.env.AGENT_HEARTBEAT_TIMEOUT_MS = originalEnv
    }
  })

  it('returns default 30000 when env var is not set', () => {
    delete process.env.AGENT_HEARTBEAT_TIMEOUT_MS
    expect(getHeartbeatTimeoutFromEnv()).toBe(30000)
  })

  it('parses valid integer from env var', () => {
    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = '60000'
    expect(getHeartbeatTimeoutFromEnv()).toBe(60000)
  })

  it('returns default for non-numeric env var', () => {
    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = 'abc'
    expect(getHeartbeatTimeoutFromEnv()).toBe(30000)
  })

  it('returns default for zero value', () => {
    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = '0'
    expect(getHeartbeatTimeoutFromEnv()).toBe(30000)
  })

  it('returns default for negative value', () => {
    process.env.AGENT_HEARTBEAT_TIMEOUT_MS = '-5000'
    expect(getHeartbeatTimeoutFromEnv()).toBe(30000)
  })
})

describe('getMaxRecoveryAttemptsFromEnv', () => {
  const originalEnv = process.env.AGENT_MAX_RECOVERY_ATTEMPTS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_MAX_RECOVERY_ATTEMPTS
    } else {
      process.env.AGENT_MAX_RECOVERY_ATTEMPTS = originalEnv
    }
  })

  it('returns default 3 when env var is not set', () => {
    delete process.env.AGENT_MAX_RECOVERY_ATTEMPTS
    expect(getMaxRecoveryAttemptsFromEnv()).toBe(3)
  })

  it('parses valid integer from env var', () => {
    process.env.AGENT_MAX_RECOVERY_ATTEMPTS = '5'
    expect(getMaxRecoveryAttemptsFromEnv()).toBe(5)
  })

  it('returns default for non-numeric env var', () => {
    process.env.AGENT_MAX_RECOVERY_ATTEMPTS = 'xyz'
    expect(getMaxRecoveryAttemptsFromEnv()).toBe(3)
  })

  it('returns default for zero value', () => {
    process.env.AGENT_MAX_RECOVERY_ATTEMPTS = '0'
    expect(getMaxRecoveryAttemptsFromEnv()).toBe(3)
  })

  it('returns default for negative value', () => {
    process.env.AGENT_MAX_RECOVERY_ATTEMPTS = '-1'
    expect(getMaxRecoveryAttemptsFromEnv()).toBe(3)
  })
})
