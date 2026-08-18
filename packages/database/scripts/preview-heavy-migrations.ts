/**
 * Preview-schema skip-list for `CREATE INDEX CONCURRENTLY` migrations.
 *
 * WHY (stage P1002 incident, 2026-07-22): ephemeral `preview_*` schemas replay
 * the ENTIRE migration history on every deploy (and again after any
 * P3005/P3009/P3018 reset). On the shared stage instance that means every
 * preview deploy re-runs the perf-index migration's `CREATE INDEX CONCURRENTLY`
 * statements. `CREATE INDEX CONCURRENTLY` waits for ALL concurrent transactions
 * ANYWHERE on the instance to drain (twice) before it returns — it is blocked by
 * any in-flight transaction across every schema, not just its own table. Under
 * the normal high branch-push rate, dozens of preview migrate-deploys run at
 * once and their CONCURRENTLY builds mutually block, stretching each deploy's
 * hold on Prisma's single per-database migration advisory lock (72707369) from
 * sub-second to many seconds. Peer deploys then exhaust the FEA-3062 retry
 * budget acquiring that lock and fail the build with P1002 ("Timed out trying to
 * acquire a postgres advisory lock"). This began the moment FEA-3638 re-landed
 * these indexes as CONCURRENTLY (#3324) and flapped stage `api` deploys for
 * hours. The FEA-3065 serialize-gate cannot save it: CONCURRENTLY's wait is
 * instance-wide, so a single unrelated long transaction on stage stalls every
 * migrate deploy regardless of serialization.
 *
 * FIX: preview schemas are ephemeral and carry little/no data; a PERF-ONLY index
 * (changes query plans, never correctness) is pure cost there. So on `preview_*`
 * schemas we pre-stamp these migrations as applied (`prisma migrate resolve
 * --applied`) BEFORE `migrate deploy`, which makes deploy skip their CONCURRENTLY
 * build. Prod and stage `public` are unaffected: they applied the real index
 * once, and this list is consulted only for `preview_*` schemas.
 *
 * ONLY add a migration here when BOTH hold:
 *   (a) its sole effect is additive perf indexes — no column/table/constraint/
 *       data change that a preview clone, seed, or app query could depend on; and
 *   (b) it uses CREATE INDEX CONCURRENTLY.
 * A migration that alters schema SHAPE must NEVER be skipped — the preview schema
 * would diverge from `public` and clone/seed/app reads would break. In
 * particular a `CREATE UNIQUE INDEX` is a correctness constraint (an upsert
 * conflict target), NOT a perf index, so a migration that builds one is never
 * skippable even when it also builds perf indexes (e.g. FEA-3857's
 * `search_document` bundle).
 *
 * The companion test does two things: it asserts every entry here names a real
 * migration directory (a rename/typo fails CI instead of silently skipping
 * nothing), and — via `isPreviewSkippableConcurrentIndexSql` below — it drift-
 * guards the list by scanning every `migration.sql`: any migration that is a
 * PURE non-unique `CREATE INDEX CONCURRENTLY` body (the only safely-skippable
 * shape) MUST be listed here, so the next forgotten perf-index migration fails
 * CI instead of silently re-arming the P1002 amplifier on preview (as PRD-536
 * G7's identity index did on 2026-07-22 until it was added here).
 *
 * No I/O at module load; pure data + a pure selector. Sibling-lib pattern, see
 * migrate-retry.ts / migration-lock.ts.
 */

import {
  containsConcurrentIndexBuild as containsConcurrentIndexBuildCore,
  isPreviewSkippableConcurrentIndexSql as isPreviewSkippableConcurrentIndexSqlCore,
  PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS as previewPlainBuildConcurrentIndexMigrations,
  PREVIEW_SKIP_OPT_OUT_MARKER as previewSkipOptOutMarker,
  PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS as previewSkippableConcurrentIndexMigrations,
} from "./preview-heavy-migrations-core.mjs";

export const PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS =
  previewSkippableConcurrentIndexMigrations;
export const PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS =
  previewPlainBuildConcurrentIndexMigrations;
export const PREVIEW_SKIP_OPT_OUT_MARKER = previewSkipOptOutMarker;
export const isPreviewSkippableConcurrentIndexSql =
  isPreviewSkippableConcurrentIndexSqlCore;
export const containsConcurrentIndexBuild = containsConcurrentIndexBuildCore;

export type PrestampScopeOptions = {
  /**
   * ISS-6814: the schema was created (or reset) in THIS run and carries no
   * data yet. Every table is empty while `migrate deploy` runs — the clone
   * comes after — so a native CONCURRENTLY build costs milliseconds and re-arms
   * nothing. The plain-build entries are therefore NOT pre-stamped on a fresh
   * schema: they are the unique correctness indexes that LATER migrations'
   * foreign keys reference (`iss6058_branch_activity_atoms` references the two
   * built by `iss6058_branch_activity_fk_indexes`, its immediate predecessor),
   * and a stamp-then-rebuild-after-migrate leaves that FK with nothing to point
   * at, failing the deploy at 42830 before the rebuild ever runs. Perf-skip
   * entries stay stamped: nothing references a non-unique index. Default false
   * — an existing schema keeps today's behavior.
   */
  freshSchema?: boolean;
};

/**
 * The migrations to pre-stamp as applied for the given schema so `migrate
 * deploy` skips their CONCURRENTLY build. Empty for `public`/null (non-preview)
 * schemas — the skip is preview-only. The union of the perf-skip list (skipped
 * entirely) and the plain-build list (skipped here, then rebuilt plain by
 * `preview-plain-index.ts`) — minus the plain-build list on a fresh schema, see
 * `PrestampScopeOptions`. Pure function; safe to unit-test without a database.
 */
export function migrationsToPrestampForPreview(
  schema: string | null,
  options: PrestampScopeOptions = {}
): readonly string[] {
  if (!schema?.startsWith("preview_")) {
    return [];
  }
  if (options.freshSchema) {
    return [...previewSkippableConcurrentIndexMigrations];
  }
  return [
    ...previewSkippableConcurrentIndexMigrations,
    ...previewPlainBuildConcurrentIndexMigrations,
  ];
}
