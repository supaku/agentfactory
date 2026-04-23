import { describe, it, expect } from 'vitest'
import { extractShellCommand, isGrepGlobShellCommand } from './orchestrator.js'

describe('extractShellCommand', () => {
  it('returns string inputs verbatim', () => {
    expect(extractShellCommand('rg pattern file')).toBe('rg pattern file')
  })

  it('unwraps { command: string } (Codex shape)', () => {
    expect(extractShellCommand({ command: 'rg -n foo' })).toBe('rg -n foo')
  })

  it('joins { command: string[] } argv arrays', () => {
    expect(extractShellCommand({ command: ['rg', '-n', 'foo'] })).toBe('rg -n foo')
  })

  it('returns undefined for unknown shapes', () => {
    expect(extractShellCommand(null)).toBeUndefined()
    expect(extractShellCommand(undefined)).toBeUndefined()
    expect(extractShellCommand({})).toBeUndefined()
    expect(extractShellCommand({ command: 42 })).toBeUndefined()
  })

  it('handles the zsh wrapper shape { cmd: string }', () => {
    expect(extractShellCommand({ cmd: 'find . -name "*.ts"' })).toBe('find . -name "*.ts"')
  })
})

describe('isGrepGlobShellCommand', () => {
  const positives = [
    'rg -n "pattern" src/',
    'grep -r foo .',
    'egrep "a|b" file',
    'find . -name "*.ts"',
    'fd --type f',
    'ack pattern',
    'sed -n \'1,100p\' file.go',
    '/bin/zsh -lc \'rg -n "foo" afcli\'',
    'bash -c "grep bar **/*.ts"',
    'sh -lc "find . -name foo"',
  ]

  const negatives = [
    'git status',
    'pnpm test',
    'gh pr view 123',
    'make build',
    'go test ./...',
    'mv a b',
    '/bin/zsh -lc "go build"',
    '',
  ]

  for (const cmd of positives) {
    it(`recognizes as grep/glob: ${cmd}`, () => {
      expect(isGrepGlobShellCommand(cmd)).toBe(true)
    })
  }

  for (const cmd of negatives) {
    it(`does NOT recognize as grep/glob: ${cmd}`, () => {
      expect(isGrepGlobShellCommand(cmd)).toBe(false)
    })
  }

  it('catches grep in the second segment of a compound command', () => {
    expect(isGrepGlobShellCommand('pwd && rg pattern')).toBe(true)
    expect(isGrepGlobShellCommand('git status; find .')).toBe(true)
  })
})
