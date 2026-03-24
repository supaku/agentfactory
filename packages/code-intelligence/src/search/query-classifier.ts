/**
 * Query classifier for adaptive alpha weighting in hybrid search.
 * Detects whether a query is identifier-heavy, natural language, or mixed
 * and returns a recommended alpha value.
 */

export type QueryType = 'identifier' | 'natural' | 'mixed'

export interface QueryClassification {
  type: QueryType
  alpha: number
}

// Patterns that indicate code identifiers
const CAMEL_CASE = /[a-z][a-zA-Z]*[A-Z]/
const PASCAL_CASE = /^[A-Z][a-zA-Z]+[A-Z]/
const SNAKE_CASE = /\w+_\w+/
const CONSTANT_CASE = /^[A-Z][A-Z0-9_]+$/
const DOT_NOTATION = /\w+\.\w+/
const OPERATOR_TOKENS = /(::|->|=>|#)/

/**
 * Check if a token looks like a code identifier.
 */
function isIdentifierToken(token: string): boolean {
  if (CAMEL_CASE.test(token)) return true
  if (PASCAL_CASE.test(token)) return true
  if (SNAKE_CASE.test(token)) return true
  if (CONSTANT_CASE.test(token)) return true
  if (DOT_NOTATION.test(token)) return true
  if (OPERATOR_TOKENS.test(token)) return true
  return false
}

/**
 * Classify a search query and return the recommended alpha value
 * for CCS fusion.
 *
 * - identifier-heavy queries (camelCase, snake_case, etc.): alpha = 0.25 (favor BM25)
 * - natural language queries ("authentication middleware"): alpha = 0.75 (favor vectors)
 * - mixed queries ("fix CORS error in Express"): alpha = 0.55 (balanced)
 */
export function classifyQuery(query: string): QueryClassification {
  const tokens = query.split(/\s+/).filter(t => t.length > 0)

  if (tokens.length === 0) {
    return { type: 'natural', alpha: 0.75 }
  }

  let identifierCount = 0
  for (const token of tokens) {
    if (isIdentifierToken(token)) {
      identifierCount++
    }
  }

  const ratio = identifierCount / tokens.length

  if (ratio > 0.5) {
    return { type: 'identifier', alpha: 0.25 }
  }
  if (ratio < 0.2) {
    return { type: 'natural', alpha: 0.75 }
  }
  return { type: 'mixed', alpha: 0.55 }
}
