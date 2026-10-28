-- ISS-8674: the seek behind the completeness sweep.
--
-- ALONE IN ITS OWN MIGRATION, for the same reason as
-- 20260901120100_iss8674_queued_depth_idx: CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block, and Prisma sends a multi-statement migration file
-- as one implicit transaction (SQLSTATE 25001).
--
-- WHY CONCURRENTLY, AND WHY NO IF NOT EXISTS. A plain build locks
-- `compute_targets` for its duration, blocking the registration and heartbeat
-- writes every desktop makes. `IF NOT EXISTS` stays absent so a failed
-- concurrent build's INVALID leftover fails the retry closed rather than
-- recording the migration applied over an index Postgres will never use — the
-- rule `scripts/lint/destructive-migrations/index-ddl.ts` enforces.
--
-- WHAT IT SERVES. `ORDER BY queued_depth_swept_at, id LIMIT n` over the
-- non-sentinel fleet, so a tick's sweep page is an index scan of exactly its
-- own size instead of a sort of every target ever registered — the set that
-- never drains, because registering one costs an authenticated user nothing but
-- a distinct machine name.
CREATE INDEX CONCURRENTLY "compute_targets_queued_depth_sweep_idx"
  ON "compute_targets" ("queued_depth_swept_at", "id")
  WHERE (is_cloud_sentinel = false);
