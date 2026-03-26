/**
 * Expression Parser & Evaluator — Public API
 *
 * Parses Handlebars-style condition strings from WorkflowDefinition
 * transitions into a typed AST, and evaluates them within a sandboxed
 * context.
 *
 * @example
 * ```ts
 * import { parseExpression, evaluateCondition, buildEvaluationContext } from './expression/index.js'
 *
 * const ast = parseExpression("{{ hasLabel('bug') and priority gt 3 }}")
 * // => BinaryOp(AND, FunctionCall("hasLabel", [StringLiteral("bug")]), BinaryOp(GT, ...))
 *
 * const ctx = buildEvaluationContext(issue, phaseState)
 * const result = evaluateCondition("{{ hasLabel('bug') }}", ctx)
 * // => true or false
 * ```
 */

import type { ASTNode } from './ast.js'
import type { EvaluationContext } from './context.js'
import { tokenize, ParseError } from './lexer.js'
import { parse } from './parser.js'
import { evaluate } from './evaluator.js'

// ---------------------------------------------------------------------------
// Re-exports — AST types
// ---------------------------------------------------------------------------

export type {
  ASTNode,
  VariableRef,
  BooleanLiteral,
  StringLiteral,
  NumberLiteral,
  UnaryOp,
  BinaryOp,
  FunctionCall,
  UnaryOperator,
  BinaryOperator,
} from './ast.js'

// ---------------------------------------------------------------------------
// Re-exports — Lexer
// ---------------------------------------------------------------------------

export type {
  Token,
  TokenType,
  SourcePosition,
} from './lexer.js'

export { ParseError, tokenize } from './lexer.js'

// ---------------------------------------------------------------------------
// Re-exports — Parser
// ---------------------------------------------------------------------------

export { parse } from './parser.js'

// ---------------------------------------------------------------------------
// Re-exports — Evaluator
// ---------------------------------------------------------------------------

export { evaluate, EvaluationError } from './evaluator.js'

// ---------------------------------------------------------------------------
// Re-exports — Context
// ---------------------------------------------------------------------------

export type { EvaluationContext } from './context.js'
export { buildEvaluationContext } from './context.js'

// ---------------------------------------------------------------------------
// Re-exports — Helpers
// ---------------------------------------------------------------------------

export { createBuiltinHelpers } from './helpers.js'

// ---------------------------------------------------------------------------
// Convenience entry points
// ---------------------------------------------------------------------------

/**
 * Parse a condition string into an AST in a single call.
 *
 * Combines tokenization and parsing. Accepts strings with or without
 * `{{ }}` delimiters.
 *
 * @param condition - The condition string to parse.
 * @returns The root AST node.
 * @throws {ParseError} on invalid input with position information.
 */
export function parseExpression(condition: string): ASTNode {
  const tokens = tokenize(condition)
  return parse(tokens)
}

/**
 * Parse and evaluate a condition string, returning a boolean result.
 *
 * This is the primary entry point for workflow transition evaluation.
 * It combines parsing and evaluation in one call, and coerces the
 * result to a boolean.
 *
 * @param condition - The condition string (with or without `{{ }}`).
 * @param context   - The sandboxed evaluation context.
 * @returns `true` if the condition is satisfied, `false` otherwise.
 * @throws {ParseError} on syntax errors.
 * @throws {EvaluationError} on runtime errors (unknown functions, type mismatches).
 */
export function evaluateCondition(condition: string, context: EvaluationContext): boolean {
  const ast = parseExpression(condition)
  const result = evaluate(ast, context)
  return Boolean(result)
}

/**
 * Interpolate template expressions within a string.
 *
 * Finds all `{{ ... }}` expressions in the input string, evaluates each
 * against the context, and replaces the placeholder with the string
 * representation of the result.
 *
 * @param template - The template string containing `{{ }}` expressions.
 * @param context  - The sandboxed evaluation context.
 * @returns The fully resolved string.
 * @throws {ParseError} on syntax errors in expressions.
 * @throws {EvaluationError} on runtime errors in expressions.
 */
export function interpolateTemplate(template: string, context: EvaluationContext): string {
  // Regex to match {{ ... }} expressions (non-greedy)
  const EXPR_PATTERN = /\{\{(.*?)\}\}/g

  return template.replace(EXPR_PATTERN, (_match, expr: string) => {
    const trimmed = expr.trim()
    if (trimmed.length === 0) {
      throw new ParseError('Empty expression in template', { offset: 0, column: 1 })
    }
    const tokens = tokenize(trimmed)
    const ast = parse(tokens)
    const result = evaluate(ast, context)
    return String(result)
  })
}
