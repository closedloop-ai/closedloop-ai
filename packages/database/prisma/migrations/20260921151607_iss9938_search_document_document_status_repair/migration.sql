-- ISS-9938 (PLN-2065 §5.2): re-sync `search_document.status` with `artifacts`
-- for the `document` rows that drifted before the sync triggers existed.
--
-- Hand-written on purpose (packages/database/AGENTS.md): a pure DATA migration.
-- No schema change, so `prisma migrate dev` has nothing to generate and reports
-- no drift.
--
-- WHY THE ROWS ARE WRONG. `search_document.status` is the ANSWER to a
-- status-filtered search, not a cache: a `status:` token routes the request to
-- the projection-backed unified search, which never joins back to `artifacts`.
-- Until 20260921132329_iss9938_search_document_status_sync_triggers the column
-- was maintained only by the post-commit write hooks in
-- `apps/api/app/search/search-index-service.ts`, and several status writers
-- never called them — both bulk status paths (`writeStatusChanges`), the
-- blocked-dependent auto-unblock, and the loop-ingestion reset to DRAFT. Every
-- row one of those touched has been answering with its pre-change status ever
-- since. `artifacts.status` itself was always correct, which is what makes this
-- a re-sync from a source of truth rather than a guess.
--
-- WHY IT SORTS AFTER THE TRIGGER MIGRATION. The re-check below is what makes
-- the repair safe beside a concurrent status write, and it only works if the
-- trigger is already live. That migration stops NEW drift; this one repairs
-- what drifted before it. Both orders of the remaining race then land correct:
-- if a concurrent trigger write commits first, the re-check fails and the
-- repair leaves the newer value alone; if the repair writes first, the waiting
-- trigger applies the newer value on top of it.
--
-- WHY IT SHIPS INSIDE `migrate deploy` INSTEAD OF BEING AN OPERATOR ERRAND.
-- Same reasoning as ISS-9665
-- (20260907140000_iss9665_search_document_unset_priority_backfill): left to
-- incremental re-indexing, `status:DONE` MISSES every drifted document and the
-- stale status WRONGLY INCLUDES it, in both directions, for as long as nobody
-- edits that artifact again — and correction-on-next-write is no answer for a
-- row nothing ever touches.
--
-- WHY IT IS NOT `pnpm --filter @repo/database backfill:search-documents`. That
-- script is correct for this and stays the general reconcile, but it
-- re-projects the WHOLE corpus for every entity type, including re-reading
-- document bodies to rebuild `tsv`, in one transaction of up to 15 minutes —
-- far too heavy for a deploy's critical path, and being a manual run it is
-- exactly the "required step described as optional" this migration avoids.
--
-- THE POPULATION IS THE DEFECT'S EXACT SIGNATURE: a `document` projection row
-- whose status differs from its artifact's. `IS DISTINCT FROM` rather than
-- `<>` so the NULLs are in — rows projected before FEA-3930 added the column
-- and never re-indexed hold NULL, and those are the same defect.
--
-- WHY THERE IS NO `a."type" = 'DOCUMENT'` GATE HERE, though the trigger has
-- one. The trigger enters from the `artifacts` side, where sessions, branches
-- and deployments all pass through and must be kept out. This enters from the
-- projection side, where `entity_type` IS the discriminator: a session
-- projects under `entity_type = 'agent_session'`, never `'document'`. Stating
-- the artifact type again would narrow the population past the defect for no
-- case that can occur.
--
-- POPULATION NOT MEASURED AGAINST PRODUCTION. This plan was written in a lane
-- with no production access. READ THE COUNT BEFORE DEPLOYING — a fired ceiling
-- is a FAILED deploy for everyone, not a skipped repair:
--
--   SELECT count(*)
--     FROM "search_document" AS sd
--     JOIN "artifacts" AS a
--       ON a."id" = sd."entity_id"
--      AND a."organization_id" = sd."organization_id"
--    WHERE sd."entity_type" = 'document'
--      AND sd."status" IS DISTINCT FROM a."status";
--
-- PROPERTIES THAT FOLLOW FROM THE STATEMENT'S SHAPE, not from an argument
-- about the data. It cannot FABRICATE a status — the only value it writes is
-- the artifact's own, and `artifacts.status` is NOT NULL, so it never writes a
-- NULL either. It cannot FAN OUT — `artifacts."id"` is that table's PRIMARY
-- KEY, so the join is at most 1:1, and the UPDATE keys on
-- `search_document."id"`, its own primary key. It is IDEMPOTENT — a repaired
-- row now equals its source and so leaves the population; a re-run matches
-- nothing the first pass wrote.
--
-- IRREVERSIBLE. This repo has no down-migration convention, and after the write
-- the projection no longer records the stale status. That is the point: the
-- value was never the artifact's. Re-running is safe; that is not the same as
-- reversible. FORWARD-ONLY.
--
-- ONE STATEMENT, SELECTION AND WRITE TOGETHER. A `MATERIALIZED` candidate CTE
-- with `LIMIT max_inline_rows + 1` feeding a data-modifying CTE, so both take
-- ONE snapshot. Counting in one statement and writing in the next would take
-- two snapshots under READ COMMITTED, and a row committing in between would be
-- repaired without ever having been counted — the ISS-8517 review finding. The
-- `LIMIT` is therefore a HARD CAP on rows locked, not merely on a number that
-- gets compared.
--
-- THE UPDATE RE-STATES `sd."status" IS NOT DISTINCT FROM c."seen_status"`, and
-- that re-check is the whole reason this is safe to run against a live system:
-- READ COMMITTED re-evaluates it against the version a concurrent writer just
-- committed, so a document whose status changed between snapshot and write —
-- and whose trigger already mirrored the new value — is SKIPPED rather than
-- having the snapshot's older value written back over it. `IS NOT DISTINCT
-- FROM` and not `=`, because the captured value is NULL for exactly the rows
-- that never carried a status at all.
--
-- THE CEILING, AND WHY IT FIRES AFTER THE WRITE. `RAISE EXCEPTION` aborts the
-- transaction, so nothing commits and the deploy fails having changed nothing;
-- what it no longer does is stop the rows being touched in the first place.
-- Bounded at `max_inline_rows + 1`, that is the lock exposure a preflight count
-- would have been sizing for anyway. What the abort does NOT undo is the work:
-- every over-ceiling attempt rewrites up to `max_inline_rows + 1` rows and then
-- discards them, leaving that many dead tuples on `search_document` plus the
-- index churn each non-HOT update drags the `tsv` GIN through. Drain BEFORE the
-- first attempt rather than after a failed one.
--
-- `SET LOCAL lock_timeout` (via `set_config(..., true)`, the plpgsql spelling —
-- scoped to this migration's transaction and reset with it). This is a data
-- write: ROW EXCLUSIVE plus row locks, blocking neither reads nor inserts. The
-- direction that costs a deploy is the other one. Postgres defaults
-- `lock_timeout` to 0, so this UPDATE would wait INDEFINITELY behind a row lock
-- an application transaction holds on a `search_document` row — which, since
-- the trigger migration, is any open document status write whose trigger
-- reached that row, and is the manual `backfill:search-documents` for as long
-- as its single transaction runs. A `migrate deploy` parked there also holds
-- `withMigrationSerializeLock`, so every later deploy queues behind it with
-- nothing in the logs saying why. Five seconds turns that into a loud failure —
-- the same value the other lock-taking migrations and scripts here use.
--
-- A LOCK FAILURE IS NOT THE P0001 PATH. Two shapes reach the operator that the
-- RAISE below does not describe, and the remedy for both is the same as the
-- ceiling's: nothing was committed, so `prisma migrate resolve --rolled-back`
-- this migration, drain, and re-run the deploy.
--   - 55P03 `canceling statement due to lock timeout` — the wait above.
--   - 40P01 `deadlock detected` — the repair locks mirror rows in the order the
--     scan visits them (an unindexed one: every index on this table leads with
--     `organization_id`, and this filters `entity_type` across all orgs), while
--     a multi-row status write locks its mirror rows through the trigger in the
--     order ITS update visits them. Overlapping rows in opposite orders is a
--     cycle, and Postgres may pick this migration as the victim. The trigger
--     migration's header names the same exposure for the manual backfill.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED. It mirrors the SOURCE entity's
-- `updatedAt` (never this row's write time) and is the search result ordering
-- key and the `since`/`until` predicate, so touching it would re-rank every
-- repaired document for a change no user made (PLN-2065 §8).
--
-- RECOVERY, if the ceiling fires. The steps are in the RAISE MESSAGE rather
-- than only the HINT on purpose: `migrate-deploy-recovery.ts` parses P0001
-- output with `/Database error:\s*(?:ERROR:\s*)?([^\n]+)/` — the first LINE
-- only — and Postgres carries HINT as a separate field, so a hint-only remedy
-- can be dropped before an operator sees it.
--
-- THE DRAIN, referenced by that message. Run in psql AUTOCOMMIT — NOT inside a
-- transaction, since the point is that each batch commits and releases its row
-- locks. Repeat until it reports 0. Its predicate is the candidate CTE's
-- predicate, and the two move together by hand. The re-check is kept even
-- though `FOR UPDATE` already re-fetches the latest version, so the drain and
-- the statement stay the same shape.
--
--   \set batch 20000
--
--   WITH stale AS (
--     SELECT sd."id",
--            sd."status" AS seen_status,
--            a."status" AS source_status
--       FROM "search_document" AS sd
--       JOIN "artifacts" AS a
--         ON a."id" = sd."entity_id"
--        AND a."organization_id" = sd."organization_id"
--      WHERE sd."entity_type" = 'document'
--        AND sd."status" IS DISTINCT FROM a."status"
--      LIMIT :batch
--        FOR UPDATE OF sd SKIP LOCKED
--   )
--   UPDATE "search_document" AS sd
--      SET "status" = stale."source_status"
--     FROM stale
--    WHERE sd."id" = stale."id"
--      AND sd."status" IS NOT DISTINCT FROM stale."seen_status";
--
-- Because this is idempotent, draining fully before a first deploy simply makes
-- it a no-op.

DO $iss9938_document$
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
           a."status" AS source_status
      FROM "search_document" AS sd
      JOIN "artifacts" AS a
        ON a."id" = sd."entity_id"
       AND a."organization_id" = sd."organization_id"
     WHERE sd."entity_type" = 'document'
       AND sd."status" IS DISTINCT FROM a."status"
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
      'ISS-9938: more than % search_document document rows still carry a status their artifact no longer has; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20260921151607_iss9938_search_document_document_status_repair`, then the batched drain in that migration''s header until it reports 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and nothing it wrote was committed. Its sibling 20260921151657_iss9938_search_document_loop_status_repair has not been applied yet and needs no attention. The three recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  RAISE NOTICE 'ISS-9938: repaired % of % drifted search_document document statuses.',
    stale_written, stale_selected;
END
$iss9938_document$;
