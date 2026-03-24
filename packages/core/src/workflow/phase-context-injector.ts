/**
 * Phase Context Injector
 *
 * Injects collected phase outputs into TemplateContext so that downstream
 * phases can access upstream data via Handlebars interpolation.
 *
 * Example usage in templates:
 *   {{phaseOutputs.development.prUrl}}
 *   {{phaseOutputs.qa.testsPassed}}
 */

import type { TemplateContext } from '../templates/types.js'

/**
 * Utility class to inject collected phase outputs into template context.
 */
export class PhaseContextInjector {
  /**
   * Inject phase outputs into a template context.
   *
   * Merges the provided phase outputs into `context.phaseOutputs`, preserving
   * any existing phase output data already on the context. New outputs for
   * the same phase name are merged (not replaced) at the output-key level.
   *
   * @param context - The template context to augment
   * @param phaseOutputs - Map of phase name to collected outputs
   * @returns The augmented template context (same reference, mutated in place)
   */
  inject(
    context: TemplateContext,
    phaseOutputs: Record<string, Record<string, unknown>>,
  ): TemplateContext {
    // Initialize phaseOutputs on context if not present
    if (!context.phaseOutputs) {
      context.phaseOutputs = {}
    }

    // Merge each phase's outputs into the context
    for (const [phaseName, outputs] of Object.entries(phaseOutputs)) {
      if (!context.phaseOutputs[phaseName]) {
        context.phaseOutputs[phaseName] = {}
      }
      // Merge individual output keys (later values overwrite earlier ones)
      for (const [key, value] of Object.entries(outputs)) {
        context.phaseOutputs[phaseName][key] = value
      }
    }

    return context
  }
}
