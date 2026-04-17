import { describe, it, expect, vi } from 'vitest'
import { codeIntelligencePlugin } from '../code-intelligence-plugin.js'
import type { FileReservationDelegate } from '../file-reservation-delegate.js'

describe('codeIntelligencePlugin', () => {
  it('has correct name and description', () => {
    expect(codeIntelligencePlugin.name).toBe('af-code-intelligence')
    expect(codeIntelligencePlugin.description).toBeTruthy()
  })

  it('creates 6 tools without file reservation delegate', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    expect(tools).toHaveLength(6)
  })

  it('creates 9 tools with file reservation delegate', () => {
    const mockDelegate: FileReservationDelegate = {
      reserveFiles: vi.fn().mockResolvedValue({ reserved: [], conflicts: [] }),
      checkFileConflicts: vi.fn().mockResolvedValue([]),
      releaseFiles: vi.fn().mockResolvedValue(0),
      releaseAllSessionFiles: vi.fn().mockResolvedValue(0),
    }
    const tools = codeIntelligencePlugin.createTools({
      env: { LINEAR_SESSION_ID: 'test-session' },
      cwd: '/tmp',
      fileReservation: mockDelegate,
    })
    expect(tools).toHaveLength(9)
  })

  it('creates tools with correct names', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    const names = tools.map(t => t.name)
    expect(names).toContain('af_code_search_symbols')
    expect(names).toContain('af_code_get_repo_map')
    expect(names).toContain('af_code_search_code')
    expect(names).toContain('af_code_check_duplicate')
    expect(names).toContain('af_code_find_type_usages')
    expect(names).toContain('af_code_validate_cross_deps')
  })

  it('includes reservation tool names when delegate is present', () => {
    const mockDelegate: FileReservationDelegate = {
      reserveFiles: vi.fn().mockResolvedValue({ reserved: [], conflicts: [] }),
      checkFileConflicts: vi.fn().mockResolvedValue([]),
      releaseFiles: vi.fn().mockResolvedValue(0),
      releaseAllSessionFiles: vi.fn().mockResolvedValue(0),
    }
    const tools = codeIntelligencePlugin.createTools({
      env: {},
      cwd: '/tmp',
      fileReservation: mockDelegate,
    })
    const names = tools.map(t => t.name)
    expect(names).toContain('af_code_reserve_files')
    expect(names).toContain('af_code_check_conflicts')
    expect(names).toContain('af_code_release_files')
  })

  it('tools have descriptions', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
    }
  })

  it('tools have input schemas', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined()
    }
  })

  it('search tool returns results', async () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    const searchTool = tools.find(t => t.name === 'af_code_search_symbols')!
    const result = await searchTool.handler({ query: 'test' }, {})
    expect(result.content).toBeDefined()
    expect(result.content[0].type).toBe('text')
  })

  it('duplicate check tool works', async () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    const dedupTool = tools.find(t => t.name === 'af_code_check_duplicate')!
    const result = await dedupTool.handler({ content: 'test content' }, {})
    expect(result.content).toBeDefined()
    const firstContent = result.content[0] as { type: 'text'; text: string }
    const parsed = JSON.parse(firstContent.text)
    expect(parsed.isDuplicate).toBe(false)
  })

  it('reserve_files tool calls delegate with session ID from env', async () => {
    const mockDelegate: FileReservationDelegate = {
      reserveFiles: vi.fn().mockResolvedValue({ reserved: ['src/a.ts'], conflicts: [] }),
      checkFileConflicts: vi.fn().mockResolvedValue([]),
      releaseFiles: vi.fn().mockResolvedValue(0),
      releaseAllSessionFiles: vi.fn().mockResolvedValue(0),
    }
    const tools = codeIntelligencePlugin.createTools({
      env: { LINEAR_SESSION_ID: 'test-session-123' },
      cwd: '/tmp',
      fileReservation: mockDelegate,
    })
    const reserveTool = tools.find(t => t.name === 'af_code_reserve_files')!
    const result = await reserveTool.handler({ file_paths: ['src/a.ts'], reason: 'test' }, {})

    expect(mockDelegate.reserveFiles).toHaveBeenCalledWith('test-session-123', ['src/a.ts'], 'test')
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.reserved).toEqual(['src/a.ts'])
  })

  it('check_conflicts tool calls delegate', async () => {
    const mockDelegate: FileReservationDelegate = {
      reserveFiles: vi.fn().mockResolvedValue({ reserved: [], conflicts: [] }),
      checkFileConflicts: vi.fn().mockResolvedValue([
        { filePath: 'src/a.ts', heldBy: { sessionId: 'other', reservedAt: 123 } },
      ]),
      releaseFiles: vi.fn().mockResolvedValue(0),
      releaseAllSessionFiles: vi.fn().mockResolvedValue(0),
    }
    const tools = codeIntelligencePlugin.createTools({
      env: { LINEAR_SESSION_ID: 'my-session' },
      cwd: '/tmp',
      fileReservation: mockDelegate,
    })
    const checkTool = tools.find(t => t.name === 'af_code_check_conflicts')!
    const result = await checkTool.handler({ file_paths: ['src/a.ts'] }, {})

    expect(mockDelegate.checkFileConflicts).toHaveBeenCalledWith('my-session', ['src/a.ts'])
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.hasConflicts).toBe(true)
    expect(parsed.conflicts).toHaveLength(1)
  })

  it('release_files tool calls delegate', async () => {
    const mockDelegate: FileReservationDelegate = {
      reserveFiles: vi.fn().mockResolvedValue({ reserved: [], conflicts: [] }),
      checkFileConflicts: vi.fn().mockResolvedValue([]),
      releaseFiles: vi.fn().mockResolvedValue(2),
      releaseAllSessionFiles: vi.fn().mockResolvedValue(0),
    }
    const tools = codeIntelligencePlugin.createTools({
      env: { LINEAR_SESSION_ID: 'my-session' },
      cwd: '/tmp',
      fileReservation: mockDelegate,
    })
    const releaseTool = tools.find(t => t.name === 'af_code_release_files')!
    const result = await releaseTool.handler({ file_paths: ['src/a.ts', 'src/b.ts'] }, {})

    expect(mockDelegate.releaseFiles).toHaveBeenCalledWith('my-session', ['src/a.ts', 'src/b.ts'])
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.released).toBe(2)
  })
})
