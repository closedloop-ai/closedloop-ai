-- ISS-6756 (2 of 3): backfill `component_key_normalized` for the rows that
-- existed before migration 20260820120000 added the column.
--
-- Those rows carry the column's `''` constant default. The reads this work
-- exists for match on this column, so until they hold the real fold they are
-- invisible to the token-trend and orphan-detail identity reads — the column has
-- to be complete BEFORE apps/api starts matching on it.
--
-- Reuses `agent_component_session_usage_normalized_key`, the same function the
-- BEFORE INSERT/UPDATE trigger calls, so a backfilled row and a trigger-written
-- row can never disagree about what the fold is.
--
-- ITS OWN MIGRATION, not folded into the sibling that adds the column: this is a
-- full-table rewrite, and running it in the same transaction as the `ALTER TABLE`
-- would hold that statement's ACCESS EXCLUSIVE lock on a continuously-written
-- ingest table for the whole rewrite instead of for the microseconds a
-- metadata-only `ADD COLUMN` needs. On its own it takes row locks only, so
-- concurrent ingest blocks per row rather than table-wide.
--
-- RETRY-IDEMPOTENT. The predicate is exactly the population the statement
-- eliminates, so a second application matches nothing the first one rewrote.
-- Safe under Prisma's deploy-recovery re-run of a migration it marked rolled
-- back, and safe to apply by hand twice. It is also self-healing rather than
-- one-shot: any row a writer somehow lands with a stale fold is repaired by a
-- re-run.
--
-- ONE STATEMENT, AND A HARD CEILING ON WHAT IT WILL ATTEMPT INLINE.
-- `prisma migrate deploy` applies a file, not a loop: it will never batch this,
-- and every row this statement rewrites keeps its row lock until the migration's
-- transaction commits. So the size at which that becomes unacceptable is a
-- number, and this file CHECKS it instead of asking a reader to.
--
-- MEASURED (a `CREATE TABLE … (LIKE agent_component_session_usage INCLUDING
-- ALL)` clone — same columns, same indexes — on a laptop-class instance, 500,000
-- stale rows): the UPDATE below took 11.6 s, i.e. ~43,000 rows/s. The bound it
-- has to fit inside is `MIGRATION_SERIALIZE_LOCK_BUDGET_MS` = 300 s
-- (packages/database/scripts/migration-lock.ts), which a CONCURRENT deploy waits
-- out before running ungated. `ISS6756_MAX_INLINE_BACKFILL_ROWS` = 2,000,000 is
-- ~46 s at that rate: comfortably inside the budget even on an instance several
-- times slower than the one measured, and far enough below it that a re-run
-- after a partial deploy still fits.
--
-- The preflight is BOUNDED — `LIMIT ceiling + 1` inside the count — so it costs
-- one scan that stops as soon as the answer is decided rather than a full
-- `count(*)`. Measured on the same clone: 0.32 s over 500,000 rows either way
-- (~0.65 us/row), against 11.6 s for the rewrite it guards.
--
-- Above the ceiling this RAISES rather than proceeding, because the failure it
-- prevents is worse than the failure it causes: a deploy that fails here has
-- changed nothing and names its own remedy, while one that runs a 10-minute
-- locked rewrite has already stalled ingest by the time anyone notices.
--
-- THE DRAIN. In psql AUTOCOMMIT — NOT inside a transaction, since the whole
-- point is that each batch commits and releases its row locks. Repeat until it
-- reports 0. Correct only once the sibling migration 20260820120000 is applied,
-- because until its trigger is live new rows keep arriving on the `''` default
-- and the loop chases ingest forever:
--
--   \set batch 20000
--   WITH stale AS (
--     SELECT "id" FROM "agent_component_session_usage"
--      WHERE "component_key_normalized" IS DISTINCT FROM
--            "agent_component_session_usage_normalized_key"("component_key")
--      LIMIT :batch FOR UPDATE SKIP LOCKED
--   )
--   UPDATE "agent_component_session_usage" u
--      SET "component_key_normalized" =
--            "agent_component_session_usage_normalized_key"(u."component_key")
--     FROM stale WHERE u."id" = stale."id";
--
-- AFTER THE PREFLIGHT HAS ALREADY RAISED (the state the HINT below names). The
-- sibling migration is applied and RECORDED — `migrate deploy` applied it in the
-- same run before entering this file — and THIS migration is recorded as failed.
-- So do not re-apply 20260820120000: it would fail 42701, and
-- `migrate resolve --applied` would be rejected for a migration already applied.
--
--   1. Clear this migration's failed row, or every later deploy refuses to start:
--
--        pnpm -C packages/database exec prisma migrate resolve --rolled-back \
--          20260820120100_iss6756_backfill_component_key_normalized
--
--   2. Run the drain above until it reports 0. The trigger is already live.
--   3. Re-run the deploy. The preflight sees 0 stale rows, the UPDATE matches
--      nothing, and neither takes a row lock.
--
-- AHEAD OF A FIRST DEPLOY (the proactive path, when `SELECT count(*)` already
-- says the table is over the ceiling). Here nothing is applied yet, so the
-- sibling has to be applied and recorded by hand to make the drain converge:
--
--        psql "$DATABASE_URL" -1 -f \
--          prisma/migrations/20260820120000_iss6756_component_session_usage_normalized_key/migration.sql
--        pnpm -C packages/database exec prisma migrate resolve --applied \
--          20260820120000_iss6756_component_session_usage_normalized_key
--
-- then the drain above, then the deploy — which now skips the sibling and finds
-- this file's preflight satisfied.
--
-- ORDERING AGAINST THE READS — AND WHERE IT DOES NOT HOLD (whitlockk). On a
-- deployment that migrates at BUILD time, `@repo/database`'s `prebuild`
-- (`scripts/migrate.ts`) runs before turbo builds apps/api, so the column is
-- complete before anything queries it. That is NOT universal: api-stage sets
-- `BUILD_MIGRATE_ENABLED=0` (packages/database/scripts/build-migrate-flag.ts) to
-- keep builds off Secure Compute, so there the new bundle serves BEFORE this
-- migration runs. Closing that window is a rollout decision — an advance
-- migration-only release, or a readiness-gated fallback in the reads — and it is
-- tracked on the PR rather than assumed away here. Do not read the paragraph
-- above as a guarantee it is not.
--
-- FORWARD-ONLY: no rollback path. The column is derived, so nothing is lost —
-- dropping it reconstructs no information that `component_key` does not still
-- hold.
--
-- ONE STATEMENT ON PURPOSE: the preflight and the rewrite share a `DO` block so
-- the whole file is a single statement, which is what lets
-- `component-session-usage-normalized-key.integration.test.ts` execute the
-- SHIPPED file rather than a transcription of it.

DO $iss6756$
DECLARE
  -- ~46 s at the 43,000 rows/s measured above, against the 300 s
  -- MIGRATION_SERIALIZE_LOCK_BUDGET_MS peer budget.
  max_inline_rows CONSTANT bigint := 2000000;
  stale bigint;
BEGIN
  SELECT count(*) INTO stale
    FROM (
      SELECT 1
        FROM "agent_component_session_usage"
       WHERE "component_key_normalized" IS DISTINCT FROM
             "agent_component_session_usage_normalized_key"("component_key")
       LIMIT max_inline_rows + 1
    ) bounded;

  IF stale > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-6756: more than % rows still need the component_key_normalized fold; refusing to rewrite them in one transaction.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and 20260820120000 is already applied. Run `prisma migrate resolve --rolled-back 20260820120100_iss6756_backfill_component_key_normalized`, then the batched drain in this migration''s header until it reports 0, then re-run the deploy. Do NOT re-apply 20260820120000.';
  END IF;

  UPDATE "agent_component_session_usage"
     SET "component_key_normalized" =
           "agent_component_session_usage_normalized_key"("component_key")
   WHERE "component_key_normalized" IS DISTINCT FROM
         "agent_component_session_usage_normalized_key"("component_key");
END
$iss6756$;
