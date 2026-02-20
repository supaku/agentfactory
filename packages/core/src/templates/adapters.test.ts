import { describe, it, expect } from 'vitest'
import { ClaudeToolPermissionAdapter } from './adapters.js'

describe('ClaudeToolPermissionAdapter', () => {
  const adapter = new ClaudeToolPermissionAdapter()

  it('translates shell command with glob', () => {
    const result = adapter.translatePermissions([{ shell: 'pnpm *' }])
    expect(result).toEqual(['Bash(pnpm:*)'])
  })

  it('translates multi-word shell command', () => {
    const result = adapter.translatePermissions([{ shell: 'git commit *' }])
    expect(result).toEqual(['Bash(git commit:*)'])
  })

  it('translates git push command', () => {
    const result = adapter.translatePermissions([{ shell: 'git push *' }])
    expect(result).toEqual(['Bash(git push:*)'])
  })

  it('translates user-input to AskUserQuestion', () => {
    const result = adapter.translatePermissions(['user-input'])
    expect(result).toEqual(['AskUserQuestion'])
  })

  it('passes through other string permissions', () => {
    const result = adapter.translatePermissions(['Read', 'Write'])
    expect(result).toEqual(['Read', 'Write'])
  })

  it('translates single-word shell command', () => {
    const result = adapter.translatePermissions([{ shell: 'ls' }])
    expect(result).toEqual(['Bash(ls:*)'])
  })

  it('handles mixed permissions', () => {
    const result = adapter.translatePermissions([
      { shell: 'pnpm *' },
      'user-input',
      { shell: 'gh pr *' },
    ])
    expect(result).toEqual([
      'Bash(pnpm:*)',
      'AskUserQuestion',
      'Bash(gh pr:*)',
    ])
  })
})
