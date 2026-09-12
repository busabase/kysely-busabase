import { UnsupportedJoinError } from "busabase-orm-core";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { describe, expect, it } from "vitest";
import { parseJoins, parseProjection, parseSetOperations } from "./compile-select";

/**
 * Reading Kysely's SELECT shape.
 *
 * Every case is driven through Kysely's own builders rather than a hand-written
 * node literal: the point is to notice when the real shape changes, which a
 * hand-written fixture never would. What the shapes MEAN is tested in
 * busabase-orm-core, shared with the drizzle driver.
 */

interface DB {
  contacts: { id: string; name: string; stage: string; score: number; firm: string };
  companies: { id: string; code: string; city: string };
}

const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (instance) => new PostgresIntrospector(instance),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const query = (built: { compile: () => { query: unknown } }) =>
  built.compile().query as Record<string, unknown>;

describe("parseProjection", () => {
  it("reads plain columns under their own names", () => {
    expect(
      parseProjection(query(db.selectFrom("contacts").select(["name", "score"])).selections),
    ).toEqual([
      { kind: "column", alias: "name", table: null, column: "name" },
      { kind: "column", alias: "score", table: null, column: "score" },
    ]);
  });

  it("keeps the table on a qualified column, so two `id`s stay distinct", () => {
    const projection = parseProjection(
      query(
        db
          .selectFrom("contacts")
          .innerJoin("companies", "contacts.firm", "companies.code")
          .select(["contacts.id", "companies.id"]),
      ).selections,
    );
    expect(projection).toEqual([
      { kind: "column", alias: "id", table: "contacts", column: "id" },
      { kind: "column", alias: "id", table: "companies", column: "id" },
    ]);
  });

  it("reads an alias as the key the result is returned under", () => {
    expect(
      parseProjection(query(db.selectFrom("contacts").select("name as who")).selections),
    ).toEqual([{ kind: "column", alias: "who", table: null, column: "name" }]);
  });

  it("treats selectAll as everything", () => {
    expect(parseProjection(query(db.selectFrom("contacts").selectAll()).selections)).toEqual([
      { kind: "all" },
    ]);
  });

  it("reads aggregates with their function and argument", () => {
    const projection = parseProjection(
      query(
        db
          .selectFrom("contacts")
          .select((eb) => [
            eb.fn.count<number>("id").as("n"),
            eb.fn.countAll<number>().as("rows"),
            eb.fn.count<number>("stage").distinct().as("kinds"),
            eb.fn.sum<number>("score").as("total"),
          ]),
      ).selections,
    );
    expect(projection).toEqual([
      {
        kind: "aggregate",
        alias: "n",
        entry: expect.objectContaining({ fn: "count", fieldSlug: "id", distinct: false }),
      },
      // `countAll()` is the `count(*)` case: it counts ROWS, so it has no field.
      {
        kind: "aggregate",
        alias: "rows",
        entry: expect.objectContaining({ fn: "count", fieldSlug: null }),
      },
      { kind: "aggregate", alias: "kinds", entry: expect.objectContaining({ distinct: true }) },
      {
        kind: "aggregate",
        alias: "total",
        entry: expect.objectContaining({ fn: "sum", fieldSlug: "score" }),
      },
    ]);
  });

  it("refuses a computed expression, which has no Busabase translation", () => {
    expect(() =>
      parseProjection(
        query(db.selectFrom("contacts").select(sql<string>`lower(name)`.as("x"))).selections,
      ),
    ).toThrow(/plain columns and aliased aggregates/);
  });

  it("refuses an aggregate over an expression", () => {
    expect(() =>
      parseProjection(
        query(db.selectFrom("contacts").select((eb) => eb.fn.sum<number>(sql`score * 2`).as("x")))
          .selections,
      ),
    ).toThrow(/aggregate a plain column/);
  });
});

describe("parseJoins", () => {
  it.each([
    [
      "innerJoin",
      db.selectFrom("contacts").innerJoin("companies", "contacts.firm", "companies.code"),
      "inner",
    ],
    [
      "leftJoin",
      db.selectFrom("contacts").leftJoin("companies", "contacts.firm", "companies.code"),
      "left",
    ],
    [
      "rightJoin",
      db.selectFrom("contacts").rightJoin("companies", "contacts.firm", "companies.code"),
      "right",
    ],
    [
      "fullJoin",
      db.selectFrom("contacts").fullJoin("companies", "contacts.firm", "companies.code"),
      "full",
    ],
  ])("reads %s", (_label, built, type) => {
    expect(parseJoins(query(built.selectAll()).joins, "contacts")).toEqual([
      { tableName: "companies", type, pairs: [{ left: "contacts.firm", right: "companies.code" }] },
    ]);
  });

  it("orients the pair so the accumulated side is on the left", () => {
    // Kysely writes ON in the order the caller typed it. Written the other way
    // round, the hash keys would be swapped and NOTHING would match — which
    // reads as "the join returned nothing" rather than as a bug.
    expect(
      parseJoins(
        query(
          db
            .selectFrom("contacts")
            .innerJoin("companies", "companies.code", "contacts.firm")
            .selectAll(),
        ).joins,
        "contacts",
      ),
    ).toEqual([
      {
        tableName: "companies",
        type: "inner",
        pairs: [{ left: "contacts.firm", right: "companies.code" }],
      },
    ]);
  });

  it("reads an AND of equalities as a composite key", () => {
    const joins = parseJoins(
      query(
        db
          .selectFrom("contacts")
          .innerJoin("companies", (join) =>
            join
              .onRef("contacts.firm", "=", "companies.code")
              .onRef("contacts.id", "=", "companies.id"),
          )
          .selectAll(),
      ).joins,
      "contacts",
    );
    expect(joins[0]?.pairs).toHaveLength(2);
  });

  it.each([
    [
      "an inequality, which has no hash key",
      db
        .selectFrom("contacts")
        .innerJoin("companies", (join) => join.onRef("contacts.firm", ">", "companies.code")),
      /not an equality/,
    ],
    [
      "a comparison against a literal",
      db
        .selectFrom("contacts")
        .innerJoin("companies", (join) => join.on("companies.code", "=", "acme")),
      /other than two columns/,
    ],
  ])("refuses %s", (_label, built, message) => {
    expect(() => parseJoins(query(built.selectAll()).joins, "contacts")).toThrow(
      UnsupportedJoinError,
    );
    expect(() => parseJoins(query(built.selectAll()).joins, "contacts")).toThrow(message);
  });

  it("returns nothing for a query with no joins", () => {
    expect(parseJoins(query(db.selectFrom("contacts").selectAll()).joins, "contacts")).toEqual([]);
  });
});

describe("parseSetOperations", () => {
  it("reads the operator, its ALL flag, and the branch query", () => {
    const operations = parseSetOperations(
      query(
        db
          .selectFrom("contacts")
          .select("stage")
          .union(db.selectFrom("contacts").select("stage"))
          .intersectAll(db.selectFrom("contacts").select("stage")),
      ).setOperations,
    );
    expect(operations.map((entry) => [entry.operator, entry.all])).toEqual([
      ["union", false],
      ["intersect", true],
    ]);
    // The branch is a whole query, ready to run with its own push-down.
    expect(operations[0]?.expression.kind).toBe("SelectQueryNode");
  });

  it("returns nothing for a query with no set operations", () => {
    expect(parseSetOperations(query(db.selectFrom("contacts").selectAll()).setOperations)).toEqual(
      [],
    );
  });
});
