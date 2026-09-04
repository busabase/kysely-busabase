import {
  all,
  any,
  type ComparisonOperator,
  type CompiledWhere,
  comparison,
  finalize,
  isEmpty,
  isNotEmpty,
  matchesPattern,
  negate,
  oneOf,
  type PredicateNode,
  UnsupportedWhereError,
} from "busabase-orm-core";
import type { OperationNode } from "kysely";

/**
 * Walking Kysely's `where` into the shared predicate builders.
 *
 * Kysely hands over a real, documented AST — every node carries a `kind`, and
 * columns and values arrive as `ReferenceNode` / `ValueNode` rather than as
 * text. So this file is a `switch` on `kind`, and nothing more: what a
 * comparison means, whether the server can decide it, and how NULL behaves all
 * live in `busabase-orm-core`, shared with the drizzle driver.
 *
 * Shapes below were read off kysely 0.29 by instrumenting a QueryCompiler, not
 * guessed:
 *
 *   =/>/<     BinaryOperationNode{leftOperand: ReferenceNode, operator: OperatorNode, rightOperand: ValueNode}
 *   in        rightOperand is a PrimitiveValueListNode{values}
 *   is null   operator "is" with a ValueNode holding null
 *   and/or    AndNode/OrNode{left, right}  — binary, not a flat list
 *   parens    ParensNode{node}
 */

interface Node {
  kind: string;
  [key: string]: unknown;
}

const is = (node: unknown, kind: string): node is Node =>
  typeof node === "object" && node !== null && (node as Node).kind === kind;

/** `ReferenceNode → ColumnNode → IdentifierNode.name`. */
const columnName = (node: unknown): string | null => {
  if (!is(node, "ReferenceNode")) return null;
  const column = node.column;
  if (!is(column, "ColumnNode")) return null;
  const identifier = (column as Node).column;
  if (!is(identifier, "IdentifierNode")) return null;
  return typeof identifier.name === "string" ? identifier.name : null;
};

const literal = (node: unknown): { ok: true; value: unknown } | { ok: false } =>
  is(node, "ValueNode") ? { ok: true, value: node.value } : { ok: false };

/**
 * Kysely normalises `!=` and `<>` to the same meaning, and spells IS NULL as an
 * `is` comparison against a null value.
 */
const COMPARISONS: Record<string, ComparisonOperator> = {
  "=": "eq",
  "==": "eq",
  "!=": "ne",
  "<>": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

export const compileWhere = (where: OperationNode | undefined): CompiledWhere =>
  finalize(where ? walk(where) : undefined);

const walk = (node: OperationNode): PredicateNode => {
  if (is(node, "WhereNode")) return walk(node.where as OperationNode);
  if (is(node, "ParensNode")) return walk(node.node as OperationNode);
  if (is(node, "AndNode")) {
    return all([walk(node.left as OperationNode), walk(node.right as OperationNode)]);
  }
  if (is(node, "OrNode")) {
    return any([walk(node.left as OperationNode), walk(node.right as OperationNode)]);
  }
  if (is(node, "UnaryOperationNode")) {
    const operator = operatorText(node.operator);
    if (operator === "not") return negate(walk(node.operand as OperationNode));
    throw new UnsupportedWhereError(`unary operator \`${operator ?? "?"}\` has no translation`);
  }
  if (is(node, "BinaryOperationNode")) return walkBinary(node);

  throw new UnsupportedWhereError(
    `\`${(node as Node).kind}\` has no Busabase translation — raw sql and expressions are not translatable`,
  );
};

const operatorText = (node: unknown): string | null =>
  is(node, "OperatorNode") && typeof node.operator === "string" ? node.operator : null;

const walkBinary = (node: Node): PredicateNode => {
  const slug = columnName(node.leftOperand);
  if (!slug) {
    throw new UnsupportedWhereError(
      "left side of a comparison is not a plain column — expressions and column-to-column comparisons are not supported",
    );
  }
  const operator = operatorText(node.operator);
  if (!operator) throw new UnsupportedWhereError("comparison has no recognisable operator");

  // IS / IS NOT against null is Kysely's spelling of IS NULL / IS NOT NULL.
  if (operator === "is" || operator === "is not") {
    const value = literal(node.rightOperand);
    if (!value.ok || value.value !== null) {
      throw new UnsupportedWhereError(`\`${operator}\` is only supported against null`);
    }
    return operator === "is" ? isEmpty(slug) : isNotEmpty(slug);
  }

  if (operator === "in" || operator === "not in") {
    const right = node.rightOperand;
    if (!is(right, "PrimitiveValueListNode") || !Array.isArray(right.values)) {
      throw new UnsupportedWhereError(`\`${operator}\` without a literal value list`);
    }
    return oneOf(slug, right.values as unknown[], operator === "not in");
  }

  const value = literal(node.rightOperand);
  if (!value.ok) {
    throw new UnsupportedWhereError(
      `right side of \`${operator}\` is not a literal — only literal comparisons are supported`,
    );
  }

  if (operator === "like" || operator === "ilike") {
    if (typeof value.value !== "string") {
      throw new UnsupportedWhereError(`\`${operator}\` with a non-string pattern`);
    }
    return matchesPattern(slug, value.value, operator === "ilike");
  }

  const mapped = COMPARISONS[operator];
  if (!mapped) {
    throw new UnsupportedWhereError(`operator \`${operator}\` has no Busabase translation`);
  }
  return comparison(slug, mapped, value.value);
};
