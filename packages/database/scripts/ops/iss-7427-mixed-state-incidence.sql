-- ISS-7427 acceptance criterion 1 — incidence of the MIXED STATE (READ-ONLY).
--
-- The mixed state: a session whose MAIN transcript is terminally absent while
-- the detail response still serves derived metrics — cost, tokens, elapsed
-- span, timeline bars, trace/event counts, or readable subagent archives. The
-- reported exemplar showed $5,994.85 / 8.99B tokens / 770h 55m / 216 events
-- beside "Transcript not archived".
--
-- Safe to run against prod: SELECT-only, no temp TABLES, no writes, no DDL on
-- any real schema. It creates temp VIEWS in pg_temp, which live for the session
-- and are dropped on disconnect.
--
--   psql "$PROD_DATABASE_URL" -f iss-7427-mixed-state-incidence.sql
--
-- WHY A SCRIPT AND NOT A ONE-LINER. The cohort is not a column. It is the fold
-- `resolveSessionEvidenceCoverage` computes at read time
-- (apps/api/app/agent-sessions/service/session-evidence-coverage.ts), over the
-- disposition `deriveTranscriptDisposition` computes from the MAIN transcript
-- row (apps/api/app/agent-sessions/transcript-availability.ts). This script
-- reproduces both in SQL so the number is the same population the UI classifies,
-- not a proxy for it. Every rule below cites the code it mirrors; if one of
-- those folds changes, this script is wrong until it is changed with it.

\set ON_ERROR_STOP on
\timing off

-- ---------------------------------------------------------------------------
-- Base: one row per session, carrying its main-transcript disposition and every
-- independent-evidence signal the classifier reads.
-- ---------------------------------------------------------------------------
--
-- JOIN NOTE. `session_transcript.session_detail_id` is nullable BY DESIGN — a
-- transcript can arrive before the metadata lane creates the SessionDetail row
-- (schema.prisma:877-880). Joining on it alone would misreport those sessions as
-- having no main transcript at all. So the join falls back to the identity
-- triple, which is `session_detail`'s own unique key and the leading columns of
-- `session_transcript`'s: (compute_target_id, external_session_id[, file_key]).
CREATE TEMP VIEW iss7427_base AS
SELECT
  sd.artifact_id,
  a.organization_id,
  a.project_id,
  a.name          AS session_label,
  a.status        AS artifact_status,
  a.assignee_id   AS user_id,
  sd.harness,
  sd.model,
  sd.state        AS session_state,
  sd.origin,
  sd.repository_full_name,
  sd.session_started_at,
  sd.session_ended_at,
  m.upload_status            AS main_upload_status,
  m.permanent_failure_reason AS main_permanent_failure_reason,
  m.uploaded_at              AS main_uploaded_at,
  -- AC3's "time-to-archive": start of the run to the moment its bytes landed.
  -- NULL when nothing landed, which is exactly the cohort under audit.
  (m.uploaded_at - sd.session_started_at) AS main_time_to_archive,
  -- `deriveTranscriptDisposition` + `dispositionForAvailability`, in SQL.
  -- The `uploaded`-with-null-`uploaded_at` arm is the code's defensive guard
  -- (deriveTranscriptAvailability), kept so the two cannot disagree on a row a
  -- future write-path inconsistency produces.
  CASE
    WHEN m.id IS NULL THEN 'neverExpected'
    WHEN m.upload_status = 'uploaded' AND m.uploaded_at IS NULL THEN 'syncing'
    WHEN m.upload_status = 'uploaded' AND m.last_observed_at > m.uploaded_at THEN 'stale'
    WHEN m.upload_status = 'uploaded' THEN 'synced'
    WHEN m.upload_status = 'failed' THEN 'failedTransient'
    -- `dispositionForTerminalSkipReason`, and note the DIRECTION. Only
    -- `materialized_source_unavailable` is recoverable (ISS-4695: a
    -- batch-materialized source that re-materializes on a later sweep). EVERY
    -- other skip is `failedPermanent`, INCLUDING a null or unrecognized reason:
    -- `normalizeSkipReason` degrades an unknown label to null and the code's
    -- `if (reason === null) return FailedPermanent` is a deliberate conservative
    -- default, "so a value we cannot classify never LIES as recoverable".
    --
    -- Enumerating the HARD set instead would be the same rule copied inverted,
    -- and it would silently undercount twice: a null-reason skip (reachable —
    -- the column is nullable free text, and an API rolled back behind a newer
    -- desktop preserves a label this build cannot classify) would report as
    -- still-arriving, and a future HARD reason added to `TranscriptSkipReason`
    -- would fall through to the same wrong answer. Naming only the recoverable
    -- one keeps this correct as that grow-only enum grows.
    WHEN m.upload_status = 'skipped'
      AND m.permanent_failure_reason = 'materialized_source_unavailable'
      THEN 'syncing'
    WHEN m.upload_status = 'skipped' THEN 'failedPermanent'
    ELSE 'syncing'
  END AS main_disposition,
  -- Independent evidence, one column per signal `hasIndependentEvidence` reads
  -- (session-evidence-coverage.ts) so a breakdown can attribute the state.
  (SELECT count(*) FROM agent_session_events e
    WHERE e.agent_session_id = sd.artifact_id) AS derived_event_count,
  -- `isTranscriptReadable`: uploaded AND actually carrying an upload instant.
  -- The null-`uploaded_at` guard is the same defensive arm the main disposition
  -- above keeps, for the same reason — `deriveTranscriptAvailability` sends that
  -- row to `uploadPending`, so counting it here would report an unreadable
  -- sidechain as the independent evidence keeping a session on screen.
  (SELECT count(*) FROM session_transcript s
    WHERE s.file_key LIKE 'subagent:%'
      AND s.upload_status = 'uploaded'
      AND s.uploaded_at IS NOT NULL
      AND (s.session_detail_id = sd.artifact_id
        OR (s.compute_target_id = sd.compute_target_id
            AND s.external_session_id = sd.external_session_id))
  ) AS readable_subagent_count,
  (sd.estimated_cost > 0
    OR sd.input_tokens > 0 OR sd.output_tokens > 0
    OR sd.cache_read_tokens > 0 OR sd.cache_write_tokens > 0) AS has_metric_rollup,
  sd.estimated_cost,
  (sd.input_tokens + sd.output_tokens
    + sd.cache_read_tokens + sd.cache_write_tokens) AS total_tokens
FROM session_detail sd
JOIN artifacts a ON a.id = sd.artifact_id
LEFT JOIN session_transcript m
  ON m.file_key = 'main'
 AND (m.session_detail_id = sd.artifact_id
   OR (m.compute_target_id = sd.compute_target_id
       AND m.external_session_id = sd.external_session_id));

-- ---------------------------------------------------------------------------
-- The two cohorts, and why there are two.
-- ---------------------------------------------------------------------------
--
-- `cohort_served` is the classifier's own verdict — what a detail read actually
-- returns as `metadataOnly`. It is `failedPermanent` AND `hasIndependentEvidence`,
-- and `hasIndependentEvidence` includes `hasSessionSpan`, which is
-- `sessionStartedAt !== null` over a NOT NULL column (schema.prisma:714). So it
-- is TRIVIALLY TRUE and `cohort_served` collapses to "disposition is
-- failedPermanent". Reported as-is because it is the number that describes the
-- shipped UI; NOT presented as a measure of how often real numbers outlive an
-- archive, because it counts a session with nothing but a start timestamp too.
--
-- `cohort_derived` is the ticket's actual question: a terminally-absent main
-- archive beside metrics a reader would read as measurements. Both are reported;
-- neither is a substitute for the other, and the gap between them IS the answer
-- to "how much of the served cohort is the reported defect".
CREATE TEMP VIEW iss7427_classified AS
SELECT
  b.*,
  (b.main_disposition = 'failedPermanent') AS cohort_served,
  (b.main_disposition = 'failedPermanent'
    AND (b.derived_event_count > 0
      OR b.readable_subagent_count > 0
      OR b.has_metric_rollup)) AS cohort_derived,
  -- The population the classifier deliberately does NOT flag: no `main` row was
  -- ever written, so `deriveTranscriptDisposition` returns `neverExpected`. The
  -- ticket's wording ("missing, failed-permanent, unavailable, or has no archive
  -- row") covers it, the shipped classifier does not. Counted separately rather
  -- than folded in, so neither number is quietly redefined.
  (b.main_disposition = 'neverExpected'
    AND (b.derived_event_count > 0
      OR b.readable_subagent_count > 0
      OR b.has_metric_rollup)) AS cohort_no_main_row
FROM iss7427_base b;

-- The three reporting windows, as ONE relation so every breakdown below is
-- windowed identically and the denominators cannot drift between sections.
CREATE TEMP VIEW iss7427_windows AS
SELECT * FROM (VALUES
  ('07d', (now() - interval '7 days')),
  ('30d', (now() - interval '30 days')),
  ('all', '-infinity'::timestamptz)
) AS w(window_label, since);

CREATE TEMP VIEW iss7427_windowed AS
SELECT w.window_label, c.*
FROM iss7427_windows w
JOIN iss7427_classified c ON c.session_started_at >= w.since;

\echo ''
\echo '=== 1. INCIDENCE AND RATE, by window ==================================='
\echo '    denominator = sessions whose session_started_at falls in the window'
\echo '    (every row of session_detail joined to its SESSION artifact).'
SELECT
  window_label,
  count(*)                                            AS denominator_sessions,
  count(*) FILTER (WHERE cohort_served)                AS served_metadata_only,
  round(100.0 * count(*) FILTER (WHERE cohort_served) / nullif(count(*), 0), 4)
                                                       AS served_pct,
  count(*) FILTER (WHERE cohort_derived)               AS derived_mixed_state,
  round(100.0 * count(*) FILTER (WHERE cohort_derived) / nullif(count(*), 0), 4)
                                                       AS derived_pct,
  count(*) FILTER (WHERE cohort_no_main_row)           AS no_main_row_with_metrics,
  round(100.0 * count(*) FILTER (WHERE cohort_no_main_row) / nullif(count(*), 0), 4)
                                                       AS no_main_row_pct
FROM iss7427_windowed
GROUP BY window_label
ORDER BY window_label;

\echo ''
\echo '=== 2. WHICH SIGNAL keeps a mixed-state session on screen =============='
\echo '    Overlapping by construction: a session can carry several. Read each'
\echo '    row as "how many of the cohort carry THIS signal", never as a partition.'
SELECT
  window_label,
  count(*)                                                  AS cohort_derived,
  count(*) FILTER (WHERE derived_event_count > 0)           AS with_trace_events,
  count(*) FILTER (WHERE readable_subagent_count > 0)       AS with_readable_subagents,
  count(*) FILTER (WHERE has_metric_rollup)                 AS with_cost_or_tokens,
  count(*) FILTER (WHERE estimated_cost > 0)                AS with_nonzero_cost,
  count(*) FILTER (WHERE total_tokens > 0)                  AS with_nonzero_tokens,
  count(*) FILTER (WHERE session_ended_at IS NOT NULL)      AS with_bounded_span
FROM iss7427_windowed
WHERE cohort_derived
GROUP BY window_label
ORDER BY window_label;

\echo ''
\echo '=== 3. DISPOSITION of every session, mixed-state or not ================'
\echo '    The full partition, so section 1s numerator is checkable against it.'
SELECT window_label, main_disposition, count(*) AS sessions
FROM iss7427_windowed
GROUP BY window_label, main_disposition
ORDER BY window_label, sessions DESC;

\echo ''
\echo '=== 4. PERMANENT-FAILURE REASON (the mixed-state cohort) ==============='
SELECT
  window_label,
  coalesce(main_permanent_failure_reason, '(none)') AS permanent_failure_reason,
  count(*) AS sessions
FROM iss7427_windowed
WHERE cohort_derived
GROUP BY window_label, main_permanent_failure_reason
ORDER BY window_label, sessions DESC;

\echo ''
\echo '=== 5. MAIN vs SUBAGENT gap ==========================================='
\echo '    The shape the reporter saw: main gone, sidechains readable.'
SELECT
  window_label,
  (readable_subagent_count > 0) AS has_readable_subagents,
  count(*)                      AS sessions,
  sum(readable_subagent_count)  AS readable_subagent_files
FROM iss7427_windowed
WHERE cohort_derived
GROUP BY window_label, (readable_subagent_count > 0)
ORDER BY window_label, has_readable_subagents DESC;

\echo ''
\echo '=== 6. SEGMENTS: harness / model / state / origin ======================'
SELECT window_label, 'harness' AS segment, harness AS value, count(*) AS sessions
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, harness
UNION ALL
SELECT window_label, 'model', coalesce(model, '(null)'), count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, model
UNION ALL
SELECT window_label, 'session_state', coalesce(session_state, '(null)'), count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, session_state
UNION ALL
SELECT window_label, 'artifact_status', artifact_status, count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, artifact_status
UNION ALL
SELECT window_label, 'origin', origin::text, count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, origin
ORDER BY 1, 2, 4 DESC;

\echo ''
\echo '=== 7. SEGMENTS: owner / repository / project =========================='
\echo '    Ids only — this script reads no name or email column.'
SELECT window_label, 'owner_user_id' AS segment,
       coalesce(user_id::text, '(unassigned)') AS value, count(*) AS sessions
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, user_id
UNION ALL
SELECT window_label, 'repository', coalesce(repository_full_name, '(unresolved)'), count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, repository_full_name
UNION ALL
SELECT window_label, 'project_id', coalesce(project_id::text, '(unparented)'), count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, project_id
UNION ALL
SELECT window_label, 'organization_id', organization_id::text, count(*)
FROM iss7427_windowed WHERE cohort_derived GROUP BY window_label, organization_id
ORDER BY 1, 2, 4 DESC;

\echo ''
\echo '=== 8. TIME-TO-ARCHIVE, over sessions that DID archive a main =========='
\echo '    The control group. A mixed-state session has no uploaded_at by'
\echo '    definition, so its time-to-archive is not a number that exists —'
\echo '    reporting a percentile "for the cohort" would be a fabricated measure.'
\echo '    This is the healthy population it should be read against.'
SELECT
  window_label,
  count(*) AS archived_sessions,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY main_time_to_archive)  AS p50,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY main_time_to_archive) AS p95,
  max(main_time_to_archive)                                          AS max
FROM iss7427_windowed
WHERE main_uploaded_at IS NOT NULL
GROUP BY window_label
ORDER BY window_label;

\echo ''
\echo '=== 9. EXEMPLAR reconciliation (ticket Evidence block) ================='
\echo '    Returns 0 rows outside the org that owns it; that is not an error.'
SELECT
  artifact_id, session_label, main_disposition,
  main_permanent_failure_reason, main_uploaded_at,
  derived_event_count, readable_subagent_count,
  estimated_cost, total_tokens,
  session_started_at, session_ended_at,
  harness, model, repository_full_name
FROM iss7427_classified
WHERE artifact_id = '019f8abb-46ad-711e-a54f-14c9905dfc3a';

-- ---------------------------------------------------------------------------
-- 10. SYNC TIER — segments the day ISS-7516 / PR #5737 lands, and says so
--     until then rather than silently omitting a requested breakdown.
-- ---------------------------------------------------------------------------
--
-- A device on the `metadata` sync tier never queues a transcript at all
-- (`syncTierAllowsTranscripts`), so its sessions are not a lane failure and must
-- not be counted as one. Until the column exists there is no way to tell them
-- apart in SQL, which is a stated limit on every number above, not a rounding
-- error. `\if` skips the branch lexically, so this file parses and runs today.
-- Spelled 'true'/'false' rather than left as a boolean: psql's `\if` reads the
-- variable as TEXT, and the 't'/'f' a bare boolean renders as is not one of the
-- words it accepts.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'session_detail' AND column_name = 'data_sync_level'
) THEN 'true' ELSE 'false' END AS has_sync_tier \gset

\echo ''
\echo '=== 10. SEGMENT: data sync level ======================================='
\if :has_sync_tier
SELECT
  w.window_label,
  coalesce(sd.data_sync_level, '(null)') AS data_sync_level,
  count(*) FILTER (WHERE c.cohort_derived) AS mixed_state_sessions,
  count(*)                                 AS sessions_in_window
FROM iss7427_windows w
JOIN iss7427_classified c ON c.session_started_at >= w.since
JOIN session_detail sd ON sd.artifact_id = c.artifact_id
GROUP BY w.window_label, sd.data_sync_level
ORDER BY w.window_label, mixed_state_sessions DESC;
\else
\echo '   SKIPPED — session_detail.data_sync_level does not exist in this database.'
\echo '   It ships with ISS-7516 / PR #5737 (open at the time of writing). Every'
\echo '   count above therefore MIXES consent-tier sessions, whose transcript was'
\echo '   never queued by design, with lane failures. Re-run this same file once'
\echo '   the column lands and this section fills itself in.'
\endif

\echo ''
\echo '=== LIMITS OF THIS AUDIT =============================================='
\echo ' * No app/desktop version column exists on session_detail or'
\echo '   compute_targets, so the ticket''s "app version" segment is NOT'
\echo '   available from this database. It is not omitted for brevity.'
\echo ' * estimated_cost here is the STORED ROLLUP column, which is also what the'
\echo '   list and the detail response serve. When this audit first ran they were'
\echo '   two different numbers, because the cloud re-derived a per-event sum for'
\echo '   the served figure; ISS-7176 retired that, so section 9''s cost and'
\echo '   section 2''s with_nonzero_cost now read the same column the screen does.'
\echo ' * derived_event_count is COUNT(*) over agent_session_events. The number'
\echo '   the UI prints is turnItems.length — a projection that drops Stop'
\echo '   markers, coalesces tool runs and adds subagents, and is read under a'
\echo '   row cap. The two will not be equal; this is the honest DB population.'
\echo ' * Timeline bars come from session_detail.activity_buckets when present'
\echo '   and are synthesized client-side otherwise, so "drew bars" is not a'
\echo '   column and is not counted here.'
