-- ISS-8487 acceptance criterion 1 — the population ISS-7019 moved from Clean to
-- Unknown on the session-analytics screens (READ-ONLY).
--
-- ISS-7019 (commit fd1e9b6fc8, PR #5333, merged 2026-08-19) re-keyed
-- `outcomeOf`'s "has this run actually finished" gate from the inert
-- `session_detail.state` column onto the stored lifecycle status
-- `artifacts.status`. The old gate could not fire — nothing has written `state`
-- since the sync path dropped the field — so a live run carrying the
-- `ends_with_error: false` the reaper writes for its own benefit was graded
-- `Clean`. The new gate fires, and those runs report `Unknown`. That is the
-- correction, not a regression; this script sizes it.
--
-- Safe to run against prod: SELECT-only, no temp TABLES, no writes, no DDL on
-- any real schema. It creates temp VIEWS in pg_temp, which live for the session
-- and are dropped on disconnect. Every output is an AGGREGATE — no row
-- contents, no identifiers.
--
--   psql "$PROD_DATABASE_URL" -f iss-8487-analytics-population-movement.sql
--
-- The production run of 2026-09-16 and what it means is recorded in
-- `docs/insights.md` under "Metric notes". Re-running this re-measures the
-- STEADY STATE, not the effective date — see the note there on why the cohort
-- decays and why the figure at the cutover is not recoverable.
--
-- WHY A SCRIPT AND NOT A ONE-LINER. The cohort is not a column and was never
-- persisted. It is the difference between two read-time folds, both of which
-- live in TypeScript: `outcomeOf` in
-- `apps/api/app/insights/session-analytics-classify.ts` as it stands today, and
-- the same function at `fd1e9b6fc8^`. This script reproduces BOTH in SQL over
-- the same population the two screens read, so the number describes the sessions
-- whose grade actually changed rather than a proxy for them. Every rule below
-- cites the code it mirrors; if one of those folds changes, this script is wrong
-- until it is changed with it.
--
-- THE FOLDS, AS COMMITTED.
--
--   AFTER  (`outcomeOf`, today)
--     status non-nullish AND normalizeSessionStatus(status) ∉
--       TERMINAL_ANALYTICS_SESSION_STATUSES              -> Unknown
--     else outcomeForEndsWithError(ends_with_error)
--
--   BEFORE (`outcomeOf` at fd1e9b6fc8^)
--     state non-nullish AND state ∉ TERMINAL_AGENT_SESSION_STATES
--                                                        -> Unknown
--     else outcomeForEndsWithError(ends_with_error)
--
--   outcomeForEndsWithError (`packages/loops-api/src/insights.ts`)
--     true -> Errored   false -> Clean   null -> Unknown
--
-- WHY THE STATUS LISTS ARE SQL LITERALS. SQL cannot import the const objects,
-- and both lists are compared against a value read off a STORED ROW, so the
-- literal is the truth here rather than a copy of a constant.
--
--   * AFTER: `TERMINAL_ANALYTICS_SESSION_STATUSES` spreads
--     `TERMINAL_SESSION_STATUSES` = {`inactive`, `error`}
--     (`packages/api/src/types/session-status.ts`). The code normalizes first,
--     but `normalizeSessionStatus` returns `inactive` only for a literal
--     `inactive` and `error` only for a literal `error`: `waiting`, `unknown`,
--     `stale` and every UNRECOGNIZED value all fold to `active` via
--     `LIFECYCLE_SESSION_STATUS_FOLD` and the fail-open default. So
--     `status IN ('inactive','error')` is the normalization, not an
--     approximation of it — and it is exactly what the shipped
--     `NOT_CLEAN_OUTCOME` prefilter in `session-analytics-sql.ts` already
--     spells, including its `status IS NULL` arm.
--   * BEFORE: `TERMINAL_AGENT_SESSION_STATES` was
--     [AgentSessionState.Completed, AgentSessionState.Error] = {`COMPLETED`,
--     `ERROR`}, compared against the raw column with no normalization.
--
-- WHAT THE WINDOWS DO AND DO NOT MEAN. The grade is computed at READ time, so
-- the re-keying changed the classification of the WHOLE historical population
-- the instant it deployed — not only of sessions that started after it. The
-- windows below are NOT a before/after of the world; they slice one population
-- by `session_started_at` so the movement can be read at more than one scale.
--
-- They are AUDIT BUCKETS and they do NOT reproduce what either screen shows for
-- "30 days". Two differences, both deliberate: `resolvePeriodRange`
-- (`apps/api/app/insights/service/period.ts:54`) anchors the dashboard's window
-- at the REQUEST timestamp and walks back N days, so its bounds are whenever the
-- page was loaded and they roll; these bounds are aligned to the cutover DATE
-- and are fixed, so two runs of this script are comparable to each other. And
-- `sessionWindow` (`session-analytics-sql.ts:228`) is a CLOSED interval
-- (`>= start AND <= end`); these are half-open, so no session lands in both
-- 30-day buckets. A count here is not expected to equal a number read off a
-- dashboard tile.
--
-- Section 5 checks the assumption the BEFORE fold rests on: that `state` is
-- null for every row, so the old gate never fired. If that count is not zero
-- the BEFORE column is still correct — it carries the `state` term — but the
-- headline stops being "the gate never fired" for those rows.

\set ON_ERROR_STOP on
\timing off

-- The bucket boundary: the day commit fd1e9b6fc8 (PR #5333) merged to `main`.
--
-- THE MERGE IS NOT THE BEHAVIOR CHANGE, and here the two fall on different
-- days. `fd1e9b6fc8` merged at 2026-08-19 15:16 UTC; production is a separate
-- `@loops deploy` dispatch, and the first `production` commit containing it is
-- `e105c5c7cd` (PR #5452) at 2026-08-20 00:24 UTC. The grade is read-time, so
-- what a production reader saw flipped at that deploy, nine hours later and on
-- the following calendar day.
--
-- The constant stays on the merge date because the buckets above are audit
-- buckets rather than a reconstruction of anyone's dashboard, and re-anchoring
-- them would invalidate the run already published in `docs/insights.md` without
-- making either bucket mean more. Nothing downstream should read `2026-08-19`
-- as the date production behavior changed — that is 2026-08-20.
\set cutover '2026-08-19'

-- ---------------------------------------------------------------------------
-- Base: one row per session, carrying both folds and the signals they read.
-- ---------------------------------------------------------------------------
--
-- The FROM mirrors `SESSION_ANALYTICS_FROM` (`session-analytics-sql.ts`) exactly
-- — every `session_detail` row joined to its artifact — so this is the same
-- population both screens describe.
--
-- Spend is pre-aggregated per session rather than joined row-for-row:
-- `agent_session_token_usage` carries one row per MODEL, so a bare join would
-- multiply a multi-model session across every count below. The LEFT join keeps
-- a session that never wrote a usage row in its bucket at zero spend, which is
-- the same choice `SPEND_FROM` makes in `tokenops-waste-queries.ts` and for the
-- same reason: a run killed early is the one least likely to have written one.
CREATE TEMP VIEW iss8487_base AS
SELECT
  s.artifact_id,
  s.session_started_at,
  s.state              AS session_state,
  a.status             AS artifact_status,
  s.ends_with_error,

  -- `WALL_CLOCK_MINUTES` (`session-analytics-sql.ts`). `wall_clock` is a
  -- human-formatted string, so the span comes from timestamps; a session with
  -- no recorded end falls back to `last_activity_at`, and a negative or absent
  -- span clamps to 0.
  GREATEST(
    EXTRACT(EPOCH FROM (
      COALESCE(s.session_ended_at, s.last_activity_at) - s.session_started_at
    )),
    0
  ) / 60 AS wall_clock_minutes,

  -- `PRODUCED_ARTIFACT` (`session-analytics-sql.ts`). `CASE`, not `AND`, for two
  -- reasons — and the SECOND is the one that actually bites, measured on
  -- postgres 16.15 against the fixture:
  --
  --   1. `pull_requests` is free-form jsonb and `jsonb_array_length` raises on a
  --      scalar or object. PostgreSQL does not promise `AND` short-circuits, so
  --      the `AND` spelling is only safe by the planner's grace. (Today it does
  --      short-circuit `false AND …`, so an object does NOT in fact raise here.)
  --   2. `jsonb_typeof(NULL)` is NULL, not `'object'`, so the `AND` spelling
  --      yields NULL — not false — for every session with no `pull_requests`
  --      value at all, which is most of them. `NOT NULL` is NULL, so those rows
  --      drop straight out of `newly_lost` and the Lost-work impact SILENTLY
  --      UNDERCOUNTS. On the fixture that is 2/0/2 instead of 3/2/6. The `CASE`
  --      returns a real `false` and keeps them.
  (
    CASE
      WHEN jsonb_typeof(s.pull_requests) = 'array'
      THEN jsonb_array_length(s.pull_requests) > 0
      ELSE false
    END
    OR COALESCE(s.files_changed, 0) > 0
  ) AS produced_artifact,

  COALESCE(tu.usd, 0)::numeric AS usd,

  -- BEFORE: the gate keyed on `session_detail.state`.
  CASE
    WHEN s.state IS NOT NULL AND s.state NOT IN ('COMPLETED', 'ERROR')
      THEN 'unknown'
    WHEN s.ends_with_error IS TRUE  THEN 'errored'
    WHEN s.ends_with_error IS FALSE THEN 'clean'
    ELSE 'unknown'
  END AS outcome_before,

  -- AFTER: the gate keyed on `artifacts.status`. The `IS NULL` arm mirrors
  -- `outcomeOf`'s nullish check and `NOT_CLEAN_OUTCOME`'s; `artifacts.status` is
  -- NOT NULL in the schema, so it is a version-skew arm, not the norm.
  CASE
    WHEN a.status IS NOT NULL AND a.status NOT IN ('inactive', 'error')
      THEN 'unknown'
    WHEN s.ends_with_error IS TRUE  THEN 'errored'
    WHEN s.ends_with_error IS FALSE THEN 'clean'
    ELSE 'unknown'
  END AS outcome_after
FROM session_detail s
JOIN artifacts a ON a.id = s.artifact_id
LEFT JOIN (
  SELECT agent_session_id, SUM(estimated_cost) AS usd
  FROM agent_session_token_usage
  GROUP BY agent_session_id
) tu ON tu.agent_session_id = s.artifact_id;

-- ---------------------------------------------------------------------------
-- The moved cohort, plus what the move does to the Lost-work screen.
-- ---------------------------------------------------------------------------
--
-- `isLostSession` (`session-analytics-classify.ts`) is
-- `!producedArtifact && wallClockMinutes > 0 && outcome !== Clean`. A session
-- that moves OUT of Clean therefore does not merely change bucket on the
-- TokenOps screen — if it produced nothing and burned wall-clock it becomes
-- LOST WORK that was not lost before, and `lossClassOf` files it under
-- `Unattributed` because its outcome is Unknown. That is the larger of the two
-- effects and is counted separately rather than folded into the headline.
CREATE TEMP VIEW iss8487_classified AS
SELECT
  b.*,
  (b.outcome_before = 'clean'   AND b.outcome_after = 'unknown') AS moved_clean_to_unknown,
  (b.outcome_before = 'errored' AND b.outcome_after = 'unknown') AS moved_errored_to_unknown,
  (
    b.outcome_before = 'clean'
    AND b.outcome_after = 'unknown'
    AND NOT b.produced_artifact
    AND b.wall_clock_minutes > 0
  ) AS newly_lost
FROM iss8487_base b;

-- The reporting windows, as ONE relation so every section below is windowed
-- identically and the denominators cannot drift between sections. Half-open
-- [since, until) so no session is counted in both 30-day windows.
--
-- `post_30d` runs to the cutover + 30 days, which may be in the FUTURE — section
-- 1 prints the elapsed days so a rate is total over the ELAPSED window and never
-- the nominal 30.
CREATE TEMP VIEW iss8487_windows AS
SELECT * FROM (VALUES
  ('1_pre_30d',  (:'cutover'::timestamp - interval '30 days'), :'cutover'::timestamp),
  ('2_post_30d', :'cutover'::timestamp, (:'cutover'::timestamp + interval '30 days')),
  ('3_all',      '-infinity'::timestamp, 'infinity'::timestamp)
) AS w(window_label, since, until);

CREATE TEMP VIEW iss8487_windowed AS
SELECT w.window_label, w.since, w.until, c.*
FROM iss8487_windows w
JOIN iss8487_classified c
  ON c.session_started_at >= w.since AND c.session_started_at < w.until;

\echo ''
\echo '=== 0. WINDOW BOUNDS ==================================================='
\echo '    Print the bounds and the ELAPSED length with the numbers, so every'
\echo '    count below carries its own window and no rate is read off a'
\echo '    nominal 30 days that has not finished.'
SELECT
  window_label,
  since,
  until,
  (now() AT TIME ZONE 'UTC') AS measured_at_utc,
  CASE
    WHEN since = '-infinity'::timestamp THEN NULL
    ELSE round(
      EXTRACT(EPOCH FROM (
        LEAST(until, now() AT TIME ZONE 'UTC') - since
      )) / 86400.0, 2
    )
  END AS elapsed_days
FROM iss8487_windows
ORDER BY window_label;

\echo ''
\echo '=== 1. THE MOVED COHORT, by window ====================================='
\echo '    denominator = sessions whose session_started_at falls in the window'
\echo '    (every session_detail row joined to its artifact — the same'
\echo '    population both screens read).'
\echo '    moved_clean_to_unknown is AC1: graded Clean before ISS-7019,'
\echo '    Unknown after. minutes/usd size it in the two screens own units.'
SELECT
  window_label,
  count(*)                                                    AS denominator_sessions,
  count(*) FILTER (WHERE moved_clean_to_unknown)              AS moved_clean_to_unknown,
  round(
    100.0 * count(*) FILTER (WHERE moved_clean_to_unknown) / nullif(count(*), 0),
    4
  )                                                           AS moved_pct_of_sessions,
  round(
    SUM(wall_clock_minutes) FILTER (WHERE moved_clean_to_unknown)::numeric,
    1
  )                                                           AS moved_wall_clock_minutes,
  round(SUM(usd) FILTER (WHERE moved_clean_to_unknown), 2)    AS moved_usd,
  count(*) FILTER (WHERE moved_errored_to_unknown)            AS moved_errored_to_unknown,
  round(SUM(usd) FILTER (WHERE moved_errored_to_unknown), 2)  AS moved_errored_usd
FROM iss8487_windowed
GROUP BY window_label
ORDER BY window_label;

\echo ''
\echo '=== 2. THE FULL BEFORE -> AFTER PARTITION =============================='
\echo '    Every session, both grades. Section 1s numerator is checkable'
\echo '    against this, and it shows which other buckets moved.'
SELECT
  window_label,
  outcome_before,
  outcome_after,
  count(*)                                   AS sessions,
  round(SUM(wall_clock_minutes)::numeric, 1) AS wall_clock_minutes,
  round(SUM(usd), 2)                         AS usd
FROM iss8487_windowed
GROUP BY window_label, outcome_before, outcome_after
ORDER BY window_label, sessions DESC;

\echo ''
\echo '=== 3. LOST-WORK IMPACT of the move ===================================='
\echo '    A moved session that produced nothing and burned wall-clock was NOT'
\echo '    lost work before (isLostSession excludes Clean) and IS now, filed'
\echo '    under Unattributed. This is the larger of the two effects.'
SELECT
  window_label,
  count(*) FILTER (WHERE moved_clean_to_unknown)              AS moved_sessions,
  count(*) FILTER (WHERE newly_lost)                          AS newly_lost_sessions,
  round(
    SUM(wall_clock_minutes) FILTER (WHERE newly_lost)::numeric,
    1
  )                                                           AS newly_lost_minutes,
  round(SUM(usd) FILTER (WHERE newly_lost), 2)                AS newly_lost_usd
FROM iss8487_windowed
GROUP BY window_label
ORDER BY window_label;

\echo ''
\echo '=== 4. WHICH STATUS the moved sessions carry ==========================='
\echo '    The gate fires on any status that is not literally inactive/error,'
\echo '    so expect active. Anything ELSE here is not a problem with the AFTER'
\echo '    fold: normalizeSessionStatus fail-opens every unrecognized value to'
\echo '    active, so the code grades such a row Unknown exactly as this NOT IN'
\echo '    does. It means a WRITER put something outside the three lifecycle'
\echo '    values into artifacts.status — that is the thing to chase.'
SELECT
  window_label,
  artifact_status,
  count(*) AS sessions
FROM iss8487_windowed
WHERE moved_clean_to_unknown
GROUP BY window_label, artifact_status
ORDER BY window_label, sessions DESC;

\echo ''
\echo '=== 5. INTEGRITY: did the OLD gate ever fire? =========================='
\echo '    The headline rests on session_detail.state being null everywhere, so'
\echo '    the pre-ISS-7019 gate fell through for every row. Expect'
\echo '    state_not_null = 0. A non-zero count does not invalidate the BEFORE'
\echo '    column (it carries the state term) but it does narrow that claim.'
SELECT
  window_label,
  count(*)                                        AS sessions,
  count(*) FILTER (WHERE session_state IS NOT NULL) AS state_not_null,
  count(*) FILTER (WHERE artifact_status IS NULL)   AS artifact_status_null,
  count(*) FILTER (WHERE ends_with_error IS NULL)   AS ends_with_error_null
FROM iss8487_windowed
GROUP BY window_label
ORDER BY window_label;
