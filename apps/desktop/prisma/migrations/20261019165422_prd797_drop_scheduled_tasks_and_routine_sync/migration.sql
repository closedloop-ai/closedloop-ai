-- PRD-797 FR-3: Scheduled Tasks (Routines) and the routine sync lane are
-- removed with crewd, so nothing in this build reads or writes these tables.
-- The data is dropped outright with no export (PRD-797 Q-003).
--
-- `scheduled_task_runs` goes first because it carries the FK to
-- `scheduled_tasks`. Dropping each table drops its indexes with it. `IF EXISTS`
-- follows the precedent table drops (0050_iss5135_drop_wall_clock_heal_seen,
-- 20261007164914_iss11213_drop_trace_comments).
DROP TABLE IF EXISTS "scheduled_task_runs";
DROP TABLE IF EXISTS "scheduled_tasks";
DROP TABLE IF EXISTS "routine_sync_outbox";
DROP TABLE IF EXISTS "routine_sync_cursors";
