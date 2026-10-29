-- ISS-9665: clear the fabricated 'MEDIUM' the search projection holds for
-- artifacts whose priority column is genuinely NULL.
--
-- Hand-written on purpose (packages/database/AGENTS.md): a pure DATA migration.
-- No schema change, so `prisma migrate dev` has nothing to generate and reports
-- no drift.
--
-- WHY THE ROWS ARE WRONG. `indexDocumentProjection`
-- (apps/api/app/documents/document-service.ts) builds a `search_document` row
-- from a `Document`, and that `Document` came from `toDocument()`, which until
-- this change read `artifact.priority ?? Priority.Medium`
-- (apps/api/app/documents/document-utils.ts:77). So every document indexed
-- before this deploy whose artifact holds NULL was projected as the literal
-- string 'MEDIUM'. The projection is the only place that fold was persisted;
-- `artifacts.priority` itself was always correct, which is what makes this
-- repair a re-sync from a source of truth rather than a guess.
--
-- WHY IT SHIPS WITH THE CODE INSTEAD OF BEING AN OPERATOR ERRAND. The same
-- change teaches the search grammar `priority:none` / `priority!=none`, and
-- that grammar is NOT behind the `artifact-priority-unset` UI flag —
-- `parsePriority` accepts `none` server-side, so the filter is reachable the
-- moment this merges. Left to incremental re-indexing, `priority:none` MISSES
-- every unset document and `priority:medium` WRONGLY INCLUDES it, for as long
-- as nobody edits that artifact again. Correction-on-next-write does happen; it
-- is not an answer for a row nothing ever touches, and it leaves a user-facing
-- filter answering wrongly in BOTH directions over an unbounded window. Running
-- inside `migrate deploy` closes that window before the new API serves a
-- request, and needs no human to remember anything.
--
-- WHY IT IS NOT `pnpm --filter @repo/database backfill:search-documents`. That
-- script is correct for this (it selects `artifact.priority` straight off the
-- column and never went through `toDocument()`), and it stays the general
-- reconcile. But it re-projects the WHOLE corpus for every entity type,
-- including re-reading document bodies to rebuild `tsv`, which is far too heavy
-- to put in a deploy's critical path for a one-column repair — and, being a
-- manual run, it is exactly the "required step described as optional" this
-- migration exists to avoid.
--
-- THE POPULATION IS THE DEFECT'S EXACT SIGNATURE, and deliberately no wider:
-- a `document` projection row holding 'MEDIUM' whose artifact holds NULL. The
-- fold could only ever emit 'MEDIUM' (it is a `?? Priority.Medium` default), so
-- a row holding any OTHER value beside a NULL artifact is different drift, this
-- migration has no evidence about it, and the general reconcile above owns it.
-- A genuine MEDIUM is excluded by the join: its artifact holds 'MEDIUM', not
-- NULL. `entity_type = 'document'` is stated rather than left to the join —
-- `project` rows key on `Project.id`, not `artifacts.id`, and a project's
-- priority column is `NOT NULL DEFAULT MEDIUM` so it can never be in this
-- population at all.
--
-- POPULATION NOT MEASURED AGAINST PRODUCTION. Unlike ISS-8517, whose header
-- quotes a prod read-only count, this was authored in a lane with no production
-- access and none was taken. READ THE COUNT BEFORE DEPLOYING — a fired ceiling
-- is a FAILED deploy for everyone, not a skipped repair:
--
--   SELECT count(*)
--     FROM "search_document" AS sd
--     JOIN "artifacts" AS a
--       ON a."id" = sd."entity_id"
--      AND a."organization_id" = sd."organization_id"
--    WHERE sd."entity_type" = 'document'
--      AND sd."priority" = 'MEDIUM'
--      AND a."priority" IS NULL;
--
-- PROPERTIES THAT FOLLOW FROM THE STATEMENT'S SHAPE, not from an argument about
-- the data. It cannot FABRICATE a priority — the only value it ever writes is
-- NULL, which asserts nothing. It cannot FAN OUT — `artifacts."id"` is that
-- table's PRIMARY KEY, so the join is at most 1:1, and the UPDATE keys on
-- `search_document."id"`, its own primary key. It is IDEMPOTENT — a repaired
-- row holds NULL and so leaves the population; a re-run matches nothing the
-- first pass wrote. And it is NARROWING-ONLY — no row gains a priority, and no
-- row's priority changes to a different priority.
--
-- IRREVERSIBLE. This repo has no down-migration convention, and after the write
-- the projection no longer records that the row held 'MEDIUM'. That is the
-- point: the value was never the artifact's. Re-running is safe; that is not
-- the same as reversible. FORWARD-ONLY.
--
-- ONE STATEMENT, SELECTION AND WRITE TOGETHER. A `MATERIALIZED` candidate CTE
-- with `LIMIT max_inline_rows + 1` feeding a data-modifying CTE, so both take
-- ONE snapshot. Counting in one statement and writing in the next would take
-- two snapshots under READ COMMITTED, and a row committing in between would be
-- repaired without ever having been counted — the ISS-8517 review finding. The
-- `LIMIT` is therefore a HARD CAP on rows locked, not merely on a number that
-- gets compared.
--
-- THE UPDATE RE-STATES `sd."priority" = 'MEDIUM'` against its own target, and
-- that re-check is load-bearing: READ COMMITTED re-evaluates it against the
-- version a concurrent writer just committed, so a document that acquired a
-- real LOW/HIGH/URGENT priority between snapshot and write keeps it.
--
-- THE ONE RACE THE RE-CHECK CANNOT CLOSE, stated rather than papered over. A
-- user who sets a priority of exactly MEDIUM on one of these artifacts during
-- the migration's own execution leaves the row still matching `= 'MEDIUM'`, and
-- it is cleared. Closing it would mean `FOR UPDATE` on up to `max_inline_rows`
-- `artifacts` rows — blocking document edits fleet-wide for the length of the
-- migration — to protect against a window of seconds on a specific artifact.
-- The consequence is bounded and self-healing: that row reads as unset until
-- the artifact's next write re-projects it, which is the same best-effort
-- staleness this denormalized mirror already tolerates by design. Neither
-- ISS-8517 nor ISS-8674 locks its source table either.
--
-- THE CEILING, AND WHY IT FIRES AFTER THE WRITE. `RAISE EXCEPTION` aborts the
-- transaction, so nothing commits and the deploy fails having changed nothing;
-- what it no longer does is stop the rows being touched in the first place.
-- Bounded at `max_inline_rows + 1`, that is the lock exposure a preflight count
-- would have been sizing for anyway.
--
-- NO `SET lock_timeout`. This is a data write: ROW EXCLUSIVE plus row locks,
-- blocking neither reads nor inserts. It does block a concurrent UPDATE of a
-- row it is rewriting, and the projection write hooks upsert this table, so at
-- the ceiling that is a stall for an indexing write touching one of those rows.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED. It mirrors the SOURCE entity's
-- `updatedAt` (never this row's write time) and is the search result ordering
-- key, so touching it would re-rank every repaired document for a change no
-- user made. The migration test pins that the statement assigns `priority` and
-- nothing else.
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
-- predicate, and the two move together by hand; a drain wider than the
-- statement writes costs this migration deliberately refuses, and a narrower
-- one never clears the ceiling the re-run has to get under.
--
--   \set batch 20000
--
--   WITH stale AS (
--     SELECT sd."id"
--       FROM "search_document" AS sd
--       JOIN "artifacts" AS a
--         ON a."id" = sd."entity_id"
--        AND a."organization_id" = sd."organization_id"
--      WHERE sd."entity_type" = 'document'
--        AND sd."priority" = 'MEDIUM'
--        AND a."priority" IS NULL
--      LIMIT :batch
--        FOR UPDATE OF sd SKIP LOCKED
--   )
--   UPDATE "search_document" AS sd
--      SET "priority" = NULL
--     FROM stale
--    WHERE sd."id" = stale."id"
--      AND sd."priority" = 'MEDIUM';
--
-- This migration stands alone: it has no sibling to re-apply or resolve by
-- hand, and because it is idempotent, draining fully before a first deploy
-- simply makes it a no-op.

DO $iss9665$
DECLARE
  -- ~72 s at the ~3,450 rows/s ISS-8517 measured for a comparable
  -- single-column UPDATE on laptop-class Postgres 16.
  max_inline_rows CONSTANT bigint := 250000;
  stale_selected bigint;
  stale_written bigint;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT sd."id"
      FROM "search_document" AS sd
      JOIN "artifacts" AS a
        ON a."id" = sd."entity_id"
       AND a."organization_id" = sd."organization_id"
     WHERE sd."entity_type" = 'document'
       AND sd."priority" = 'MEDIUM'
       AND a."priority" IS NULL
     LIMIT max_inline_rows + 1
  ), cleared AS (
    UPDATE "search_document" AS sd
       SET "priority" = NULL
      FROM candidates AS c
     WHERE sd."id" = c."id"
       AND sd."priority" = 'MEDIUM'
    RETURNING sd."id"
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM cleared)
    INTO stale_selected, stale_written;

  IF stale_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-9665: more than % search_document rows still project a fabricated MEDIUM for an unset artifact priority; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20260907140000_iss9665_search_document_unset_priority_backfill`, then the batched drain in that migration''s header until it reports 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and stands alone — no sibling migration needs attention. Nothing it wrote was committed. The three recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  RAISE NOTICE 'ISS-9665: cleared % of % selected stale search_document priorities.',
    stale_written, stale_selected;
END
$iss9665$;
