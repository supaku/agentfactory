/**
 * Template Renderer
 *
 * Bridge between the template registry and the existing prompt generation
 * functions. Provides a drop-in replacement for generatePromptForWorkType
 * that uses templates when available and falls back to hardcoded prompts.
 */

import type { AgentWorkType } from '@supaku/agentfactory-linear'
import type { TemplateContext } from './types.js'
import type { TemplateRegistry } from './registry.js'

/**
 * Render a prompt from a template registry with fallback support.
 *
 * @param registry - The template registry to use
 * @param workType - The work type to generate a prompt for
 * @param context - Template variables
 * @param fallback - Fallback function when no template is available
 * @returns The rendered prompt string
 */
export function renderPromptWithFallback(
  registry: TemplateRegistry | null,
  workType: AgentWorkType,
  context: TemplateContext,
  fallback: (identifier: string, workType: AgentWorkType, options?: { parentContext?: string; mentionContext?: string }) => string
): string {
  // If registry exists and has a template, use it
  if (registry?.hasTemplate(workType)) {
    const rendered = registry.renderPrompt(workType, context)
    if (rendered !== null) {
      return rendered
    }
  }

  // Fall back to hardcoded prompt generation
  return fallback(context.identifier, workType, {
    parentContext: context.parentContext,
    mentionContext: context.mentionContext,
  })
}
