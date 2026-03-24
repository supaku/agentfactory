/**
 * Expression Evaluator (Tree-Walking)
 *
 * Walks a parsed AST and produces a result value within a sandboxed
 * EvaluationContext. No `eval()`, `new Function()`, or dynamic code
 * execution is used — evaluation is a pure recursive descent over the
 * typed AST nodes.
 */

import type { ASTNode } from './ast.js'
import type { EvaluationContext } from './context.js'

// ---------------------------------------------------------------------------
// EvaluationError
// ---------------------------------------------------------------------------

/**
 * Error thrown when expression evaluation fails at runtime.
 *
 * Examples: unknown function name, type mismatch in numeric comparison.
 */
export class EvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary value to a boolean using JavaScript truthiness rules.
 */
function toBool(value: unknown): boolean {
  return Boolean(value)
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate an AST node within the given context.
 *
 * @param ast     - The AST node to evaluate.
 * @param context - The sandboxed evaluation context.
 * @returns The result of evaluating the node.
 * @throws {EvaluationError} on unknown functions or type mismatches.
 */
export function evaluate(ast: ASTNode, context: EvaluationContext): unknown {
  switch (ast.type) {
    // -------------------------------------------------------------------
    // Literals — return value directly
    // -------------------------------------------------------------------
    case 'BooleanLiteral':
      return ast.value

    case 'StringLiteral':
      return ast.value

    case 'NumberLiteral':
      return ast.value

    // -------------------------------------------------------------------
    // Variable reference — look up in context, default to false
    // -------------------------------------------------------------------
    case 'VariableRef': {
      const value = context.variables[ast.name]
      // Undefined variables resolve to `false` (no crash)
      if (value === undefined) {
        return false
      }
      return value
    }

    // -------------------------------------------------------------------
    // Unary operator
    // -------------------------------------------------------------------
    case 'UnaryOp': {
      // Currently only 'not' is supported
      const operand = evaluate(ast.operand, context)
      return !toBool(operand)
    }

    // -------------------------------------------------------------------
    // Binary operator
    // -------------------------------------------------------------------
    case 'BinaryOp':
      return evaluateBinaryOp(ast.operator, ast.left, ast.right, context)

    // -------------------------------------------------------------------
    // Function call
    // -------------------------------------------------------------------
    case 'FunctionCall': {
      const fn = context.functions[ast.name]
      if (!fn) {
        throw new EvaluationError(
          `Unknown function '${ast.name}'. Available functions: ${Object.keys(context.functions).join(', ') || '(none)'}`,
        )
      }
      const args = ast.args.map((arg) => evaluate(arg, context))
      return fn(...args)
    }

    default: {
      // Exhaustive check — should never reach here with a well-typed AST
      const _exhaustive: never = ast
      throw new EvaluationError(`Unknown AST node type: ${(_exhaustive as ASTNode).type}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Binary operator evaluation
// ---------------------------------------------------------------------------

function evaluateBinaryOp(
  operator: string,
  left: ASTNode,
  right: ASTNode,
  context: EvaluationContext,
): unknown {
  switch (operator) {
    // Short-circuit logical operators
    case 'and': {
      const leftVal = evaluate(left, context)
      if (!toBool(leftVal)) return leftVal
      return evaluate(right, context)
    }

    case 'or': {
      const leftVal = evaluate(left, context)
      if (toBool(leftVal)) return leftVal
      return evaluate(right, context)
    }

    // Equality — works across all types
    case 'eq': {
      const leftVal = evaluate(left, context)
      const rightVal = evaluate(right, context)
      return leftVal === rightVal
    }

    case 'neq': {
      const leftVal = evaluate(left, context)
      const rightVal = evaluate(right, context)
      return leftVal !== rightVal
    }

    // Ordering comparisons — require matching numeric types
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const leftVal = evaluate(left, context)
      const rightVal = evaluate(right, context)
      return evaluateOrdering(operator, leftVal, rightVal)
    }

    default:
      throw new EvaluationError(`Unknown operator '${operator}'`)
  }
}

function evaluateOrdering(
  operator: 'gt' | 'lt' | 'gte' | 'lte',
  left: unknown,
  right: unknown,
): boolean {
  // Both must be numbers or both must be strings for ordering comparisons
  if (typeof left === 'number' && typeof right === 'number') {
    switch (operator) {
      case 'gt': return left > right
      case 'lt': return left < right
      case 'gte': return left >= right
      case 'lte': return left <= right
    }
  }

  if (typeof left === 'string' && typeof right === 'string') {
    switch (operator) {
      case 'gt': return left > right
      case 'lt': return left < right
      case 'gte': return left >= right
      case 'lte': return left <= right
    }
  }

  throw new EvaluationError(
    `Cannot compare ${typeLabel(left)} and ${typeLabel(right)} with '${operator}'. ` +
    `Both operands must be numbers or both must be strings.`,
  )
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
