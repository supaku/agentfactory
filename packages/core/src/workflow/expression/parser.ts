/**
 * Expression Parser (Recursive Descent)
 *
 * Parses a token stream (produced by the lexer) into a typed AST.
 *
 * Operator precedence (lowest to highest):
 *   1. `or`
 *   2. `and`
 *   3. comparisons: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`
 *   4. `not` (unary prefix)
 *   5. primary: literals, variable refs, function calls, parenthesized exprs
 */

import type { ASTNode } from './ast.js'
import type { Token } from './lexer.js'
import { ParseError } from './lexer.js'

// ---------------------------------------------------------------------------
// Operator sets
// ---------------------------------------------------------------------------

const COMPARISON_OPERATORS = new Set(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in'])

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

/**
 * Immutable cursor over the token array. We use a simple index rather
 * than mutating the array so the parser stays pure-functional in spirit
 * (the index is the only mutable state and it is local to `parse`).
 */
interface ParserState {
  readonly tokens: readonly Token[]
  pos: number
}

function peek(state: ParserState): Token {
  return state.tokens[state.pos]
}

function advance(state: ParserState): Token {
  const token = state.tokens[state.pos]
  state.pos++
  return token
}

function expect(state: ParserState, type: Token['type'], value?: string): Token {
  const token = peek(state)
  if (token.type !== type || (value !== undefined && token.value !== value)) {
    const expected = value ? `'${value}'` : type
    const got = token.type === 'EOF' ? 'end of expression' : `'${token.value}'`
    throw new ParseError(`Expected ${expected} but got ${got}`, token.position)
  }
  return advance(state)
}

// ---------------------------------------------------------------------------
// Grammar rules
// ---------------------------------------------------------------------------

/**
 * expression := orExpr
 */
function parseExpression(state: ParserState): ASTNode {
  return parseOr(state)
}

/**
 * orExpr := andExpr ( 'or' andExpr )*
 */
function parseOr(state: ParserState): ASTNode {
  let left = parseAnd(state)
  while (peek(state).type === 'Operator' && peek(state).value === 'or') {
    advance(state) // consume 'or'
    const right = parseAnd(state)
    left = { type: 'BinaryOp', operator: 'or', left, right }
  }
  return left
}

/**
 * andExpr := comparisonExpr ( 'and' comparisonExpr )*
 */
function parseAnd(state: ParserState): ASTNode {
  let left = parseComparison(state)
  while (peek(state).type === 'Operator' && peek(state).value === 'and') {
    advance(state) // consume 'and'
    const right = parseComparison(state)
    left = { type: 'BinaryOp', operator: 'and', left, right }
  }
  return left
}

/**
 * comparisonExpr := unaryExpr ( ('eq'|'neq'|'gt'|'lt'|'gte'|'lte') unaryExpr )?
 *
 * Comparisons are non-associative (no chaining).
 */
function parseComparison(state: ParserState): ASTNode {
  let left = parseUnary(state)
  const token = peek(state)
  if (token.type === 'Operator' && COMPARISON_OPERATORS.has(token.value)) {
    const operator = advance(state).value as ASTNode extends never ? never : 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in'
    const right = parseUnary(state)
    left = { type: 'BinaryOp', operator, left, right }
  }
  return left
}

/**
 * unaryExpr := 'not' unaryExpr | primaryExpr
 */
function parseUnary(state: ParserState): ASTNode {
  const token = peek(state)
  if (token.type === 'Operator' && token.value === 'not') {
    advance(state) // consume 'not'
    const operand = parseUnary(state)
    return { type: 'UnaryOp', operator: 'not', operand }
  }
  return parsePrimary(state)
}

/**
 * primaryExpr := BooleanLiteral
 *              | StringLiteral
 *              | NumberLiteral
 *              | Identifier '(' argList? ')'   -- function call
 *              | Identifier                     -- variable ref
 *              | '(' expression ')'             -- grouped sub-expression
 */
function parsePrimary(state: ParserState): ASTNode {
  const token = peek(state)

  // Boolean literal
  if (token.type === 'BooleanLiteral') {
    advance(state)
    return { type: 'BooleanLiteral', value: token.value === 'true' }
  }

  // String literal
  if (token.type === 'StringLiteral') {
    advance(state)
    return { type: 'StringLiteral', value: token.value }
  }

  // Number literal
  if (token.type === 'NumberLiteral') {
    advance(state)
    return { type: 'NumberLiteral', value: Number(token.value) }
  }

  // Identifier — could be variable ref or function call
  if (token.type === 'Identifier') {
    advance(state)
    // Check for function call: Identifier '(' ...
    if (peek(state).type === 'LeftParen') {
      advance(state) // consume '('
      const args = parseArgList(state)
      expect(state, 'RightParen')
      return { type: 'FunctionCall', name: token.value, args }
    }
    return { type: 'VariableRef', name: token.value }
  }

  // Parenthesized sub-expression
  if (token.type === 'LeftParen') {
    advance(state) // consume '('
    const expr = parseExpression(state)
    expect(state, 'RightParen')
    return expr
  }

  // Error: unexpected token
  const got = token.type === 'EOF' ? 'end of expression' : `'${token.value}'`
  throw new ParseError(`Unexpected ${got}`, token.position)
}

/**
 * argList := expression ( ',' expression )*
 *          | (empty)
 */
function parseArgList(state: ParserState): ASTNode[] {
  const args: ASTNode[] = []
  if (peek(state).type === 'RightParen') {
    return args
  }
  args.push(parseExpression(state))
  while (peek(state).type === 'Comma') {
    advance(state) // consume ','
    args.push(parseExpression(state))
  }
  return args
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a token stream into an AST.
 *
 * @param tokens - Token array produced by `tokenize()`.
 * @returns The root AST node.
 * @throws {ParseError} on syntax errors.
 */
export function parse(tokens: Token[]): ASTNode {
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].type === 'EOF')) {
    throw new ParseError('Empty expression', { offset: 0, column: 1 })
  }

  const state: ParserState = { tokens, pos: 0 }
  const ast = parseExpression(state)

  // Ensure all tokens were consumed (except EOF)
  const remaining = peek(state)
  if (remaining.type !== 'EOF') {
    throw new ParseError(
      `Unexpected '${remaining.value}' after expression`,
      remaining.position,
    )
  }

  return ast
}
