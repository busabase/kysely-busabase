import { UnsupportedWhereError } from "busabase-orm-core";
import type { OperationNode, QueryCompiler, RootOperationNode } from "kysely";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { compileWhere } from "./compile-where";

/**
 * These drive real Kysely expressions rather than hand-built nodes, so they
 * re-verify the AST shapes this module reads. If Kysely changes a node, these
 * fail rather than the driver quietly mistranslating.
 */

interface DB {
  t: { name: string | null; age: number; active: boolean };
}

/** Captures the where node of whatever query is built, without running it. */
const whereOf = (build: (db: Kysely<DB>) => { compile: () => unknown }): OperationNode => {
  let captured: RootOperationNode | undefined;
  const compiler: QueryCompiler = {
    compileQuery(node: RootOperationNode) {
      captured = node;
      return { query: node, sql: "", parameters: [], queryId: {} } as never;
    },
  };
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createQueryCompiler: () => compiler,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (d) => new PostgresIntrospector(d),
    },
  });
  build(db).compile();
  const where = (captured as unknown as { where?: OperationNode }).where;
  if (!where) throw new Error("no where captured");
  return where;
};

const compile = (build: (db: Kysely<DB>) => { compile: () => unknown }) =>
  compileWhere(whereOf(build));

const matches = (
  build: (db: Kysely<DB>) => { compile: () => unknown },
  payload: Record<string, unknown>,
) => compile(build).predicate(payload);

const row = { name: "kelly", age: 30, active: true };

describe("comparisons", () => {
  it.each([
    ["=", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("name", "=", "kelly"), true],
    ["!=", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("name", "!=", "sam"), true],
    ["<>", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("name", "<>", "sam"), true],
    [">", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("age", ">", 18), true],
    [">=", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("age", ">=", 30), true],
    ["<", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("age", "<", 30), false],
    ["<=", (db: Kysely<DB>) => db.selectFrom("t").selectAll().where("age", "<=", 30), true],
  ])("%s", (_label, build, expected) => {
    expect(matches(build, row)).toBe(expected);
  });

  it("maps every comparison onto an exact value candidate", () => {
    const compiled = compile((db) => db.selectFrom("t").selectAll().where("age", ">", 18));
    expect(compiled.valueCandidates).toEqual([{ fieldSlug: "age", operator: "gt", value: 18 }]);
    expect(compiled.fullyExact).toBe(true);
  });

  it("gives equality a view-filter push-down as well", () => {
    const compiled = compile((db) => db.selectFrom("t").selectAll().where("name", "=", "kelly"));
    expect(compiled.pushdown).toEqual([{ fieldSlug: "name", operator: "equals", value: "kelly" }]);
  });

  it("maps a boolean equality onto is_true / is_false", () => {
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("active", "=", true)).pushdown,
    ).toEqual([{ fieldSlug: "active", operator: "is_true" }]);
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("active", "=", false)).pushdown,
    ).toEqual([{ fieldSlug: "active", operator: "is_false" }]);
  });
});

describe("null handling", () => {
  it("reads `is null` / `is not null`", () => {
    expect(matches((db) => db.selectFrom("t").selectAll().where("name", "is", null), {})).toBe(
      true,
    );
    expect(matches((db) => db.selectFrom("t").selectAll().where("name", "is not", null), row)).toBe(
      true,
    );
  });

  it("pushes them down as is_empty / not_empty", () => {
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("name", "is", null)).pushdown,
    ).toEqual([{ fieldSlug: "name", operator: "is_empty" }]);
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("name", "is not", null)).pushdown,
    ).toEqual([{ fieldSlug: "name", operator: "not_empty" }]);
  });

  it("rejects `is` against a non-null value rather than guessing", () => {
    expect(() =>
      compile((db) =>
        db
          .selectFrom("t")
          .selectAll()
          .where("name", "is", "kelly" as never),
      ),
    ).toThrow(UnsupportedWhereError);
  });

  it("treats a missing field as UNKNOWN, not as a JS coercion", () => {
    expect(matches((db) => db.selectFrom("t").selectAll().where("age", ">", 18), {})).toBe(false);
    expect(matches((db) => db.selectFrom("t").selectAll().where("age", "<", 18), {})).toBe(false);
    expect(matches((db) => db.selectFrom("t").selectAll().where("name", "!=", "sam"), {})).toBe(
      false,
    );
  });
});

describe("lists and patterns", () => {
  it("reads `in` and `not in`", () => {
    expect(
      matches((db) => db.selectFrom("t").selectAll().where("name", "in", ["sam", "kelly"]), row),
    ).toBe(true);
    expect(
      matches((db) => db.selectFrom("t").selectAll().where("name", "not in", ["sam"]), row),
    ).toBe(true);
  });

  it("treats a single-element `in` as equality, but not a longer list", () => {
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("name", "in", ["kelly"]))
        .valueCandidates,
    ).toEqual([{ fieldSlug: "name", operator: "eq", value: "kelly" }]);
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("name", "in", ["a", "b"]))
        .valueCandidates,
    ).toEqual([]);
  });

  it("distinguishes like from ilike", () => {
    expect(matches((db) => db.selectFrom("t").selectAll().where("name", "like", "KEL%"), row)).toBe(
      false,
    );
    expect(
      matches((db) => db.selectFrom("t").selectAll().where("name", "ilike", "KEL%"), row),
    ).toBe(true);
  });

  it("pushes an unanchored pattern down as contains, and nothing else", () => {
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("name", "ilike", "%kel%")).pushdown,
    ).toEqual([{ fieldSlug: "name", operator: "contains", value: "kel" }]);
    expect(
      compile((db) => db.selectFrom("t").selectAll().where("name", "like", "kel%")).pushdown,
    ).toEqual([]);
  });
});

describe("boolean structure", () => {
  it("reads a flat AND chain", () => {
    const compiled = compile((db) =>
      db.selectFrom("t").selectAll().where("name", "=", "kelly").where("age", ">", 18),
    );
    expect(compiled.predicate(row)).toBe(true);
    expect(compiled.predicate({ ...row, age: 5 })).toBe(false);
    expect(compiled.fullyExact).toBe(true);
  });

  it("reads OR and refuses to push any branch", () => {
    const compiled = compile((db) =>
      db
        .selectFrom("t")
        .selectAll()
        .where((eb) => eb.or([eb("name", "=", "kelly"), eb("name", "=", "sam")])),
    );
    expect(compiled.predicate(row)).toBe(true);
    expect(compiled.predicate({ ...row, name: "other" })).toBe(false);
    expect(compiled.pushdown).toEqual([]);
    expect(compiled.fullyExact).toBe(false);
  });

  it("reads NOT, and keeps SQL's NOT UNKNOWN = UNKNOWN", () => {
    const compiled = compile((db) =>
      db
        .selectFrom("t")
        .selectAll()
        .where((eb) => eb.not(eb("name", "=", "kelly"))),
    );
    expect(compiled.predicate(row)).toBe(false);
    expect(compiled.predicate({ ...row, name: "sam" })).toBe(true);
    expect(compiled.predicate({})).toBe(false);
    expect(compiled.fullyExact).toBe(false);
  });

  it("reads a nested tree", () => {
    const compiled = compile((db) =>
      db
        .selectFrom("t")
        .selectAll()
        .where((eb) =>
          eb.and([eb("active", "=", true), eb.or([eb("age", ">", 40), eb("name", "is", null)])]),
        ),
    );
    expect(compiled.predicate({ active: true, age: 50, name: "kelly" })).toBe(true);
    expect(compiled.predicate({ active: true, age: 20, name: null })).toBe(true);
    expect(compiled.predicate({ active: true, age: 20, name: "kelly" })).toBe(false);
    expect(compiled.predicate({ active: false, age: 50, name: "kelly" })).toBe(false);
  });

  it("loses exactness when one branch of an AND is inexact", () => {
    const compiled = compile((db) =>
      db.selectFrom("t").selectAll().where("age", ">", 18).where("name", "like", "kel%"),
    );
    expect(compiled.fullyExact).toBe(false);
    expect(compiled.valueCandidates).toEqual([{ fieldSlug: "age", operator: "gt", value: 18 }]);
  });
});

describe("refusals", () => {
  it("rejects a raw sql fragment rather than ignoring it", () => {
    expect(() =>
      compile((db) => db.selectFrom("t").selectAll().where(sql<boolean>`lower(name) = 'x'`)),
    ).toThrow(UnsupportedWhereError);
  });

  it("rejects a column-to-column comparison", () => {
    expect(() =>
      compile((db) =>
        db
          .selectFrom("t")
          .selectAll()
          .whereRef("name", "=", "age" as never),
      ),
    ).toThrow(UnsupportedWhereError);
  });

  it("says why, so the failure is actionable", () => {
    expect(() =>
      compile((db) => db.selectFrom("t").selectAll().where(sql<boolean>`lower(name) = 'x'`)),
    ).toThrow(/no Busabase translation|not translatable/);
  });

  it("compiles an absent where clause to an always-true predicate", () => {
    const compiled = compileWhere(undefined);
    expect(compiled.predicate({})).toBe(true);
    expect(compiled.fullyExact).toBe(true);
  });
});
