-- ISS-12251 (PLN-2176 T-2.1): a session's Owner is its artifact assignee
-- (operator decision D-1), so copy every owned session's
-- `session_detail.user_id` onto `artifacts.assignee_id`, and refresh the search
-- projection's copy of the assignee for agent-session rows.
--
-- Hand-written on purpose (packages/database/AGENTS.md): a pure DATA migration.
-- No schema change, so `prisma migrate dev` has nothing to generate and reports
-- no drift.
--
-- WHY THE ROWS ARE WRONG. Until ISS-12251 the Owner lived on
-- `session_detail.user_id`: ingest wrote it on create, and `PATCH
-- /agent-sessions/{id}` `ownerUserId` and `/agent-sessions/bulk-assign` wrote
-- it on reassignment. `artifacts.assignee_id` was never written for a session,
-- so every session created before the PLN-2176 C1 deploy holds NULL there.
--
-- THE POPULATION IS `assignee_id IS DISTINCT FROM sd.user_id`, NOT
-- `assignee_id IS NULL` (PR #8734 review, binding). Between the C1 deploy and
-- this one, ingest set `assignee_id` = the uploader on create while PATCH and
-- bulk-assign still wrote only `session_detail.user_id`. A session created in
-- that window and then reassigned holds assignee = uploader and user_id = the
-- new Owner; an IS NULL predicate would leave it on the wrong Owner forever.
-- Sessions with `sd.user_id IS NULL` (owner deleted; the FK is SET NULL) are
-- outside the population and keep whatever assignee they hold.
--
-- WHY IT SHIPS AS A MIGRATION. The API that deploys with it writes and reads
-- the Owner on `artifacts.assignee_id` only. Running inside `migrate deploy`
-- moves every existing session's Owner with no operator script. A RESIDUAL
-- WINDOW remains: in production the old bundle keeps serving after this
-- commits, and an API reassignment there writes only `user_id`; on stage the
-- new bundle serves before this runs, and arm 1 reverts a reassignment made
-- then. Reassignment is API-only; an affected Owner is fixed by reassigning.
--
-- SEARCH. Before this deploy, `search_document.assignee_id` for an
-- `agent_session` row was written only by the transcript indexer, so an
-- existing row keeps the value it was indexed with until that session's
-- transcript is re-indexed. Arm 2 re-syncs it from `artifacts.assignee_id`, and
-- the API that deploys with it re-projects it after every Owner write, so
-- search `@owner` matches sessions by assignee from this deploy on (PLN-2176
-- AC-009).
--
-- POPULATION NOT MEASURED AGAINST PRODUCTION. Authored in a lane with no
-- production access. ISS-8517 measured 29,345 session_detail rows on
-- 2026-09-03. READ THE COUNTS BEFORE DEPLOYING; a fired ceiling is a FAILED
-- deploy for everyone, not a skipped repair:
--
--   SELECT count(*)
--     FROM "artifacts" AS a
--     JOIN "session_detail" AS sd ON sd."artifact_id" = a."id"
--    WHERE a."type" = 'SESSION'::"ArtifactType"
--      AND sd."user_id" IS NOT NULL
--      AND a."assignee_id" IS DISTINCT FROM sd."user_id";
--
--   SELECT count(*)
--     FROM "search_document" AS s
--     JOIN "artifacts" AS a
--       ON a."id" = s."entity_id"
--      AND a."organization_id" = s."organization_id"
--    WHERE s."entity_type" = 'agent_session'
--      AND a."type" = 'SESSION'::"ArtifactType"
--      AND s."assignee_id" IS DISTINCT FROM a."assignee_id";
--
-- (The second count is taken before arm 1 runs, so it under-counts what arm 2
-- will select by the sessions arm 1 is about to move; add the first count for
-- an upper bound.)
--
-- ONE STATEMENT PER ARM, SELECTION AND WRITE TOGETHER, the ISS-8517 / ISS-9665
-- shape: a `MATERIALIZED` candidate CTE capped at `max_inline_rows + 1` feeding
-- a data-modifying CTE, so both read one snapshot and the cap bounds the rows
-- locked. Not a `FOR UPDATE SKIP LOCKED` loop: a skipped row would leave an
-- owned session without its Owner, and the count check below would fail the
-- deploy for it anyway.
--
-- EACH UPDATE RE-STATES ITS POPULATION PREDICATE against its own target, so
-- READ COMMITTED re-evaluates it against a row a concurrent writer has just
-- changed, and a re-run writes nothing the first pass wrote (idempotent).
--
-- THE COUNT CHECK (PLN-2176 AC-003). After arm 1, every SESSION artifact with
-- a non-null `session_detail.user_id` must have `assignee_id = user_id`. The
-- check compares those two counts in one statement and RAISEs on a mismatch,
-- which rolls back everything this migration wrote. It can fail spuriously
-- when the still-serving older API commits an Owner write between arm 1 and
-- the check: a `POST /agent-sessions` naming an `ownerUserId`, or a `PATCH
-- /agent-sessions/{id}` `ownerUserId` or `/agent-sessions/bulk-assign`
-- reassignment, which writes `session_detail.user_id` (arm 1 locks only
-- `artifacts` rows, so it does not block that write). Each fails closed;
-- resolving the migration as rolled back and re-running the deploy converges.
--
-- `updated_at` IS NOT BUMPED. `artifacts.updated_at` and
-- `search_document.updated_at` are written by the application (Prisma
-- `@updatedAt` / the projector), with no database default or trigger, so an
-- UPDATE that does not name them leaves them alone. Bumping them would move
-- every session to the top of every updated-sorted list for a change no user
-- made.
--
-- THE CEILING, per arm: 250,000 rows, ~72 s at the ~3,450 rows/s ISS-8517
-- measured for a single-column UPDATE on laptop-class Postgres 16. This is a
-- data write: ROW EXCLUSIVE plus row locks on the rows it rewrites. It blocks
-- a concurrent UPDATE of one of those rows (desktop sync updates `artifacts`)
-- for the life of the transaction.
--
-- RECOVERY, if a ceiling fires: `prisma migrate resolve --rolled-back
-- 20261012170000_iss12251_session_assignee_backfill`, then run the drain below
-- until it reports UPDATE 0, then re-run the deploy (which then completes arm 2
-- and the check). Arm 1's drain:
--
--   WITH c AS (
--     SELECT a."id", sd."user_id"
--       FROM "artifacts" AS a
--       JOIN "session_detail" AS sd ON sd."artifact_id" = a."id"
--      WHERE a."type" = 'SESSION'::"ArtifactType"
--        AND sd."user_id" IS NOT NULL
--        AND a."assignee_id" IS DISTINCT FROM sd."user_id"
--      LIMIT 10000
--   )
--   UPDATE "artifacts" AS a SET "assignee_id" = c."user_id"
--     FROM c
--    WHERE a."id" = c."id"
--      AND a."assignee_id" IS DISTINCT FROM c."user_id";
--
-- Arm 2's drain is the same shape over arm 2's predicate below, with
-- `LIMIT 10000`.
--
-- IRREVERSIBLE from data alone: the assignee each session held before (NULL,
-- or the uploader for a C1-window row) is not recorded. FORWARD-ONLY.
DO $iss12251$
DECLARE
  max_inline_rows CONSTANT bigint := 250000;
  assignee_selected bigint;
  assignee_written bigint;
  search_selected bigint;
  search_written bigint;
  owned_sessions bigint;
  owned_sessions_assigned bigint;
BEGIN
  -- ARM 1: the session's Owner moves onto its artifact assignee.
  WITH candidates AS MATERIALIZED (
    SELECT a."id", sd."user_id"
      FROM "artifacts" AS a
      JOIN "session_detail" AS sd ON sd."artifact_id" = a."id"
     WHERE a."type" = 'SESSION'::"ArtifactType"
       AND sd."user_id" IS NOT NULL
       AND a."assignee_id" IS DISTINCT FROM sd."user_id"
     LIMIT max_inline_rows + 1
  ), assigned AS (
    UPDATE "artifacts" AS a
       SET "assignee_id" = c."user_id"
      FROM candidates AS c
     WHERE a."id" = c."id"
       AND a."type" = 'SESSION'::"ArtifactType"
       AND a."assignee_id" IS DISTINCT FROM c."user_id"
    RETURNING a."id"
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM assigned)
    INTO assignee_selected, assignee_written;

  IF assignee_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-12251 arm 1 (session Owner to assignee): more than % SESSION artifacts still need their assignee set from session_detail.user_id; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20261012170000_iss12251_session_assignee_backfill`, then the arm 1 drain in that migration''s header until it reports UPDATE 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and stands alone. Nothing it wrote was committed. The three recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE a."assignee_id" = sd."user_id")
    INTO owned_sessions, owned_sessions_assigned
    FROM "artifacts" AS a
    JOIN "session_detail" AS sd ON sd."artifact_id" = a."id"
   WHERE a."type" = 'SESSION'::"ArtifactType"
     AND sd."user_id" IS NOT NULL;

  IF owned_sessions_assigned <> owned_sessions THEN
    RAISE EXCEPTION
      'ISS-12251: % owned sessions but only % carry assignee_id = session_detail.user_id after the backfill; refusing to commit a partial Owner move. Recover: run `prisma migrate resolve --rolled-back 20261012170000_iss12251_session_assignee_backfill`, then re-run the deploy; if it fails again, read the arm 1 count in that migration''s header against the rows it leaves behind.',
      owned_sessions, owned_sessions_assigned;
  END IF;

  -- ARM 2: the search projection's assignee follows the artifact's.
  WITH candidates AS MATERIALIZED (
    SELECT s."id", a."assignee_id"
      FROM "search_document" AS s
      JOIN "artifacts" AS a
        ON a."id" = s."entity_id"
       AND a."organization_id" = s."organization_id"
     WHERE s."entity_type" = 'agent_session'
       AND a."type" = 'SESSION'::"ArtifactType"
       AND s."assignee_id" IS DISTINCT FROM a."assignee_id"
     LIMIT max_inline_rows + 1
  ), refreshed AS (
    UPDATE "search_document" AS s
       SET "assignee_id" = c."assignee_id"
      FROM candidates AS c
     WHERE s."id" = c."id"
       AND s."assignee_id" IS DISTINCT FROM c."assignee_id"
    RETURNING s."id"
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM refreshed)
    INTO search_selected, search_written;

  IF search_selected > max_inline_rows THEN
    RAISE EXCEPTION
      'ISS-12251 arm 2 (search projection assignee): more than % agent_session search_document rows still disagree with their artifact assignee; refusing to rewrite them in one transaction. Recover: run `prisma migrate resolve --rolled-back 20261012170000_iss12251_session_assignee_backfill`, then the arm 1 and arm 2 drains in that migration''s header until each reports UPDATE 0, then re-run the deploy.',
      max_inline_rows
      USING HINT =
        'This migration is now recorded as failed and stands alone. Nothing it wrote was committed, including arm 1. The recovery steps are in the message above; the drain SQL is in the migration header.';
  END IF;

  RAISE NOTICE 'ISS-12251: arm 1 assigned % of % selected sessions (% owned, all assigned); arm 2 refreshed % of % selected search rows.',
    assignee_written, assignee_selected, owned_sessions,
    search_written, search_selected;
END
$iss12251$;
