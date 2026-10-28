-- ISS-5981 (scope item 3): retire the stored `waiting` session status by
-- collapsing it onto the canonical lifecycle vocabulary.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): a pure DATA migration.
-- There is no schema change, so `prisma migrate dev` has nothing to generate and
-- reports no drift after it is applied.
--
-- WHY THIS EXISTS. `waiting` is DISPLAY vocabulary. The lifecycle set a session
-- row may store is exactly `active` / `inactive` / `error`
-- (`packages/api/src/types/session-status.ts`), and the awaiting-input sub-state
-- is re-derived per read by `projectDisplayedSessionStatus` from
-- `awaiting_input_since`. Both cloud WRITE paths already fold: the reopen arm
-- since ISS-5974 (#4810) and the main ingest since ISS-5981 (#5018), so no NEW
-- row can carry the spelling. Rows written before those landed were never
-- backfilled, which is why every read path is still tolerant of one.
--
-- A ROW IS COLLAPSED ONLY WHERE ITS AWAITING-INPUT BIT SURVIVES THE COLLAPSE.
-- The stored word carries exactly one bit — "this run is blocked on a human" —
-- so overwriting it is only safe where that bit is either already recorded
-- elsewhere or provably meaningless. That splits the population in three, and
-- one of the three is deliberately left alone.
--
--   1. LIVE AND ANCHORED (`session_ended_at` null, `awaiting_input_since` set)
--      -> `active`. The anchor already carries the bit and is what every reader
--      re-derives Waiting from (`projectDisplayedSessionStatus`,
--      `DISPLAYS_AS_WAITING`, `toAgentSessionState`), so the row reads Waiting
--      before and after, with the same elapsed time.
--
--   2. ENDED (`session_ended_at` set) -> a TERMINAL value, `error` or
--      `inactive`, never `active`. An ended run cannot be awaiting input at all
--      (ISS-4559) — every server reader requires `session_ended_at IS NULL`
--      before reporting Waiting — so the bit is not lost here; it was never
--      meaningful on these rows. See the next paragraph for why the value is
--      terminal rather than `active`.
--
--   3. LIVE AND ANCHORLESS (`session_ended_at` null, `awaiting_input_since`
--      null) -> LEFT AS `waiting`, deliberately. See below.
--
-- WHY AN ENDED ROW IS NOT WRITTEN `active`, AND WHERE ITS TERMINAL VALUE COMES
-- FROM. Writing `active` onto a run that is known to be over makes three shipped
-- readers disagree about the same row:
--   * `projectDisplayedSessionStatus` badges it Active, or Stale once past the
--     display cutoff;
--   * `deriveAgentSessionFallbackState` classifies the same ended row Completed,
--     because it reads `endedAt` rather than the status; and
--   * `resolveSessionDurationWindow` treats `active` as the Running lifecycle,
--     which ignores the row's real `session_ended_at` and measures the duration
--     to `now()` — a finished session whose Duration cell grows forever.
-- So the value is resolved from the terminal evidence the row already carries.
-- `sd."ends_with_error"` is the durable per-run verdict the desktop syncs
-- (ISS-4586), and the ERROR-vs-INACTIVE split below is not a judgement invented
-- here: it is byte-for-byte the mapping the stale-session reaper
-- (`apps/api/app/agent-sessions/stale-session-reaper-service.ts`) already applies
-- when it declares a run over from that same column —
-- `endsWithError ? ERROR : INACTIVE` — where a null or false flag means
-- not-error and resolves to `inactive`. `IS TRUE` rather than a bare truth test
-- so a NULL flag takes the not-error arm explicitly instead of falling through a
-- three-valued comparison. All three values are members of the lifecycle set
-- (`active` / `inactive` / `error`); nothing here introduces a fourth.
--
-- WHY THE ANCHORLESS LIVE ROWS ARE NOT TOUCHED, AND WHY NO TIMESTAMP IS
-- SYNTHESIZED FOR THEM. For these rows the word is the ONLY record that the run
-- is blocked on a human, and neither available column can replace it honestly.
-- `sd."last_activity_at"` is the cloud's own monotonic
-- `GREATEST(MAX(event_created_at), …)` and `sd."session_started_at"` is when the
-- run BEGAN; both say when the session was alive, neither says when it ASKED.
-- The elapsed-waiting UI renders `awaiting_input_since` as an exact fact, so
-- persisting either would present a proxy as a measurement — and on a row whose
-- activity clock is null it would claim the run had been waiting for its entire
-- lifetime. The root `AGENTS.md` ("Handling Bad or Nonsensical Data") is
-- explicit that for an internal nullable value a null is the valid
-- representation of "unknown" and is PREFERRED to a fabricated one; here there
-- is a third option better than either, which is to keep the representation that
-- already states the bit truthfully and states nothing it cannot support.
--
-- These rows therefore display exactly as they do today: `waiting` is still a
-- recognized DISPLAY value, and `resolveDisplayedSessionStatus` returns WAITING
-- from the raw status before it consults any timestamp (it is also exempt from
-- the staleness fold), so the badge, the Status facet and the sort are unchanged
-- for them. The cost is stated plainly rather than hidden: this migration does
-- NOT empty the stored-`waiting` population, so the read-side tolerance cannot
-- be retired on the strength of it alone. Retiring that tolerance needs the
-- ANCHOR RECOVERED for this subset — from the session's own event stream, which
-- a SQL migration has no access to — not a wider UPDATE here.
--
-- NO TIMESTAMP IS WRITTEN AT ALL. Neither statement touches
-- `awaiting_input_since`. Nothing here can invent a clock reading, and nothing
-- here can move an anchor a row already carries.
--
-- `type = 'SESSION'` IS LOAD-BEARING, NOT DECORATION. `artifacts.status` is a
-- FREEFORM per-subtype lifecycle column, deliberately not bound to a DB enum
-- (see the model comment in schema.prisma). A DOCUMENT, BRANCH, or DEPLOYMENT
-- artifact may legitimately carry the string 'waiting' with an entirely
-- different meaning. Without this predicate the statement would rewrite them.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED, for the reason the ISS-4654 backfill
-- (`20260808120000_iss4654_backfill_legacy_session_status`) already records:
-- Prisma's `@updatedAt` is client-applied, so a raw UPDATE leaves the column
-- alone, and touching it would float every historical session to the top of the
-- "recently updated" views that `artifacts_org_assignee_updated_idx` backs.
--
-- NO SEARCH PROJECTION TO REPAIR. `agentSessionProjection`
-- (apps/api/app/search/search-index-service.ts) sets `status: null` for sessions
-- — there is no denormalized status mirror to keep in step.
--
-- POPULATION SIZE IS UNMEASURED, AND THAT IS A REAL GAP. The ISS-4654 precedent
-- sampled its population across orgs before accepting an unbatched UPDATE; this
-- change was authored without production database access, so no equivalent count
-- exists. The statement is also unindexed for its predicate: the only relevant
-- index is `artifacts(organization_id, type, status)` and it cannot supply the
-- leading `organization_id`, so Postgres will most likely sequentially scan
-- `artifacts` and hold the resulting row locks for the length of the file's
-- single transaction. Same shape as the ISS-4654 backfill, which ran fine, but
-- MEASURE THE POPULATION BEFORE APPLYING IN PRODUCTION —
--   SELECT count(*) FROM "artifacts" WHERE "type" = 'SESSION' AND "status" = 'waiting';
-- and batch it instead if the count is large.
--
-- RETRY-IDEMPOTENT. Each predicate is exactly the population its statement
-- eliminates, so a second application matches nothing either one already
-- rewrote. The two populations are disjoint (`session_ended_at` is null in one
-- and not null in the other), so neither statement can see the other's output
-- and their order does not matter. The retained anchorless-live rows fail BOTH
-- predicates on EVERY application, so a re-run is a no-op on them too rather
-- than a second chance to collapse them. Safe under Prisma's deploy-recovery
-- re-run of a migration it marked rolled back, and safe to apply by hand twice.
--
-- FORWARD-ONLY: no rollback path. Where the spelling is removed the bit it
-- carried is preserved (by the anchor, or by the row's own terminality), and
-- where the bit is all the row has, the spelling is kept.

UPDATE "artifacts" AS a
   SET "status" = 'active'
  FROM "session_detail" AS sd
 WHERE sd."artifact_id" = a."id"
   AND a."type" = 'SESSION'
   AND a."status" = 'waiting'
   AND sd."session_ended_at" IS NULL
   AND sd."awaiting_input_since" IS NOT NULL;

UPDATE "artifacts" AS a
   SET "status" = CASE
         WHEN sd."ends_with_error" IS TRUE THEN 'error'
         ELSE 'inactive'
       END
  FROM "session_detail" AS sd
 WHERE sd."artifact_id" = a."id"
   AND a."type" = 'SESSION'
   AND a."status" = 'waiting'
   AND sd."session_ended_at" IS NOT NULL;
