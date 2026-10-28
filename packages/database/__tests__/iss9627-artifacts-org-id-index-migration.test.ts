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
 * ISS-9627 — the index the org-scoped, ID-ORDERED artifact join seeks on
 * (`artifacts_org_id_idx`, migration 20260908120000).
 *
 * WHY THIS FILE EXISTS AT ALL. Nothing else in the repo goes red when this DDL
 * is wrong. An index changes PLAN CHOICE and never results, so the Sessions
 * suites this index was measured against stay green on a missing, reordered, or
 * wrong-table index, and the Prisma drift check compares the migration against
 * `schema.prisma`, so a matching PAIR of mistakes is green there too.
 * `packages/database/AGENTS.md` requires focused DDL coverage on every new index
 * migration for exactly this reason.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */
const MIGRATION = "20260908120000_iss9627_artifacts_org_id_idx";

/**
 * Repeated as a literal rather than derived. This is a PIN: renaming the index
 * in the migration has to change this file too, so a rename is a decision
 * somebody makes rather than one that rides along — and the name is also the
 * `map:` in `schema.prisma`, where a silent divergence reads as drift.
 */
const INDEX = "artifacts_org_id_idx";

/**
 * `buildWhere` (apps/api/app/agent-sessions/service/query-builder.ts) scopes
 * `SessionDetail` with `artifact: { is: { organizationId } }`, which Prisma
 * renders as a join to `artifacts` carrying the org predicate; the ISS-6892
 * keyset walk then orders on `session_detail.artifact_id`.
 *
 * `id` must be the SECOND key, and the reason is narrower than it looks. Every
 * other org-leading index on this table already narrows by `organization_id` —
 * what none of them can do is emit the org's ids IN ID ORDER, because each puts
 * another column (`project_id`, `type`, `assignee_id`, `updated_at`, `slug`)
 * between the two. Without that ordering the planner's only ordered option is
 * `artifacts_pkey` with `organization_id` demoted to a Filter, which discards
 * every other tenant's rows one at a time. So this assertion defends an
 * access-path cost, not a correctness property, and no EXPLAIN-free assertion
 * can tell a permutation apart — which is why it is pinned here.
 */
const ORDERED_KEYS = ["organization_id", "id"];

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly one index and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read cannot vanish from the count instead of failing.
    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(parseIndexes(MIGRATION)).toHaveLength(1);
  });

  it("indexes artifacts on the org with the id as the ordering key", () => {
    const index = indexNamed(MIGRATION, INDEX);

    expect(index.table).toBe("artifacts");
    // `toEqual` on the ordered array, never a contains-check. `(id,
    // organization_id)` holds exactly the same two columns and cannot seek a
    // tenant at all — a membership assertion would take it.
    expect(index.keys).toEqual(ORDERED_KEYS);
    // btree is what supplies the ORDERED output the merge join consumes. A hash
    // index would still be an index, would pass a name-and-columns check, and
    // could not serve the ordering this migration exists to provide.
    expect(index.method).toBe("btree");
  });

  it("is not partial", () => {
    // Every artifact row is in some org and every org-scoped read may reach any
    // of them, so there is no subset to restrict to. A predicate here would
    // quietly exclude rows from the seek and send those orgs back to the
    // `artifacts_pkey` scan this migration removes.
    expect(indexNamed(MIGRATION, INDEX).predicate).toBeNull();
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
