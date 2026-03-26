/**
 * Expression Lexer (Tokenizer)
 *
 * Converts a condition string (with optional `{{ }}` delimiters) into a
 * flat token stream. Each token carries source-position info for error
 * reporting downstream.
 */

// ---------------------------------------------------------------------------
// Token Types
// ---------------------------------------------------------------------------

export type TokenType =
  | 'Identifier'
  | 'BooleanLiteral'
  | 'StringLiteral'
  | 'NumberLiteral'
  | 'Operator'
  | 'LeftParen'
  | 'RightParen'
  | 'Comma'
  | 'EOF'

/** Source position within the *inner* expression (after delimiter stripping). */
export interface SourcePosition {
  /** 0-based character offset */
  readonly offset: number
  /** 1-based column (same as offset + 1 since expressions are single-line) */
  readonly column: number
}

export interface Token {
  readonly type: TokenType
  readonly value: string
  readonly position: SourcePosition
}

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

/**
 * Error thrown when the lexer or parser encounters invalid input.
 * Carries source-position information for precise error messages.
 */
export class ParseError extends Error {
  readonly position: SourcePosition

  constructor(message: string, position: SourcePosition) {
    super(`${message} at column ${position.column}`)
    this.name = 'ParseError'
    this.position = position
  }
}

// ---------------------------------------------------------------------------
// Keyword sets
// ---------------------------------------------------------------------------

const OPERATORS = new Set([
  'and', 'or', 'not',
  'eq', 'neq', 'gt', 'lt', 'gte', 'lte',
  'in',
])

const BOOLEAN_LITERALS = new Set(['true', 'false'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') ||
         (ch >= 'A' && ch <= 'Z') ||
         ch === '_'
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}

function pos(offset: number): SourcePosition {
  return { offset, column: offset + 1 }
}

// ---------------------------------------------------------------------------
// Strip delimiters
// ---------------------------------------------------------------------------

/**
 * Remove the `{{ }}` Handlebars-style delimiters from a condition string.
 * Returns the inner content and the offset of the inner content within
 * the original string (so positions map back correctly).
 */
function stripDelimiters(input: string): { inner: string; offset: number } {
  const trimmed = input.trim()

  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    const openIdx = input.indexOf('{{')
    // +2 to skip past the opening {{
    const innerStart = openIdx + 2
    const closeIdx = input.lastIndexOf('}}')
    return {
      inner: input.slice(innerStart, closeIdx),
      offset: innerStart,
    }
  }

  // No delimiters — treat as raw expression
  return { inner: input, offset: 0 }
}

// ---------------------------------------------------------------------------
// Tokenize
// ---------------------------------------------------------------------------

/**
 * Tokenize a condition string into a flat token array.
 *
 * @param input - The condition string, optionally wrapped in `{{ }}`.
 * @returns An array of tokens ending with an `EOF` token.
 * @throws {ParseError} on unexpected characters or unterminated strings.
 */
export function tokenize(input: string): Token[] {
  const { inner } = stripDelimiters(input)
  const tokens: Token[] = []
  let i = 0

  while (i < inner.length) {
    const ch = inner[i]

    // Skip whitespace
    if (isWhitespace(ch)) {
      i++
      continue
    }

    // Single-quoted string literal
    if (ch === "'") {
      const start = i
      i++ // skip opening quote
      let value = ''
      while (i < inner.length && inner[i] !== "'") {
        value += inner[i]
        i++
      }
      if (i >= inner.length) {
        throw new ParseError('Unterminated string literal', pos(start))
      }
      i++ // skip closing quote
      tokens.push({ type: 'StringLiteral', value, position: pos(start) })
      continue
    }

    // Number literal
    if (isDigit(ch) || (ch === '-' && i + 1 < inner.length && isDigit(inner[i + 1]))) {
      const start = i
      if (ch === '-') i++ // consume negative sign
      while (i < inner.length && isDigit(inner[i])) i++
      // Decimal part
      if (i < inner.length && inner[i] === '.' && i + 1 < inner.length && isDigit(inner[i + 1])) {
        i++ // skip dot
        while (i < inner.length && isDigit(inner[i])) i++
      }
      tokens.push({ type: 'NumberLiteral', value: inner.slice(start, i), position: pos(start) })
      continue
    }

    // Identifiers, keywords, operators, boolean literals
    if (isIdentStart(ch)) {
      const start = i
      while (i < inner.length && isIdentChar(inner[i])) i++

      // Dotted variable paths: consume `.` followed by another identifier segment
      while (
        i < inner.length &&
        inner[i] === '.' &&
        i + 1 < inner.length &&
        isIdentStart(inner[i + 1])
      ) {
        i++ // skip the dot
        while (i < inner.length && isIdentChar(inner[i])) i++
      }

      const word = inner.slice(start, i)

      if (BOOLEAN_LITERALS.has(word)) {
        tokens.push({ type: 'BooleanLiteral', value: word, position: pos(start) })
      } else if (OPERATORS.has(word)) {
        tokens.push({ type: 'Operator', value: word, position: pos(start) })
      } else {
        tokens.push({ type: 'Identifier', value: word, position: pos(start) })
      }
      continue
    }

    // Parentheses
    if (ch === '(') {
      tokens.push({ type: 'LeftParen', value: '(', position: pos(i) })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'RightParen', value: ')', position: pos(i) })
      i++
      continue
    }

    // Comma
    if (ch === ',') {
      tokens.push({ type: 'Comma', value: ',', position: pos(i) })
      i++
      continue
    }

    // Symbolic comparison operators
    if (ch === '=' && i + 1 < inner.length && inner[i + 1] === '=') {
      tokens.push({ type: 'Operator', value: 'eq', position: pos(i) })
      i += 2
      continue
    }
    if (ch === '!' && i + 1 < inner.length && inner[i + 1] === '=') {
      tokens.push({ type: 'Operator', value: 'neq', position: pos(i) })
      i += 2
      continue
    }
    if (ch === '>') {
      if (i + 1 < inner.length && inner[i + 1] === '=') {
        tokens.push({ type: 'Operator', value: 'gte', position: pos(i) })
        i += 2
      } else {
        tokens.push({ type: 'Operator', value: 'gt', position: pos(i) })
        i += 1
      }
      continue
    }
    if (ch === '<') {
      if (i + 1 < inner.length && inner[i + 1] === '=') {
        tokens.push({ type: 'Operator', value: 'lte', position: pos(i) })
        i += 2
      } else {
        tokens.push({ type: 'Operator', value: 'lt', position: pos(i) })
        i += 1
      }
      continue
    }

    // Unknown character
    throw new ParseError(`Unexpected character '${ch}'`, pos(i))
  }

  tokens.push({ type: 'EOF', value: '', position: pos(i) })
  return tokens
}
