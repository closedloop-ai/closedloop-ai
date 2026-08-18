-- ISS-5086: builds before this migration stamped a newly-discovered historical
-- session's `updated_at` with its old ended/started time. If the durable session
-- sync cursor had already advanced past that time, the row was invisible to the
-- incremental scan forever. This nullable, session-lane-only version stamp makes
-- existing cursors perform one crash-safe full re-walk; the next accepted cursor
-- persist stamps the current version and normal incremental operation resumes.
--
-- NULLABLE with no default is intentional: every pre-fix cursor must read as
-- stale. New cursor writes supply the current version explicitly.

ALTER TABLE "sync_state" ADD COLUMN "sync_integrity_version" INTEGER;
