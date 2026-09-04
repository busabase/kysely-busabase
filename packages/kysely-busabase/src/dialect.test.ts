import { ScanLimitExceededError } from "busabase-orm-core";
import type { BusabaseClient } from "busabase-sdk";
import { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { BusabaseDialect } from "./dialect";

interface Contacts {
  // Optional because Busabase assigns it — Kysely would otherwise demand it on insert.
  id?: string;
  name: string;
  stage: string;
  score: number;
}
interface DB {
  contacts: Contacts;
}

interface ValueFilterCall {
  fieldSlug: string;
  operator: string;
  value: number | string;
}
interface ListCall {
  baseId?: string;
  limit?: number;
  filters?: unknown[];
  valueFilters?: ValueFilterCall[];
  sort?: unknown;
  cursor?: string;
}

/** The server's exact comparison, reproduced for the fake. */
const compareValue = (stored: unknown, filter: ValueFilterCall): boolean => {
  if (stored === null || stored === undefined) return false;
  const left = typeof stored === "number" ? stored : Number(stored);
  const right = typeof filter.value === "number" ? filter.value : Number(filter.value);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  switch (filter.operator) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    default:
      return false;
  }
};

const dataset: { id: string; payload: Record<string, unknown> }[] = [
  { id: "rec_1", payload: { name: "Ada", stage: "won", score: 90 } },
  { id: "rec_2", payload: { name: "Bo", stage: "lost", score: 10 } },
  { id: "rec_3", payload: { name: "Cy", stage: "won", score: 70 } },
  { id: "rec_4", payload: { name: "Di", stage: "lost", score: 20 } },
  { id: "rec_5", payload: { name: "Ed", stage: "won", score: 50 } },
  { id: "rec_6", payload: { name: "Fi", stage: "won", score: 30 } },
];

/**
 * Same fake as the drizzle driver's, and deliberately so: view `filters` are
 * accepted and IGNORED (a legal superset), `valueFilters` are applied
 * FAITHFULLY. Both drivers must cope with exactly this.
 */
const makeClient = (records = dataset, pageSize = 2) => {
  const calls: ListCall[] = [];
  const created: Record<string, unknown>[] = [];
  const updated: { recordId: string; fields: Record<string, unknown> }[] = [];
  const deleted: string[] = [];

  const client = {
    bases: {
      list: async () => [
        {
          id: "bas_1",
          slug: "contacts",
          fields: [
            { slug: "name", type: "text" },
            { slug: "stage", type: "text" },
            { slug: "score", type: "number" },
          ],
        },
      ],
      createChangeRequest: async (input: { fields: Record<string, unknown> }) => {
        created.push(input.fields);
        return {
          materialized: true as const,
          id: `rec_new_${created.length}`,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          headCommit: { payload: input.fields },
        };
      },
    },
    records: {
      list: async (input: ListCall) => {
        calls.push(input);
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) =>
            rows.filter((row) => compareValue(row.payload[filter.fieldSlug], filter)),
          records,
        );
        const start = input.cursor ? Number(input.cursor) : 0;
        const size = Math.min(input.limit ?? pageSize, pageSize);
        const slice = matching.slice(start, start + size);
        return {
          records: slice.map((record) => ({
            id: record.id,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            headCommit: { payload: record.payload },
          })),
          nextCursor: start + size < matching.length ? String(start + size) : null,
        };
      },
      changeRequest: async (input: {
        recordId: string;
        operation: string;
        fields?: Record<string, unknown>;
      }) => {
        if (input.operation === "delete") {
          deleted.push(input.recordId);
          return { materialized: false as const, id: "cr_del" };
        }
        updated.push({ recordId: input.recordId, fields: input.fields ?? {} });
        return {
          materialized: true as const,
          id: input.recordId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          headCommit: { payload: input.fields ?? {} },
        };
      },
    },
  } as unknown as BusabaseClient;

  return { client, calls, created, updated, deleted };
};

const makeDb = (fake: ReturnType<typeof makeClient>, options = {}) =>
  new Kysely<DB>({ dialect: new BusabaseDialect({ client: fake.client, ...options }) });

describe("select", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient();
  });

  it("filters on a value the server can decide", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db.selectFrom("contacts").selectAll().where("score", ">", 40).execute();
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gt", value: 40 },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed"]);
  });

  it("narrows a superset filter locally", async () => {
    // The fake ignores view filters entirely, so a correct result here proves
    // the local predicate is doing the deciding.
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db.selectFrom("contacts").selectAll().where("stage", "=", "won").execute();
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Cy", "Ed", "Fi"]);
  });

  it("pushes limit down once the server decides the whole where clause", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .selectAll()
      .where("score", ">", 40)
      .limit(2)
      .execute();
    expect(fake.calls[0]?.limit).toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("does not push limit when a condition is left to the client", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .selectAll()
      .where("score", ">", 40)
      .where("stage", "=", "won")
      .limit(2)
      .execute();
    expect(fake.calls[0]?.limit).not.toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("handles or, in, and case-sensitive vs insensitive matching", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const ors = await db
      .selectFrom("contacts")
      .selectAll()
      .where((eb) => eb.or([eb("name", "=", "Ada"), eb("name", "=", "Bo")]))
      .execute();
    expect(ors.map((row) => row.name).sort()).toEqual(["Ada", "Bo"]);

    const ins = await db
      .selectFrom("contacts")
      .selectAll()
      .where("name", "in", ["Cy", "Ed"])
      .execute();
    expect(ins.map((row) => row.name).sort()).toEqual(["Cy", "Ed"]);

    // `like` is case-sensitive, so "Di" (capital D only) must not match.
    const likes = await db
      .selectFrom("contacts")
      .selectAll()
      .where("name", "like", "%d%")
      .execute();
    expect(likes.map((row) => row.name).sort()).toEqual(["Ada", "Ed"]);

    // `ilike` is not, so it picks "Di" up as well.
    const ilikes = await db
      .selectFrom("contacts")
      .selectAll()
      .where("name", "ilike", "%d%")
      .execute();
    expect(ilikes.map((row) => row.name).sort()).toEqual(["Ada", "Di", "Ed"]);
  });

  it("projects the selected columns only", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select(["name", "score"])
      .where("name", "=", "Ada")
      .execute();
    expect(rows).toEqual([{ name: "Ada", score: 90 }]);
  });

  it("orders locally on a text field and by the server on a number", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    await db.selectFrom("contacts").selectAll().orderBy("score", "asc").execute();
    expect(fake.calls[0]?.sort).toEqual({
      fieldSlug: "score",
      direction: "asc",
      fieldType: "number",
    });

    fake.calls.length = 0;
    const byName = await db.selectFrom("contacts").selectAll().orderBy("name", "desc").execute();
    expect(fake.calls[0]?.sort).toBeUndefined();
    expect(byName.map((row) => row.name)).toEqual(["Fi", "Ed", "Di", "Cy", "Bo", "Ada"]);
  });

  it("fails loudly rather than truncating when the scan budget runs out", async () => {
    const db = makeDb(fake, { maxScannedRecords: 3 });
    await expect(
      db.selectFrom("contacts").selectAll().where("name", "like", "%a%").execute(),
    ).rejects.toThrow(ScanLimitExceededError);
  });
});

describe("write", () => {
  it("inserts through a change request", async () => {
    const fake = makeClient([]);
    const db = makeDb(fake);
    await db.insertInto("contacts").values({ name: "Gil", stage: "new", score: 5 }).execute();
    expect(fake.created).toEqual([{ name: "Gil", stage: "new", score: 5 }]);
  });

  it("carries untouched fields through an update", async () => {
    const fake = makeClient();
    const db = makeDb(fake, { pageSize: 100 });
    await db.updateTable("contacts").set({ stage: "won" }).where("name", "=", "Bo").execute();
    expect(fake.updated).toEqual([
      { recordId: "rec_2", fields: { name: "Bo", stage: "won", score: 10 } },
    ]);
  });

  it("refuses delete by default because Busabase deletes are review-first", async () => {
    const fake = makeClient();
    const db = makeDb(fake, { pageSize: 100 });
    await expect(db.deleteFrom("contacts").where("name", "=", "Bo").execute()).rejects.toThrow(
      /review-first/,
    );
    expect(fake.deleted).toEqual([]);
  });

  it("submits a delete change request once opted in", async () => {
    const fake = makeClient();
    const db = makeDb(fake, { pageSize: 100, allowReviewFirstDelete: true });
    await db.deleteFrom("contacts").where("name", "=", "Bo").execute();
    expect(fake.deleted).toEqual(["rec_2"]);
  });
});

describe("refusals", () => {
  it("rejects a join rather than emulating one", async () => {
    const fake = makeClient();
    const db = makeDb(fake);
    await expect(
      db
        .selectFrom("contacts")
        .innerJoin("contacts as other", "other.id", "contacts.id")
        .selectAll()
        .execute(),
    ).rejects.toThrow(/cannot join/);
  });

  it("rejects transactions with a pointer at the ChangeRequest boundary", async () => {
    const fake = makeClient();
    const db = makeDb(fake);
    await expect(db.transaction().execute(async () => undefined)).rejects.toThrow(/ChangeRequest/);
  });
});

describe("writes that land in review", () => {
  // A credential without write access does not error — the change becomes a
  // pending ChangeRequest. Reporting success would claim a row exists when it
  // does not.
  const reviewingClient = () => {
    const base = makeClient();
    const client = new Proxy(base.client, {
      get(target, prop) {
        if (prop === "bases") {
          const bases = Reflect.get(target, prop) as Record<string, unknown>;
          return new Proxy(bases, {
            get: (bt, bp) =>
              bp === "createChangeRequest"
                ? async () => ({ materialized: false as const, id: "cr_pending" })
                : Reflect.get(bt, bp),
          });
        }
        if (prop === "records") {
          const records = Reflect.get(target, prop) as Record<string, unknown>;
          return new Proxy(records, {
            get(rt, rp) {
              if (rp !== "changeRequest") return Reflect.get(rt, rp);
              const original = Reflect.get(rt, rp) as (i: {
                operation: string;
              }) => Promise<unknown>;
              return async (input: { operation: string }) =>
                input.operation === "update"
                  ? { materialized: false as const, id: "cr_pending" }
                  : original(input);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    });
    return { ...base, client: client as typeof base.client };
  };

  it("throws on an insert awaiting review, naming the ChangeRequest", async () => {
    const db = makeDb(reviewingClient(), { pageSize: 100 });
    await expect(
      db.insertInto("contacts").values({ name: "Gil", stage: "new", score: 5 }).execute(),
    ).rejects.toThrow(/cr_pending/);
  });

  it("throws on an update awaiting review", async () => {
    const db = makeDb(reviewingClient(), { pageSize: 100 });
    await expect(
      db.updateTable("contacts").set({ stage: "won" }).where("name", "=", "Bo").execute(),
    ).rejects.toThrow(/awaiting review — the row is unchanged/);
  });
});

describe("more refusals", () => {
  it("rejects a query against more than one table", async () => {
    const fake = makeClient();
    const db = makeDb(fake);
    await expect(
      db.selectFrom(["contacts", "contacts as other"]).selectAll().execute(),
    ).rejects.toThrow(/exactly one table/);
  });

  it("rejects group by", async () => {
    const fake = makeClient();
    const db = makeDb(fake);
    await expect(
      db.selectFrom("contacts").select("stage").groupBy("stage").execute(),
    ).rejects.toThrow(/group by/);
  });

  it("rejects DDL, which Busabase has no equivalent for", async () => {
    const fake = makeClient();
    const db = makeDb(fake);
    await expect(db.schema.createTable("nope").addColumn("id", "text").execute()).rejects.toThrow(
      /no schema DDL/,
    );
  });

  it("reports the same refusal for commit and rollback as for begin", async () => {
    const fake = makeClient();
    const driver = new BusabaseDialect({ client: fake.client }).createDriver();
    await expect(driver.commitTransaction({} as never)).rejects.toThrow(/transactions/);
    await expect(driver.rollbackTransaction({} as never)).rejects.toThrow(/transactions/);
  });
});

describe("dialect wiring", () => {
  it("builds an adapter, compiler, driver and introspector", () => {
    const fake = makeClient();
    const dialect = new BusabaseDialect({ client: fake.client });
    expect(dialect.createAdapter()).toBeDefined();
    expect(dialect.createDriver()).toBeDefined();
    expect(dialect.createQueryCompiler()).toBeDefined();
    expect(dialect.createIntrospector(makeDb(fake) as never)).toBeDefined();
  });

  it("compiles to the AST with an empty sql string", () => {
    // The whole premise: no SQL is ever produced.
    const fake = makeClient();
    const compiled = makeDb(fake).selectFrom("contacts").selectAll().compile();
    expect(compiled.sql).toBe("");
    expect((compiled as unknown as { query: { kind: string } }).query.kind).toBe("SelectQueryNode");
  });
});
