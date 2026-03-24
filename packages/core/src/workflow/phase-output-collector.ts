/**
 * Phase Output Collector
 *
 * Extracts structured outputs from agent result text using marker comments.
 * Supports two marker formats:
 *   - <!-- PHASE_OUTPUT:key=value -->         (string, url, boolean types)
 *   - <!-- PHASE_OUTPUT_JSON:key={...} -->    (json type)
 *
 * Validates collected outputs against PhaseOutputDeclaration when provided.
 */

import type { PhaseOutputDeclaration } from './workflow-types.js'

/**
 * Regex to match string-type output markers.
 * Captures: key and value from <!-- PHASE_OUTPUT:key=value -->
 */
const STRING_MARKER_RE = /<!--\s*PHASE_OUTPUT:(\w+)=(.*?)\s*-->/g

/**
 * Regex to match JSON-type output markers.
 * Captures: key and JSON value from <!-- PHASE_OUTPUT_JSON:key={...} -->
 */
const JSON_MARKER_RE = /<!--\s*PHASE_OUTPUT_JSON:(\w+)=([\s\S]*?)\s*-->/g

/**
 * Utility class to extract structured outputs from agent result text.
 */
export class PhaseOutputCollector {
  /**
   * Collect structured outputs from agent output text.
   *
   * @param agentOutput - The raw text output from an agent
   * @param declarations - Optional output declarations for validation
   * @returns Record of collected output key-value pairs
   * @throws Error if a required output is missing or type validation fails
   */
  collect(
    agentOutput: string,
    declarations?: Record<string, PhaseOutputDeclaration>,
  ): Record<string, unknown> {
    const outputs: Record<string, unknown> = {}

    // Extract string-type markers
    for (const match of agentOutput.matchAll(STRING_MARKER_RE)) {
      const key = match[1]
      const rawValue = match[2]
      outputs[key] = rawValue
    }

    // Extract JSON-type markers (these override string markers for same key)
    for (const match of agentOutput.matchAll(JSON_MARKER_RE)) {
      const key = match[1]
      const rawJson = match[2]
      try {
        outputs[key] = JSON.parse(rawJson)
      } catch {
        // If JSON parsing fails, store as raw string
        outputs[key] = rawJson
      }
    }

    // Validate against declarations if provided
    if (declarations) {
      this.validate(outputs, declarations)
    }

    // Coerce types based on declarations
    if (declarations) {
      for (const [key, value] of Object.entries(outputs)) {
        const decl = declarations[key]
        if (decl) {
          outputs[key] = this.coerceType(value, decl.type)
        }
      }
    }

    return outputs
  }

  /**
   * Validate collected outputs against declarations.
   * Checks required fields and type compatibility.
   */
  private validate(
    outputs: Record<string, unknown>,
    declarations: Record<string, PhaseOutputDeclaration>,
  ): void {
    for (const [key, decl] of Object.entries(declarations)) {
      // Check required outputs
      if (decl.required && !(key in outputs)) {
        throw new Error(`Required phase output "${key}" is missing`)
      }

      // Validate type if value is present
      if (key in outputs) {
        const value = outputs[key]
        this.validateType(key, value, decl.type)
      }
    }
  }

  /**
   * Validate that a collected value is compatible with the declared type.
   */
  private validateType(key: string, value: unknown, type: PhaseOutputDeclaration['type']): void {
    switch (type) {
      case 'string':
      case 'url':
        if (typeof value !== 'string') {
          throw new Error(
            `Phase output "${key}" expected type "${type}" but got ${typeof value}`,
          )
        }
        if (type === 'url' && typeof value === 'string') {
          // Basic URL validation: must have a protocol-like prefix
          if (!/^https?:\/\/.+/.test(value)) {
            throw new Error(
              `Phase output "${key}" expected a valid URL but got "${value}"`,
            )
          }
        }
        break
      case 'boolean':
        // Booleans may arrive as strings from markers; we accept string booleans
        if (typeof value === 'string') {
          if (value !== 'true' && value !== 'false') {
            throw new Error(
              `Phase output "${key}" expected boolean but got "${value}"`,
            )
          }
        } else if (typeof value !== 'boolean') {
          throw new Error(
            `Phase output "${key}" expected type "boolean" but got ${typeof value}`,
          )
        }
        break
      case 'json':
        // JSON type accepts any non-string parsed value, or a string that was kept as-is
        // No additional validation needed — the value was either parsed or kept raw
        break
    }
  }

  /**
   * Coerce a raw collected value to the declared type.
   */
  private coerceType(value: unknown, type: PhaseOutputDeclaration['type']): unknown {
    switch (type) {
      case 'boolean':
        if (typeof value === 'string') {
          return value === 'true'
        }
        return value
      case 'string':
      case 'url':
        if (typeof value !== 'string') {
          return String(value)
        }
        return value
      case 'json':
        return value
      default:
        return value
    }
  }
}
