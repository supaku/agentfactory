/**
 * Workflow Template System
 *
 * Configurable, composable workflow templates using YAML with Handlebars.
 */

export type {
  WorkflowTemplate,
  PartialTemplate,
  TemplateContext,
  ToolPermission,
  ToolPermissionAdapter,
  TemplateRegistryConfig,
} from './types.js'

export {
  WorkflowTemplateSchema,
  PartialTemplateSchema,
  TemplateContextSchema,
  AgentWorkTypeSchema,
  ToolPermissionSchema,
  validateWorkflowTemplate,
  validatePartialTemplate,
} from './types.js'

export { TemplateRegistry } from './registry.js'

export {
  loadTemplatesFromDir,
  loadTemplateFile,
  loadPartialsFromDir,
  getBuiltinDefaultsDir,
  getBuiltinPartialsDir,
} from './loader.js'

export { ClaudeToolPermissionAdapter, CodexToolPermissionAdapter, createToolPermissionAdapter } from './adapters.js'

export { renderPromptWithFallback } from './renderer.js'

export type { AgentDefinition, AgentDefinitionFrontmatter } from './agent-definition.js'
export { parseAgentDefinition, parseAgentDefinitionFile, AgentDefinitionFrontmatterSchema } from './agent-definition.js'
