import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import {
  createHeartbeatWriter,
  HeartbeatWriter,
  getHeartbeatIntervalFromEnv,
} from './heartbeat-writer.js'

const defaultConfig = {
  agentDir: '/tmp/test-agent',
  pid: 12345,
  intervalMs: 1000,
  startTime: Date.now(),
}

describe('HeartbeatWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('createHeartbeatWriter returns a HeartbeatWriter instance', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    expect(writer).toBeInstanceOf(HeartbeatWriter)
  })

  it('start() writes initial heartbeat immediately', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1)

    writer.stop()
  })

  it('start() creates directory if it does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)

    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()

    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true }
    )

    writer.stop()
  })

  it('start() is idempotent - calling twice does not create two intervals', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()
    writer.start()

    // Only the initial heartbeat from the first start() call
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1)

    // Advance by one interval - should only get one additional write
    vi.advanceTimersByTime(defaultConfig.intervalMs)
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2)

    writer.stop()
  })

  it('stop() clears the interval', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()

    // Initial write
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1)

    writer.stop()

    // Advance time - no more writes should happen
    vi.advanceTimersByTime(defaultConfig.intervalMs * 5)
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1)
  })

  it('start() throws after stop() has been called', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()
    writer.stop()

    expect(() => writer.start()).toThrow(
      'HeartbeatWriter has been stopped and cannot be restarted'
    )
  })

  it('updateActivity("tool_use", "Bash") increments tool call count', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()
    vi.mocked(writeFileSync).mockClear()
    vi.mocked(renameSync).mockClear()

    writer.updateActivity('tool_use', 'Bash')
    writer.updateActivity('tool_use', 'Read')

    // Trigger a heartbeat write to inspect the state
    vi.advanceTimersByTime(defaultConfig.intervalMs)

    const writeCall = vi.mocked(writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.toolCallsCount).toBe(2)

    writer.stop()
  })

  it('recordToolCall("Read") delegates to updateActivity', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()
    vi.mocked(writeFileSync).mockClear()
    vi.mocked(renameSync).mockClear()

    writer.recordToolCall('Read')

    vi.advanceTimersByTime(defaultConfig.intervalMs)

    const writeCall = vi.mocked(writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.lastActivityType).toBe('tool_use')
    expect(written.currentOperation).toBe('Read')
    expect(written.toolCallsCount).toBe(1)

    writer.stop()
  })

  it('recordThinking() sets activity type to "thinking"', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()
    vi.mocked(writeFileSync).mockClear()
    vi.mocked(renameSync).mockClear()

    writer.recordThinking()

    vi.advanceTimersByTime(defaultConfig.intervalMs)

    const writeCall = vi.mocked(writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.lastActivityType).toBe('thinking')

    writer.stop()
  })

  it('heartbeat writes use atomic pattern (writeFileSync to .tmp, renameSync to final)', () => {
    const writer = createHeartbeatWriter(defaultConfig)
    writer.start()

    const tmpPath = vi.mocked(writeFileSync).mock.calls[0][0] as string
    expect(tmpPath).toMatch(/\.tmp$/)

    const renameArgs = vi.mocked(renameSync).mock.calls[0]
    expect(renameArgs[0]).toBe(tmpPath)
    expect((renameArgs[1] as string).endsWith('heartbeat.json')).toBe(true)

    writer.stop()
  })
})

describe('getHeartbeatIntervalFromEnv', () => {
  const originalEnv = process.env.AGENT_HEARTBEAT_INTERVAL_MS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_HEARTBEAT_INTERVAL_MS
    } else {
      process.env.AGENT_HEARTBEAT_INTERVAL_MS = originalEnv
    }
  })

  it('returns default 10000 when env var is not set', () => {
    delete process.env.AGENT_HEARTBEAT_INTERVAL_MS
    expect(getHeartbeatIntervalFromEnv()).toBe(10000)
  })

  it('reads AGENT_HEARTBEAT_INTERVAL_MS env var', () => {
    process.env.AGENT_HEARTBEAT_INTERVAL_MS = '5000'
    expect(getHeartbeatIntervalFromEnv()).toBe(5000)
  })
})
