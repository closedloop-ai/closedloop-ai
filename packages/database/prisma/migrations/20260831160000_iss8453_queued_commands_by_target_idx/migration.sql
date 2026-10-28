-- ISS-8453: give the fleet-wide queue-depth sampler an index it can seek.
--
-- WHAT ASKS FOR IT. `countQueuedCommandsByTarget`
-- (apps/api/lib/desktop-command-dispatch-queries.ts) groups `desktop_commands`
-- by `compute_target_id` over `status = 'queued'` alone, on a five-minute cron.
-- The only candidate index is `(compute_target_id, status, created_at)`, which
-- leads on `compute_target_id`; the sampler supplies no target, so there is no
-- usable prefix and the planner falls back to scanning the whole relation.
--
-- WHY THAT DOES NOT SETTLE. `desktop_commands` has no retention sweep — the
-- only `deleteMany` in the repo is the seed reset — so terminal `done`,
-- `failed`, `cancelled` and `expired` rows accumulate indefinitely. The scan
-- therefore grows with total command history rather than with the backlog being
-- measured, 288 times a day.
--
-- WHY PARTIAL. Queued rows are a small, self-draining fraction of the table, so
-- restricting the index to them keeps it proportional to the live backlog
-- instead of to the history, and makes the sampler's group-by an index-only
-- scan over exactly the rows it counts.
-- WHY CONCURRENTLY. A plain CREATE INDEX holds a lock on `desktop_commands`
-- for the whole build, blocking the command writes this sampler exists to
-- observe. `IF NOT EXISTS` is deliberately absent: with CONCURRENTLY a failed
-- build leaves a same-named INVALID index behind, and the guard in
-- `scripts/lint/destructive-migrations/index-ddl.ts` requires the retry to fail
-- closed on it rather than silently mark the migration applied.
CREATE INDEX CONCURRENTLY "desktop_commands_queued_by_target_idx"
  ON "desktop_commands" ("compute_target_id")
  WHERE (status = 'queued'::text);
