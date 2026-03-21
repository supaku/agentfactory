import { describe, it, expect, vi, beforeEach } from 'vitest'
import { linearPlugin } from '../plugins/linear.js'
import type { ToolPluginContext } from '../types.js'

// Mock runLinear to avoid real API calls
vi.mock('../linear-runner.js', () => ({
  runLinear: vi.fn(),
}))

// We need to import after mock
import { runLinear } from '../linear-runner.js'
const mockRunLinear = vi.mocked(runLinear)

describe('linearPlugin', () => {
  const contextWithKey: ToolPluginContext = {
    env: { LINEAR_API_KEY: 'test-key', LINEAR_TEAM_NAME: 'TestTeam' },
    cwd: '/tmp/test',
  }

  const contextWithoutKey: ToolPluginContext = {
    env: {},
    cwd: '/tmp/test',
  }

  it('has correct metadata', () => {
    expect(linearPlugin.name).toBe('af-linear')
    expect(linearPlugin.description).toBeTruthy()
  })

  it('returns no tools when LINEAR_API_KEY is missing', () => {
    const tools = linearPlugin.createTools(contextWithoutKey)
    expect(tools).toHaveLength(0)
  })

  it('returns 17 tools when LINEAR_API_KEY is set', () => {
    const tools = linearPlugin.createTools(contextWithKey)
    expect(tools).toHaveLength(17)
  })

  it('creates tools with correct names', () => {
    const tools = linearPlugin.createTools(contextWithKey)
    const names = tools.map((t) => t.name)

    expect(names).toContain('af_linear_get_issue')
    expect(names).toContain('af_linear_create_issue')
    expect(names).toContain('af_linear_update_issue')
    expect(names).toContain('af_linear_list_comments')
    expect(names).toContain('af_linear_create_comment')
    expect(names).toContain('af_linear_add_relation')
    expect(names).toContain('af_linear_list_relations')
    expect(names).toContain('af_linear_remove_relation')
    expect(names).toContain('af_linear_list_sub_issues')
    expect(names).toContain('af_linear_list_sub_issue_statuses')
    expect(names).toContain('af_linear_update_sub_issue')
    expect(names).toContain('af_linear_check_blocked')
    expect(names).toContain('af_linear_list_backlog_issues')
    expect(names).toContain('af_linear_list_unblocked_backlog')
    expect(names).toContain('af_linear_check_deployment')
    expect(names).toContain('af_linear_list_issues')
    expect(names).toContain('af_linear_create_blocker')
  })

  describe('tool handlers', () => {
    beforeEach(() => {
      mockRunLinear.mockReset()
    })

    function findTool(name: string) {
      const tools = linearPlugin.createTools(contextWithKey)
      const t = tools.find((t) => t.name === name)
      if (!t) throw new Error(`Tool not found: ${name}`)
      return t
    }

    it('af_linear_get_issue maps args correctly', async () => {
      mockRunLinear.mockResolvedValue({ output: { id: '123', title: 'Test' } })

      const t = findTool('af_linear_get_issue')
      const result = await t.handler({ issue_id: 'SUP-123' }, {})

      expect(mockRunLinear).toHaveBeenCalledWith({
        command: 'get-issue',
        args: {},
        positionalArgs: ['SUP-123'],
        apiKey: 'test-key',
      })
      expect(result.content[0].text).toContain('"id": "123"')
    })

    it('af_linear_create_issue uses team from context', async () => {
      mockRunLinear.mockResolvedValue({ output: { id: '456' } })

      const t = findTool('af_linear_create_issue')
      await t.handler({ title: 'New Issue' }, {})

      expect(mockRunLinear).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'create-issue',
          args: expect.objectContaining({ title: 'New Issue', team: 'TestTeam' }),
        })
      )
    })

    it('af_linear_create_issue uses explicit team over env', async () => {
      mockRunLinear.mockResolvedValue({ output: { id: '456' } })

      const t = findTool('af_linear_create_issue')
      await t.handler({ title: 'New Issue', team: 'OtherTeam' }, {})

      expect(mockRunLinear).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.objectContaining({ team: 'OtherTeam' }),
        })
      )
    })

    it('af_linear_create_comment maps body correctly', async () => {
      mockRunLinear.mockResolvedValue({ output: { id: 'c1' } })

      const t = findTool('af_linear_create_comment')
      await t.handler({ issue_id: 'SUP-123', body: 'Hello world' }, {})

      expect(mockRunLinear).toHaveBeenCalledWith({
        command: 'create-comment',
        args: { body: 'Hello world' },
        positionalArgs: ['SUP-123'],
        apiKey: 'test-key',
      })
    })

    it('af_linear_add_relation maps type and positional args', async () => {
      mockRunLinear.mockResolvedValue({ output: { success: true } })

      const t = findTool('af_linear_add_relation')
      await t.handler({ issue_id: 'SUP-1', related_issue_id: 'SUP-2', type: 'blocks' }, {})

      expect(mockRunLinear).toHaveBeenCalledWith({
        command: 'add-relation',
        args: { type: 'blocks' },
        positionalArgs: ['SUP-1', 'SUP-2'],
        apiKey: 'test-key',
      })
    })

    it('af_linear_check_deployment passes pr_number as string positional', async () => {
      mockRunLinear.mockResolvedValue({ output: { deployed: true } })

      const t = findTool('af_linear_check_deployment')
      await t.handler({ pr_number: 42 }, {})

      expect(mockRunLinear).toHaveBeenCalledWith({
        command: 'check-deployment',
        args: {},
        positionalArgs: ['42'],
        apiKey: 'test-key',
      })
    })

    it('handles errors gracefully', async () => {
      mockRunLinear.mockRejectedValue(new Error('API rate limit'))

      const t = findTool('af_linear_get_issue')
      const result = await t.handler({ issue_id: 'SUP-1' }, {})

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('API rate limit')
    })

    it('af_linear_update_sub_issue passes state and comment', async () => {
      mockRunLinear.mockResolvedValue({ output: { id: 'x' } })

      const t = findTool('af_linear_update_sub_issue')
      await t.handler({ issue_id: 'SUP-5', state: 'Finished', comment: 'Done' }, {})

      expect(mockRunLinear).toHaveBeenCalledWith({
        command: 'update-sub-issue',
        args: { state: 'Finished', comment: 'Done' },
        positionalArgs: ['SUP-5'],
        apiKey: 'test-key',
      })
    })

    it('af_linear_create_blocker maps all optional args', async () => {
      mockRunLinear.mockResolvedValue({ output: { id: 'b1' } })

      const t = findTool('af_linear_create_blocker')
      await t.handler({
        source_issue_id: 'SUP-10',
        title: 'Need API key',
        description: 'Set up credentials',
        team: 'Platform',
        project: 'Infra',
        assignee: 'user@test.com',
      }, {})

      expect(mockRunLinear).toHaveBeenCalledWith({
        command: 'create-blocker',
        args: {
          title: 'Need API key',
          description: 'Set up credentials',
          team: 'Platform',
          project: 'Infra',
          assignee: 'user@test.com',
        },
        positionalArgs: ['SUP-10'],
        apiKey: 'test-key',
      })
    })
  })
})
