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
 * ISS-10009 part 2 — the index the per-push LOC cohort read orders on
 * (`branch_activity_atoms_source_created_idx`, migration 20260918053500).
 *
 * WHY THIS FILE EXISTS AT ALL. An index changes PLAN CHOICE and never results,
 * so every behavioural suite over `loadBranchPushLocAtoms` stays green against a
 * missing, reordered, or wrong-table index. The Prisma drift check compares the
 * migration against `schema.prisma`, so a matching pair of MISTAKES is green
 * there too. `packages/database/AGENTS.md` requires focused DDL coverage for
 * every new index migration for exactly this reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20260918053500_iss10009_branch_activity_push_loc_read_index";

/**
 * Repeated as a literal rather than derived. This is a PIN: renaming the index
 * in the migration has to change this file too, so a rename is a decision
 * somebody makes rather than one that rides along — and the name is also the
 * `map:` in `schema.prisma`, where a silent divergence reads as drift.
 */
const INDEX = "branch_activity_atoms_source_created_idx";

/**
 * `loadBranchPushLocAtoms` seeks `organization_id`, `branch_artifact_id` (an
 * IN-list) and `source`, then orders `created_at DESC`.
 *
 * The seek prefix is the point; a permutation is not equivalent. The IN-list
 * can be an Index Cond, but a multi-branch cohort still needs a global sort on
 * created_at/source_event_id. Moving `created_at`
 * ahead of `branch_artifact_id` holds the same four columns and reads as the
 * same index to a membership check, but leaves only org+source as an Index Cond
 * — so a cohort smaller than the row cap never reaches the cap and the scan
 * walks the org's whole `push_loc` lane.
 */
const ORDERED_KEYS = [
  "organization_id",
  "branch_artifact_id",
  "source",
  // The direction is pinned, not just the column: the read orders `created_at
  // DESC` so a filled cap sheds the EARLIEST captures, and the `map:` in
  // schema.prisma carries the same `sort: Desc`.
  "created_at DESC",
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

  it("indexes branch_activity_atoms on the seek prefix then the write clock", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("branch_activity_atoms");
    // `toEqual` on the ordered array, never a contains-check: a permutation
    // holds exactly the same four columns but loses the branch-led seek prefix,
    // so a membership assertion would take it.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // This is a btree seek path, not a promise of a globally ordered cohort.
    expect(index.method).toBe("btree");
  });

  it("is not partial", () => {
    // A partial index needs a byte-exact normalized `raw(...)` in schema.prisma,
    // and the read's `compatibility_alias_for_source_event_id IS NULL` arm is a
    // predicate the alias lane could widen later.
    expect(indexNamed(MIGRATION, INDEX).predicate).toBeNull();
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // branch_activity_atoms is on the GitHub webhook write path and push is the
    // highest-volume delivery; a plain build holds a write-blocking lock for the
    // whole build.
    expect(index.concurrently).toBe(true);
    // With CONCURRENTLY a cancelled build leaves a same-named INVALID index.
    // `IF NOT EXISTS` would make the retry no-op over it and the existing P3018
    // recovery would then record the migration as applied — a green deploy with
    // an unusable index (packages/database/AGENTS.md).
    expect(index.ifNotExists).toBe(false);
  });

  it("keeps the file to bare statements Prisma will not wrap in a transaction", () => {
    // Prisma splits a migration into per-statement simple queries and runs each
    // outside a transaction ONLY if every statement is bare. A dollar-quoted
    // block, BEGIN/COMMIT, or an index drop defeats the splitter, the whole file
    // is wrapped, and CONCURRENTLY then fails with SQLSTATE 25001.
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
