import { describe, it, expect, beforeEach } from 'vitest'
import { TemplateRegistry } from './registry.js'
import { ClaudeToolPermissionAdapter } from './adapters.js'
import type { WorkflowTemplate } from './types.js'

describe('TemplateRegistry', () => {
  let registry: TemplateRegistry

  beforeEach(() => {
    registry = new TemplateRegistry()
  })

  describe('basic operations', () => {
    it('returns undefined for unregistered work type', () => {
      expect(registry.getTemplate('development')).toBeUndefined()
      expect(registry.hasTemplate('development')).toBe(false)
    })

    it('returns empty list of registered work types initially', () => {
      expect(registry.getRegisteredWorkTypes()).toEqual([])
    })

    it('returns null when rendering unregistered work type', () => {
      expect(registry.renderPrompt('development', { identifier: 'SUP-123' })).toBeNull()
    })
  })

  describe('inline templates', () => {
    const devTemplate: WorkflowTemplate = {
      apiVersion: 'v1',
      kind: 'WorkflowTemplate',
      metadata: { name: 'development', workType: 'development' },
      tools: { allow: [{ shell: 'pnpm *' }] },
      prompt: 'Start work on {{identifier}}.',
    }

    it('registers and renders inline templates', () => {
      registry.initialize({ templates: { development: devTemplate }, useBuiltinDefaults: false })
      expect(registry.hasTemplate('development')).toBe(true)
      const result = registry.renderPrompt('development', { identifier: 'SUP-123' })
      expect(result).toBe('Start work on SUP-123.')
    })

    it('handles mentionContext conditional', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        prompt: 'Work on {{identifier}}.{{#if mentionContext}}\nContext: {{mentionContext}}{{/if}}',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      // Without mentionContext
      expect(registry.renderPrompt('development', { identifier: 'SUP-1' }))
        .toBe('Work on SUP-1.')

      // With mentionContext
      expect(registry.renderPrompt('development', { identifier: 'SUP-1', mentionContext: 'fix bug' }))
        .toBe('Work on SUP-1.\nContext: fix bug')
    })
  })

  describe('partials', () => {
    it('renders templates with registered partials', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        prompt: 'Work on {{identifier}}.{{> partials/test-partial}}',
      }

      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })
      registry.registerPartial('partials/test-partial', '\nTest partial content.')

      const result = registry.renderPrompt('development', { identifier: 'SUP-1' })
      expect(result).toBe('Work on SUP-1.\nTest partial content.')
    })

    it('throws on missing partial', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        prompt: 'Work on {{identifier}}.{{> partials/missing}}',
      }

      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })

      expect(() => registry.renderPrompt('development', { identifier: 'SUP-1' }))
        .toThrow('Failed to render template')
    })
  })

  describe('tool permissions', () => {
    it('returns undefined when no tools defined', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        prompt: 'test',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })
      expect(registry.getToolPermissions('development')).toBeUndefined()
    })

    it('returns raw permissions without adapter', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        tools: { allow: [{ shell: 'pnpm *' }, 'Read'] },
        prompt: 'test',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })
      const perms = registry.getToolPermissions('development')
      expect(perms).toEqual(['pnpm *', 'Read'])
    })

    it('translates permissions with Claude adapter', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        tools: {
          allow: [{ shell: 'pnpm *' }, { shell: 'git commit *' }],
          disallow: ['user-input'],
        },
        prompt: 'test',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })
      registry.setToolPermissionAdapter(new ClaudeToolPermissionAdapter())

      const perms = registry.getToolPermissions('development')
      expect(perms).toEqual(['Bash(pnpm:*)', 'Bash(git commit:*)'])
    })

    it('returns disallowed tools', () => {
      const template: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'dev', workType: 'development' },
        tools: { disallow: ['user-input'] },
        prompt: 'test',
      }
      registry.initialize({ templates: { development: template }, useBuiltinDefaults: false })
      expect(registry.getDisallowedTools('development')).toEqual(['user-input'])
    })
  })

  describe('built-in defaults', () => {
    it('loads built-in default templates when useBuiltinDefaults is true', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      // 13 base work types + 5 strategy templates. The former `merge` template
      // was removed — merging is handled by the local queue (acceptance hands
      // off to the sidecar worker) so agents no longer need a merge prompt.
      const workTypes = fullRegistry.getRegisteredWorkTypes()
      expect(workTypes.length).toBe(18)
      expect(workTypes).toContain('development')
      expect(workTypes).toContain('qa')
      expect(workTypes).toContain('coordination')
      expect(workTypes).toContain('security')
      expect(workTypes).not.toContain('merge')
      // Strategy-specific templates
      expect(workTypes).toContain('refinement-context-enriched')
      expect(workTypes).toContain('refinement-decompose')
      expect(workTypes).toContain('development-retry')
      expect(workTypes).toContain('qa-retry')
      expect(workTypes).toContain('qa-native')
    })

    it('renders a built-in template with variables', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('development', { identifier: 'SUP-999' })
      expect(result).toContain('SUP-999')
      expect(result).toContain('Implement the feature/fix')
    })

    it('built-in templates include CLI instructions partial', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('development', { identifier: 'SUP-1', linearCli: 'pnpm af-linear', packageManager: 'pnpm' })
      expect(result).toContain('pnpm af-linear')
      expect(result).toContain('LINEAR CLI (CRITICAL)')
    })

    it('built-in QA template includes work result marker', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('qa', { identifier: 'SUP-1' })
      expect(result).toContain('WORK_RESULT:passed')
      expect(result).toContain('WORK_RESULT:failed')
    })

    it('built-in coordination template includes shared worktree safety', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('coordination', { identifier: 'SUP-1' })
      expect(result).toContain('SHARED WORKTREE')
      expect(result).toContain('git worktree remove')
      expect(result).toContain('git stash')
    })

    it('built-in development template bans git stash', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('development', { identifier: 'SUP-1' })
      expect(result).toContain('NEVER run `git stash`')
    })

    // REN-1263: coordination/development/inflight agents must apply the same
    // hard-fail rule as the QA agent — a non-zero exit from typecheck/build/test
    // forces WORK_RESULT:failed and cannot be passed off as "pre-existing".
    describe('REN-1263: validation hard-fail rule (coordination/development parity with QA)', () => {
      const workTypesWithHardFail = [
        'development',
        'inflight',
        'development-retry',
        'coordination',
        'inflight-coordination',
      ] as const

      for (const workType of workTypesWithHardFail) {
        it(`${workType} template includes the validation hard-fail rule`, () => {
          const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
          // Cast to satisfy renderPrompt's AgentWorkType param — strategy template
          // names like "development-retry" are valid keys at runtime.
          const result = fullRegistry.renderPrompt(workType as never, {
            identifier: 'REN-1263',
            packageManager: 'pnpm',
            linearCli: 'pnpm af-linear',
          })
          expect(result).not.toBeNull()
          // Header is the unique marker introduced by the validation-hard-fail partial.
          expect(result).toContain('HARD FAIL RULE — VALIDATION EXIT CODES')
          // Mirror QA's hard-fail wording: non-zero exit = automatic fail.
          expect(result).toContain('non-zero exit')
          expect(result).toContain('WORK_RESULT:failed')
          // Forbidden justifications must be explicitly listed.
          expect(result).toContain('pre-existing')
          expect(result).toContain('not introduced by this work')
          expect(result).toContain('environmental')
          expect(result).toContain('warning only')
          // Escalation path requires create-blocker.
          expect(result).toContain('create-blocker')
          // Exit code is the source of truth — not stdout parsing.
          expect(result).toMatch(/exit code is the (single )?source of truth/i)
        })
      }

      it('commit-push-pr partial reinforces exit-code-as-truth in development prompts', () => {
        const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
        const result = fullRegistry.renderPrompt('development', {
          identifier: 'REN-1263',
          packageManager: 'pnpm',
          linearCli: 'pnpm af-linear',
        })
        expect(result).not.toBeNull()
        expect(result).toContain('EXIT CODE IS THE SOURCE OF TRUTH')
        expect(result).toMatch(/NEVER emit WORK_RESULT:passed while any of these/)
      })
    })

    it('built-in templates handle mentionContext', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('development', {
        identifier: 'SUP-1',
        mentionContext: 'Fix the login bug',
      })
      expect(result).toContain('Fix the login bug')
      expect(result).toContain('Additional context')
    })

    it('built-in templates omit mentionContext when not provided', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('development', { identifier: 'SUP-1' })
      expect(result).not.toContain('Additional context')
    })

    // REN-74: when the orchestrator merges a customPrompt into mentionContext,
    // the rendered development prompt must contain BOTH the mandatory
    // commit/push/PR ladder AND the caller-provided context. This asserts the
    // template-merge path produces a prompt a Codex exec-mode agent can act on.
    it('built-in development template renders commit/push/PR ladder alongside mentionContext', () => {
      const fullRegistry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = fullRegistry.renderPrompt('development', {
        identifier: 'REN-74',
        mentionContext: 'Start work on REN-74. Implement the feature/fix as specified.',
        packageManager: 'pnpm',
        linearCli: 'pnpm af-linear',
      })
      // Mandatory persistence ladder (from commit-push-pr partial)
      expect(result).toContain('git commit')
      expect(result).toContain('git push')
      expect(result).toContain('gh pr create')
      expect(result).toContain('VALIDATE THEN PERSIST YOUR WORK')
      // Caller-provided context is preserved
      expect(result).toContain('Start work on REN-74')
      expect(result).toContain('Additional context')
    })
  })

  describe('layer override', () => {
    it('inline templates override built-in defaults', () => {
      const customTemplate: WorkflowTemplate = {
        apiVersion: 'v1',
        kind: 'WorkflowTemplate',
        metadata: { name: 'custom-dev', workType: 'development' },
        prompt: 'Custom prompt for {{identifier}}.',
      }

      const customRegistry = TemplateRegistry.create({
        useBuiltinDefaults: true,
        templates: { development: customTemplate },
      })

      const result = customRegistry.renderPrompt('development', { identifier: 'SUP-1' })
      expect(result).toBe('Custom prompt for SUP-1.')
    })
  })
})
