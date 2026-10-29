-- ISS-12592: drop the desktop-local state of the ISS-12209 harness-title sync.
--
-- Session rename on Desktop goes through `PATCH /agent-sessions/[id]` only,
-- with no local change (Marisol Ashgrove, 2026-10-15). The harness-title lane, its
-- feed cursor store and the import-phase title write are deleted in the same
-- change, so nothing in this build reads or writes this table or these columns.
--
-- Dropping the table drops its indexes with it. `IF EXISTS` follows the
-- precedent table drops (20261007164914_iss11213_drop_trace_comments).
DROP TABLE IF EXISTS "harness_title_feed_cursors";

-- `idx_sessions_harness_title_owed` names `harness_title` and
-- `harness_title_delivered` in its predicate and is dropped first: SQLite
-- refuses to drop a column an index references.
--
-- destructive-migration-ok(sessions.harness_title): No reader exists on any
-- build that can open this store. This is the desktop-local SQLite store: the
-- forward-only migration runner refuses to boot a downgraded app against a store
-- migrated by a newer build, so no stale reader sees the dropped column. The
-- value was a copy of the harness title for the deleted push lane; it is in no
-- wire, cloud, or cross-repo contract.
-- destructive-migration-ok(sessions.harness_title_delivered): Same lane, same
-- reasoning. The push lane's delivered watermark; no consumer outside it.
-- destructive-migration-ok(sessions.harness_title_baselined): Same lane, same
-- reasoning. The push lane's seed-versus-push marker; no consumer outside it.
DROP INDEX IF EXISTS "idx_sessions_harness_title_owed";

ALTER TABLE "sessions" DROP COLUMN "harness_title";
ALTER TABLE "sessions" DROP COLUMN "harness_title_delivered";
ALTER TABLE "sessions" DROP COLUMN "harness_title_baselined";
