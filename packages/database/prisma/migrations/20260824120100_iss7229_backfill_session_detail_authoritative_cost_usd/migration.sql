-- ISS-7229, step 2 of 2: backfill `authoritative_cost_usd` for sessions whose
-- loop already completed before the column existed.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): a pure DATA migration.
-- No schema change here, so `prisma migrate dev` has nothing to generate and
-- reports no drift after it is applied.
--
-- WHY A BACKFILL IS REQUIRED, not a nicety. Without it `authoritative_cost_usd
-- IS NULL` means EITHER "Claude reported no cost" OR "this session predates the
-- column" — two different facts under one value. Every fleet drift aggregate run
-- before the population turned over would then be computed against a silently
-- truncated denominator: a wrong number that looks right, which is the exact
-- defect class this ticket exists to end. The backfill is what makes NULL mean
-- one thing.
--
-- THE DATA IS RECOVERABLE, verified. `authoritativeCostUsd` has been persisted
-- into `loop_events.data.usageReconciliation` since PRD-538 / ISS-5349, so this
-- reads back the same rows the live read path (`findSessionAuthoritativeCostUsd`)
-- already serves from. Known and deliberately NOT addressed here: sessions
-- finalized in the 2026-07-19 → 2026-08-06 window, when the figure was computed
-- but not yet written to `loop_events`. Those rows have nothing to read and stay
-- NULL; whether they are recoverable from retained stdout captures is an open
-- measurement recorded on the ticket, not something to guess at in a migration.
--
-- THE SAME TWO SCOPES AS THE READ, and for the same reason. `l.organization_id`
-- is not defence in depth: `session_detail.source_loop_id` has no foreign key and
-- is populated from a caller-supplied sync payload, so org scope is what stops a
-- forged pointer pulling another org's accounting. `l.session_artifact_id` is the
-- UNIQUE claim backlink, and it is what makes the figure THIS session's — several
-- sessions can name the same `source_loop_id`, so keying on the loop alone would
-- stamp one run's reported cost onto every session that pointed at it.
--
-- LATEST COMPLETED EVENT WINS (`ORDER BY created_at DESC`), identical to the
-- read's `orderBy: { createdAt: "desc" }`. A loop re-completed after a retry has
-- more than one, and live and backfill must not disagree about which is current.
--
-- NARROW JSON GUARD, and why it is sufficient. `buildCompletedEventData` parses
-- the block through `LoopUsageReconciliationSchema` BEFORE persisting and omits
-- the whole block when it fails, so every `usageReconciliation` in this table is
-- already schema output rather than wire input. The remaining runtime hazards are
-- the ones SQL must handle itself:
--   * `jsonb_typeof(...) = 'number'` — a JSON null, string, or absent key is
--     absence, and `->>` on any of them would otherwise become a cast error or a
--     silent 0.
--   * the ABS bound — a number wider than DECIMAL(14,6) would raise 22003 and
--     abort the whole migration. Out-of-range is not a cost we can stand behind,
--     so it is left NULL, matching the read's finite check.
-- A reported `0` passes both guards and IS written: it is a measurement.
--
-- IDEMPOTENT / RE-RUNNABLE: `WHERE s.authoritative_cost_usd IS NULL` means a
-- second application selects nothing already written, and the live projection
-- writes the same value from the same source, so re-running cannot flip a row.
--
-- ADDITIVE: writes one previously-NULL column. No DROP, no ALTER, no row deleted.
--
-- COST AND WHAT IT BLOCKS. Driven from `loops` (bounded by loops that are BOTH
-- claimed by a session and completed), not from `loop_events`; the correlated
-- lookup rides the existing `loop_events(loop_id, type)` index. It takes only ROW
-- EXCLUSIVE on `session_detail`, which does not block ingest inserts.
--
-- OPERATOR ESCAPE, if this table has outgrown the deploy budget: run the
-- statement below by hand ahead of the deploy, then `prisma migrate resolve
-- --applied 20260824120100_iss7229_backfill_session_detail_authoritative_cost_usd`.
-- The statement is idempotent, so doing that and letting the migration run anyway
-- is also safe.

UPDATE "session_detail" AS s
SET "authoritative_cost_usd" = reported.value
FROM "loops" AS l
JOIN "artifacts" AS a
  ON a."id" = l."session_artifact_id"
 AND a."organization_id" = l."organization_id"
-- LATEST COMPLETION FIRST, THEN VALIDATE ITS COST (#5790 review). The type and
-- range checks were WHERE predicates, so a newest completed event carrying no
-- storable cost was discarded and an OLDER event's figure was backfilled in its
-- place. The live reader takes the newest completed event and parses THAT one,
-- answering null — so the two disagreed permanently, on exactly the rows this
-- backfill exists to populate. Selecting the row first and validating it in a
-- CASE reproduces the reader: an unusable newest figure yields NULL, never a
-- stale predecessor.
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN jsonb_typeof(e."data" -> 'usageReconciliation' -> 'authoritativeCostUsd') = 'number'
     AND abs((e."data" -> 'usageReconciliation' ->> 'authoritativeCostUsd')::numeric) < 100000000
    THEN (e."data" -> 'usageReconciliation' ->> 'authoritativeCostUsd')::numeric
    ELSE NULL
  END AS value
  FROM "loop_events" AS e
  WHERE e."loop_id" = l."id"
    AND e."type" = 'completed'
  ORDER BY e."created_at" DESC
  LIMIT 1
) AS reported
WHERE s."artifact_id" = a."id"
  AND s."authoritative_cost_usd" IS NULL;
