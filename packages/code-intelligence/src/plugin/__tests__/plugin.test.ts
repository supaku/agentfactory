import { describe, it, expect } from 'vitest'
import { codeIntelligencePlugin } from '../code-intelligence-plugin.js'

describe('codeIntelligencePlugin', () => {
  it('has correct name and description', () => {
    expect(codeIntelligencePlugin.name).toBe('af-code-intelligence')
    expect(codeIntelligencePlugin.description).toBeTruthy()
  })

  it('creates 4 tools', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    expect(tools).toHaveLength(4)
  })

  it('creates tools with correct names', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    const names = tools.map(t => t.name)
    expect(names).toContain('af_code_search_symbols')
    expect(names).toContain('af_code_get_repo_map')
    expect(names).toContain('af_code_search_code')
    expect(names).toContain('af_code_check_duplicate')
  })

  it('tools have descriptions', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
    }
  })

  it('tools have input schemas', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('search tool returns results', async () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    const searchTool = tools.find(t => t.name === 'af_code_search_symbols')!
    const result = await searchTool.execute({ query: 'test' })
    expect(result.content).toBeDefined()
    expect(result.content[0].type).toBe('text')
  })

  it('duplicate check tool works', async () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    const dedupTool = tools.find(t => t.name === 'af_code_check_duplicate')!
    const result = await dedupTool.execute({ content: 'test content' })
    expect(result.content).toBeDefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.isDuplicate).toBe(false)
  })
})
