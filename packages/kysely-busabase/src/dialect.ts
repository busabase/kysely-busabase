import {
  BaseResolver,
  combine,
  computeAggregate,
  distinctKeyValues,
  type ExecuteContext,
  executeAggregate,
  executeSelect,
  finalize,
  groupRows,
  hashJoin,
  type JoinedRow,
  type JoinPair,
  oneOf,
  qualifiedValues,
  type RecordRow,
  type ResolvedBase,
  readColumn,
  ScanLimitExceededError,
  type SortKey,
  sortCombined,
} from "busabase-orm-core";
import type { BusabaseClient } from "busabase-sdk";
import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  OperationNode,
  QueryCompiler,
  QueryResult,
  RootOperationNode,
} from "kysely";
import { DummyDriver, PostgresAdapter, PostgresIntrospector } from "kysely";
import {
  type KyselyJoin,
  type KyselySetOperation,
  type ProjectedField,
  parseJoins,
  parseProjection,
  parseSetOperations,
  referenceOf,
} from "./compile-select";
import { compileWhere } from "./compile-where";

/**
 * A Kysely dialect that never produces SQL.
 *
 * `QueryCompiler` has exactly one method, and `CompiledQuery` carries the AST
 * (`query`) right alongside the string — so a dialect is free to hand back an
 * empty `sql` and let the driver work from the node tree. Kysely's own executor
 * never reads `.sql`; `DummyDriver`'s existence is the same idea from the other
 * direction. Nothing here is forked, patched, or reaching past a public export.
 *
 * That makes this the cleanest of the two drivers: drizzle has to be intercepted
 * at `PgDialect.buildSelectQuery` and its config type is not exported, so that
 * side needs a local re-declaration a compiler cannot check. Here every node
 * type is exported and a shape change is a compile error.
 */

interface BusabaseCompiledQuery extends CompiledQuery {
  readonly query: RootOperationNode;
}

class BusabaseQueryCompiler implements QueryCompiler {
  compileQuery(node: RootOperationNode, queryId: unknown): CompiledQuery {
    // The AST *is* the compiled query. `sql` stays empty on purpose: producing
    // it would be wasted work, and anything reading it deserves to notice.
    return {
      query: node,
      sql: "",
      parameters: [],
      queryId,
    } as unknown as CompiledQuery;
  }
}

const node = (value: unknown): { kind: string; [key: string]: unknown } =>
  value as { kind: string; [key: string]: unknown };

/** `TableNode → SchemableIdentifierNode → IdentifierNode.name`. */
const tableName = (table: unknown): string => {
  const identifier = node(node(table).table);
  const name = node(identifier.identifier).name;
  if (typeof name !== "string") {
    throw new Error("kysely-busabase: could not read a table name from the query");
  }
  return name;
};

const singleTable = (from: unknown): string => {
  const froms = node(from).froms;
  if (!Array.isArray(froms) || froms.length !== 1) {
    throw new Error(
      "kysely-busabase supports exactly one table per query — Busabase has no join, and emulating one client-side would silently read whole Bases.",
    );
  }
  return tableName(froms[0]);
};

/** GROUP BY column names. Kysely gives `GroupByNode{items:[GroupByItemNode{groupBy}]}`. */
const parseGroupBy = (groupBy: unknown): string[] => {
  const items = node(groupBy)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const reference = referenceOf(node(item).groupBy);
    if (!reference) {
      throw new Error(
        "kysely-busabase can only group by a plain column — a grouped expression has no Busabase translation.",
      );
    }
    return reference.column;
  });
};

/** Ordering for combined/grouped output: numbers numerically, nulls last. */
const compareForOrder = (left: unknown, right: unknown): number => {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
};

/**
 * Ordering applied to GROUPS, resolved against the projection — a grouped query
 * has no records left to order by the time it gets here.
 */
const sortAggregateObjects = (
  rows: Record<string, unknown>[],
  root: Record<string, unknown>,
  projection: ProjectedField[],
): Record<string, unknown>[] => {
  const aliasOf = (name: string) => {
    const field = projection.find(
      (entry) =>
        (entry.kind === "column" && entry.column === name) ||
        (entry.kind === "aggregate" && entry.alias === name),
    );
    if (!field || field.kind === "all") {
      throw new Error(
        `kysely-busabase cannot order a grouped query by "${name}" — it is not one of the selected columns.`,
      );
    }
    return field.alias;
  };
  const keys = parseSortKeys(root.orderBy).map((key) => ({
    alias: aliasOf(key.fieldSlug),
    direction: key.direction,
  }));
  if (keys.length === 0) return rows;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const order = compareForOrder(left[key.alias], right[key.alias]);
      if (order !== 0) return key.direction === "desc" ? -order : order;
    }
    return 0;
  });
};

/** `limit`/`offset` applied to GROUPS or combined rows, never to the branches. */
const sliceRows = <T>(rows: T[], root: Record<string, unknown>): T[] => {
  const limitValue = node(node(root.limit)?.limit)?.value;
  const offsetValue = node(node(root.offset)?.offset)?.value;
  const offset = typeof offsetValue === "number" ? offsetValue : 0;
  return typeof limitValue === "number"
    ? rows.slice(offset, offset + limitValue)
    : rows.slice(offset);
};

const parseSortKeys = (orderBy: unknown): SortKey[] => {
  if (!orderBy) return [];
  const items = node(orderBy).items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const entry = node(item);
    const reference = node(entry.orderBy);
    const column = node(reference.column);
    const name = node(column.column).name;
    if (typeof name !== "string") {
      throw new Error(
        "kysely-busabase can only order by a column, not by an expression — ignoring it would return rows in the wrong order.",
      );
    }
    // Direction is the one place Kysely still hands over a string: a RawNode
    // whose fragments read "asc" or "desc". A closed vocabulary, so reading it
    // is safe.
    //
    // It is also OPTIONAL — `orderBy("name")` with no direction omits the node
    // entirely, and reading through it unconditionally crashed on a query as
    // ordinary as that.
    const direction = entry.direction ? node(entry.direction) : undefined;
    const fragments = Array.isArray(direction?.sqlFragments) ? direction.sqlFragments : [];
    return {
      fieldSlug: name,
      direction:
        String(fragments.join("")).trim() === "desc" ? ("desc" as const) : ("asc" as const),
    };
  });
};

/** Which columns a select asked for; `null` means "all of them". */
const selectedColumns = (selections: unknown): string[] | null => {
  if (!Array.isArray(selections) || selections.length === 0) return null;
  const names: string[] = [];
  for (const selection of selections) {
    const inner = node(node(selection).selection);
    if (inner.kind === "SelectAllNode") return null;
    if (inner.kind !== "ReferenceNode") {
      throw new Error(
        "kysely-busabase can only select plain columns — computed expressions have no Busabase translation.",
      );
    }
    const name = node(node(inner.column).column).name;
    if (typeof name !== "string") return null;
    names.push(name);
  }
  return names;
};

const toObject = (base: ResolvedBase, row: RecordRow, columns: string[] | null) => {
  const names = columns ?? [...base.fields.keys()];
  const out: Record<string, unknown> = {};
  for (const name of names) out[name] = readColumn(base, row, name);
  // A selectAll should still expose the record's identity, which is not a field.
  if (!columns && !base.fields.has("id")) out.id = row.id;
  return out;
};

export interface BusabaseDialectOptions {
  client: BusabaseClient;
  /** Maps a table name to a Base slug or `bas_…` id. */
  bases?: Record<string, string>;
  maxScannedRecords?: number;
  pageSize?: number;
  /**
   * `deleteFrom(...)` ARCHIVES rather than removes: merging the delete sets the
   * record's status to `archived`, which takes it out of every query this
   * dialect can issue but leaves it restorable in Busabase. A delete means
   * erasure anywhere else, so the difference is opted into rather than assumed
   * — this is not a data-erasure primitive.
   */
  allowArchivingDelete?: boolean;
  /**
   * @deprecated Renamed to {@link BusabaseDialectOptions.allowArchivingDelete}.
   * The old name described a review-first model that no longer holds: a
   * credential with write access merges the delete immediately. Still accepted
   * so 0.1.x callers keep working.
   */
  allowReviewFirstDelete?: boolean;
  changeMessage?: string;
}

class BusabaseConnection implements DatabaseConnection {
  private readonly context: ExecuteContext;

  constructor(
    private readonly client: BusabaseClient,
    private readonly options: BusabaseDialectOptions,
    resolver: BaseResolver,
  ) {
    this.context = {
      client,
      resolver,
      maxScannedRecords: options.maxScannedRecords ?? 10_000,
      pageSize: Math.min(options.pageSize ?? 100, 100),
    };
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const root = node((compiled as BusabaseCompiledQuery).query);
    switch (root.kind) {
      case "SelectQueryNode":
        return this.select<R>(root);
      case "InsertQueryNode":
        return this.insert<R>(root);
      case "UpdateQueryNode":
        return this.update<R>(root);
      case "DeleteQueryNode":
        return this.remove<R>(root);
      default:
        throw new Error(
          `kysely-busabase cannot run a ${root.kind} — Busabase has no schema DDL or raw query surface.`,
        );
    }
  }

  async *streamQuery<R>(compiled: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiled);
  }

  private async select<R>(root: Record<string, unknown>): Promise<QueryResult<R>> {
    const setOperations = parseSetOperations(root.setOperations);
    if (setOperations.length)
      return { rows: (await this.runSetOperation(root, setOperations)) as R[] };

    const projection = parseProjection(root.selections);
    const groupSlugs = parseGroupBy(root.groupBy);
    if (Array.isArray(root.joins) && root.joins.length) {
      return { rows: (await this.runJoined(root, projection)) as R[] };
    }
    if (groupSlugs.length || projection.some((field) => field.kind === "aggregate")) {
      return { rows: (await this.runAggregate(root, projection, groupSlugs)) as R[] };
    }
    const limit = node(root.limit)?.limit;
    const offset = node(root.offset)?.offset;
    const { base, rows } = await executeSelect(
      {
        baseSlug: singleTable(root.from),
        where: compileWhere(root.where as OperationNode | undefined),
        orderBy: parseSortKeys(root.orderBy),
        limit: typeof node(limit)?.value === "number" ? (node(limit).value as number) : undefined,
        offset:
          typeof node(offset)?.value === "number" ? (node(offset).value as number) : undefined,
      },
      this.context,
    );
    const columns = selectedColumns(root.selections);
    return { rows: rows.map((row) => toObject(base, row, columns)) as R[] };
  }

  /** Every row of one select, without any of the projection applied. */
  private async selectRows(root: Record<string, unknown>) {
    const limit = node(root.limit)?.limit;
    const offset = node(root.offset)?.offset;
    return executeSelect(
      {
        baseSlug: singleTable(root.from),
        where: compileWhere(root.where as OperationNode | undefined),
        orderBy: parseSortKeys(root.orderBy),
        limit: typeof node(limit)?.value === "number" ? (node(limit).value as number) : undefined,
        offset:
          typeof node(offset)?.value === "number" ? (node(offset).value as number) : undefined,
      },
      this.context,
    );
  }

  /**
   * A grouped / aggregated select. Same division of labour as the drizzle
   * driver: one fast path for UNGROUPED aggregates over a fully-exact where
   * clause (`records.groupBy` with no group field — one round trip, no records
   * transferred), everything else computed over rows this driver fetches.
   *
   * `limit`/`offset` are NOT passed down: on an aggregate query they bound the
   * GROUPS, so pushing them would truncate the input to the aggregation and
   * report a confidently wrong total.
   */
  private async runAggregate(
    root: Record<string, unknown>,
    projection: ProjectedField[],
    groupSlugs: string[],
  ): Promise<Record<string, unknown>[]> {
    const baseSlug = singleTable(root.from);
    const where = compileWhere(root.where as OperationNode | undefined);
    const aggregates = projection.filter(
      (field): field is Extract<ProjectedField, { kind: "aggregate" }> =>
        field.kind === "aggregate",
    );

    // A projection of aggregates — optionally grouped by ONE column — is a
    // single round trip. SQL bucketing is what makes the server's groups match
    // what `groupRows` would produce here.
    const groupColumns = projection.filter(
      (field): field is Extract<ProjectedField, { kind: "column" }> => field.kind === "column",
    );
    const serverGroupable =
      groupSlugs.length <= 1 &&
      aggregates.length > 0 &&
      // Every non-aggregate column must BE the group column: anything else has
      // no defined value per group, and SQL would reject the query outright.
      groupColumns.every((field) => field.column === groupSlugs[0]);

    if (serverGroupable) {
      const answered = await executeAggregate(
        {
          baseSlug,
          where,
          groupBy: groupSlugs[0],
          aggregates: aggregates.map((field) => field.entry),
        },
        this.context,
      );
      if (answered) {
        const rows = answered.map((group) =>
          Object.fromEntries(
            projection.map((field) => {
              if (field.kind === "all") {
                throw new Error("kysely-busabase cannot select * alongside an aggregate.");
              }
              if (field.kind === "column") return [field.alias, group.value];
              return [
                field.alias,
                field.entry.fieldSlug === null
                  ? group.count
                  : (group.values[`${field.entry.fn}:${field.entry.fieldSlug}`] ??
                    (field.entry.fn === "count" ? 0 : null)),
              ];
            }),
          ),
        );
        return sliceRows(sortAggregateObjects(rows, root, projection), root);
      }
    }

    const { base, rows } = await executeSelect({ baseSlug, where }, this.context);
    const groups = groupRows(base, rows, groupSlugs);
    const built = groups.map((group) =>
      Object.fromEntries(
        projection.map((field) => {
          if (field.kind === "all") {
            throw new Error("kysely-busabase cannot select * alongside an aggregate.");
          }
          if (field.kind === "aggregate") {
            return [field.alias, computeAggregate(field.entry, base, group.rows)];
          }
          return [field.alias, readColumn(base, group.rows[0] as RecordRow, field.column)];
        }),
      ),
    );
    return sliceRows(sortAggregateObjects(built, root, projection), root);
  }

  /**
   * A joined select, as a hash join. The joined side is fetched BY KEY when the
   * key is a real Base field; the driving side is read in full unless the whole
   * `where` belongs to it. Both bounded by `maxScannedRecords`.
   */
  private async runJoined(
    root: Record<string, unknown>,
    projection: ProjectedField[],
  ): Promise<Record<string, unknown>[]> {
    const drivingTable = singleTable(root.from);
    const specs = parseJoins(root.joins, drivingTable);

    // Push the whole `where` only when every column in it belongs to the
    // driving table — a clause spanning tables cannot be split back apart here.
    let drivingWhere: ReturnType<typeof compileWhere> | undefined;
    if (root.where) {
      try {
        drivingWhere = compileWhere(root.where as OperationNode | undefined, {
          accept: (table) => table === null || table === drivingTable,
        });
      } catch {
        drivingWhere = undefined;
      }
    }

    const drivingBase = await this.context.resolver.resolve(drivingTable);
    const { rows: drivingRows } = await executeSelect(
      { baseSlug: drivingTable, where: drivingWhere },
      this.context,
    );
    if (drivingRows.length > this.context.maxScannedRecords) {
      throw new ScanLimitExceededError(drivingBase.slug, this.context.maxScannedRecords);
    }
    const namesOf = (base: ResolvedBase) => [...base.fields.keys(), "id", "createdAt", "updatedAt"];
    let accumulated: JoinedRow[] = drivingRows.map((row) => ({
      values: qualifiedValues(drivingBase, drivingTable, row, namesOf(drivingBase)),
      sources: { [drivingTable]: row },
    }));

    for (const spec of specs) {
      const base = await this.context.resolver.resolve(spec.tableName);
      const names = namesOf(base);
      const records = await this.fetchJoinSide(accumulated, spec, base);
      if (records.length > this.context.maxScannedRecords) {
        throw new ScanLimitExceededError(base.slug, this.context.maxScannedRecords);
      }
      accumulated = hashJoin(
        accumulated,
        records.map((row) => ({ row, values: qualifiedValues(base, spec.tableName, row, names) })),
        spec.pairs,
        spec.type,
        spec.tableName,
        qualifiedValues(base, spec.tableName, null, names),
      );
    }

    // The authoritative predicate reads QUALIFIED names, because it may span
    // tables — the push-down above was only ever an optimisation on the left.
    if (root.where) {
      const combined = compileWhere(root.where as OperationNode | undefined, {
        qualifyWith: drivingTable,
      });
      accumulated = accumulated.filter((row) => combined.predicate(row.values));
    }

    const built = accumulated.map((row) =>
      Object.fromEntries(
        projection.flatMap((field) => {
          if (field.kind === "all") return Object.entries(row.values);
          if (field.kind === "aggregate") {
            throw new Error("kysely-busabase cannot aggregate over a join.");
          }
          return [
            [field.alias, row.values[`${field.table ?? drivingTable}.${field.column}`] ?? null],
          ];
        }),
      ),
    );
    return sliceRows(built, root);
  }

  /** Rows of one joined table: by key when the key is a Base field, else all. */
  private async fetchJoinSide(
    accumulated: JoinedRow[],
    spec: KyselyJoin,
    base: ResolvedBase,
  ): Promise<RecordRow[]> {
    const rightSlug =
      spec.pairs.length === 1 ? (spec.pairs[0] as JoinPair).right.split(".")[1] : undefined;
    const keys = distinctKeyValues(accumulated, spec.pairs);
    // An outer join needs the joined table's unmatched rows too, so it cannot
    // be narrowed to the keys the driving side happens to hold.
    const needsEveryRow = spec.type === "right" || spec.type === "full";
    if (!rightSlug || !base.fields.has(rightSlug) || keys === null || needsEveryRow) {
      const { rows } = await executeSelect({ baseSlug: spec.tableName }, this.context);
      return rows;
    }
    if (keys.length === 0) return [];
    const collected: RecordRow[] = [];
    const seen = new Set<string>();
    // Batched under the value filters' own URL budget — `records.list` is a GET.
    for (let index = 0; index < keys.length; index += 50) {
      const { rows } = await executeSelect(
        {
          baseSlug: spec.tableName,
          where: finalize(oneOf(rightSlug, keys.slice(index, index + 50), false)),
        },
        this.context,
      );
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        collected.push(row);
      }
    }
    return collected;
  }

  /**
   * `union` / `intersect` / `except`. Each branch runs as an ordinary select,
   * so each keeps its own push-down; they are combined on the PROJECTED row,
   * which is what SQL's set operators compare.
   */
  private async runSetOperation(
    root: Record<string, unknown>,
    operations: KyselySetOperation[],
  ): Promise<Record<string, unknown>[]> {
    const projection = parseProjection(root.selections);
    const aliases = projection.map((field) => (field.kind === "all" ? "*" : field.alias));
    const branch = async (query: Record<string, unknown>) => {
      const { base, rows } = await this.selectRows(query);
      const columns = selectedColumns(query.selections);
      return rows.map((row) => {
        const object = toObject(base, row, columns);
        return aliases.map((alias) => (alias === "*" ? JSON.stringify(object) : object[alias]));
      });
    };

    // The branches are union-compatible by SQL's own rule, so the left's
    // projection names every column.
    const { setOperations: _branches, ...left } = root;
    let combined = await branch(left);
    for (const operation of operations) {
      combined = combine(
        combined,
        await branch(operation.expression),
        operation.operator,
        operation.all,
      );
    }

    const sorted = sortCombined(
      combined,
      parseSortKeys(root.orderBy).map((key) => {
        const index = aliases.indexOf(key.fieldSlug);
        if (index === -1) {
          throw new Error(
            `kysely-busabase cannot order a union/intersect/except by "${key.fieldSlug}" — it is not one of the combined columns.`,
          );
        }
        return { index, direction: key.direction };
      }),
      compareForOrder,
    );
    return sliceRows(
      sorted.map((row) => Object.fromEntries(aliases.map((alias, index) => [alias, row[index]]))),
      root,
    );
  }

  private async insert<R>(root: Record<string, unknown>): Promise<QueryResult<R>> {
    const base = await this.context.resolver.resolve(tableName(root.into));
    const columns = Array.isArray(root.columns)
      ? root.columns.map((column) => String(node(node(column).column).name))
      : [];
    const valueRows = Array.isArray(node(root.values)?.values) ? node(root.values).values : [];
    const rows: Record<string, unknown>[] = [];
    for (const valueRow of valueRows as unknown[]) {
      const values = node(valueRow).values;
      if (!Array.isArray(values)) {
        throw new Error("kysely-busabase can only insert literal values.");
      }
      const fields = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
      const result = await this.client.bases.createChangeRequest({
        baseId: base.id,
        fields,
        message: this.options.changeMessage ?? "Change via kysely-busabase",
      });
      if (!result.materialized) {
        throw new Error(
          `kysely-busabase submitted the insert as ChangeRequest ${result.id}, which is awaiting review — the row does not exist yet. ` +
            `This happens when the API credential lacks write access on the Base; approve the ChangeRequest to apply it.`,
        );
      }
      rows.push(
        toObject(
          base,
          {
            id: result.id,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
            payload: result.headCommit.payload,
          },
          null,
        ),
      );
    }
    return { rows: rows as R[], numAffectedRows: BigInt(rows.length) };
  }

  private async update<R>(root: Record<string, unknown>): Promise<QueryResult<R>> {
    const { base, rows } = await executeSelect(
      {
        baseSlug: tableName(root.table),
        where: compileWhere(root.where as OperationNode | undefined),
      },
      this.context,
    );
    const updates = Array.isArray(root.updates) ? root.updates : [];
    const patch = Object.fromEntries(
      updates.map((update) => {
        const entry = node(update);
        return [String(node(node(entry.column).column).name), node(entry.value).value];
      }),
    );
    const updated: Record<string, unknown>[] = [];
    for (const row of rows) {
      const result = await this.client.records.changeRequest({
        recordId: row.id,
        operation: "update",
        // Busabase revises a record as a whole payload, so untouched fields have
        // to be carried over or they would be cleared.
        fields: { ...row.payload, ...patch },
        message: this.options.changeMessage ?? "Change via kysely-busabase",
        autoMerge: true,
      });
      if (!result.materialized) {
        throw new Error(
          `kysely-busabase submitted the update to record ${row.id} as ChangeRequest ${result.id}, which is awaiting review — the row is unchanged for now.`,
        );
      }
      updated.push(
        toObject(
          base,
          {
            id: result.id,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
            payload: result.headCommit.payload,
          },
          null,
        ),
      );
    }
    return { rows: updated as R[], numAffectedRows: BigInt(updated.length) };
  }

  private async remove<R>(root: Record<string, unknown>): Promise<QueryResult<R>> {
    if (!(this.options.allowArchivingDelete ?? this.options.allowReviewFirstDelete)) {
      throw new Error(
        "kysely-busabase refuses deleteFrom() by default. A Busabase delete ARCHIVES the record rather than removing it: " +
          "it leaves every query this dialect can issue, but it is still stored and restorable — which is not what a delete means " +
          "anywhere else. Pass `allowArchivingDelete: true` once you have accounted for that.",
      );
    }
    const { rows } = await executeSelect(
      {
        baseSlug: singleTable(root.from),
        where: compileWhere(root.where as OperationNode | undefined),
      },
      this.context,
    );
    for (const row of rows) {
      const result = await this.client.records.changeRequest({
        recordId: row.id,
        operation: "delete",
        message: this.options.changeMessage ?? "Change via kysely-busabase",
        autoMerge: true,
      });
      if (!result.materialized) {
        throw new Error(
          `kysely-busabase submitted the delete of record ${row.id} as ChangeRequest ${result.id}, which is awaiting review — ` +
            `the record is STILL THERE. This happens when the API credential lacks write access on the Base. ` +
            `The delete is NOT lost; approve the ChangeRequest to apply it.`,
        );
      }
    }
    return { rows: [] as R[], numAffectedRows: BigInt(rows.length) };
  }
}

class BusabaseDriver implements Driver {
  private readonly connection: BusabaseConnection;

  constructor(options: BusabaseDialectOptions) {
    this.connection = new BusabaseConnection(
      options.client,
      options,
      new BaseResolver(options.client, options.bases ?? {}),
    );
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}

  async beginTransaction(): Promise<void> {
    throw new Error(
      "kysely-busabase does not support transactions yet. Busabase's ChangeRequest is the natural boundary " +
        "(one request, many operations, merged atomically), but this driver does not batch into one yet.",
    );
  }
  async commitTransaction(): Promise<void> {
    throw new Error("kysely-busabase does not support transactions yet.");
  }
  async rollbackTransaction(): Promise<void> {
    throw new Error("kysely-busabase does not support transactions yet.");
  }
}

/**
 * ```ts
 * const bb = new Busabase({ apiKey: process.env.BUSABASE_API_KEY });
 * const db = new Kysely<DB>({ dialect: new BusabaseDialect({ client: bb.client }) });
 * const won = await db.selectFrom("contacts").selectAll().where("stage", "=", "won").execute();
 * ```
 */
export class BusabaseDialect implements Dialect {
  constructor(private readonly options: BusabaseDialectOptions) {}

  createDriver(): Driver {
    return new BusabaseDriver(this.options);
  }

  createQueryCompiler(): QueryCompiler {
    return new BusabaseQueryCompiler();
  }

  // Busabase is not Postgres, but the adapter only tells Kysely which *syntax*
  // affordances exist (returning clauses, transactional DDL). Postgres's answers
  // are the closest fit, and none of it reaches the wire since no SQL is built.
  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Dialect
  // interface itself is declared with `Kysely<any>`; narrowing here would not
  // implement it.
  // biome-ignore lint/suspicious/noExplicitAny: matches Kysely's own signature
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

/** Re-exported so a consumer can build a no-op dialect in tests. */
export { DummyDriver };
