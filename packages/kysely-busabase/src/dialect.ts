import {
  BaseResolver,
  type ExecuteContext,
  executeSelect,
  type RecordRow,
  type ResolvedBase,
  readColumn,
  type SortKey,
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
    const direction = node(entry.direction);
    const fragments = Array.isArray(direction.sqlFragments) ? direction.sqlFragments : [];
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
   * Busabase deletes are review-first: `deleteFrom(...)` submits a
   * ChangeRequest proposing the rows be archived, and they are still present
   * when it resolves. Refused unless this is set.
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
    if (Array.isArray(root.joins) && root.joins.length) {
      throw new Error(
        "kysely-busabase cannot join: Busabase's REST surface has no join, and emulating one client-side would silently read whole Bases.",
      );
    }
    if (root.groupBy) throw new Error("kysely-busabase does not support group by yet.");
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
    if (!this.options.allowReviewFirstDelete) {
      throw new Error(
        "kysely-busabase refuses deleteFrom() by default. Busabase deletes are review-first: the call submits a ChangeRequest " +
          "proposing the rows be archived, and they are STILL PRESENT when it resolves — which is not what a delete means anywhere else. " +
          "Pass `allowReviewFirstDelete: true` once you have accounted for that.",
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
      await this.client.records.changeRequest({
        recordId: row.id,
        operation: "delete",
        message: this.options.changeMessage ?? "Change via kysely-busabase",
      });
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
