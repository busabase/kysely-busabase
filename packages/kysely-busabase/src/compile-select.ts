import type { AggregateEntry, AggregateFn, JoinPair, JoinType } from "busabase-orm-core";
import { UnsupportedJoinError } from "busabase-orm-core";

/**
 * Reading Kysely's SELECT shape: projections, joins and set operations.
 *
 * Same division as `compile-where.ts`. Kysely hands over a documented AST, so
 * everything here is a `switch` on `kind`; what a join, an aggregate or a union
 * MEANS lives in `busabase-orm-core`, shared with the drizzle driver.
 *
 * Shapes below were read off kysely 0.29 by instrumenting a QueryCompiler, not
 * guessed:
 *
 *   count(x)   SelectionNode{selection: AliasNode{node: AggregateFunctionNode{func, distinct,
 *                aggregated: [ReferenceNode]}, alias: IdentifierNode}}
 *   countAll   the same, with `aggregated: [SelectionNode]` instead of a reference
 *   join       JoinNode{joinType: "InnerJoin"|"LeftJoin"|"RightJoin"|"FullJoin",
 *                table: TableNode, on: OnNode{on: BinaryOperationNode}}
 *   union      SetOperationNode{operator: "union"|"intersect"|"except", all: boolean,
 *                expression: SelectQueryNode}   — the branch is a whole query, ready to run
 */

interface Node {
  kind: string;
  [key: string]: unknown;
}

const is = (node: unknown, kind: string): node is Node =>
  typeof node === "object" && node !== null && (node as Node).kind === kind;

const identifierName = (node: unknown): string | null =>
  is(node, "IdentifierNode") && typeof node.name === "string" ? node.name : null;

/** `TableNode → SchemableIdentifierNode → IdentifierNode.name`. */
export const tableOf = (node: unknown): string | null => {
  if (!is(node, "TableNode")) return null;
  const schemable = node.table;
  return is(schemable, "SchemableIdentifierNode") ? identifierName(schemable.identifier) : null;
};

/** `ReferenceNode → ColumnNode → IdentifierNode.name`, plus its table when qualified. */
export const referenceOf = (node: unknown): { table: string | null; column: string } | null => {
  if (!is(node, "ReferenceNode")) return null;
  const column = node.column;
  if (!is(column, "ColumnNode")) return null;
  const name = identifierName(column.column);
  return name === null ? null : { table: tableOf(node.table), column: name };
};

const AGGREGATE_FUNCTIONS: Record<string, AggregateFn> = {
  count: "count",
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
};

/** One projected field, as either a column reference or an aggregate. */
export type ProjectedField =
  | { kind: "all" }
  | { kind: "column"; alias: string; table: string | null; column: string }
  | { kind: "aggregate"; alias: string; entry: AggregateEntry };

/**
 * A select's projection.
 *
 * `alias` is what the result object is keyed by, which is where Kysely differs
 * usefully from drizzle: results are objects rather than positional arrays, so
 * an unaliased aggregate has no name to return under and is refused rather than
 * given an invented one.
 */
export const parseProjection = (selections: unknown): ProjectedField[] => {
  if (!Array.isArray(selections) || selections.length === 0) return [{ kind: "all" }];
  const fields: ProjectedField[] = [];
  for (const selection of selections) {
    if (!is(selection, "SelectionNode")) continue;
    const inner = selection.selection;
    if (is(inner, "SelectAllNode")) return [{ kind: "all" }];

    const reference = referenceOf(inner);
    if (reference) {
      fields.push({ kind: "column", alias: reference.column, ...reference });
      continue;
    }

    if (is(inner, "AliasNode")) {
      const alias = identifierName(inner.alias);
      const aliased = inner.node;
      const aliasedReference = referenceOf(aliased);
      if (alias && aliasedReference) {
        fields.push({ kind: "column", alias, ...aliasedReference });
        continue;
      }
      if (alias && is(aliased, "AggregateFunctionNode")) {
        const fn = AGGREGATE_FUNCTIONS[String(aliased.func)];
        if (!fn) {
          throw new Error(
            `kysely-busabase cannot compute \`${String(aliased.func)}\` — it has no Busabase translation.`,
          );
        }
        const argument = Array.isArray(aliased.aggregated) ? aliased.aggregated[0] : undefined;
        const argumentReference = referenceOf(argument);
        // `countAll()` renders its argument as a SelectionNode rather than a
        // reference — that is the `count(*)` case, which counts ROWS.
        if (!argumentReference && !is(argument, "SelectionNode")) {
          throw new Error(
            "kysely-busabase can only aggregate a plain column — an aggregate over an expression has no Busabase translation.",
          );
        }
        fields.push({
          kind: "aggregate",
          alias,
          entry: {
            kind: "aggregate",
            fn,
            fieldSlug: argumentReference ? argumentReference.column : null,
            distinct: aliased.distinct === true,
          },
        });
        continue;
      }
    }

    throw new Error(
      "kysely-busabase can only select plain columns and aliased aggregates — computed expressions have no Busabase translation.",
    );
  }
  return fields;
};

const JOIN_TYPES: Record<string, JoinType> = {
  InnerJoin: "inner",
  LeftJoin: "left",
  RightJoin: "right",
  FullJoin: "full",
};

export interface KyselyJoin {
  tableName: string;
  type: JoinType;
  pairs: JoinPair[];
}

/** `ON a.x = b.y`, or an AND of several. Equality only — see the shared join. */
const parseOn = (node: unknown): JoinPair[] => {
  if (is(node, "ParensNode")) return parseOn(node.node);
  if (is(node, "AndNode")) return [...parseOn(node.left), ...parseOn(node.right)];
  if (is(node, "OrNode")) {
    throw new UnsupportedJoinError("an OR in ON has no single hash key to join on");
  }
  if (!is(node, "BinaryOperationNode")) {
    throw new UnsupportedJoinError("the ON condition is not a comparison this driver can read");
  }
  const left = referenceOf(node.leftOperand);
  const right = referenceOf(node.rightOperand);
  if (!left || !right) {
    throw new UnsupportedJoinError(
      "ON compares something other than two columns — a literal or an expression cannot be a join key",
    );
  }
  const operator = is(node.operator, "OperatorNode") ? String(node.operator.operator) : "?";
  if (operator !== "=") {
    throw new UnsupportedJoinError(
      `\`${operator}\` in ON is not an equality, so there is no key to hash on`,
    );
  }
  const qualified = (reference: { table: string | null; column: string }, fallback: string) =>
    `${reference.table ?? fallback}.${reference.column}`;
  return [{ left: qualified(left, ""), right: qualified(right, "") }];
};

export const parseJoins = (joins: unknown, drivingTable: string): KyselyJoin[] => {
  if (!Array.isArray(joins)) return [];
  return joins.map((entry) => {
    if (!is(entry, "JoinNode")) {
      throw new UnsupportedJoinError("the join is not a shape this driver can read");
    }
    const type = JOIN_TYPES[String(entry.joinType)];
    if (!type) {
      throw new UnsupportedJoinError(
        `\`${String(entry.joinType)}\` is not a join type this driver knows`,
      );
    }
    const table = tableOf(entry.table);
    if (!table) throw new UnsupportedJoinError("the joined table has no readable name");
    const on = is(entry.on, "OnNode") ? entry.on.on : undefined;
    const pairs = parseOn(on).map((pair) => ({
      // An unqualified side of ON belongs to the driving table; Kysely
      // qualifies both in practice, but assuming it would make a bad guess
      // silent rather than loud.
      left: pair.left.startsWith(".") ? `${drivingTable}${pair.left}` : pair.left,
      right: pair.right.startsWith(".") ? `${table}${pair.right}` : pair.right,
    }));
    // Kysely writes ON in the order the caller typed it, so `on(u.code, "=",
    // t.firm)` puts the JOINED table on the left. Orient every pair so `left`
    // is the accumulated side — otherwise the hash keys are swapped and nothing
    // matches, which reads as "the join returned nothing" rather than as a bug.
    return {
      tableName: table,
      type,
      pairs: pairs.map((pair) =>
        pair.right.startsWith(`${table}.`) ? pair : { left: pair.right, right: pair.left },
      ),
    };
  });
};

export interface KyselySetOperation {
  operator: "union" | "intersect" | "except";
  all: boolean;
  /** The branch is a whole `SelectQueryNode`, ready to run as its own query. */
  expression: Record<string, unknown>;
}

export const parseSetOperations = (setOperations: unknown): KyselySetOperation[] => {
  if (!Array.isArray(setOperations)) return [];
  return setOperations.map((entry) => {
    if (!is(entry, "SetOperationNode")) {
      throw new Error("kysely-busabase cannot read this set operation.");
    }
    const operator = String(entry.operator);
    if (operator !== "union" && operator !== "intersect" && operator !== "except") {
      throw new Error(`kysely-busabase cannot run a \`${operator}\` set operation.`);
    }
    if (!is(entry.expression, "SelectQueryNode")) {
      throw new Error(
        "kysely-busabase can only combine plain selects with union/intersect/except.",
      );
    }
    return {
      operator,
      all: entry.all === true,
      expression: entry.expression as unknown as Record<string, unknown>,
    };
  });
};
