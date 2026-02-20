/**
 * Template Registry
 *
 * In-memory registry that resolves workflow templates by work type.
 * Supports layered resolution with built-in defaults, project overrides,
 * and inline config overrides.
 */

import Handlebars from 'handlebars'
import type { AgentWorkType } from '@supaku/agentfactory-linear'
import type {
  WorkflowTemplate,
  TemplateContext,
  TemplateRegistryConfig,
  ToolPermission,
  ToolPermissionAdapter,
} from './types.js'
import {
  loadTemplatesFromDir,
  loadPartialsFromDir,
  getBuiltinDefaultsDir,
  getBuiltinPartialsDir,
} from './loader.js'

/**
 * Template Registry manages workflow templates and renders prompts.
 */
export class TemplateRegistry {
  private templates = new Map<AgentWorkType, WorkflowTemplate>()
  private handlebars: typeof Handlebars
  private toolPermissionAdapter?: ToolPermissionAdapter

  constructor() {
    this.handlebars = Handlebars.create()
  }

  /**
   * Create and initialize a registry from configuration.
   */
  static create(config: TemplateRegistryConfig = {}): TemplateRegistry {
    const registry = new TemplateRegistry()
    registry.initialize(config)
    return registry
  }

  /**
   * Initialize the registry by loading templates from configured sources.
   * Resolution order (later sources override earlier):
   *   1. Built-in defaults
   *   2. Each directory in templateDirs (in order)
   *   3. Inline template overrides
   */
  initialize(config: TemplateRegistryConfig = {}): void {
    const { templateDirs = [], templates, useBuiltinDefaults = true, frontend } = config

    // Layer 1: Built-in defaults
    if (useBuiltinDefaults) {
      const builtinDir = getBuiltinDefaultsDir()
      const builtinTemplates = loadTemplatesFromDir(builtinDir)
      for (const [workType, template] of builtinTemplates) {
        this.templates.set(workType, template)
      }

      // Load built-in partials
      const builtinPartialsDir = getBuiltinPartialsDir()
      const builtinPartials = loadPartialsFromDir(builtinPartialsDir, frontend)
      for (const [name, content] of builtinPartials) {
        this.handlebars.registerPartial(`partials/${name}`, content)
      }
    }

    // Layer 2: Project-level overrides (each dir in order)
    for (const dir of templateDirs) {
      const dirTemplates = loadTemplatesFromDir(dir)
      for (const [workType, template] of dirTemplates) {
        this.templates.set(workType, template)
      }

      // Load partials from each dir's partials subdirectory
      const partialsDir = `${dir}/partials`
      const partials = loadPartialsFromDir(partialsDir, frontend)
      for (const [name, content] of partials) {
        this.handlebars.registerPartial(`partials/${name}`, content)
      }
    }

    // Layer 3: Inline config overrides (highest priority)
    if (templates) {
      for (const [workType, template] of Object.entries(templates)) {
        if (template) {
          this.templates.set(workType as AgentWorkType, template)
        }
      }
    }
  }

  /**
   * Set the tool permission adapter for provider-specific translation.
   */
  setToolPermissionAdapter(adapter: ToolPermissionAdapter): void {
    this.toolPermissionAdapter = adapter
  }

  /**
   * Look up a template by work type.
   * Returns undefined if no template is registered for the work type.
   */
  getTemplate(workType: AgentWorkType): WorkflowTemplate | undefined {
    return this.templates.get(workType)
  }

  /**
   * Check if a template is registered for a work type.
   */
  hasTemplate(workType: AgentWorkType): boolean {
    return this.templates.has(workType)
  }

  /**
   * Get all registered work types.
   */
  getRegisteredWorkTypes(): AgentWorkType[] {
    return Array.from(this.templates.keys())
  }

  /**
   * Render a template for a work type with the given context variables.
   * Returns null if no template is registered for the work type.
   */
  renderPrompt(workType: AgentWorkType, context: TemplateContext): string | null {
    const template = this.templates.get(workType)
    if (!template) {
      return null
    }

    try {
      const compiledTemplate = this.handlebars.compile(template.prompt, { noEscape: true })
      return compiledTemplate(context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to render template for work type "${workType}": ${message}`
      )
    }
  }

  /**
   * Get the translated tool permissions for a work type.
   * Returns undefined if no template or no tool permissions defined.
   */
  getToolPermissions(workType: AgentWorkType): string[] | undefined {
    const template = this.templates.get(workType)
    if (!template?.tools?.allow) {
      return undefined
    }

    if (this.toolPermissionAdapter) {
      return this.toolPermissionAdapter.translatePermissions(template.tools.allow)
    }

    // Without an adapter, return string permissions as-is
    return template.tools.allow.map(p =>
      typeof p === 'string' ? p : (p as { shell: string }).shell
    )
  }

  /**
   * Get disallowed tools for a work type.
   */
  getDisallowedTools(workType: AgentWorkType): ToolPermission[] | undefined {
    const template = this.templates.get(workType)
    return template?.tools?.disallow
  }

  /**
   * Register a partial template for use in Handlebars rendering.
   */
  registerPartial(name: string, content: string): void {
    this.handlebars.registerPartial(name, content)
  }
}
