import { describe, it, expect } from 'vitest'
import { parseExpression, tokenize, parse, ParseError, interpolateTemplate } from './index.js'
import type { ASTNode, Token } from './index.js'

// ---------------------------------------------------------------------------
// Lexer tests
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('strips {{ }} delimiters', () => {
    const tokens = tokenize('{{ isParentIssue }}')
    expect(tokens).toHaveLength(2) // Identifier + EOF
    expect(tokens[0].type).toBe('Identifier')
    expect(tokens[0].value).toBe('isParentIssue')
  })

  it('handles input without delimiters', () => {
    const tokens = tokenize('isParentIssue')
    expect(tokens[0].type).toBe('Identifier')
    expect(tokens[0].value).toBe('isParentIssue')
  })

  it('tokenizes boolean literals', () => {
    const tokens = tokenize('{{ true }}')
    expect(tokens[0].type).toBe('BooleanLiteral')
    expect(tokens[0].value).toBe('true')
  })

  it('tokenizes string literals', () => {
    const tokens = tokenize("{{ 'bug' }}")
    expect(tokens[0].type).toBe('StringLiteral')
    expect(tokens[0].value).toBe('bug')
  })

  it('tokenizes number literals', () => {
    const tokens = tokenize('{{ 42 }}')
    expect(tokens[0].type).toBe('NumberLiteral')
    expect(tokens[0].value).toBe('42')
  })

  it('tokenizes decimal numbers', () => {
    const tokens = tokenize('{{ 2.5 }}')
    expect(tokens[0].type).toBe('NumberLiteral')
    expect(tokens[0].value).toBe('2.5')
  })

  it('tokenizes operators as Operator tokens', () => {
    const tokens = tokenize('{{ and or not eq neq gt lt gte lte }}')
    const ops = tokens.filter((t: Token) => t.type === 'Operator')
    expect(ops.map((t: Token) => t.value)).toEqual([
      'and', 'or', 'not', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte',
    ])
  })

  it('tokenizes parentheses and commas', () => {
    const tokens = tokenize("{{ hasLabel('bug', 'feat') }}")
    const types = tokens.map((t: Token) => t.type)
    expect(types).toEqual([
      'Identifier', 'LeftParen', 'StringLiteral', 'Comma', 'StringLiteral', 'RightParen', 'EOF',
    ])
  })

  it('includes position information on tokens', () => {
    const tokens = tokenize('{{ abc }}')
    // inner string is " abc ", so 'abc' starts at offset 1
    expect(tokens[0].position.offset).toBeGreaterThanOrEqual(0)
    expect(tokens[0].position.column).toBeGreaterThanOrEqual(1)
  })

  it('throws ParseError on unterminated string', () => {
    expect(() => tokenize("{{ 'unterminated }}")).toThrow(ParseError)
    expect(() => tokenize("{{ 'unterminated }}")).toThrow(/Unterminated string/)
  })

  it('throws ParseError on unexpected character', () => {
    expect(() => tokenize('{{ @ }}')).toThrow(ParseError)
    expect(() => tokenize('{{ @ }}')).toThrow(/Unexpected character/)
  })

  it('always ends with EOF token', () => {
    const tokens = tokenize('{{ x }}')
    expect(tokens[tokens.length - 1].type).toBe('EOF')
  })

  it('tokenizes dotted variable path as single Identifier', () => {
    const tokens = tokenize('{{ trigger.data.issueId }}')
    const nonEof = tokens.filter((t: Token) => t.type !== 'EOF')
    expect(nonEof).toHaveLength(1)
    expect(nonEof[0].type).toBe('Identifier')
    expect(nonEof[0].value).toBe('trigger.data.issueId')
  })

  it('tokenizes symbolic operators == != > < >= <=', () => {
    const cases: Array<{ input: string; expected: string }> = [
      { input: '{{ x == y }}', expected: 'eq' },
      { input: '{{ x != y }}', expected: 'neq' },
      { input: '{{ x > y }}', expected: 'gt' },
      { input: '{{ x < y }}', expected: 'lt' },
      { input: '{{ x >= y }}', expected: 'gte' },
      { input: '{{ x <= y }}', expected: 'lte' },
    ]
    for (const { input, expected } of cases) {
      const tokens = tokenize(input)
      const ops = tokens.filter((t: Token) => t.type === 'Operator')
      expect(ops).toHaveLength(1)
      expect(ops[0].value).toBe(expected)
    }
  })

  it('tokenizes mixed symbolic and keyword operators', () => {
    const tokens = tokenize('{{ x == 5 and y > 3 }}')
    const types = tokens.map((t: Token) => `${t.type}:${t.value}`)
    expect(types).toEqual([
      'Identifier:x',
      'Operator:eq',
      'NumberLiteral:5',
      'Operator:and',
      'Identifier:y',
      'Operator:gt',
      'NumberLiteral:3',
      'EOF:',
    ])
  })
})

// ---------------------------------------------------------------------------
// Parser tests — simple expressions
// ---------------------------------------------------------------------------

describe('parseExpression', () => {
  describe('simple variable reference', () => {
    it('parses a single identifier', () => {
      const ast = parseExpression('{{ isParentIssue }}')
      expect(ast).toEqual({
        type: 'VariableRef',
        name: 'isParentIssue',
      })
    })
  })

  describe('boolean literals', () => {
    it('parses true', () => {
      const ast = parseExpression('{{ true }}')
      expect(ast).toEqual({
        type: 'BooleanLiteral',
        value: true,
      })
    })

    it('parses false', () => {
      const ast = parseExpression('{{ false }}')
      expect(ast).toEqual({
        type: 'BooleanLiteral',
        value: false,
      })
    })
  })

  describe('string literals', () => {
    it('parses a quoted string', () => {
      const ast = parseExpression("{{ 'hello' }}")
      expect(ast).toEqual({
        type: 'StringLiteral',
        value: 'hello',
      })
    })
  })

  describe('number literals', () => {
    it('parses an integer', () => {
      const ast = parseExpression('{{ 42 }}')
      expect(ast).toEqual({
        type: 'NumberLiteral',
        value: 42,
      })
    })

    it('parses a decimal', () => {
      const ast = parseExpression('{{ 3.14 }}')
      expect(ast).toEqual({
        type: 'NumberLiteral',
        value: 3.14,
      })
    })
  })

  // -------------------------------------------------------------------------
  // Boolean operators
  // -------------------------------------------------------------------------

  describe('boolean operators', () => {
    it('parses and', () => {
      const ast = parseExpression('{{ a and b }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: { type: 'VariableRef', name: 'a' },
        right: { type: 'VariableRef', name: 'b' },
      })
    })

    it('parses or', () => {
      const ast = parseExpression('{{ a or b }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'or',
        left: { type: 'VariableRef', name: 'a' },
        right: { type: 'VariableRef', name: 'b' },
      })
    })

    it('parses not (unary)', () => {
      const ast = parseExpression('{{ not x }}')
      expect(ast).toEqual({
        type: 'UnaryOp',
        operator: 'not',
        operand: { type: 'VariableRef', name: 'x' },
      })
    })

    it('parses "researchCompleted and not backlogCreationCompleted"', () => {
      const ast = parseExpression('{{ researchCompleted and not backlogCreationCompleted }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: { type: 'VariableRef', name: 'researchCompleted' },
        right: {
          type: 'UnaryOp',
          operator: 'not',
          operand: { type: 'VariableRef', name: 'backlogCreationCompleted' },
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Comparison operators
  // -------------------------------------------------------------------------

  describe('comparison operators', () => {
    it('parses gt', () => {
      const ast = parseExpression('{{ priority gt 3 }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'VariableRef', name: 'priority' },
        right: { type: 'NumberLiteral', value: 3 },
      })
    })

    it('parses eq', () => {
      const ast = parseExpression("{{ status eq 'active' }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'VariableRef', name: 'status' },
        right: { type: 'StringLiteral', value: 'active' },
      })
    })

    it('parses neq', () => {
      const ast = parseExpression("{{ status neq 'closed' }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'neq',
        left: { type: 'VariableRef', name: 'status' },
        right: { type: 'StringLiteral', value: 'closed' },
      })
    })

    it('parses lt', () => {
      const ast = parseExpression('{{ count lt 10 }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'lt',
        left: { type: 'VariableRef', name: 'count' },
        right: { type: 'NumberLiteral', value: 10 },
      })
    })

    it('parses gte', () => {
      const ast = parseExpression('{{ score gte 80 }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'gte',
        left: { type: 'VariableRef', name: 'score' },
        right: { type: 'NumberLiteral', value: 80 },
      })
    })

    it('parses lte', () => {
      const ast = parseExpression('{{ age lte 5 }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'lte',
        left: { type: 'VariableRef', name: 'age' },
        right: { type: 'NumberLiteral', value: 5 },
      })
    })

    it('parses in', () => {
      const ast = parseExpression("{{ 'bug' in labels }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'in',
        left: { type: 'StringLiteral', value: 'bug' },
        right: { type: 'VariableRef', name: 'labels' },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Dotted variable paths
  // -------------------------------------------------------------------------

  describe('dotted variable paths', () => {
    it('parses dotted variable reference', () => {
      const ast = parseExpression('{{ trigger.data.issueId }}')
      expect(ast).toEqual({
        type: 'VariableRef',
        name: 'trigger.data.issueId',
      })
    })

    it('parses dotted path with symbolic comparison', () => {
      const ast = parseExpression('{{ trigger.data.priority > 3 }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'VariableRef', name: 'trigger.data.priority' },
        right: { type: 'NumberLiteral', value: 3 },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Symbolic operators
  // -------------------------------------------------------------------------

  describe('symbolic operators', () => {
    it('parses expression with symbolic == operator', () => {
      const ast = parseExpression("{{ status == 'active' }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'VariableRef', name: 'status' },
        right: { type: 'StringLiteral', value: 'active' },
      })
    })

    it('parses expression with symbolic != operator', () => {
      const ast = parseExpression("{{ status != 'closed' }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'neq',
        left: { type: 'VariableRef', name: 'status' },
        right: { type: 'StringLiteral', value: 'closed' },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Function calls
  // -------------------------------------------------------------------------

  describe('function calls', () => {
    it('parses a function call with one string arg', () => {
      const ast = parseExpression("{{ hasLabel('bug') }}")
      expect(ast).toEqual({
        type: 'FunctionCall',
        name: 'hasLabel',
        args: [{ type: 'StringLiteral', value: 'bug' }],
      })
    })

    it('parses a function call with no args', () => {
      const ast = parseExpression('{{ isEmpty() }}')
      expect(ast).toEqual({
        type: 'FunctionCall',
        name: 'isEmpty',
        args: [],
      })
    })

    it('parses a function call with multiple args', () => {
      const ast = parseExpression("{{ hasAny('bug', 'feat') }}")
      expect(ast).toEqual({
        type: 'FunctionCall',
        name: 'hasAny',
        args: [
          { type: 'StringLiteral', value: 'bug' },
          { type: 'StringLiteral', value: 'feat' },
        ],
      })
    })

    it('parses hasDirective function call', () => {
      const ast = parseExpression("{{ hasDirective('hotfix') }}")
      expect(ast).toEqual({
        type: 'FunctionCall',
        name: 'hasDirective',
        args: [{ type: 'StringLiteral', value: 'hotfix' }],
      })
    })
  })

  // -------------------------------------------------------------------------
  // Operator precedence
  // -------------------------------------------------------------------------

  describe('operator precedence', () => {
    it('not binds tighter than and', () => {
      // "not a and b" should parse as "(not a) and b"
      const ast = parseExpression('{{ not a and b }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: {
          type: 'UnaryOp',
          operator: 'not',
          operand: { type: 'VariableRef', name: 'a' },
        },
        right: { type: 'VariableRef', name: 'b' },
      })
    })

    it('and binds tighter than or', () => {
      // "a or b and c" should parse as "a or (b and c)"
      const ast = parseExpression('{{ a or b and c }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'or',
        left: { type: 'VariableRef', name: 'a' },
        right: {
          type: 'BinaryOp',
          operator: 'and',
          left: { type: 'VariableRef', name: 'b' },
          right: { type: 'VariableRef', name: 'c' },
        },
      })
    })

    it('comparison binds tighter than and', () => {
      // "a gt 3 and b" should parse as "(a gt 3) and b"
      const ast = parseExpression('{{ a gt 3 and b }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: {
          type: 'BinaryOp',
          operator: 'gt',
          left: { type: 'VariableRef', name: 'a' },
          right: { type: 'NumberLiteral', value: 3 },
        },
        right: { type: 'VariableRef', name: 'b' },
      })
    })

    it('parentheses override precedence', () => {
      // "(a or b) and c" should group the or first
      const ast = parseExpression('{{ (a or b) and c }}')
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: {
          type: 'BinaryOp',
          operator: 'or',
          left: { type: 'VariableRef', name: 'a' },
          right: { type: 'VariableRef', name: 'b' },
        },
        right: { type: 'VariableRef', name: 'c' },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Complex nested expressions
  // -------------------------------------------------------------------------

  describe('complex nested expressions', () => {
    it('parses "(hasLabel(\'bug\') or hasDirective(\'hotfix\')) and priority gt 2"', () => {
      const ast = parseExpression("{{ (hasLabel('bug') or hasDirective('hotfix')) and priority gt 2 }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: {
          type: 'BinaryOp',
          operator: 'or',
          left: {
            type: 'FunctionCall',
            name: 'hasLabel',
            args: [{ type: 'StringLiteral', value: 'bug' }],
          },
          right: {
            type: 'FunctionCall',
            name: 'hasDirective',
            args: [{ type: 'StringLiteral', value: 'hotfix' }],
          },
        },
        right: {
          type: 'BinaryOp',
          operator: 'gt',
          left: { type: 'VariableRef', name: 'priority' },
          right: { type: 'NumberLiteral', value: 2 },
        },
      })
    })

    it('parses "hasLabel(\'bug\') or hasDirective(\'hotfix\')"', () => {
      const ast = parseExpression("{{ hasLabel('bug') or hasDirective('hotfix') }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'or',
        left: {
          type: 'FunctionCall',
          name: 'hasLabel',
          args: [{ type: 'StringLiteral', value: 'bug' }],
        },
        right: {
          type: 'FunctionCall',
          name: 'hasDirective',
          args: [{ type: 'StringLiteral', value: 'hotfix' }],
        },
      })
    })

    it('parses double not', () => {
      const ast = parseExpression('{{ not not x }}')
      expect(ast).toEqual({
        type: 'UnaryOp',
        operator: 'not',
        operand: {
          type: 'UnaryOp',
          operator: 'not',
          operand: { type: 'VariableRef', name: 'x' },
        },
      })
    })

    it('parses chained and', () => {
      const ast = parseExpression('{{ a and b and c }}')
      // Left-associative: (a and b) and c
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: {
          type: 'BinaryOp',
          operator: 'and',
          left: { type: 'VariableRef', name: 'a' },
          right: { type: 'VariableRef', name: 'b' },
        },
        right: { type: 'VariableRef', name: 'c' },
      })
    })

    it('parses chained or', () => {
      const ast = parseExpression('{{ a or b or c }}')
      // Left-associative: (a or b) or c
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'or',
        left: {
          type: 'BinaryOp',
          operator: 'or',
          left: { type: 'VariableRef', name: 'a' },
          right: { type: 'VariableRef', name: 'b' },
        },
        right: { type: 'VariableRef', name: 'c' },
      })
    })

    it('parses function call as argument to comparison', () => {
      const ast = parseExpression("{{ count() gt 3 }}")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'FunctionCall', name: 'count', args: [] },
        right: { type: 'NumberLiteral', value: 3 },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe('error cases', () => {
    it('throws on empty expression "{{ }}"', () => {
      expect(() => parseExpression('{{ }}')).toThrow(ParseError)
      expect(() => parseExpression('{{ }}')).toThrow(/Empty expression/)
    })

    it('throws on leading operator "{{ and }}"', () => {
      expect(() => parseExpression('{{ and }}')).toThrow(ParseError)
    })

    it('throws on unclosed parenthesis "{{ hasLabel( }}"', () => {
      expect(() => parseExpression("{{ hasLabel( }}")).toThrow(ParseError)
    })

    it('throws on unclosed parenthesized expression', () => {
      expect(() => parseExpression('{{ (a or b }}')).toThrow(ParseError)
    })

    it('throws on trailing operator "{{ a and }}"', () => {
      expect(() => parseExpression('{{ a and }}')).toThrow(ParseError)
    })

    it('throws on unexpected token after expression', () => {
      expect(() => parseExpression('{{ a b }}')).toThrow(ParseError)
      expect(() => parseExpression('{{ a b }}')).toThrow(/Unexpected/)
    })

    it('error includes position information', () => {
      try {
        parseExpression('{{ and }}')
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ParseError)
        const parseErr = err as ParseError
        expect(parseErr.position).toBeDefined()
        expect(parseErr.position.column).toBeGreaterThanOrEqual(1)
        expect(parseErr.message).toMatch(/column/)
      }
    })

    it('throws on completely empty string', () => {
      expect(() => parseExpression('')).toThrow(ParseError)
    })

    it('throws on only whitespace', () => {
      expect(() => parseExpression('   ')).toThrow(ParseError)
    })
  })

  // -------------------------------------------------------------------------
  // Input without delimiters
  // -------------------------------------------------------------------------

  describe('input without delimiters', () => {
    it('parses raw expression without {{ }}', () => {
      const ast = parseExpression('isParentIssue')
      expect(ast).toEqual({
        type: 'VariableRef',
        name: 'isParentIssue',
      })
    })

    it('parses complex expression without delimiters', () => {
      const ast = parseExpression("hasLabel('bug') and priority gt 3")
      expect(ast).toEqual({
        type: 'BinaryOp',
        operator: 'and',
        left: {
          type: 'FunctionCall',
          name: 'hasLabel',
          args: [{ type: 'StringLiteral', value: 'bug' }],
        },
        right: {
          type: 'BinaryOp',
          operator: 'gt',
          left: { type: 'VariableRef', name: 'priority' },
          right: { type: 'NumberLiteral', value: 3 },
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // parse() function directly
  // -------------------------------------------------------------------------

  describe('parse() with token array', () => {
    it('accepts tokenized output directly', () => {
      const tokens = tokenize('{{ x }}')
      const ast = parse(tokens)
      expect(ast).toEqual({ type: 'VariableRef', name: 'x' })
    })
  })
})

// ---------------------------------------------------------------------------
// Template interpolation tests
// ---------------------------------------------------------------------------

describe('interpolateTemplate', () => {
  /** Create a context with the given variables and optional functions. */
  function ctx(
    variables: Record<string, unknown>,
    functions: Record<string, (...args: unknown[]) => unknown> = {},
  ): import('./index.js').EvaluationContext {
    return { variables, functions }
  }

  it('resolves a single expression', () => {
    const result = interpolateTemplate(
      'Issue {{ issueId }} is ready',
      ctx({ issueId: 'SUP-123' }),
    )
    expect(result).toBe('Issue SUP-123 is ready')
  })

  it('resolves multiple expressions', () => {
    const result = interpolateTemplate(
      '{{ name }} has {{ count }} items',
      ctx({ name: 'Alice', count: 5 }),
    )
    expect(result).toBe('Alice has 5 items')
  })

  it('resolves dotted path expressions', () => {
    const result = interpolateTemplate(
      'Issue {{ trigger.data.issueId }} is ready',
      ctx({ trigger: { data: { issueId: 'SUP-123' } } }),
    )
    expect(result).toBe('Issue SUP-123 is ready')
  })

  it('coerces boolean to string', () => {
    const result = interpolateTemplate(
      'Result: {{ active }}',
      ctx({ active: true }),
    )
    expect(result).toBe('Result: true')
  })

  it('coerces number to string', () => {
    const result = interpolateTemplate(
      'Count: {{ count }}',
      ctx({ count: 42 }),
    )
    expect(result).toBe('Count: 42')
  })

  it('passes through static string without expressions', () => {
    const result = interpolateTemplate('No expressions here', ctx({}))
    expect(result).toBe('No expressions here')
  })

  it('resolves expression-only template', () => {
    const result = interpolateTemplate('{{ status }}', ctx({ status: 'In Progress' }))
    expect(result).toBe('In Progress')
  })

  it('resolves function calls in template', () => {
    const result = interpolateTemplate(
      'Has bug: {{ hasLabel(\'bug\') }}',
      ctx({}, { hasLabel: (...args: unknown[]) => args[0] === 'bug' }),
    )
    expect(result).toBe('Has bug: true')
  })

  it('throws ParseError on empty expression', () => {
    expect(() => interpolateTemplate('Hello {{  }}', ctx({}))).toThrow(ParseError)
    expect(() => interpolateTemplate('Hello {{  }}', ctx({}))).toThrow(/Empty expression/)
  })

  it('resolves false for undefined variables', () => {
    const result = interpolateTemplate(
      'Value: {{ missing }}',
      ctx({}),
    )
    expect(result).toBe('Value: false')
  })
})
