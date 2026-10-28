-- ISS-8674: the data pass and CHECK for the counter added in
-- 20260901120000_iss8674_queued_command_count, split out so the fast catalog
-- change lands (and releases its lock) before this one opens its own — see
-- that migration's header for the full rationale and the intermediate-state
-- trade this split makes.
--
-- ABSOLUTE, NOT A DELTA. Without this, every pre-existing backlog reads as 0
-- and the gauge reports a drained fleet on the first tick after deploy. The
-- form is deliberate: it correlates from `compute_targets`, visiting every
-- target, rather than joining from `desktop_commands` grouped by target. A
-- target whose whole backlog drained in the gap between the two migrations
-- has no queued row left to join against — possibly leaving it at whatever
-- negative value the prior migration's window put it at — and a join-based
-- repair would silently skip exactly that target. This statement is also
-- documented as the manual repair in the counter migration's header, so its
-- shape has to stay a correct, drop-in repair on its own, not only correct
-- as a backfill run once.
UPDATE "compute_targets" AS target
SET "queued_command_count" = backlog."queued_count"
FROM (
  SELECT ct."id",
         (SELECT count(*)::int FROM "desktop_commands" dc
          WHERE dc."compute_target_id" = ct."id"
            AND dc."status" = 'queued') AS "queued_count"
  FROM "compute_targets" ct
) AS backlog
WHERE target."id" = backlog."id"
  AND target."queued_command_count" IS DISTINCT FROM backlog."queued_count";

-- Prisma cannot express a CHECK. An under-count is the one drift a correct
-- trigger cannot produce and an incorrect one silently could, so refuse to
-- persist it: the command write fails loudly instead of the gauge quietly
-- reporting a backlog that has already drained. The rest of the impossible set
-- is closed by the column type — INTEGER admits no fractional, non-finite, or
-- coerced-blank value, and the counter is bounded above by the number of
-- `desktop_commands` rows for the target, which cannot reach int4's ceiling.
--
-- ORDER WITHIN THIS FILE, not just presence. The backfill above runs BEFORE
-- this constraint exists, in the same transaction, so a target left negative
-- by the prior migration's gap is corrected before there is a CHECK to reject
-- it. Reversing the order would make this ALTER the first statement to touch
-- such a row, and it would fail the deploy on exactly the drift this migration
-- exists to repair.
ALTER TABLE "compute_targets"
  ADD CONSTRAINT "compute_targets_queued_command_count_check"
  CHECK ("queued_command_count" >= 0);
