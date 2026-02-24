import { describe, it, expect } from 'vitest'
import {
  ClaudeToolPermissionAdapter,
  CodexToolPermissionAdapter,
  createToolPermissionAdapter,
} from './adapters.js'

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

describe('CodexToolPermissionAdapter', () => {
  const adapter = new CodexToolPermissionAdapter()

  it('translates shell command to shell: prefix format', () => {
    const result = adapter.translatePermissions([{ shell: 'pnpm *' }])
    expect(result).toEqual(['shell:pnpm *'])
  })

  it('translates multi-word shell command', () => {
    const result = adapter.translatePermissions([{ shell: 'git commit *' }])
    expect(result).toEqual(['shell:git commit *'])
  })

  it('passes through user-input as-is (Codex exec is non-interactive)', () => {
    const result = adapter.translatePermissions(['user-input'])
    expect(result).toEqual(['user-input'])
  })

  it('passes through other string permissions as-is', () => {
    const result = adapter.translatePermissions(['Read', 'Write'])
    expect(result).toEqual(['Read', 'Write'])
  })

  it('translates single-word shell command', () => {
    const result = adapter.translatePermissions([{ shell: 'ls' }])
    expect(result).toEqual(['shell:ls'])
  })

  it('handles mixed permissions', () => {
    const result = adapter.translatePermissions([
      { shell: 'pnpm *' },
      'user-input',
      { shell: 'gh pr *' },
    ])
    expect(result).toEqual([
      'shell:pnpm *',
      'user-input',
      'shell:gh pr *',
    ])
  })

  it('handles empty permissions array', () => {
    const result = adapter.translatePermissions([])
    expect(result).toEqual([])
  })
})

describe('createToolPermissionAdapter', () => {
  it('returns ClaudeToolPermissionAdapter for claude', () => {
    const adapter = createToolPermissionAdapter('claude')
    expect(adapter).toBeInstanceOf(ClaudeToolPermissionAdapter)
  })

  it('returns CodexToolPermissionAdapter for codex', () => {
    const adapter = createToolPermissionAdapter('codex')
    expect(adapter).toBeInstanceOf(CodexToolPermissionAdapter)
  })

  it('returns ClaudeToolPermissionAdapter for amp (fallback)', () => {
    const adapter = createToolPermissionAdapter('amp')
    expect(adapter).toBeInstanceOf(ClaudeToolPermissionAdapter)
  })

  it('returns ClaudeToolPermissionAdapter for unknown provider', () => {
    const adapter = createToolPermissionAdapter('unknown' as 'claude')
    expect(adapter).toBeInstanceOf(ClaudeToolPermissionAdapter)
  })

  it('claude and codex adapters produce different output for same input', () => {
    const claudeAdapter = createToolPermissionAdapter('claude')
    const codexAdapter = createToolPermissionAdapter('codex')

    const permissions = [{ shell: 'pnpm *' }] as const

    const claudeResult = claudeAdapter.translatePermissions([...permissions])
    const codexResult = codexAdapter.translatePermissions([...permissions])

    expect(claudeResult).toEqual(['Bash(pnpm:*)'])
    expect(codexResult).toEqual(['shell:pnpm *'])
    expect(claudeResult).not.toEqual(codexResult)
  })
})
