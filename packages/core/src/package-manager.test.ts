import { describe, it, expect } from 'vitest'
import {
  getLockFileName,
  getInstallCommand,
  getAddCommand,
  getGitattributesEntry,
  type PackageManager,
} from './package-manager.js'

describe('getLockFileName', () => {
  it('returns correct lockfile for each package manager', () => {
    expect(getLockFileName('pnpm')).toBe('pnpm-lock.yaml')
    expect(getLockFileName('npm')).toBe('package-lock.json')
    expect(getLockFileName('yarn')).toBe('yarn.lock')
    expect(getLockFileName('bun')).toBe('bun.lockb')
  })

  it('returns null for none', () => {
    expect(getLockFileName('none')).toBeNull()
  })
})

describe('getInstallCommand', () => {
  it('returns base install command without frozen flag', () => {
    expect(getInstallCommand('pnpm')).toBe('pnpm install')
    expect(getInstallCommand('npm')).toBe('npm install')
    expect(getInstallCommand('yarn')).toBe('yarn install')
    expect(getInstallCommand('bun')).toBe('bun install')
  })

  it('returns frozen install command when frozen is true', () => {
    expect(getInstallCommand('pnpm', true)).toBe('pnpm install --frozen-lockfile')
    expect(getInstallCommand('npm', true)).toBe('npm install --ci')
    expect(getInstallCommand('yarn', true)).toBe('yarn install --frozen-lockfile')
    expect(getInstallCommand('bun', true)).toBe('bun install --frozen-lockfile')
  })

  it('returns null for none', () => {
    expect(getInstallCommand('none')).toBeNull()
    expect(getInstallCommand('none', true)).toBeNull()
  })
})

describe('getAddCommand', () => {
  it('returns correct add command for each package manager', () => {
    expect(getAddCommand('pnpm')).toBe('pnpm add')
    expect(getAddCommand('npm')).toBe('npm install')
    expect(getAddCommand('yarn')).toBe('yarn add')
    expect(getAddCommand('bun')).toBe('bun add')
  })

  it('returns null for none', () => {
    expect(getAddCommand('none')).toBeNull()
  })
})

describe('getGitattributesEntry', () => {
  it('returns correct gitattributes entry for each package manager', () => {
    expect(getGitattributesEntry('pnpm')).toBe('pnpm-lock.yaml merge=ours')
    expect(getGitattributesEntry('npm')).toBe('package-lock.json merge=ours')
  })

  it('returns null for none', () => {
    expect(getGitattributesEntry('none')).toBeNull()
  })
})
