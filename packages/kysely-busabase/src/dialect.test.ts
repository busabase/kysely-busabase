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
  firm?: string;
}
interface Companies {
  id: string;
  code: string;
  city: string;
}

interface DB {
  contacts: Contacts;
  companies: Companies;
}

/** A second Base, so joins have something to join to. */
const COMPANY_BASE = {
  id: "bas_2",
  slug: "companies",
  fields: [
    { slug: "code", type: "text" },
    { slug: "city", type: "text" },
  ],
};

const companyRows: { id: string; payload: Record<string, unknown> }[] = [
  { id: "co_1", payload: { code: "acme", city: "NY" } },
  { id: "co_2", payload: { code: "zeta", city: "LA" } },
  { id: "co_3", payload: { code: "orphan", city: "SF" } },
];

interface ValueFilterLeaf {
  fieldSlug: string;
  operator: string;
  value: number | string | boolean;
}

/** One CNF conjunct on the wire: a comparison, or a disjunction of them. */
type ValueFilterCall = ValueFilterLeaf | { any: ValueFilterLeaf[] };
interface ListCall {
  baseId?: string;
  limit?: number;
  filters?: unknown[];
  valueFilters?: ValueFilterCall[];
  sort?: unknown;
  cursor?: string;
}

/** The Base this fake serves, and the field types the comparison dispatches on. */
const FIELD_TYPES: Record<string, string> = {
  name: "text",
  stage: "select",
  score: "number",
  firm: "text",
  code: "text",
  city: "text",
};

/**
 * The server's exact comparison, reproduced for the fake — dispatching on FIELD
 * TYPE rather than on the shape of the incoming value, the way
 * `buildExactValueFilter` does. A fake more permissive than the real server
 * would turn a 400 into a green test, so text compares as text and ordering on
 * text raises rather than answering.
 */
const compareLeaf = (stored: unknown, filter: ValueFilterLeaf): boolean => {
  // No stored value never matches, including on the negative operators — the
  // server's EXISTS finds no row, which is SQL's UNKNOWN collapsed to false.
  if (stored === null || stored === undefined) return false;
  const family = FIELD_TYPES[filter.fieldSlug];
  if (family === "text" || family === "select") {
    if (filter.operator !== "eq" && filter.operator !== "ne") {
      throw new Error(`fake server: ${filter.operator} is not exact on text "${filter.fieldSlug}"`);
    }
    const equal = String(stored) === String(filter.value);
    return filter.operator === "eq" ? equal : !equal;
  }
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

/** A CNF conjunct: a leaf, or an OR of leaves. */
const matchesConjunct = (payload: Record<string, unknown>, filter: ValueFilterCall): boolean =>
  "any" in filter
    ? filter.any.some((leaf) => compareLeaf(payload[leaf.fieldSlug], leaf))
    : compareLeaf(payload[filter.fieldSlug], filter);

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
  const groupByCalls: ListCall[] = [];
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
            { slug: "stage", type: "select" },
            { slug: "score", type: "number" },
            { slug: "firm", type: "text" },
          ],
        },
        COMPANY_BASE,
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
        const source = input.baseId === COMPANY_BASE.id ? companyRows : records;
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) => rows.filter((row) => matchesConjunct(row.payload, filter)),
          source,
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
      /**
       * Reproduces the server's NULL semantics deliberately, including SQL
       * bucketing giving a missing value its OWN group — a fake that folded
       * would let the grouped fast path look right here and disagree with the
       * scan path in production.
       */
      /** Present so the driver's capability probe reaches a faithful answer. */
      count: async (input: ListCall) => {
        // A real server REFUSES a filter naming a field the Base does not have,
        // and the driver uses that refusal to tell a server that APPLIES these
        // filters from an older one that silently strips them. A fake that
        // answered politely would make every exact push-down look unsupported.
        for (const filter of input.valueFilters ?? []) {
          const slugs =
            "any" in filter ? filter.any.map((leaf) => leaf.fieldSlug) : [filter.fieldSlug];
          for (const slug of slugs) {
            if (!FIELD_TYPES[slug]) {
              throw new Error(`valueFilters: this Base has no field "${slug}"`);
            }
          }
        }
        return { total: records.length };
      },
      groupBy: async (
        input: ListCall & {
          fieldSlug?: string;
          bucketing?: string;
          aggregates?: { fn: string; fieldSlug: string }[];
        },
      ) => {
        groupByCalls.push(input);
        const source = input.baseId === COMPANY_BASE.id ? companyRows : records;
        const matching = (input.valueFilters ?? []).reduce(
          (rows, filter) => rows.filter((row) => matchesConjunct(row.payload, filter)),
          source,
        );
        if (matching.length === 0) return { groups: [], total: 0 };
        const buckets = new Map<unknown, typeof matching>();
        for (const row of matching) {
          const key = input.fieldSlug ? (row.payload[input.fieldSlug] ?? null) : null;
          buckets.set(key, [...(buckets.get(key) ?? []), row]);
        }
        const groups = [...buckets.entries()].map(([value, rows]) => {
          const aggregates: Record<string, number | null> = {};
          for (const entry of input.aggregates ?? []) {
            const values = rows
              .map((row) => row.payload[entry.fieldSlug])
              .filter((v) => v !== null && v !== undefined)
              .map(Number)
              .filter((v) => Number.isFinite(v));
            const key = `${entry.fn}:${entry.fieldSlug}`;
            if (entry.fn === "count") aggregates[key] = values.length;
            else if (values.length === 0) aggregates[key] = null;
            else if (entry.fn === "sum") aggregates[key] = values.reduce((a, b) => a + b, 0);
            else if (entry.fn === "avg")
              aggregates[key] = values.reduce((a, b) => a + b, 0) / values.length;
            else if (entry.fn === "min") aggregates[key] = Math.min(...values);
            else aggregates[key] = Math.max(...values);
          }
          return { value, count: rows.length, aggregates };
        });
        return { groups, total: matching.length };
      },
      changeRequest: async (input: {
        recordId: string;
        operation: string;
        fields?: Record<string, unknown>;
      }) => {
        if (input.operation === "delete") {
          deleted.push(input.recordId);
          // A real server MERGES this when the credential has write access, so
          // the record is gone by the time the call resolves. Modelling only
          // the no-permission case let a pending delete read as a success.
          return { materialized: true as const, id: "cr_del" };
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

  return { client, calls, groupByCalls, created, updated, deleted };
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
    // `like` has no exact form, so the server's answer is a superset and its
    // extra rows would eat a pushed-down limit.
    //
    // This was written with `stage = "won"` while text equality had no exact
    // server form. It has one now, so that query pushes its limit legitimately
    // (see below) — the invariant being guarded here is unchanged.
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .selectAll()
      .where("score", ">", 40)
      .where("stage", "like", "wo%")
      .limit(2)
      .execute();
    expect(fake.calls[0]?.limit).not.toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("pushes limit down alongside an exact TEXT comparison", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .selectAll()
      .where("stage", "=", "won")
      .limit(2)
      .execute();
    expect(rows).toHaveLength(2);
    expect(fake.calls[0]?.limit).toBe(2);
    expect(fake.calls[0]?.valueFilters).toEqual([
      { fieldSlug: "stage", operator: "eq", value: "won" },
    ]);
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

  it("refuses delete by default, because a Busabase delete ARCHIVES rather than removes", async () => {
    const fake = makeClient();
    const db = makeDb(fake, { pageSize: 100 });
    await expect(db.deleteFrom("contacts").where("name", "=", "Bo").execute()).rejects.toThrow(
      /ARCHIVES/,
    );
    expect(fake.deleted).toEqual([]);
  });

  it("deletes once opted in", async () => {
    const fake = makeClient();
    const db = makeDb(fake, { pageSize: 100, allowArchivingDelete: true });
    await db.deleteFrom("contacts").where("name", "=", "Bo").execute();
    expect(fake.deleted).toEqual(["rec_2"]);
  });

  it("still accepts the 0.1.x option name", async () => {
    const fake = makeClient();
    const db = makeDb(fake, { pageSize: 100, allowReviewFirstDelete: true });
    await db.deleteFrom("contacts").where("name", "=", "Bo").execute();
    expect(fake.deleted).toEqual(["rec_2"]);
  });

  it("throws rather than report a delete that is only PROPOSED", async () => {
    // Without write access the change request stays pending and the record is
    // still there. `insertInto` and `updateTable` both guard against reporting
    // that as success; `deleteFrom` did not — it returned `numAffectedRows`
    // counting rows that were never touched.
    const fake = makeClient();
    const records = fake.client.records as Record<string, unknown>;
    const original = records.changeRequest as (i: { operation: string }) => Promise<unknown>;
    records.changeRequest = async (input: { operation: string }) =>
      input.operation === "delete"
        ? { materialized: false as const, id: "cr_pending" }
        : original(input);
    const db = makeDb(fake, { pageSize: 100, allowArchivingDelete: true });
    await expect(db.deleteFrom("contacts").where("name", "=", "Bo").execute()).rejects.toThrow(
      /awaiting review — the record is STILL THERE/,
    );
  });
});

describe("refusals", () => {
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

describe("ordering without an explicit direction", () => {
  it("defaults to ascending instead of crashing", async () => {
    // `orderBy("name")` omits Kysely's direction node entirely. Reading through
    // it unconditionally threw on a plain select — found while adding grouped
    // ordering, but it was never specific to that.
    const fake = makeClient(dataset, 100);
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db.selectFrom("contacts").select("name").orderBy("name").execute();
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Bo", "Cy", "Di", "Ed", "Fi"]);
  });
});

describe("aggregates", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(dataset, 100);
  });

  it("takes the server's own aggregate for an UNGROUPED projection", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select((eb) => [eb.fn.sum<number>("score").as("total"), eb.fn.max<number>("score").as("hi")])
      .where("score", ">", 40)
      .execute();
    expect(rows).toEqual([{ total: 210, hi: 90 }]); // 90 + 70 + 50
    expect(fake.groupByCalls[0]?.valueFilters).toEqual([
      { fieldSlug: "score", operator: "gt", value: 40 },
    ]);
    // The point: no records crossed the wire.
    expect(fake.calls).toHaveLength(0);
  });

  it("counts rows with countAll, and present values with count(col)", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const [row] = await db
      .selectFrom("contacts")
      .select((eb) => [
        eb.fn.countAll<number>().as("rows"),
        eb.fn.count<number>("score").as("vals"),
      ])
      .execute();
    expect(row).toEqual({ rows: 6, vals: 6 });
  });

  it("falls back to scanning when the where clause is not fully exact", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select((eb) => eb.fn.sum<number>("score").as("total"))
      .where("name", "like", "A%")
      .execute();
    expect(rows).toEqual([{ total: "90" }]); // Ada
    expect(fake.groupByCalls).toHaveLength(0);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("falls back for a DISTINCT aggregate, which the endpoint does not offer", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    await db
      .selectFrom("contacts")
      .select((eb) => eb.fn.count<number>("stage").distinct().as("n"))
      .execute();
    expect(fake.groupByCalls).toHaveLength(0);
  });

  it("takes the SERVER's grouped aggregate, transferring no records", async () => {
    // `stage` is a select, which the server buckets with SQL semantics — so
    // this is one round trip rather than a scan.
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select((eb) => ["stage" as const, eb.fn.sum<number>("score").as("total")])
      .groupBy("stage")
      .orderBy("stage")
      .execute();
    expect(rows).toEqual([
      { stage: "lost", total: 30 },
      { stage: "won", total: 240 },
    ]);
    expect(fake.groupByCalls[0]).toMatchObject({ fieldSlug: "stage", bucketing: "sql" });
    expect(fake.calls).toHaveLength(0);
  });

  it("falls back to scanning when the group field cannot be bucketed with SQL semantics", async () => {
    // `name` is text: `value_text` is truncated at a projection limit, so two
    // long values could share a bucket.
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select((eb) => ["name" as const, eb.fn.countAll<number>().as("n")])
      .groupBy("name")
      .execute();
    expect(rows).toHaveLength(6);
    expect(fake.groupByCalls).toHaveLength(0);
  });

  it("groups locally, with SQL's NULL semantics", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    // A locally-decided condition forces the scan path for the same question,
    // which is what makes this a comparison rather than a repeat of the test
    // above.
    const rows = await db
      .selectFrom("contacts")
      .select((eb) => ["stage" as const, eb.fn.sum<number>("score").as("total")])
      .where("name", "like", "%")
      .groupBy("stage")
      .orderBy("stage")
      .execute();
    expect(rows).toEqual([
      { stage: "lost", total: "30" }, // 10 + 20
      { stage: "won", total: "240" }, // 90 + 70 + 50 + 30
    ]);
    expect(fake.groupByCalls).toHaveLength(0);
  });

  it("applies limit to the GROUPS, not to the records", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select((eb) => ["stage" as const, eb.fn.countAll<number>().as("n")])
      .groupBy("stage")
      .orderBy("stage")
      .limit(1)
      .execute();
    expect(rows).toEqual([{ stage: "lost", n: 2 }]);
    expect(fake.calls.some((call) => call.limit === 1)).toBe(false);
  });
});

describe("joins", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(
      [
        { id: "rec_1", payload: { name: "Ada", stage: "won", score: 90, firm: "acme" } },
        { id: "rec_2", payload: { name: "Bo", stage: "lost", score: 10, firm: "zeta" } },
        { id: "rec_3", payload: { name: "Cy", stage: "won", score: 70, firm: "acme" } },
        { id: "rec_4", payload: { name: "Di", stage: "lost", score: 20 } }, // no firm
      ],
      100,
    );
  });

  it("inner joins on a field, keeping only matched rows", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .innerJoin("companies", "contacts.firm", "companies.code")
      .select(["contacts.name", "companies.city"])
      .execute();
    expect(rows).toEqual([
      { name: "Ada", city: "NY" },
      { name: "Bo", city: "LA" },
      { name: "Cy", city: "NY" },
    ]);
  });

  it("left joins, keeping the unmatched driving row with nulls", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .leftJoin("companies", "contacts.firm", "companies.code")
      .select(["contacts.name", "companies.city"])
      .execute();
    expect(rows).toContainEqual({ name: "Di", city: null });
    expect(rows).toHaveLength(4);
  });

  it("right joins, keeping the unmatched joined row", async () => {
    // The by-key fetch below is exactly what a right join must not do: it would
    // drop the company no contact references, which is the row a right join
    // exists to keep.
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .rightJoin("companies", "contacts.firm", "companies.code")
      .select(["contacts.name", "companies.city"])
      .execute();
    expect(rows).toContainEqual({ name: null, city: "SF" });
  });

  it("fetches the joined table BY KEY rather than scanning it", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    await db
      .selectFrom("contacts")
      .innerJoin("companies", "contacts.firm", "companies.code")
      .select(["contacts.name", "companies.city"])
      .execute();
    const companyCall = fake.calls.find((call) => call.baseId === "bas_2");
    expect(companyCall?.valueFilters).toEqual([
      {
        any: [
          { fieldSlug: "code", operator: "eq", value: "acme" },
          { fieldSlug: "code", operator: "eq", value: "zeta" },
        ],
      },
    ]);
  });

  it("pushes a where that belongs entirely to the driving table", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    await db
      .selectFrom("contacts")
      .innerJoin("companies", "contacts.firm", "companies.code")
      .select(["contacts.name"])
      .where("contacts.stage", "=", "won")
      .execute();
    const contactCall = fake.calls.find((call) => call.baseId === "bas_1");
    expect(contactCall?.valueFilters).toEqual([
      { fieldSlug: "stage", operator: "eq", value: "won" },
    ]);
  });

  it("still answers correctly when the where spans BOTH tables", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .innerJoin("companies", "contacts.firm", "companies.code")
      .select(["contacts.name", "companies.city"])
      .where("contacts.stage", "=", "won")
      .where("companies.city", "=", "NY")
      .execute();
    expect(rows).toEqual([
      { name: "Ada", city: "NY" },
      { name: "Cy", city: "NY" },
    ]);
    const contactCall = fake.calls.find((call) => call.baseId === "bas_1");
    expect(contactCall?.valueFilters ?? []).toEqual([]);
  });

  it("refuses an ON it cannot hash on", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    await expect(
      db
        .selectFrom("contacts")
        .innerJoin("companies", (join) => join.onRef("contacts.firm", ">", "companies.code"))
        .select(["contacts.name"])
        .execute(),
    ).rejects.toThrow(/not an equality/);
  });
});

describe("set operations", () => {
  let fake: ReturnType<typeof makeClient>;
  beforeEach(() => {
    fake = makeClient(dataset, 100);
  });

  it("unions two branches and dedupes the combined ROWS", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select("stage")
      .where("score", ">", 40)
      .union(db.selectFrom("contacts").select("stage").where("score", "<", 40))
      .execute();
    expect(rows).toEqual([{ stage: "won" }, { stage: "lost" }]);
    // Each branch is its own narrow query.
    expect(fake.calls).toHaveLength(2);
  });

  it("keeps duplicates with unionAll", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select("stage")
      .where("score", ">", 40)
      .unionAll(db.selectFrom("contacts").select("stage").where("score", "<", 40))
      .execute();
    expect(rows).toHaveLength(6);
  });

  it("intersects and excepts", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const won = () => db.selectFrom("contacts").select("name").where("stage", "=", "won");
    const high = () => db.selectFrom("contacts").select("name").where("score", ">", 40);
    expect((await won().intersect(high()).execute()).map((r) => r.name).sort()).toEqual([
      "Ada",
      "Cy",
      "Ed",
    ]);
    expect((await won().except(high()).execute()).map((r) => r.name)).toEqual(["Fi"]);
  });

  it("orders and limits the COMBINED result", async () => {
    const db = makeDb(fake, { pageSize: 100 });
    const rows = await db
      .selectFrom("contacts")
      .select("name")
      .where("score", ">", 40)
      .union(db.selectFrom("contacts").select("name").where("score", "<", 40))
      .orderBy("name", "desc")
      .limit(2)
      .execute();
    expect(rows.map((row) => row.name)).toEqual(["Fi", "Ed"]);
    expect(fake.calls.some((call) => call.limit === 2)).toBe(false);
  });
});
