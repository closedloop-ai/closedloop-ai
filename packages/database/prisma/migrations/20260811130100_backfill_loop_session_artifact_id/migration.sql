-- FEA-1718 back-link, step 2 of 2: backfill `loops.session_artifact_id` from the
-- session rows that already record their originating loop.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): a pure DATA migration.
-- There is no schema change here, so `prisma migrate dev` has nothing to
-- generate and reports no drift after it is applied.
--
-- BACKGROUND. `loops.session_artifact_id` has existed since
-- 20260615162310_add_session_origin_and_loop_session_artifact but never had a
-- production writer — the live lineage runs the other way, as
-- `session_detail.source_loop_id`, written at ingest from the desktop's session
-- attribution. The companion application change (upsert-session-slice.ts →
-- linkLoopSessionArtifact) now writes the back-link for every session that
-- materializes from here on; this migration does the same for rows that
-- materialized before it shipped, so the column is populated for the whole
-- history rather than only for new traffic.
--
-- ORDERING: 20260811130000 creates `session_detail_source_loop_id_idx` and
-- applies first (lexicographic directory order), so the grouping below drives
-- from that index instead of sorting the whole of `session_detail`.
--
-- WHICH SESSION WINS, AND WHY THE LIVE PATH MUST AGREE (wongk, review). A loop
-- can legitimately have more than one session claiming it (a resumed or
-- re-launched run), but `session_artifact_id` is UNIQUE — at most one Session
-- per Loop. So the pick is explicit and deterministic rather than left to the
-- planner: the EARLIEST session by `session_started_at`, ties broken by
-- `artifact_id`. That is the session that actually materialized the loop; later
-- ones are continuations.
--
-- The live claim in `service/loop-session-backlink.ts` now applies the SAME
-- comparison. It previously claimed only when the loop was unclaimed, which made
-- ARRIVAL ORDER decide the winner — so an older session syncing after a newer
-- one produced a different back-link than this migration would, and the same
-- history resolved differently depending on rollout timing. Arrival order cannot
-- be reconstructed in SQL, so the reproducible rule is the one both sides use.
-- `loop-session-artifact-backlink.test.ts` pins the two paths choosing the SAME
-- session from the same two rows, in both arrival orders.
--
-- ORG SCOPING IS PART OF THE JOIN, NOT AN AFTERTHOUGHT. `source_loop_id` is a
-- free-text column fed from a desktop payload, so it can name a loop in another
-- organization. Joining `loops` INSIDE the candidate CTE (on both the id and the
-- artifact's `organization_id`) means a cross-org claim is not merely rejected —
-- it never becomes the candidate in the first place, so a genuine same-org
-- session further down the list still wins the loop. Filtering after the pick
-- would have let one bogus row suppress the real link.
--
-- SESSION-ONLY, AND THAT IS A SEPARATE INVARIANT FROM ORG OWNERSHIP (wongk,
-- review). `Loop.sessionArtifactId` is documented to hold a SESSION-typed
-- Artifact, but `session_detail.artifact_id` is only an FK into the polymorphic
-- `artifacts` table — nothing in the schema stops a malformed persisted detail
-- row from pointing at a FEATURE or DOCUMENT. The org join proves WHOSE artifact
-- it is, never WHAT it is, so `a."type" = 'SESSION'` is asserted explicitly and,
-- like the org predicate, sits INSIDE the candidate CTE: a malformed row is
-- excluded from the pick entirely rather than being allowed to become the
-- candidate and suppress a valid sibling session.
--
-- The cast is `loops.id::text`, never `source_loop_id::uuid`: a uuid always
-- casts to text, whereas casting the free-text column would raise 22P02 on the
-- first malformed value and abort the whole migration. Malformed values simply
-- fail to join.
--
-- NO UNIQUE VIOLATION IS POSSIBLE, by construction:
--   * `session_detail.artifact_id` is that table's primary key, so each session
--     contributes at most one candidate row and each `artifact_id` therefore
--     appears in at most one candidate row — two loops in this statement can
--     never claim the same artifact;
--   * `NOT EXISTS (... other.session_artifact_id = candidate.artifact_id)`
--     rejects an artifact some OTHER loop already claimed before this ran.
--
-- IDEMPOTENT / RE-RUNNABLE: `session_artifact_id IS NULL` appears in both the
-- candidate CTE and the UPDATE, so a second application finds no candidates and
-- writes nothing. It never overwrites a link the application already made.
--
-- ADDITIVE: writes two previously-defaulted/NULL columns. No DROP, no ALTER, no
-- row deleted, and no existing back-link overwritten.
--
-- STATEMENT 1 (origin) EXISTS FOR RETENTION, NOT COSMETICS (wongk, review).
-- `session_detail.origin` is what the stale reaper and BOTH retention sweeps
-- filter on, and all three already document that LOOP-materialized sessions are
-- governed by their source Loop's lifecycle and are never swept. Historical
-- loop-materialized rows were nonetheless left at the `DESKTOP_SYNC` default, so
-- the phantom sweep could DELETE the session artifact and its
-- `ON DELETE SET NULL` would clear the very back-link statement 2 just wrote.
-- Marking origin first is what makes this backfill durable rather than a value
-- that quietly disappears within a retention window.
--
-- It marks EVERY loop-materialized session, not only the ones that win a
-- back-link below: origin describes how the row was PRODUCED, and a session that
-- lost the earliest-wins tie-break is still loop-materialized and still must not
-- be swept as ephemeral desktop scratch. Same three predicates as the candidate
-- CTE (SESSION-typed, same-org, real loop), so a malformed or cross-org row
-- cannot buy itself retention immunity.

UPDATE "session_detail" AS sd
SET "origin" = 'LOOP'
FROM "artifacts" a, "loops" lo
WHERE a."id" = sd."artifact_id"
  AND a."type" = 'SESSION'
  AND lo."id"::text = sd."source_loop_id"
  AND lo."organization_id" = a."organization_id"
  AND sd."source_loop_id" IS NOT NULL
  AND sd."origin" <> 'LOOP';

WITH candidate AS (
  SELECT DISTINCT ON (sd."source_loop_id")
    sd."source_loop_id" AS loop_id,
    sd."artifact_id" AS artifact_id
  FROM "session_detail" sd
  JOIN "artifacts" a
    ON a."id" = sd."artifact_id"
   AND a."type" = 'SESSION'
  JOIN "loops" lo
    ON lo."id"::text = sd."source_loop_id"
   AND lo."organization_id" = a."organization_id"
  WHERE sd."source_loop_id" IS NOT NULL
    AND lo."session_artifact_id" IS NULL
  ORDER BY sd."source_loop_id", sd."session_started_at", sd."artifact_id"
)
UPDATE "loops" AS l
SET "session_artifact_id" = candidate."artifact_id"
FROM candidate
WHERE l."id"::text = candidate."loop_id"
  AND l."session_artifact_id" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "loops" other
    WHERE other."session_artifact_id" = candidate."artifact_id"
  );
