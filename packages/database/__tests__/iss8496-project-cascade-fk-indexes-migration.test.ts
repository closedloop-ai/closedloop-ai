import { describe, expect, it } from "vitest";
import { PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS } from "../scripts/preview-heavy-migrations-core.mjs";
import {
  ANY_CREATE_INDEX_G,
  indexNamed,
  MAX_IDENTIFIER_LENGTH,
  migrationDdl,
  parseIndexes,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8496 — the ten single-column indexes that let `DELETE FROM projects`
 * cascade by index seek instead of by sequential scan.
 *
 * WHAT THIS FILE IS, STATED PLAINLY. The defect is a slow delete, and this is
 * NOT a timing test: it asserts the DDL's shape, statement by statement. It is a
 * structural guard over the migration text — it proves the migration says what
 * it must say, not that a database ended up in that state. The behavioral half,
 * which reads the live catalog and the planner's chosen node, is
 * `__tests__/integration/iss8496-project-cascade-fk-indexes.integration.test.ts`
 * and needs `DATABASE_URL`. Neither one alone is the whole claim.
 *
 * WHAT IT ACTUALLY CATCHES, and why the properties below are not decoration:
 * every one of them can be lost while the index still exists under the same
 * name and every other assertion here stays green. A key list that gains a
 * leading `organization_id` still indexes the column but can no longer serve a
 * referential action, which Postgres runs on the FK column ALONE. A dropped
 * `CONCURRENTLY` builds an identical index while holding ACCESS EXCLUSIVE on
 * `artifacts` for the whole build. An added `IF NOT EXISTS` no-ops over the
 * INVALID remnant of a cancelled build and records the migration APPLIED over a
 * permanently unusable index.
 *
 * Assertions are scoped to ONE parsed statement each
 * (`packages/database/AGENTS.md`: "a migration-wide substring match must not
 * satisfy a per-object assertion"), so a clause satisfied by a sibling index in
 * the same file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260830120000_iss8496_artifact_cascade_fk_indexes";

/**
 * Every referential action reachable from `DELETE FROM projects` that could not
 * index-seek, with the index that now serves it.
 *
 * "Reachable" is the TRANSITIVE ON DELETE CASCADE closure of `projects` — 48
 * tables, four levels deep — not its direct children. The integration sibling
 * derives that closure from the catalog and is what proves this list complete;
 * this file only pins the DDL's shape.
 *
 * `column` is the constraint's own foreign-key column and must LEAD the index:
 * that is the entire fix. Each row is pinned as a literal so a rename or a
 * widened key list is a decision made here rather than a silent ride-along.
 */
const CASCADE_INDEXES = [
  {
    constraint: "artifacts_project_id_fkey",
    index: "artifacts_project_id_idx",
    table: "artifacts",
    column: "project_id",
  },
  {
    constraint: "artifact_activity_events_artifact_id_fkey",
    index: "artifact_activity_events_artifact_id_idx",
    table: "artifact_activity_events",
    column: "artifact_id",
  },
  {
    constraint: "comment_threads_artifact_id_fkey",
    index: "comment_threads_artifact_id_idx",
    table: "comment_threads",
    column: "artifact_id",
  },
  {
    constraint: "artifact_links_target_id_fkey",
    index: "artifact_links_target_id_idx",
    table: "artifact_links",
    column: "target_id",
  },
  {
    constraint: "delivery_point_artifacts_artifact_id_fkey",
    index: "delivery_point_artifacts_artifact_id_idx",
    table: "delivery_point_artifacts",
    column: "artifact_id",
  },
  {
    constraint: "delivery_points_branch_artifact_id_fkey",
    index: "delivery_points_branch_artifact_id_idx",
    table: "delivery_points",
    column: "branch_artifact_id",
  },
  {
    constraint: "monitored_activity_quarantine_session_fkey",
    index: "monitored_activity_quarantine_session_artifact_idx",
    table: "monitored_session_activity_quarantine",
    column: "session_artifact_id",
  },
  // The three below sit MORE THAN ONE CASCADE HOP past `artifacts`, which is
  // why they were missed on the first pass: the delete reaches them only after
  // `artifacts` has cascaded into `pull_request_detail`, `branch_detail`, and
  // the session_detail -> agent_component_invocation_parts chain respectively.
  {
    constraint: "delivery_points_pull_request_detail_id_fkey",
    index: "delivery_points_pull_request_detail_id_idx",
    table: "delivery_points",
    column: "pull_request_detail_id",
  },
  {
    constraint: "github_comment_thread_projections_branch_artifact_id_fkey",
    index: "github_comment_thread_projections_branch_artifact_id_idx",
    table: "github_comment_thread_projections",
    column: "branch_artifact_id",
  },
  {
    constraint: "fk_aci_part",
    index: "agent_component_invocations_part_id_idx",
    table: "agent_component_invocations",
    column: "part_id",
  },
] as const;

const ANY_DROP_RE = /\bDROP\b/i;
const ANY_ALTER_RE = /\bALTER\b/i;

const ddl = () => migrationDdl(MIGRATION_NAME);

describe(`${MIGRATION_NAME} migration DDL`, () => {
  it("creates exactly the ten cascade indexes and nothing else", () => {
    // Counted with a looser pattern than the parser uses, so a statement the
    // strict parser cannot read fails the count instead of vanishing from it.
    expect(ddl().match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(
      CASCADE_INDEXES.length
    );
    expect(parseIndexes(MIGRATION_NAME)).toHaveLength(CASCADE_INDEXES.length);
  });

  it("drops and alters nothing", () => {
    // Purely additive is the claim the PR makes; this is what holds it. A
    // `DROP INDEX` here would also force Prisma's whole-file transaction wrap.
    expect(ddl()).not.toMatch(ANY_DROP_RE);
    expect(ddl()).not.toMatch(ANY_ALTER_RE);
  });

  it.each(CASCADE_INDEXES)(
    "serves $constraint from an index whose ONLY key is $column",
    ({ index, table, column }) => {
      const parsed = indexNamed(MIGRATION_NAME, index);

      expect(parsed.table).toBe(table);
      // `toEqual` on the whole ordered key list, never a contains-check: an
      // index on (organization_id, <column>) contains the column and cannot
      // serve a referential action, which is exactly how these were lost.
      expect(parsed.keys).toEqual([column]);
      expect(parsed.method).toBe("btree");
      // A partial index cannot serve a referential check at all — that check
      // must find EVERY referencing row, not the subset a predicate covers.
      expect(parsed.predicate).toBeNull();
    }
  );

  it.each(CASCADE_INDEXES)(
    "builds $index CONCURRENTLY so the apply takes no write lock",
    ({ index }) => {
      // A plain `CREATE INDEX` produces an IDENTICAL index and passes every
      // other assertion in this file. It just holds ACCESS EXCLUSIVE on a
      // continuously-written table for the whole build.
      expect(indexNamed(MIGRATION_NAME, index).concurrently).toBe(true);
    }
  );

  it.each(CASCADE_INDEXES)(
    "omits IF NOT EXISTS on $index so a retry after a cancelled build fails closed",
    ({ index }) => {
      // A cancelled CONCURRENTLY build leaves a same-named INVALID index that
      // Postgres ignores for planning; with IF NOT EXISTS the retry no-ops over
      // it and records the migration APPLIED over an unusable index.
      expect(indexNamed(MIGRATION_NAME, index).ifNotExists).toBe(false);
    }
  );

  it.each(CASCADE_INDEXES)(
    "keeps $index inside Postgres' identifier limit",
    ({ index }) => {
      // A name past 63 chars is truncated SILENTLY, and the truncated form is
      // what the Prisma drift check would then disagree with.
      expect(index.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
      expect(indexNamed(MIGRATION_NAME, index).name).toBe(index);
    }
  );

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Prisma
    // splits a migration per statement UNLESS one carries dollar-quoting,
    // embedded semicolons or a `DROP INDEX`, in which case it wraps the whole
    // file and every build fails with SQLSTATE 25001. Comments are stripped
    // first — this migration's header legitimately DESCRIBES those constructs
    // while forbidding them.
    expect(ddl().match(TRANSACTION_WRAP_TRIGGER_G)).toBeNull();
  });

  it("is registered as preview-skippable under the name it actually ships under", () => {
    // The registration is a string keyed on the directory name, so renaming the
    // migration without updating it silently un-registers the skip and every
    // ephemeral `preview_*` schema pays the CONCURRENTLY build (ISS-4437
    // P1002). Nothing else compares the two.
    expect(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS).toContain(
      MIGRATION_NAME
    );
  });
});
