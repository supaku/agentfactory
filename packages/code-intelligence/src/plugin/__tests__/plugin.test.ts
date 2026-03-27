import { describe, it, expect } from 'vitest'
import { codeIntelligencePlugin } from '../code-intelligence-plugin.js'

describe('codeIntelligencePlugin', () => {
  it('has correct name and description', () => {
    expect(codeIntelligencePlugin.name).toBe('af-code-intelligence')
    expect(codeIntelligencePlugin.description).toBeTruthy()
  })

  it('creates 6 tools', () => {
    const tools = codeIntelligencePlugin.createTools({ env: {}, cwd: '/tmp' })
    expect(tools).toHaveLength(6)
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
})
