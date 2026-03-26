import { describe, it, expect } from 'vitest'
import { evaluate, EvaluationError } from './evaluator.js'
import type { EvaluationContext } from './context.js'
import { buildEvaluationContext } from './context.js'
import { createBuiltinHelpers } from './helpers.js'
import { evaluateCondition, parseExpression } from './index.js'
import type { ASTNode } from './ast.js'
import type { GovernorIssue } from '../../governor/governor-types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal empty context for tests that don't need variables/functions. */
function emptyContext(): EvaluationContext {
  return { variables: {}, functions: {} }
}

/** Create a context with the given variables and optional functions. */
function ctx(
  variables: Record<string, unknown>,
  functions: Record<string, (...args: unknown[]) => unknown> = {},
): EvaluationContext {
  return { variables, functions }
}

/** Create a minimal GovernorIssue for testing. */
function makeIssue(overrides: Partial<GovernorIssue> = {}): GovernorIssue {
  return {
    id: 'issue-1',
    identifier: 'SUP-100',
    title: 'Test Issue',
    description: 'Some description with @hotfix directive',
    status: 'In Progress',
    labels: ['bug', 'priority-high'],
    createdAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Literal evaluation
// ---------------------------------------------------------------------------

describe('evaluate — literals', () => {
  it('returns boolean true for BooleanLiteral(true)', () => {
    const ast: ASTNode = { type: 'BooleanLiteral', value: true }
    expect(evaluate(ast, emptyContext())).toBe(true)
  })

  it('returns boolean false for BooleanLiteral(false)', () => {
    const ast: ASTNode = { type: 'BooleanLiteral', value: false }
    expect(evaluate(ast, emptyContext())).toBe(false)
  })

  it('returns the string for StringLiteral', () => {
    const ast: ASTNode = { type: 'StringLiteral', value: 'hello' }
    expect(evaluate(ast, emptyContext())).toBe('hello')
  })

  it('returns the number for NumberLiteral', () => {
    const ast: ASTNode = { type: 'NumberLiteral', value: 42 }
    expect(evaluate(ast, emptyContext())).toBe(42)
  })

  it('returns zero for NumberLiteral(0)', () => {
    const ast: ASTNode = { type: 'NumberLiteral', value: 0 }
    expect(evaluate(ast, emptyContext())).toBe(0)
  })

  it('returns empty string for StringLiteral("")', () => {
    const ast: ASTNode = { type: 'StringLiteral', value: '' }
    expect(evaluate(ast, emptyContext())).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2. Variable lookup
// ---------------------------------------------------------------------------

describe('evaluate — variable lookup', () => {
  it('returns the variable value when it exists', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'x' }
    expect(evaluate(ast, ctx({ x: 42 }))).toBe(42)
  })

  it('returns string variable value', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'status' }
    expect(evaluate(ast, ctx({ status: 'active' }))).toBe('active')
  })

  it('returns boolean variable value', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'isReady' }
    expect(evaluate(ast, ctx({ isReady: true }))).toBe(true)
  })

  it('returns false for undefined variables (no crash)', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'nonexistent' }
    expect(evaluate(ast, emptyContext())).toBe(false)
  })

  it('returns the actual value when variable is explicitly false', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'done' }
    expect(evaluate(ast, ctx({ done: false }))).toBe(false)
  })

  it('returns the actual value when variable is explicitly 0', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'count' }
    expect(evaluate(ast, ctx({ count: 0 }))).toBe(0)
  })

  it('returns the actual value when variable is null', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'data' }
    expect(evaluate(ast, ctx({ data: null }))).toBe(null)
  })

  it('resolves dotted variable path from nested context', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'trigger.data.issueId' }
    expect(evaluate(ast, ctx({ trigger: { data: { issueId: 'SUP-123' } } }))).toBe('SUP-123')
  })

  it('resolves two-level dotted path', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'steps.route.result' }
    expect(evaluate(ast, ctx({ steps: { route: { result: 'development' } } }))).toBe('development')
  })

  it('returns false for dotted path when intermediate is missing', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'trigger.data.issueId' }
    expect(evaluate(ast, ctx({}))).toBe(false)
  })

  it('returns false for dotted path when intermediate is null', () => {
    const ast: ASTNode = { type: 'VariableRef', name: 'trigger.data.issueId' }
    expect(evaluate(ast, ctx({ trigger: null }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Boolean operators
// ---------------------------------------------------------------------------

describe('evaluate — boolean operators', () => {
  describe('and', () => {
    it('returns right value when both sides are truthy', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'and',
        left: { type: 'BooleanLiteral', value: true },
        right: { type: 'BooleanLiteral', value: true },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns left falsy value (short-circuit)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'and',
        left: { type: 'BooleanLiteral', value: false },
        right: { type: 'BooleanLiteral', value: true },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('short-circuits — does not evaluate right side when left is falsy', () => {
      let rightEvaluated = false
      const context = ctx({}, {
        sideEffect: () => {
          rightEvaluated = true
          return true
        },
      })
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'and',
        left: { type: 'BooleanLiteral', value: false },
        right: { type: 'FunctionCall', name: 'sideEffect', args: [] },
      }
      evaluate(ast, context)
      expect(rightEvaluated).toBe(false)
    })

    it('evaluates right side when left is truthy', () => {
      let rightEvaluated = false
      const context = ctx({}, {
        sideEffect: () => {
          rightEvaluated = true
          return true
        },
      })
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'and',
        left: { type: 'BooleanLiteral', value: true },
        right: { type: 'FunctionCall', name: 'sideEffect', args: [] },
      }
      evaluate(ast, context)
      expect(rightEvaluated).toBe(true)
    })
  })

  describe('or', () => {
    it('returns left truthy value (short-circuit)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'or',
        left: { type: 'BooleanLiteral', value: true },
        right: { type: 'BooleanLiteral', value: false },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns right value when left is falsy', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'or',
        left: { type: 'BooleanLiteral', value: false },
        right: { type: 'BooleanLiteral', value: true },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('short-circuits — does not evaluate right side when left is truthy', () => {
      let rightEvaluated = false
      const context = ctx({}, {
        sideEffect: () => {
          rightEvaluated = true
          return false
        },
      })
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'or',
        left: { type: 'BooleanLiteral', value: true },
        right: { type: 'FunctionCall', name: 'sideEffect', args: [] },
      }
      evaluate(ast, context)
      expect(rightEvaluated).toBe(false)
    })

    it('returns false when both sides are falsy', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'or',
        left: { type: 'BooleanLiteral', value: false },
        right: { type: 'BooleanLiteral', value: false },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })
  })

  describe('not', () => {
    it('negates true to false', () => {
      const ast: ASTNode = {
        type: 'UnaryOp',
        operator: 'not',
        operand: { type: 'BooleanLiteral', value: true },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('negates false to true', () => {
      const ast: ASTNode = {
        type: 'UnaryOp',
        operator: 'not',
        operand: { type: 'BooleanLiteral', value: false },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('coerces truthy values before negating', () => {
      const ast: ASTNode = {
        type: 'UnaryOp',
        operator: 'not',
        operand: { type: 'StringLiteral', value: 'hello' },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('coerces falsy values before negating (empty string)', () => {
      const ast: ASTNode = {
        type: 'UnaryOp',
        operator: 'not',
        operand: { type: 'StringLiteral', value: '' },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('coerces falsy values before negating (0)', () => {
      const ast: ASTNode = {
        type: 'UnaryOp',
        operator: 'not',
        operand: { type: 'NumberLiteral', value: 0 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('double not returns original truthiness', () => {
      const ast: ASTNode = {
        type: 'UnaryOp',
        operator: 'not',
        operand: {
          type: 'UnaryOp',
          operator: 'not',
          operand: { type: 'BooleanLiteral', value: true },
        },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Comparisons
// ---------------------------------------------------------------------------

describe('evaluate — comparisons', () => {
  describe('eq', () => {
    it('returns true for equal numbers', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false for unequal numbers', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 3 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('returns true for equal strings', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'StringLiteral', value: 'active' },
        right: { type: 'StringLiteral', value: 'active' },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false for different types (strict equality)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'NumberLiteral', value: 0 },
        right: { type: 'BooleanLiteral', value: false },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('compares variable to string literal', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'eq',
        left: { type: 'VariableRef', name: 'status' },
        right: { type: 'StringLiteral', value: 'active' },
      }
      expect(evaluate(ast, ctx({ status: 'active' }))).toBe(true)
    })
  })

  describe('neq', () => {
    it('returns true for unequal values', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'neq',
        left: { type: 'StringLiteral', value: 'open' },
        right: { type: 'StringLiteral', value: 'closed' },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false for equal values', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'neq',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })
  })

  describe('gt', () => {
    it('returns true when left > right (numbers)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 3 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false when left <= right (numbers)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'NumberLiteral', value: 3 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('returns false when equal (numbers)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'NumberLiteral', value: 3 },
        right: { type: 'NumberLiteral', value: 3 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })

    it('works with string comparison', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gt',
        left: { type: 'StringLiteral', value: 'b' },
        right: { type: 'StringLiteral', value: 'a' },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })
  })

  describe('lt', () => {
    it('returns true when left < right (numbers)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'lt',
        left: { type: 'NumberLiteral', value: 2 },
        right: { type: 'NumberLiteral', value: 10 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false when left >= right (numbers)', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'lt',
        left: { type: 'NumberLiteral', value: 10 },
        right: { type: 'NumberLiteral', value: 2 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })
  })

  describe('gte', () => {
    it('returns true when left > right', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gte',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 3 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns true when left == right', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gte',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false when left < right', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'gte',
        left: { type: 'NumberLiteral', value: 3 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })
  })

  describe('lte', () => {
    it('returns true when left < right', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'lte',
        left: { type: 'NumberLiteral', value: 3 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns true when left == right', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'lte',
        left: { type: 'NumberLiteral', value: 5 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(true)
    })

    it('returns false when left > right', () => {
      const ast: ASTNode = {
        type: 'BinaryOp',
        operator: 'lte',
        left: { type: 'NumberLiteral', value: 7 },
        right: { type: 'NumberLiteral', value: 5 },
      }
      expect(evaluate(ast, emptyContext())).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// 4b. in operator
// ---------------------------------------------------------------------------

describe('evaluate — in operator', () => {
  it('returns true when value is in array', () => {
    const result = evaluateCondition("{{ 'bug' in labels }}", ctx({ labels: ['bug', 'enhancement'] }))
    expect(result).toBe(true)
  })

  it('returns false when value is not in array', () => {
    const result = evaluateCondition("{{ 'feature' in labels }}", ctx({ labels: ['bug', 'enhancement'] }))
    expect(result).toBe(false)
  })

  it('returns true for substring in string', () => {
    const result = evaluateCondition("{{ 'fix' in title }}", ctx({ title: 'Quick fix for bug' }))
    expect(result).toBe(true)
  })

  it('returns false when substring not in string', () => {
    const result = evaluateCondition("{{ 'hotfix' in title }}", ctx({ title: 'Quick fix for bug' }))
    expect(result).toBe(false)
  })

  it('throws for invalid right operand type', () => {
    expect(() => evaluateCondition("{{ 'x' in count }}", ctx({ count: 42 }))).toThrow(EvaluationError)
  })
})

// ---------------------------------------------------------------------------
// 5. Function calls
// ---------------------------------------------------------------------------

describe('evaluate — function calls', () => {
  it('calls a registered function with evaluated args', () => {
    const context = ctx({}, {
      add: (...args: unknown[]) => (args[0] as number) + (args[1] as number),
    })
    const ast: ASTNode = {
      type: 'FunctionCall',
      name: 'add',
      args: [
        { type: 'NumberLiteral', value: 2 },
        { type: 'NumberLiteral', value: 3 },
      ],
    }
    expect(evaluate(ast, context)).toBe(5)
  })

  it('calls a no-arg function', () => {
    const context = ctx({}, {
      getTrue: () => true,
    })
    const ast: ASTNode = {
      type: 'FunctionCall',
      name: 'getTrue',
      args: [],
    }
    expect(evaluate(ast, context)).toBe(true)
  })

  it('evaluates arguments before passing to function', () => {
    const context = ctx({ x: 10 }, {
      double: (...args: unknown[]) => (args[0] as number) * 2,
    })
    const ast: ASTNode = {
      type: 'FunctionCall',
      name: 'double',
      args: [{ type: 'VariableRef', name: 'x' }],
    }
    expect(evaluate(ast, context)).toBe(20)
  })

  it('throws EvaluationError for unknown function', () => {
    const ast: ASTNode = {
      type: 'FunctionCall',
      name: 'unknownFn',
      args: [],
    }
    expect(() => evaluate(ast, emptyContext())).toThrow(EvaluationError)
    expect(() => evaluate(ast, emptyContext())).toThrow(/Unknown function 'unknownFn'/)
  })

  it('includes available function names in error message', () => {
    const context = ctx({}, { hasLabel: () => true, hasDirective: () => false })
    const ast: ASTNode = {
      type: 'FunctionCall',
      name: 'unknownFn',
      args: [],
    }
    expect(() => evaluate(ast, context)).toThrow(/hasLabel/)
    expect(() => evaluate(ast, context)).toThrow(/hasDirective/)
  })
})

// ---------------------------------------------------------------------------
// 6. Built-in helpers
// ---------------------------------------------------------------------------

describe('built-in helpers', () => {
  describe('hasLabel', () => {
    it('returns true when the issue has the label', () => {
      const issue = makeIssue({ labels: ['bug', 'enhancement'] })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasLabel('bug')).toBe(true)
    })

    it('returns false when the issue does not have the label', () => {
      const issue = makeIssue({ labels: ['bug'] })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasLabel('feature')).toBe(false)
    })

    it('returns false for non-string argument', () => {
      const issue = makeIssue({ labels: ['bug'] })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasLabel(123)).toBe(false)
    })

    it('returns false when labels array is empty', () => {
      const issue = makeIssue({ labels: [] })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasLabel('bug')).toBe(false)
    })
  })

  describe('hasDirective', () => {
    it('returns true when description contains the directive', () => {
      const issue = makeIssue({ description: 'Please fix @hotfix this soon' })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasDirective('hotfix')).toBe(true)
    })

    it('returns false when description does not contain the directive', () => {
      const issue = makeIssue({ description: 'Just a regular description' })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasDirective('hotfix')).toBe(false)
    })

    it('returns false when description is undefined', () => {
      const issue = makeIssue({ description: undefined })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasDirective('hotfix')).toBe(false)
    })

    it('returns false for non-string argument', () => {
      const issue = makeIssue({ description: '@hotfix needed' })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasDirective(42)).toBe(false)
    })
  })

  describe('isParentIssue', () => {
    it('returns true when hasSubIssues is true', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { hasSubIssues: true })
      expect(helpers.isParentIssue()).toBe(true)
    })

    it('returns false when hasSubIssues is false', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { hasSubIssues: false })
      expect(helpers.isParentIssue()).toBe(false)
    })

    it('returns false when hasSubIssues is not specified', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.isParentIssue()).toBe(false)
    })
  })

  describe('hasSubIssues', () => {
    it('returns true when hasSubIssues is true', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { hasSubIssues: true })
      expect(helpers.hasSubIssues()).toBe(true)
    })

    it('returns false when hasSubIssues is false', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { hasSubIssues: false })
      expect(helpers.hasSubIssues()).toBe(false)
    })

    it('returns false when hasSubIssues is not specified', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasSubIssues()).toBe(false)
    })
  })

  describe('isAssignedToHuman', () => {
    it('returns true when isAssignedToHuman is true', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { isAssignedToHuman: true })
      expect(helpers.isAssignedToHuman()).toBe(true)
    })

    it('returns false when isAssignedToHuman is false', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { isAssignedToHuman: false })
      expect(helpers.isAssignedToHuman()).toBe(false)
    })

    it('returns false when isAssignedToHuman is not specified', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.isAssignedToHuman()).toBe(false)
    })
  })

  describe('hasBlockingIncomplete', () => {
    it('returns true when hasBlockingIncomplete is true', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { hasBlockingIncomplete: true })
      expect(helpers.hasBlockingIncomplete()).toBe(true)
    })

    it('returns false when hasBlockingIncomplete is false', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue, { hasBlockingIncomplete: false })
      expect(helpers.hasBlockingIncomplete()).toBe(false)
    })

    it('returns false when hasBlockingIncomplete is not specified', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.hasBlockingIncomplete()).toBe(false)
    })
  })

  describe('startsWith', () => {
    it('returns true when string starts with prefix', () => {
      const issue = makeIssue({ title: 'fix: resolve bug' })
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.startsWith('fix: resolve bug', 'fix')).toBe(true)
    })

    it('returns false when string does not start with prefix', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.startsWith('hello world', 'world')).toBe(false)
    })

    it('returns false for non-string arguments', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.startsWith(123, 'fix')).toBe(false)
    })
  })

  describe('contains', () => {
    it('returns true when string contains substring', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.contains('hello world', 'world')).toBe(true)
    })

    it('returns false when string does not contain substring', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.contains('hello world', 'foo')).toBe(false)
    })

    it('returns false for non-string arguments', () => {
      const issue = makeIssue()
      const helpers = createBuiltinHelpers(issue)
      expect(helpers.contains(42, 'test')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// 7. Complex expressions (end-to-end with evaluateCondition)
// ---------------------------------------------------------------------------

describe('evaluateCondition — end-to-end', () => {
  it('evaluates "{{ isParentIssue }}" with variable binding', () => {
    const context = ctx({ isParentIssue: true })
    expect(evaluateCondition('{{ isParentIssue }}', context)).toBe(true)
  })

  it('evaluates "{{ not isParentIssue }}" to false when isParentIssue is true', () => {
    const context = ctx({ isParentIssue: true })
    expect(evaluateCondition('{{ not isParentIssue }}', context)).toBe(false)
  })

  it('evaluates "{{ researchCompleted and not backlogCreationCompleted }}"', () => {
    const context = ctx({
      researchCompleted: true,
      backlogCreationCompleted: false,
    })
    expect(evaluateCondition('{{ researchCompleted and not backlogCreationCompleted }}', context)).toBe(true)
  })

  it('evaluates "{{ researchCompleted and not backlogCreationCompleted }}" when both true', () => {
    const context = ctx({
      researchCompleted: true,
      backlogCreationCompleted: true,
    })
    expect(evaluateCondition('{{ researchCompleted and not backlogCreationCompleted }}', context)).toBe(false)
  })

  it('evaluates "{{ hasLabel(\'bug\') and priority gt 3 }}"', () => {
    const context = ctx(
      { priority: 5 },
      { hasLabel: (...args: unknown[]) => args[0] === 'bug' },
    )
    expect(evaluateCondition("{{ hasLabel('bug') and priority gt 3 }}", context)).toBe(true)
  })

  it('evaluates "{{ hasLabel(\'bug\') or hasDirective(\'hotfix\') }}"', () => {
    const context = ctx(
      {},
      {
        hasLabel: (...args: unknown[]) => args[0] === 'bug',
        hasDirective: (...args: unknown[]) => args[0] === 'hotfix',
      },
    )
    expect(evaluateCondition("{{ hasLabel('bug') or hasDirective('hotfix') }}", context)).toBe(true)
  })

  it('evaluates complex nested expression with parentheses', () => {
    const context = ctx(
      { priority: 5 },
      {
        hasLabel: (...args: unknown[]) => args[0] === 'bug',
        hasDirective: () => false,
      },
    )
    expect(evaluateCondition(
      "{{ (hasLabel('bug') or hasDirective('hotfix')) and priority gt 2 }}",
      context,
    )).toBe(true)
  })

  it('evaluates expression without delimiters', () => {
    const context = ctx({ x: true })
    expect(evaluateCondition('x', context)).toBe(true)
  })

  it('coerces non-boolean results to boolean', () => {
    const context = ctx({ name: 'hello' })
    expect(evaluateCondition('{{ name }}', context)).toBe(true)
  })

  it('coerces falsy non-boolean results to false', () => {
    const context = ctx({ count: 0 })
    expect(evaluateCondition('{{ count }}', context)).toBe(false)
  })

  it('returns false for undefined variable in evaluateCondition', () => {
    expect(evaluateCondition('{{ unknownVar }}', emptyContext())).toBe(false)
  })

  it('evaluates "{{ status eq \'In Progress\' }}" with real context', () => {
    const issue = makeIssue({ status: 'In Progress' })
    const context = buildEvaluationContext(issue)
    expect(evaluateCondition("{{ status eq 'In Progress' }}", context)).toBe(true)
  })

  it('evaluates full workflow condition with built-in helpers', () => {
    const issue = makeIssue({
      labels: ['bug'],
      description: 'Something with @hotfix',
      status: 'Icebox',
    })
    const context = buildEvaluationContext(issue, { researchCompleted: true }, { hasSubIssues: false })
    expect(evaluateCondition("{{ hasLabel('bug') and researchCompleted }}", context)).toBe(true)
  })

  it('evaluates hasSubIssues() in condition', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasSubIssues: true })
    expect(evaluateCondition('{{ hasSubIssues() }}', context)).toBe(true)
  })

  it('evaluates isAssignedToHuman() in condition', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { isAssignedToHuman: true })
    expect(evaluateCondition('{{ isAssignedToHuman() }}', context)).toBe(true)
  })

  it('evaluates hasBlockingIncomplete() in condition', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasBlockingIncomplete: true })
    expect(evaluateCondition('{{ hasBlockingIncomplete() }}', context)).toBe(true)
  })

  it('evaluates dotted path expression end-to-end', () => {
    const context = ctx({ trigger: { data: { issueId: 'SUP-123' } } })
    expect(evaluateCondition("{{ trigger.data.issueId == 'SUP-123' }}", context)).toBe(true)
  })

  it('evaluates symbolic operators end-to-end', () => {
    const context = ctx({ priority: 5 })
    expect(evaluateCondition('{{ priority > 3 }}', context)).toBe(true)
  })

  it('evaluates startsWith() function in condition', () => {
    const context = ctx(
      { title: 'fix: resolve memory leak' },
      { startsWith: (...args: unknown[]) => typeof args[0] === 'string' && typeof args[1] === 'string' && (args[0] as string).startsWith(args[1] as string) },
    )
    expect(evaluateCondition("{{ startsWith(title, 'fix') }}", context)).toBe(true)
  })

  it('evaluates contains() function in condition', () => {
    const context = ctx(
      { description: 'This is a hotfix release' },
      { contains: (...args: unknown[]) => typeof args[0] === 'string' && typeof args[1] === 'string' && (args[0] as string).includes(args[1] as string) },
    )
    expect(evaluateCondition("{{ contains(description, 'hotfix') }}", context)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. Error cases
// ---------------------------------------------------------------------------

describe('evaluate — error cases', () => {
  it('throws EvaluationError on type mismatch in gt (number vs string)', () => {
    const ast: ASTNode = {
      type: 'BinaryOp',
      operator: 'gt',
      left: { type: 'NumberLiteral', value: 5 },
      right: { type: 'StringLiteral', value: 'hello' },
    }
    expect(() => evaluate(ast, emptyContext())).toThrow(EvaluationError)
    expect(() => evaluate(ast, emptyContext())).toThrow(/Cannot compare/)
  })

  it('throws EvaluationError on type mismatch in lt (boolean vs number)', () => {
    const ast: ASTNode = {
      type: 'BinaryOp',
      operator: 'lt',
      left: { type: 'BooleanLiteral', value: true },
      right: { type: 'NumberLiteral', value: 5 },
    }
    expect(() => evaluate(ast, emptyContext())).toThrow(EvaluationError)
    expect(() => evaluate(ast, emptyContext())).toThrow(/Cannot compare/)
  })

  it('throws EvaluationError on type mismatch in gte', () => {
    const ast: ASTNode = {
      type: 'BinaryOp',
      operator: 'gte',
      left: { type: 'StringLiteral', value: 'a' },
      right: { type: 'NumberLiteral', value: 1 },
    }
    expect(() => evaluate(ast, emptyContext())).toThrow(EvaluationError)
  })

  it('throws EvaluationError on type mismatch in lte', () => {
    const ast: ASTNode = {
      type: 'BinaryOp',
      operator: 'lte',
      left: { type: 'BooleanLiteral', value: false },
      right: { type: 'StringLiteral', value: 'z' },
    }
    expect(() => evaluate(ast, emptyContext())).toThrow(EvaluationError)
  })

  it('error message includes type information', () => {
    const ast: ASTNode = {
      type: 'BinaryOp',
      operator: 'gt',
      left: { type: 'NumberLiteral', value: 5 },
      right: { type: 'StringLiteral', value: 'hello' },
    }
    try {
      evaluate(ast, emptyContext())
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluationError)
      const evalErr = err as EvaluationError
      expect(evalErr.message).toMatch(/number/)
      expect(evalErr.message).toMatch(/string/)
    }
  })

  it('EvaluationError has correct name property', () => {
    const err = new EvaluationError('test')
    expect(err.name).toBe('EvaluationError')
    expect(err).toBeInstanceOf(Error)
  })

  it('unknown function error includes "(none)" when no functions registered', () => {
    const ast: ASTNode = {
      type: 'FunctionCall',
      name: 'missing',
      args: [],
    }
    expect(() => evaluate(ast, emptyContext())).toThrow('(none)')
  })
})

// ---------------------------------------------------------------------------
// 9. Context builder
// ---------------------------------------------------------------------------

describe('buildEvaluationContext', () => {
  it('sets isParentIssue to true when hasSubIssues is true', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasSubIssues: true })
    expect(context.variables.isParentIssue).toBe(true)
  })

  it('sets isParentIssue to false when hasSubIssues is false', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasSubIssues: false })
    expect(context.variables.isParentIssue).toBe(false)
  })

  it('sets isParentIssue to false by default', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue)
    expect(context.variables.isParentIssue).toBe(false)
  })

  it('sets labels from issue', () => {
    const issue = makeIssue({ labels: ['bug', 'urgent'] })
    const context = buildEvaluationContext(issue)
    expect(context.variables.labels).toEqual(['bug', 'urgent'])
  })

  it('sets status from issue', () => {
    const issue = makeIssue({ status: 'In Progress' })
    const context = buildEvaluationContext(issue)
    expect(context.variables.status).toBe('In Progress')
  })

  it('sets priority to default of 0', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue)
    expect(context.variables.priority).toBe(0)
  })

  it('merges phaseState variables', () => {
    const issue = makeIssue()
    const phaseState = {
      researchCompleted: true,
      backlogCreationCompleted: false,
    }
    const context = buildEvaluationContext(issue, phaseState)
    expect(context.variables.researchCompleted).toBe(true)
    expect(context.variables.backlogCreationCompleted).toBe(false)
  })

  it('registers hasLabel function', () => {
    const issue = makeIssue({ labels: ['bug'] })
    const context = buildEvaluationContext(issue)
    expect(context.functions.hasLabel).toBeDefined()
    expect(context.functions.hasLabel('bug')).toBe(true)
    expect(context.functions.hasLabel('feature')).toBe(false)
  })

  it('registers hasDirective function', () => {
    const issue = makeIssue({ description: 'Fix @hotfix this' })
    const context = buildEvaluationContext(issue)
    expect(context.functions.hasDirective).toBeDefined()
    expect(context.functions.hasDirective('hotfix')).toBe(true)
    expect(context.functions.hasDirective('skipci')).toBe(false)
  })

  it('registers isParentIssue function', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasSubIssues: true })
    expect(context.functions.isParentIssue).toBeDefined()
    expect(context.functions.isParentIssue()).toBe(true)
  })

  it('registers hasSubIssues function', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasSubIssues: true })
    expect(context.functions.hasSubIssues).toBeDefined()
    expect(context.functions.hasSubIssues()).toBe(true)
  })

  it('registers isAssignedToHuman function', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { isAssignedToHuman: true })
    expect(context.functions.isAssignedToHuman).toBeDefined()
    expect(context.functions.isAssignedToHuman()).toBe(true)
  })

  it('registers hasBlockingIncomplete function', () => {
    const issue = makeIssue()
    const context = buildEvaluationContext(issue, undefined, { hasBlockingIncomplete: true })
    expect(context.functions.hasBlockingIncomplete).toBeDefined()
    expect(context.functions.hasBlockingIncomplete()).toBe(true)
  })

  it('works end-to-end with evaluateCondition', () => {
    const issue = makeIssue({
      labels: ['bug', 'priority-high'],
      status: 'Icebox',
      description: 'Needs @hotfix urgently',
    })
    const context = buildEvaluationContext(
      issue,
      { researchCompleted: true },
      { hasSubIssues: false },
    )

    expect(evaluateCondition("{{ hasLabel('bug') }}", context)).toBe(true)
    expect(evaluateCondition("{{ hasLabel('feature') }}", context)).toBe(false)
    expect(evaluateCondition("{{ hasDirective('hotfix') }}", context)).toBe(true)
    expect(evaluateCondition("{{ isParentIssue() }}", context)).toBe(false)
    expect(evaluateCondition("{{ status eq 'Icebox' }}", context)).toBe(true)
    expect(evaluateCondition('{{ researchCompleted }}', context)).toBe(true)
    expect(evaluateCondition("{{ hasLabel('bug') and researchCompleted }}", context)).toBe(true)
  })
})
