/**
 * Expression AST Node Definitions
 *
 * Typed AST nodes for parsed condition expressions from WorkflowDefinition
 * `branching[].condition` fields. Uses discriminated unions with a literal
 * `type` field for exhaustive pattern matching.
 */

// ---------------------------------------------------------------------------
// Literal Nodes
// ---------------------------------------------------------------------------

/** A reference to a named variable, e.g. `isParentIssue`, `priority` */
export interface VariableRef {
  readonly type: 'VariableRef'
  readonly name: string
}

/** A boolean literal: `true` or `false` */
export interface BooleanLiteral {
  readonly type: 'BooleanLiteral'
  readonly value: boolean
}

/** A single-quoted string literal, e.g. `'bug'` */
export interface StringLiteral {
  readonly type: 'StringLiteral'
  readonly value: string
}

/** A numeric literal, e.g. `3`, `2.5` */
export interface NumberLiteral {
  readonly type: 'NumberLiteral'
  readonly value: number
}

// ---------------------------------------------------------------------------
// Operator Nodes
// ---------------------------------------------------------------------------

/** Unary operators */
export type UnaryOperator = 'not'

/** Binary logical/comparison operators */
export type BinaryOperator =
  | 'and'
  | 'or'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'in'

/** A unary operation, e.g. `not <expr>` */
export interface UnaryOp {
  readonly type: 'UnaryOp'
  readonly operator: UnaryOperator
  readonly operand: ASTNode
}

/** A binary operation, e.g. `<expr> and <expr>`, `<expr> gt <expr>` */
export interface BinaryOp {
  readonly type: 'BinaryOp'
  readonly operator: BinaryOperator
  readonly left: ASTNode
  readonly right: ASTNode
}

// ---------------------------------------------------------------------------
// Function Call Node
// ---------------------------------------------------------------------------

/** A function call, e.g. `hasLabel('bug')`, `hasDirective('hotfix')` */
export interface FunctionCall {
  readonly type: 'FunctionCall'
  readonly name: string
  readonly args: ASTNode[]
}

// ---------------------------------------------------------------------------
// Union Type
// ---------------------------------------------------------------------------

/** Discriminated union of all AST node types */
export type ASTNode =
  | VariableRef
  | BooleanLiteral
  | StringLiteral
  | NumberLiteral
  | UnaryOp
  | BinaryOp
  | FunctionCall
