-- ISS-9938 (PLN-2065 §5.3): re-sync `search_document.status` with `loops` for
-- the `loop` rows that drifted before the sync triggers existed.
--
-- The sibling 20260921151607_iss9938_search_document_document_status_repair
-- does the same for `document` rows, and its header carries the full reasoning
-- — why the rows are wrong, why this runs inside `migrate deploy` rather than
-- through the manual backfill, why it must sort after
-- 20260921132329_iss9938_search_document_status_sync_triggers, and what the
-- re-check, the single snapshot and the ceiling each buy. Two files rather than
-- one so a fired ceiling names exactly one migration to resolve, and so the
-- larger corpus can be drained without holding back the smaller one.
--
-- Hand-written on purpose (packages/database/AGENTS.md): a pure DATA migration.
-- No schema change, so `prisma migrate dev` reports no drift.
--
-- WHAT IS DIFFERENT HERE. `loops.status` is the `LoopStatus` ENUM and the
-- mirror column is TEXT, so both the comparison and the write cast — exactly as
-- the loop trigger does. And every loop transition after create skipped the
-- indexer: `loops/service.ts` carried a comment deferring later transitions to
-- the manual backfill (FEA-3930), which nothing runs on a schedule. Loops are
-- therefore expected to be the LARGER of the two populations (PLN-2065 §4).
--
-- THE POPULATION: a `loop` projection row whose status differs from its loop's.
-- `IS DISTINCT FROM` rather than `<>` so the NULLs are in — rows projected
-- before FEA-3930 added the column and never re-indexed hold NULL, and those
-- are the same defect.
--
-- POPULATION NOT MEASURED AGAINST PRODUCTION. READ THE COUNT BEFORE DEPLOYING —
-- a fired ceiling is a FAILED deploy for everyone, not a skipped repair:
--
--   SELECT count(*)
--     FROM "search_document" AS sd
--     JOIN "loops" AS l
--       ON l."id" = sd."entity_id"
--      AND l."organization_id" = sd."organization_id"
--    WHERE sd."entity_type" = 'loop'
--      AND sd."status" IS DISTINCT FROM l."status"::text;
--
-- PROPERTIES THAT FOLLOW FROM THE STATEMENT'S SHAPE. It cannot FABRICATE a
-- status — the only value it writes is the loop's own, and `loops.status` is
-- NOT NULL with a `PENDING` default, so it never writes a NULL either. It
-- cannot FAN OUT — `loops."id"` is that table's PRIMARY KEY, so the join is at
-- most 1:1, and the UPDATE keys on `search_document."id"`, its own primary key.
-- It is IDEMPOTENT, and FORWARD-ONLY: there is no down migration, and after the
-- write the projection no longer records the stale status.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED (PLN-2065 §8), as in the sibling.
--
-- `SET LOCAL lock_timeout` = 5s, as in the sibling, whose header carries the
-- reasoning: without it this UPDATE waits indefinitely behind a row lock an
-- open status write or the manual backfill holds, and a parked `migrate deploy`
-- holds `withMigrationSerializeLock` while it waits. A 55P03 lock timeout and a
-- 40P01 deadlock with a concurrent multi-row status write are both failures the
-- RAISE below does not describe; both leave nothing committed and take the same
-- remedy as a fired ceiling — resolve as rolled back, drain, re-run the deploy.
-- An over-ceiling attempt also rewrites and discards up to `max_inline_rows + 1`
-- rows, so drain BEFORE the first attempt rather than after a failed one. Loops
-- being the larger population, that matters more on this side.
--
-- THE DRAIN, referenced by the RAISE MESSAGE. Run in psql AUTOCOMMIT — NOT
-- inside a transaction, since the point is that each batch commits and releases
-- its row locks. Repeat until it reports 0. Its predicate is the candidate
-- CTE's predicate, and the two move together by hand.
--
--   \set batch 20000
--
--   WITH stale AS (
--     SELECT sd."id",
--            sd."status" AS seen_status,
--            l."status"::text AS source_status
--       FROM "search_document" AS sd
--       JOIN "loops" AS l
--         ON l."id" = sd."entity_id"
--        AND l."organization_id" = sd."organization_id"
--      WHERE sd."entity_type" = 'loop'
--        AND sd."status" IS DISTINCT FROM l."status"::text
--      LIMIT :batch
--        FOR UPDATE OF sd SKIP LOCKED
--   )
--   UPDATE "search_document" AS sd
--      SET "status" = stale."source_status"
--     FROM stale
--    WHERE sd."id" = stale."id"
--      AND sd."status" IS NOT DISTINCT FROM stale."seen_status";

DO $iss9938_loop$
DECLARE
  -- ~72 s at the ~3,450 rows/s ISS-8517 measured for a comparable
  -- single-column UPDATE on laptop-class Postgres 16.
  max_inline_rows CONSTANT bigint := 250000;
  stale_selected bigint;
  stale_written bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  WITH candidates AS MATERIALIZED (
    SELECT sd."id",
           sd."status" AS seen_status,
           l."status"::text AS source_status
      FROM "search_document" AS sd
      JOIN "loops" AS l
        ON l."id" = sd."entity_id"
       AND l."organization_id" = sd."organization_id"
     WHERE sd."entity_type" = 'loop'
       AND sd."status" IS DISTINCT FROM l."status"::text
     LIMIT max_inline_rows + 1
  ), repaired AS (
    UPDATE "search_document" AS sd
       SET "status" = c."source_status"
      FROM candidates AS c
     WHERE sd."id" = c."id"
       AND sd."status" IS NOT DISTINCT FROM c."seen_status"
    RETURNING sd."id"
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM repaired)
    INTO stale_selected, stale_written;

  IF stale_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-9938: more than % search_document loop rows still carry a status their loop no longer has; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20260921151657_iss9938_search_document_loop_status_repair`, then the batched drain in that migration''s header until it reports 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and nothing it wrote was committed. Its sibling 20260921151607_iss9938_search_document_document_status_repair already applied and committed; it is idempotent and needs no attention. The three recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  RAISE NOTICE 'ISS-9938: repaired % of % drifted search_document loop statuses.',
    stale_written, stale_selected;
END
$iss9938_loop$;
