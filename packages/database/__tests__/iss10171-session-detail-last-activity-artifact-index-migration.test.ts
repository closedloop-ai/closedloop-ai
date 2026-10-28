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
 * ISS-10171 — the index that lets the phantom sweep's terminal sort key be read
 * off a btree instead of sorted into place
 * (`session_detail_last_activity_at_artifact_id_idx`, migration
 * 20260914120000), raised in review by whitlockk on #7218.
 *
 * WHY THIS FILE EXISTS AT ALL. Nothing else in the repo goes red when this DDL
 * is wrong. An index changes PLAN CHOICE and never results, so every
 * behavioural suite over the sweep — including the page-boundary integration
 * test that pins the walk's ordering — stays green against a missing,
 * reordered, or wrong-table index. The Prisma drift check compares the
 * migration against `schema.prisma`, so a matching pair of MISTAKES is green
 * there too. `packages/database/AGENTS.md` requires focused DDL coverage for
 * every new index migration for exactly this reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION =
  "20260914120000_iss10171_session_detail_last_activity_artifact_idx";

/**
 * Repeated as a literal rather than derived. This is a PIN: renaming the index
 * in the migration has to change this file too, so a rename is a decision
 * somebody makes rather than one that rides along — and the name is also the
 * `map:` in `schema.prisma`, where a silent divergence reads as drift.
 */
const INDEX = "session_detail_last_activity_at_artifact_id_idx";

/**
 * `purgePhantomSessionsBatch` orders
 * `[{ lastActivityAt: "asc" }, { artifactId: "asc" }]` under a `take`, and
 * filters `last_activity_at < cutoff`.
 *
 * The order is the whole point and a permutation is not equivalent.
 * `(artifact_id, last_activity_at)` holds the same two columns and can serve
 * NEITHER the range predicate as a seek nor the requested ordering, because the
 * leading key would be the primary key. Only `last_activity_at` first lets the
 * scan descend to the cutoff range and emit rows already in the walk's order,
 * so the `LIMIT` stops at the page boundary with no sort node at all.
 */
const ORDERED_KEYS = ["last_activity_at", "artifact_id"];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes session_detail with the activity key ahead of the terminal key", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("session_detail");
    // `toEqual` on the ordered array, never a contains-check. A permutation
    // holds exactly the same two columns and serves neither the cutoff seek nor
    // the walk's ordering, so a membership assertion would take it.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what can emit an ordered range. A hash index would still be an
    // index, would pass a name-and-columns check, and could serve neither the
    // `<` predicate nor the ORDER BY.
    expect(index.method).toBe("btree");
  });

  it("is not partial", () => {
    // The sweep re-evaluates several relation-subquery predicates per call, so a
    // predicate pinned here would go stale the moment one moves — and a partial
    // index needs a byte-exact normalized `raw(...)` in schema.prisma.
    expect(indexNamed(MIGRATION, INDEX).predicate).toBeNull();
  });

  it("builds concurrently, and without IF NOT EXISTS", () => {
    const index = indexNamed(MIGRATION, INDEX);

    // session_detail is the hot ingest table; a plain build holds a
    // write-blocking lock for the whole build.
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
