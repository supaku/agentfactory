import { describe, it, expect } from 'vitest'
import { classifyTool } from '../tool-category.js'
import type { ToolCategory } from '../tool-category.js'

describe('classifyTool', () => {
  describe('security category', () => {
    it.each([
      'security-scan',
      'vuln-check',
      'sast-analyzer',
      'dast-runner',
      'sbom-generator',
      'cve-lookup',
      'audit-deps',
    ])('classifies "%s" as security', (name) => {
      expect(classifyTool(name)).toBe('security')
    })
  })

  describe('testing category', () => {
    it.each([
      'test-runner',
      'jest',
      'vitest',
      'playwright-run',
      'cypress-e2e',
      'coverage-report',
      'assert-output',
    ])('classifies "%s" as testing', (name) => {
      expect(classifyTool(name)).toBe('testing')
    })
  })

  describe('build category', () => {
    it.each([
      'build-project',
      'compile-ts',
      'bundle-assets',
      'webpack-build',
      'vite-dev',
      'esbuild-run',
      'tsc-check',
    ])('classifies "%s" as build', (name) => {
      expect(classifyTool(name)).toBe('build')
    })
  })

  describe('deploy category', () => {
    it.each([
      'deploy-prod',
      'release-version',
      'publish-package',
      'docker-build',
      'k8s-apply',
      'terraform-plan',
      'infra-provision',
    ])('classifies "%s" as deploy', (name) => {
      expect(classifyTool(name)).toBe('deploy')
    })
  })

  describe('research category', () => {
    it.each([
      'search-code',
      'fetch-docs',
      'browse-web',
      'Read',
      'Grep',
      'Glob',
      'explore-repo',
    ])('classifies "%s" as research', (name) => {
      expect(classifyTool(name)).toBe('research')
    })
  })

  describe('general category (fallback)', () => {
    it.each([
      'Bash',
      'Edit',
      'Write',
      'Task',
      'TodoWrite',
      'unknown-tool',
    ])('classifies "%s" as general', (name) => {
      expect(classifyTool(name)).toBe('general')
    })
  })

  describe('MCP-qualified tool names', () => {
    it('extracts tool name from mcp__plugin__tool format', () => {
      expect(classifyTool('mcp__af-linear__af_linear_create_issue')).toBe('general')
    })

    it('classifies MCP security tools', () => {
      expect(classifyTool('mcp__scanner__security_scan')).toBe('security')
    })

    it('classifies MCP testing tools', () => {
      expect(classifyTool('mcp__ci__test_runner')).toBe('testing')
    })

    it('classifies MCP build tools', () => {
      expect(classifyTool('mcp__ci__build_project')).toBe('build')
    })

    it('classifies MCP deploy tools', () => {
      expect(classifyTool('mcp__ops__deploy_service')).toBe('deploy')
    })

    it('classifies MCP research tools', () => {
      expect(classifyTool('mcp__utils__search_code')).toBe('research')
    })
  })

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(classifyTool('SECURITY-SCAN')).toBe('security')
      expect(classifyTool('Test-Runner')).toBe('testing')
      expect(classifyTool('BUILD')).toBe('build')
      expect(classifyTool('Deploy')).toBe('deploy')
      expect(classifyTool('SEARCH')).toBe('research')
    })
  })

  describe('edge cases', () => {
    it('returns general for empty string', () => {
      expect(classifyTool('')).toBe('general')
    })

    it('handles tool names with only underscores', () => {
      expect(classifyTool('__')).toBe('general')
    })

    it('handles tool names with trailing __', () => {
      // lastIndexOf('__') finds it, but substring after would be empty
      // so it falls back to the original name
      expect(classifyTool('prefix__')).toBe('general')
    })
  })

  describe('type export', () => {
    it('ToolCategory type is usable', () => {
      const cat: ToolCategory = classifyTool('test')
      expect(typeof cat).toBe('string')
    })
  })
})
