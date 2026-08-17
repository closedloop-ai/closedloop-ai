-- ISS-4586: move the desktop session status model to ACTIVE / INACTIVE / ERROR.
--
-- `inactive` is the terminal-but-not-failed state that `completed` and
-- `abandoned` collapse into; `error` stays the failed terminal. Which of the two
-- a session lands on when it is declared inactive (by the importer or the
-- orphaned-session sweep) is decided by the new `ends_with_error` flag, set at
-- import from the parser's `endedOnUnrecoveredError`.
--
-- `ends_with_error` is a NULLABLE INTEGER (SQLite boolean), no default: NULL
-- means "not yet classified" — a live/non-terminal row, or a legacy row from
-- before this column existed. Additive; SQLite ADD COLUMN has no IF NOT EXISTS
-- guard, re-run safety comes from the migration runner's checksum tracking.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "ends_with_error" INTEGER;

-- Backfill the flag for existing TERMINAL rows so a later re-derivation is not
-- required to read their outcome. A failed run ends with an error; a
-- completed/abandoned (or already-migrated inactive) run does not. Non-terminal
-- rows (active/waiting/running) are left NULL — the importer classifies them
-- when they next terminate.
UPDATE sessions SET ends_with_error = 1 WHERE status = 'error';
UPDATE sessions SET ends_with_error = 0 WHERE status IN ('completed', 'abandoned', 'inactive');

-- @wongk: FEA-3580 repair for pre-fix abandoned rows MUST run here, BEFORE the
-- collapse below — `healSweptSessionEndedAt` (write-core.ts) selects only
-- `status = 'abandoned'`, so once these rows become `inactive` that boot heal can
-- never reach them and their inflated `ended_at` (sweep time, not last activity)
-- would permanently skew duration/runtime rollups. Pull `ended_at` back to the
-- true last activity for the same population the heal targets (canonical-ISO
-- timestamp guards; only where `ended_at` overshoots `last_activity_at`).
UPDATE sessions SET ended_at = last_activity_at
 WHERE status = 'abandoned'
   AND ended_at > last_activity_at
   AND started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
   AND last_activity_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
   AND last_activity_at >= started_at;

-- Collapse the legacy terminal-not-failed statuses into the canonical `inactive`
-- state. `error` is unchanged; active/waiting/running are unchanged.
UPDATE sessions SET status = 'inactive' WHERE status IN ('completed', 'abandoned');

-- shafty023: the `session_analytics` rollup carries its own denormalized status
-- and its boot backfill skips already-present rows, so collapse it here too — an
-- upgraded row must not keep a legacy `completed`/`abandoned` analytics status
-- that diverges from its `sessions.status`. (This rollup is a LOCAL derivation,
-- not part of the cloud sync payload; `sessions.updated_at` is deliberately NOT
-- bumped — the cloud consumer already folds legacy completed/abandoned to
-- inactive on read, so a mass re-sync burst of all terminal history is avoided
-- and these rows reconcile on their next natural update.)
UPDATE session_analytics SET status = 'inactive' WHERE status IN ('completed', 'abandoned');
