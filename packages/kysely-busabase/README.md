# kysely-busabase

A [Kysely](https://kysely.dev) dialect for [Busabase](https://busabase.com). Write normal Kysely queries; they are translated into [`busabase-sdk`](https://www.npmjs.com/package/busabase-sdk) REST calls against a Base.

```bash
npm install kysely-busabase kysely busabase-sdk
```

```ts
import { Busabase } from "busabase-sdk";
import { BusabaseDialect } from "kysely-busabase";
import { Kysely } from "kysely";

interface DB {
  // Table name = Base slug; column names = field slugs.
  contacts: { id?: string; name: string; stage: string; score: number };
}

const bb = new Busabase({ apiKey: process.env.BUSABASE_API_KEY });
const db = new Kysely<DB>({ dialect: new BusabaseDialect({ client: bb.client }) });

const hot = await db
  .selectFrom("contacts")
  .selectAll()
  .where("stage", "=", "won")
  .where("score", ">", 40)
  .orderBy("score", "desc")
  .limit(10)
  .execute();
```

## How it works

**This dialect never produces SQL.** `QueryCompiler` has exactly one method, and `CompiledQuery` carries the AST (`query`) alongside the string — so the compiler returns the node tree with an empty `sql`, and the driver works from that. Kysely's executor never reads `.sql`.

Nothing is forked, patched, or reached for past a public export. Every node type is exported from the package root, so if Kysely changes a node's shape, this package fails to compile rather than silently mistranslating.

The Busabase half — Base resolution, SQL value semantics, push-down decisions, joins, aggregates, paging — lives in `busabase-orm-core`, shared with [`drizzle-busabase`](https://github.com/busabase/drizzle-busabase). This package is only the walk from Kysely's AST into those shared builders.

## What pushes down

Busabase answers a filter two different ways, and the difference decides what this dialect can do with the answer:

| | what it is | may carry `limit`? |
| --- | --- | --- |
| view filters (`contains`, `equals`, …) | a **superset** the client narrows | no |
| value filters (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`) | **exact** | yes |

Every `where` compiles into both a push-down *and* a local, exactly-evaluated predicate; the predicate is always authoritative. **Exact push-down covers** number and date fields (including `created_time` / `updated_time`), text and `select` fields for `=`/`!=`, and `checkbox`. `or(...)`, `not(...)` and `in (...)` all push: the filter list is a CNF whose entries may carry an `any` group, and negation is pushed to the leaves at compile time.

So:

- **`limit` is pushed down only when the server decides the whole `where`** — every conjunct exact, and any sort pushable. Anything else (a `like`, an `is null`, a column-to-column comparison) and the limit is applied locally instead, because pushing it onto a superset returns a short page indistinguishable from a complete one.
- **`count` and grouped aggregates run on the server** when the filter is exact, transferring no rows at all; otherwise they fall back to the same scan, with the scan budget and SQL's NULL semantics.
- **Operators Busabase lacks still work**, evaluated locally. Correct, not free.
- **Sorting** is pushed down for a single number/date field. **Text sorts run locally** — Postgres orders text by the database collation and your code orders it by JavaScript string comparison (`'a' < 'B'` in `en_US.UTF-8`, not in JS), so an exact row set in an order you cannot reproduce would be worse than no push-down.
- **Nulls follow SQL three-valued logic**, not JavaScript coercion — a missing field makes `>` UNKNOWN, so the row is in neither the comparison nor its negation.

The scan is bounded by `maxScannedRecords` (default 10,000) and **throws when exceeded rather than truncating**.

## Joins, aggregates and set operations

- **Joins** — `innerJoin` / `leftJoin` / `rightJoin` / `fullJoin`, run as a hash join: the driving side is fetched with its own push-down, then the other side is fetched **by key** rather than wholesale. `rightJoin` and `fullJoin` are the exception: they have to keep rows the driving side never referenced, so that side is read in full. `ON` must be an equality (or an AND of equalities) between two columns, and is oriented automatically whichever way round you wrote it.
- **`groupBy` + aggregates** — `count` (including `countAll()` and `.distinct()`), `sum`, `avg`, `min`, `max` over a plain column, returned under the alias you gave it. An empty group aggregates to `NULL`, not `0`.
- **`union` / `intersect` / `except`**, with or without `all`. Each branch runs as its own query with its own push-down.

## What it refuses

Anything without an exact translation throws with the reason: raw SQL, computed select expressions, an unaliased aggregate (there would be no key to return it under), grouping by an expression, expression `orderBy`, aggregating over a set operation, and transactions (Busabase's ChangeRequest is the natural boundary, but this dialect does not batch into one yet).

## Writes follow Busabase, not SQL

- **`insertInto` / `updateTable`** ride Busabase's permission-aware auto-merge, and **throw** if the change lands as a pending ChangeRequest — the row does not exist yet, and reporting success would be a lie. `updateTable` carries untouched fields through, since Busabase revises a whole payload.
- **`deleteFrom` archives; it does not erase, and it is refused by default.** Merging a delete sets the record's status to `archived`: it leaves every query this dialect can issue, but it is still stored and restorable in Busabase. Opt in explicitly:

  ```ts
  new BusabaseDialect({ client: bb.client, allowArchivingDelete: true });
  ```

  Like the other writes, it **throws** rather than report a delete that is only pending review.

## Server requirements

Exact push-down needs a Busabase server that understands `valueFilters` — anything **newer than 0.42.0**.

You do not have to check. The dialect asks the server once per client, and an older server that silently drops the parameter (answering as though no filter were given) is detected and treated as having none: every query falls back to fetching and deciding locally. **Answers are the same either way**; only the amount of data transferred changes.

## Options

```ts
new BusabaseDialect({
  client: bb.client,
  bases: { contacts: "kelly-crm-contacts-v1" }, // table name -> Base slug or bas_ id
  maxScannedRecords: 10_000,
  pageSize: 100,                                // REST caps this at 100
  allowArchivingDelete: false,
  changeMessage: "Change via kysely-busabase",
});
```
