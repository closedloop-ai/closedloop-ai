-- The DISPLAYED-STATUS-DEPENDENT end instant a duration sort key measures to —
-- `now()` while the row reads as running, its recorded end once terminal.
-- The live comparator measures running rows against the minute-floored
-- `durationSortClockMs`, so an unfloored clock here logs a divergence on every
-- chain carrying `duration` and a running session.
--
-- `now()` is cast through `AT TIME ZONE 'UTC'` to a naive `timestamp`, the type
-- `session_ended_at`/`session_started_at` are stored as — `now()` alone is
-- `timestamptz` and would shift under a session time zone other than UTC.
-- `date_trunc` is applied AFTER that cast for the same reason: truncating the
-- `timestamptz` would floor to a minute of the session time zone.
CASE
  WHEN (
    -- ISS-10364: every status folds to itself if recognized, and fails
    -- OPEN to 'active' otherwise — the same fold `normalizeSessionStatus`
    -- applies. No other input: a stored 'active' reads as running whatever
    -- `session_ended_at` holds (ISS-12430).
    CASE
      WHEN a.status IN ('active', 'inactive', 'error') THEN a.status
      ELSE 'active'
    END
  ) = 'active'
  THEN date_trunc('minute', now() AT TIME ZONE 'UTC')
  ELSE sd.session_ended_at
END AS display_duration_end_at
