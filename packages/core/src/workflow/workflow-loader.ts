/**
 * Workflow Definition Loader
 *
 * Discovers, parses, and validates WorkflowDefinition documents from YAML files.
 * Follows the same pattern as templates/loader.ts for consistency.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { WorkflowDefinition } from './workflow-types.js'
import { validateWorkflowDefinition } from './workflow-types.js'

/**
 * Load and validate a single WorkflowDefinition YAML file.
 * Throws on invalid YAML syntax or schema validation failure.
 */
export function loadWorkflowDefinitionFile(filePath: string): WorkflowDefinition {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const data = parseYaml(content)
    return validateWorkflowDefinition(data, filePath)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid workflow definition')) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load workflow definition ${filePath}: ${message}`)
  }
}

/**
 * Get the path to the built-in default workflow definitions directory.
 */
export function getBuiltinWorkflowDir(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), 'defaults')
}

/**
 * Get the path to the built-in default workflow definition file.
 */
export function getBuiltinWorkflowPath(): string {
  return path.join(getBuiltinWorkflowDir(), 'workflow.yaml')
}
