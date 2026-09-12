import {
  all,
  any,
  type ComparisonOperator,
  type CompiledWhere,
  columnComparison,
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

/**
 * How a column reference becomes a field slug.
 *
 * A single-table query wants the bare name; a JOINED query wants
 * `table.column`, because a bare name is ambiguous the moment two tables are in
 * play. `accept` exists for a third case: testing whether a whole where clause
 * belongs to one table, by compiling it with a resolver that refuses every
 * other one — if that throws, the clause spans tables and cannot be pushed to
 * the driving side.
 */
export interface CompileWhereOptions {
  /** Reject a reference whose table this returns false for. */
  accept?: (table: string | null) => boolean;
  /** Resolve to `table.column`; names the table an unqualified reference means. */
  qualifyWith?: string;
}

/** `ReferenceNode → ColumnNode → IdentifierNode.name`. */
const bareColumnName = (node: unknown): string | null => {
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

const columnName = (node: unknown, options?: CompileWhereOptions): string | null => {
  const name = bareColumnName(node);
  if (name === null) return null;
  const table = is(node, "ReferenceNode") ? tableOfReference(node) : null;
  if (options?.accept && !options.accept(table)) {
    throw new UnsupportedWhereError(
      `\`${table ?? "?"}.${name}\` belongs to another table than the one being compiled`,
    );
  }
  return options?.qualifyWith ? `${table ?? options.qualifyWith}.${name}` : name;
};

/** `ReferenceNode.table → TableNode → SchemableIdentifierNode → IdentifierNode.name`. */
const tableOfReference = (node: Node): string | null => {
  const table = node.table;
  if (!is(table, "TableNode")) return null;
  const schemable = table.table;
  if (!is(schemable, "SchemableIdentifierNode")) return null;
  const identifier = schemable.identifier;
  return is(identifier, "IdentifierNode") && typeof identifier.name === "string"
    ? identifier.name
    : null;
};

export const compileWhere = (
  where: OperationNode | undefined,
  options?: CompileWhereOptions,
): CompiledWhere => finalize(where ? walk(where, options) : undefined);

const walk = (node: OperationNode, options?: CompileWhereOptions): PredicateNode => {
  if (is(node, "WhereNode")) return walk(node.where as OperationNode, options);
  if (is(node, "ParensNode")) return walk(node.node as OperationNode, options);
  if (is(node, "AndNode")) {
    return all([
      walk(node.left as OperationNode, options),
      walk(node.right as OperationNode, options),
    ]);
  }
  if (is(node, "OrNode")) {
    return any([
      walk(node.left as OperationNode, options),
      walk(node.right as OperationNode, options),
    ]);
  }
  if (is(node, "UnaryOperationNode")) {
    const operator = operatorText(node.operator);
    if (operator === "not") return negate(walk(node.operand as OperationNode, options));
    throw new UnsupportedWhereError(`unary operator \`${operator ?? "?"}\` has no translation`);
  }
  if (is(node, "BinaryOperationNode")) return walkBinary(node, options);

  throw new UnsupportedWhereError(
    `\`${(node as Node).kind}\` has no Busabase translation — raw sql and expressions are not translatable`,
  );
};

const operatorText = (node: unknown): string | null =>
  is(node, "OperatorNode") && typeof node.operator === "string" ? node.operator : null;

const walkBinary = (node: Node, options?: CompileWhereOptions): PredicateNode => {
  const slug = columnName(node.leftOperand, options);
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

  // `a <op> b` — two columns off the same record. Decided locally (there is no
  // wire form for comparing one stored column against another), but answerable,
  // so it is translated rather than refused.
  const rightSlug = columnName(node.rightOperand, options);
  if (rightSlug) {
    const mappedColumn = COMPARISONS[operator];
    if (!mappedColumn) {
      throw new UnsupportedWhereError(
        `operator \`${operator}\` has no Busabase translation for a column-to-column comparison`,
      );
    }
    return columnComparison(slug, mappedColumn, rightSlug);
  }

  const value = literal(node.rightOperand);
  if (!value.ok) {
    throw new UnsupportedWhereError(
      `right side of \`${operator}\` is neither a literal nor a column`,
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
