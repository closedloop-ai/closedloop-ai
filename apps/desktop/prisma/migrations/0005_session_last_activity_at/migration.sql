-- FEA perf: denormalize the session "last activity" sort key.
--
-- The Sessions-list cursor pagination used to recompute, on EVERY page, the
-- per-session MAX(events.created_at) via a LEFT JOIN over the whole events
-- table + GROUP BY, then ORDER BY that derived column — a full materialize +
-- filesort each page. This column stores that derived value so the read path
-- can ORDER BY an indexed column instead.
--
-- Value semantics MUST match the old cursor expression exactly:
--   COALESCE(
--     MAX(<events.created_at when it looks like an ISO date, else NULL>),
--     <sessions.started_at when it looks like an ISO date, else epoch>
--   )
-- The malformed/empty date prefix guard mirrors the GLOB date check in
-- recomputeSessionLastActivityAt and SESSION_STARTED_AT_SORT_EXPRESSION in
-- sqlite.ts. A session with no events (or only malformed event timestamps)
-- falls back to its started_at floor; a session with a malformed/empty
-- started_at falls back to the 1970 epoch, so ordering and NULL handling are
-- identical to the prior per-page computation.
--
-- The column is NOT NULL with the epoch floor as its default. That default is
-- load-bearing: the two `INSERT INTO sessions` paths omit this column and rely
-- on a follow-up recomputeSessionLastActivityAt in the same transaction, so the
-- default lets the insert succeed before the recompute overwrites it. Because
-- the stored value is never NULL, the read path can ORDER BY the bare column and
-- the index below satisfies the sort directly (no COALESCE wrapper to defeat it).

ALTER TABLE "sessions" ADD COLUMN "last_activity_at" TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

CREATE INDEX IF NOT EXISTS "idx_sessions_last_activity" ON "sessions"("last_activity_at" DESC, "id" DESC);

-- Backfill every existing row: the NOT NULL default above seeded them all with
-- the epoch, so overwrite unconditionally with the real derived activity value.
UPDATE sessions
SET last_activity_at = COALESCE(
  (
    SELECT MAX(
      CASE
        WHEN e.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
          THEN e.created_at
        ELSE NULL
      END
    )
    FROM events e
    WHERE e.session_id = sessions.id
  ),
  (
    CASE
      WHEN sessions.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
        THEN sessions.started_at
      ELSE '1970-01-01T00:00:00.000Z'
    END
  )
);
