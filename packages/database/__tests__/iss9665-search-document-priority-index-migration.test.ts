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
 * ISS-9665 — the index the `:priority` search filter seeks on
 * (`search_document_org_type_priority_updated_idx`, migration
 * 20260907140100), raised in review by whitlockk on #6796.
 *
 * WHY THIS FILE EXISTS AT ALL. Nothing else in the repo goes red when this DDL
 * is wrong. An index changes PLAN CHOICE and never results, so every
 * behavioural suite over `:priority` stays green against a missing, reordered,
 * or wrong-table index — and `search-fts-filters.test.ts` captures the SQL
 * against a fake client, so it never issues the statement at all. The Prisma
 * drift check compares the migration against `schema.prisma`, so a matching
 * pair of MISTAKES is green there too. `packages/database/AGENTS.md` requires
 * focused DDL coverage for every new index migration for exactly this reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20260907140100_iss9665_search_document_priority_idx";

/**
 * Repeated as a literal rather than derived. This is a PIN: renaming the index
 * in the migration has to change this file too, so a rename is a decision
 * somebody makes rather than one that rides along — and the name is also the
 * `map:` in `schema.prisma`, where a silent divergence reads as drift.
 */
const INDEX = "search_document_org_type_priority_updated_idx";

/**
 * `priorityPredicate` (apps/api/app/search/search-fts-service.ts) filters
 * `organization_id` by equality, `entity_type` by an IN list on the `IS NULL`
 * arm, and `priority` by `IS NULL` / `IS NOT NULL`; the query then orders on
 * `updated_at`.
 *
 * Priority must precede `updated_at`, and the reason is narrower than it looks.
 * Measured on the fixture in the migration header, the permutation
 * (organization_id, entity_type, updated_at, priority) still reports priority
 * in the `Index Cond` and still builds an IDENTICAL heap bitmap — it does not
 * fall back to a heap post-filter. What it loses is the seek: it walks the
 * whole (org, entity_type) range of the index, 198 index pages against 68.
 * So this assertion defends an access-path cost, not a correctness property,
 * and no EXPLAIN-free assertion can tell the two key orders apart — which is
 * exactly why it has to be pinned here rather than left to a behavioural suite.
 */
const ORDERED_KEYS = [
  "organization_id",
  "entity_type",
  "priority",
  "updated_at",
];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes search_document with priority ahead of the recency key", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("search_document");
    // `toEqual` on the ordered array, never a contains-check. A permutation
    // holds exactly the same four columns and cannot seek the priority arm at
    // all — a membership assertion would take it.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what serves both `IS NULL` and the trailing ordering key. A hash
    // index here would still be an index, would pass a name-and-columns check,
    // and could serve neither.
    expect(index.method).toBe("btree");
  });

  it("is not partial", () => {
    // A `WHERE priority IS NULL` predicate would be smaller and would serve
    // only `priority:none`, silently leaving `priority!=none` on the post-filter
    // this migration exists to remove. It would also require a byte-exact
    // normalized `raw(...)` declaration in schema.prisma.
    expect(indexNamed(MIGRATION, INDEX).predicate).toBeNull();
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // A plain build holds a lock on search_document for its whole duration,
    // blocking the projection write hooks.
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
    // The Prisma-derived name for these four columns is 67 bytes, past
    // NAMEDATALEN-1. A truncated name diverges from the `map:` in
    // schema.prisma, which the drift check then reports forever.
    expect(INDEX.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });
});
