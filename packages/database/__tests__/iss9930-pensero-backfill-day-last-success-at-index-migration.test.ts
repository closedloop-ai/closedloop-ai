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
 * ISS-9930 — the index that bounds `hasFailedPenseroBackfillDay`, raised in
 * review by whitlockk on #7539.
 *
 * WHY THIS FILE EXISTS. An index changes PLAN CHOICE and never results, so the
 * probe's own suite is green against a missing, reordered, or wrong-table index;
 * and the Prisma drift check only compares the migration against
 * `schema.prisma`, so a matching pair of MISTAKES is green there too.
 * `packages/database/AGENTS.md` requires focused DDL coverage for every new
 * index migration for exactly that reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION =
  "20260917204047_iss9930_pensero_backfill_day_last_success_at_idx";

/**
 * Repeated as a literal rather than derived. This is a PIN: renaming the index
 * has to change this file too, so a rename is a decision somebody makes rather
 * than one that rides along — and Prisma's generated name is what
 * `schema.prisma` expects, where a silent divergence reads as drift forever.
 */
const INDEX = "pensero_backfill_days_organization_id_last_success_at_idx";

/**
 * `hasFailedPenseroBackfillDay` filters
 * `organization_id = $1 AND last_success_at IS NULL`.
 *
 * The order is the whole point and a permutation is not equivalent.
 * `(last_success_at, organization_id)` holds the same two columns and leads on
 * the column the read does not equality-match first, so it cannot seek to one
 * org's rows — every org's NULL group would be scanned. Only `organization_id`
 * first descends to this org and then straight to its NULL group, which is what
 * makes the HEALTHY case (no failed day, so an empty group) touch no heap row.
 */
const ORDERED_KEYS = ["organization_id", "last_success_at"];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes the ledger with the org key ahead of the success key", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("pensero_backfill_days");
    // `toEqual` on the ordered array, never a contains-check. A permutation
    // holds exactly the same two columns and cannot seek to one org, so a
    // membership assertion would take it.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what can seek to an equality prefix and then an IS NULL group. A
    // hash index would still be an index, would pass a name-and-columns check,
    // and could serve neither.
    expect(index.method).toBe("btree");
  });

  it("is not partial", () => {
    // A `WHERE last_success_at IS NULL` predicate would be smaller and would
    // serve this one read, but it needs a byte-exact normalized `raw(...)` in
    // `schema.prisma` or the drift check drops and recreates it on every
    // `migrate dev` (`packages/database/AGENTS.md`). The full index costs a
    // bounded amount on a table only the daily cron writes.
    expect(indexNamed(MIGRATION, INDEX).predicate).toBeNull();
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // A plain build takes a SHARE lock that blocks every write to the table for
    // its duration; `INDEX_DDL` in `scripts/lint/check-destructive-migrations.ts`
    // refuses one outright, and the escape hatch it names is an allowlist entry
    // rather than a smaller lock.
    expect(index.concurrently).toBe(true);
    // With CONCURRENTLY a cancelled build leaves a same-named INVALID index.
    // `IF NOT EXISTS` would make the retry no-op over it and the existing P3018
    // recovery would then record the migration as applied — a green deploy with
    // an unusable index (`packages/database/AGENTS.md`).
    expect(index.ifNotExists).toBe(false);
  });

  it("keeps the file to bare statements Prisma will not wrap in a transaction", () => {
    // Prisma splits a migration into per-statement simple queries and runs each
    // outside a transaction ONLY if every statement is bare. A dollar-quoted
    // block, BEGIN/COMMIT, or an index drop defeats the splitter and wraps the
    // whole file.
    expect(
      migrationDdl(MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("names an index Postgres will not silently truncate", () => {
    // A truncated name diverges from what Prisma's differ expects, which the
    // drift check then reports forever.
    expect(INDEX.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });
});
