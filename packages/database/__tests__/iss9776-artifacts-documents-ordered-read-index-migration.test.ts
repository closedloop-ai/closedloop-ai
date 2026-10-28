import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseIndexes,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-9776 — the index the Documents ordered read seeks and sorts on
 * (`artifacts_org_type_subtype_created_id_idx`, migration 20260913120000).
 *
 * WHY THIS FILE EXISTS AT ALL. Nothing else in the repo goes red when this DDL
 * is wrong. An index changes PLAN CHOICE and never results, so every suite over
 * `GET /documents` stays green on a missing, reordered, or wrong-table index,
 * and the Prisma drift check compares the migration against `schema.prisma`, so
 * a matching PAIR of mistakes is green there too. `packages/database/AGENTS.md`
 * requires focused DDL coverage on every new index migration for exactly this
 * reason, and four reviewers flagged its absence on a sibling DB PR.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20260913120000_iss9776_artifacts_documents_ordered_read_idx";

/**
 * Repeated as a literal rather than derived. This is a PIN: renaming the index
 * in the migration has to change this file too, so a rename is a decision
 * somebody makes rather than one that rides along — and the name is also the
 * `map:` in `schema.prisma`, where a silent divergence reads as drift.
 */
const INDEX = "artifacts_org_type_subtype_created_id_idx";

/**
 * The equality columns first, then the ORDER BY in its own direction.
 *
 * Every column here is load-bearing and none is interchangeable.
 * `organization_id`, `type` and `subtype` are the equality predicate
 * `buildDocumentListWhere` emits, and `subtype` is the one NO shipped index
 * carries — it was a post-scan Filter discarding 3,130 rows. `created_at` and
 * `id` are the read's ORDER BY, and they must come AFTER the equalities: a
 * sort key ahead of an equality column cannot return rows pre-sorted, which is
 * what hands the Sort back. The DESC on both is what lets the scan walk in the
 * direction the query asks for instead of reversing at the end.
 *
 * There is no `project_id` key and no INCLUDE payload. An earlier revision
 * carried `INCLUDE ("project_id")` so the `project_id IS NULL` recheck could be
 * answered from the index tuple; the PARTIAL predicate below guarantees every
 * indexed row already satisfies it, so the payload bought nothing and was
 * dropped. The predicate — not an INCLUDE — is what makes the `count()` arm an
 * Index Only Scan. The companion assertion is "carries no INCLUDE payload,
 * because the predicate replaced it".
 */
const ORDERED_KEYS = [
  "organization_id",
  "type",
  "subtype",
  "created_at DESC",
  "id DESC",
];

/**
 * The index is PARTIAL, and the predicate is what makes it able to coexist with
 * ISS-7804 (see the migration header).
 *
 * Pinned in the MIGRATION's spelling — quoted identifier — because that is the
 * text this file parses. It is deliberately NOT the same string `schema.prisma`
 * declares: the differ compares against what Postgres STORED, which normalizes
 * to `(project_id IS NULL)`. Two spellings of one predicate, each pinned where
 * the thing reading it actually looks.
 */
const PREDICATE = '"project_id" IS NULL';

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes artifacts on the equality predicate then the read's sort order", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("artifacts");
    // `toEqual` on the ordered array, never a contains-check. The same five
    // columns in any other order serve a different query — and one with the
    // sort keys ahead of the equalities cannot serve this one at all — so a
    // membership assertion would accept precisely the mistakes worth catching.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what supplies the ORDERED output that removes the Sort. A hash
    // index would still be an index, would pass a name-and-columns check, and
    // could not serve an ordering at all.
    expect(index.method).toBe("btree");
  });

  it("is restricted to project-less rows", () => {
    // THE ASSERTION THAT KEEPS ISS-7804 WORKING, not a size optimisation.
    //
    // Without this predicate the index leads (organization_id, type, subtype),
    // which is exactly the equality set of ISS-7804's subtype-narrowed
    // reference search — so the planner preferred it there, and then had to add
    // a top-N heapsort because this index orders by `created_at` while that
    // query orders by `updated_at`. Measured on the ISS-7804 fixture: an
    // ordered Index Scan on `artifacts_org_type_updated_id_idx` became a Bitmap
    // Heap Scan over 745 rows / 520 heap blocks plus a Sort.
    //
    // `project_id IS NULL` is carried by the Documents read (it requests
    // project-less DOC artifacts) and by NO reference-search arm, so the
    // planner cannot choose this index for ISS-7804's query at all. The two
    // indexes stop competing rather than being ranked against each other.
    expect(indexNamed(MIGRATION, INDEX).predicate).toContain(PREDICATE);
  });

  it("carries no INCLUDE payload, because the predicate replaced it", () => {
    // An earlier revision carried `INCLUDE ("project_id")` so the
    // `project_id IS NULL` recheck could be answered from the index tuple. As a
    // partial index the rows are guaranteed to satisfy it, so the payload buys
    // nothing and the count arm is an Index Only Scan without it.
    expect(migrationDdl(MIGRATION)).not.toContain("INCLUDE");
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // A plain build holds a lock on `artifacts` for its whole duration, and
    // `artifacts` is written continuously by session and branch ingest.
    expect(index.concurrently).toBe(true);
    // With CONCURRENTLY a cancelled build leaves a same-named INVALID index.
    // `IF NOT EXISTS` would make the retry no-op over it and the existing P3018
    // recovery would then record the migration as applied — a green deploy with
    // an unusable index (packages/database/AGENTS.md).
    expect(index.ifNotExists).toBe(false);
  });

  it("keeps the file to bare statements Prisma will not wrap in a transaction", () => {
    // Prisma splits a migration into per-statement simple queries and runs each
    // outside a transaction ONLY if every statement is bare. A `DO $$ … $$`,
    // `BEGIN`/`COMMIT`, or `DROP INDEX` defeats the splitter, the whole file is
    // wrapped, and every CONCURRENTLY statement then fails with SQLSTATE 25001.
    expect(
      migrationDdl(MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("names an index Postgres will not silently truncate", () => {
    // A truncated name diverges from the `map:` in schema.prisma, which the
    // drift check then reports forever.
    expect(INDEX.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });
});
