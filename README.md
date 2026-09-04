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

The Busabase half — Base resolution, SQL value semantics, push-down decisions, paging — lives in `busabase-orm-core`, shared with [`drizzle-busabase`](https://github.com/busabase/drizzle-busabase). This package is only the walk from Kysely's AST into those shared builders.

## What pushes down

Busabase answers filters two different ways, and the difference decides what this dialect can do:

| | what it is | can it carry `limit`? |
| --- | --- | --- |
| view filters (`contains`, `equals`, …) | a **superset** the client narrows | no |
| value filters (`eq`/`ne`/`gt`/`gte`/`lt`/`lte` on number/date) | **exact** | yes |

So:

- **`limit` is pushed down only when the server decides the whole `where`** — a pure AND of comparisons, every one on a field with an exact value column. Anything else (an `or`, a `like`, an `is null`, a comparison on a text field) and the limit is applied locally instead, because pushing it onto a superset returns a short page indistinguishable from a complete one.
- **Operators Busabase lacks still work**, evaluated locally. Correct, not free.
- **Sorting** is pushed down for a single number/date field; text sorts run locally.
- **Nulls follow SQL three-valued logic**, not JavaScript coercion — a missing field makes `>` UNKNOWN, so the row is in neither the comparison nor its negation.

The scan is bounded by `maxScannedRecords` (default 10,000) and **throws when exceeded rather than truncating**.

## What it refuses

Anything without an exact translation throws with the reason: joins, `group by`, expression `orderBy`, raw SQL, column-to-column comparisons, and transactions (Busabase's ChangeRequest is the natural boundary, but this dialect does not batch into one yet).

## Writes follow Busabase, not SQL

- **`insertInto` / `updateTable`** ride Busabase's permission-aware auto-merge, and **throw** if the change lands as a pending ChangeRequest — the row does not exist yet, and reporting success would be a lie. `updateTable` carries untouched fields through, since Busabase revises a whole payload.
- **`deleteFrom` is refused by default.** Busabase deletes are review-first: the call submits a ChangeRequest proposing the rows be archived, and they are still present when it resolves. Opt in explicitly:

  ```ts
  new BusabaseDialect({ client: bb.client, allowReviewFirstDelete: true });
  ```

## Options

```ts
new BusabaseDialect({
  client: bb.client,
  bases: { contacts: "kelly-crm-contacts-v1" }, // table name -> Base slug or bas_ id
  maxScannedRecords: 10_000,
  pageSize: 100,                                // REST caps this at 100
  allowReviewFirstDelete: false,
  changeMessage: "Change via kysely-busabase",
});
```
