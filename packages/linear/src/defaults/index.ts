/**
 * Default implementations for prompt generation, work type detection,
 * priority assignment, and auto-trigger configuration.
 *
 * New users start with these defaults and customize as needed.
 * Supaku overrides these with its own prompts.ts.
 */

export {
  defaultGeneratePrompt,
  defaultBuildParentQAContext,
  defaultBuildParentAcceptanceContext,
} from './prompts.js'

export { defaultDetectWorkTypeFromPrompt } from './work-type-detection.js'

export { defaultGetPriority } from './priority.js'

export {
  defaultParseAutoTriggerConfig,
  type DefaultAutoTriggerConfig,
} from './auto-trigger.js'
