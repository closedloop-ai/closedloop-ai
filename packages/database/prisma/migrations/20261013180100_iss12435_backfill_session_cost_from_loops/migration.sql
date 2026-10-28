-- ISS-12435 (PRD-795), step 2 of 3: copy into `session_detail` the two figures
-- the API used to read from Loop rows, before step 3 empties those rows.
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): data only.
--
-- 1. `authoritative_cost_usd`. The session-detail read used to fall back to
--    the newest `completed` loop event of the loop that claimed the session
--    (`findSessionAuthoritativeCostUsd`, removed with Loops). This writes
--    exactly that figure where the column is still NULL: same claim
--    (`loops.session_artifact_id`) and pointer (`source_loop_id`) match, same
--    org scope, newest completed event first, the same validation of the
--    `usageReconciliation` block the read's schema parse applied, and the same
--    round-to-6 before the storable bound (`canStoreAuthoritativeCostUsd`).
--    A newest event without a usable figure leaves the column NULL, as the
--    read did. A stored Desktop figure is never touched.
--
-- 2. `legacy_loop_cost_ledger`. The usage cost split classified a session with
--    a `source_loop_id` by its loop's `metadata.apiKeySource` ("none" is
--    subscription, any other string is metered, absent is unknown), ignoring
--    `billing_mode` (`usage-cost-split.ts`). That loop row goes in step 3, so the
--    ledger is written here for EVERY row with a `source_loop_id`, including
--    rows whose loop is missing, in another org, or not text-equal to the loop
--    id: those were unknown before and stay unknown. The match is exact text, as
--    the classifier's Map lookup was.
--
-- IDEMPOTENT: both statements only fill NULL columns from rows step 3 deletes,
-- so a second run changes nothing. No DROP, no ALTER, no DELETE.

SET lock_timeout = '5s';

-- Every numeric read goes through a CASE on `jsonb_typeof` first: Postgres does
-- not promise to evaluate AND operands in order, so a bare `::numeric` beside a
-- type test could raise on a string value and abort the deploy.
UPDATE "session_detail" AS s
SET "authoritative_cost_usd" = reported.value
FROM "loops" AS l
JOIN "artifacts" AS a
  ON a."id" = l."session_artifact_id"
 AND a."organization_id" = l."organization_id"
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN v.is_object
     AND v.session_origin IN ('harness_stdout', 'persistent_transcript')
     AND v.reconciliation_status IN ('matched', 'drifted', 'unavailable')
     AND v.authoritative IS NOT NULL
     AND v.authoritative >= 0
     AND abs(round(v.authoritative, 6)) < 100000000
     AND v.derived_ok
     AND v.delta_ok
     AND v.turns_ok
     AND v.duration_ok
     AND v.duration_api_ok
     AND v.stop_reason_ok
    THEN round(v.authoritative, 6)
    ELSE NULL
  END AS value
  FROM "loop_events" AS e
  CROSS JOIN LATERAL (SELECT e."data" -> 'usageReconciliation' AS b) AS blk
  CROSS JOIN LATERAL (
    SELECT
      jsonb_typeof(blk.b) = 'object' AS is_object,
      blk.b ->> 'sessionOrigin' AS session_origin,
      blk.b ->> 'reconciliationStatus' AS reconciliation_status,
      CASE WHEN jsonb_typeof(blk.b -> 'authoritativeCostUsd') = 'number'
           THEN (blk.b ->> 'authoritativeCostUsd')::numeric END AS authoritative,
      CASE jsonb_typeof(blk.b -> 'derivedCostUsd')
        WHEN 'null' THEN true
        WHEN 'number' THEN (blk.b ->> 'derivedCostUsd')::numeric >= 0
        ELSE false END AS derived_ok,
      coalesce(jsonb_typeof(blk.b -> 'reconciliationDeltaUsd') IN ('number', 'null'), false) AS delta_ok,
      CASE jsonb_typeof(blk.b -> 'harnessNumTurns')
        WHEN 'null' THEN true
        WHEN 'number' THEN (blk.b ->> 'harnessNumTurns')::numeric >= 0
          AND (blk.b ->> 'harnessNumTurns')::numeric
              = trunc((blk.b ->> 'harnessNumTurns')::numeric)
          -- zod's `.int()` rejects a value past the safe-integer range.
          AND abs((blk.b ->> 'harnessNumTurns')::numeric) <= 9007199254740991
        ELSE false END AS turns_ok,
      CASE jsonb_typeof(blk.b -> 'harnessDurationMs')
        WHEN 'null' THEN true
        WHEN 'number' THEN (blk.b ->> 'harnessDurationMs')::numeric >= 0
        ELSE false END AS duration_ok,
      CASE
        WHEN NOT coalesce(blk.b ? 'harnessDurationApiMs', false) THEN true
        WHEN jsonb_typeof(blk.b -> 'harnessDurationApiMs') = 'number'
          THEN (blk.b ->> 'harnessDurationApiMs')::numeric >= 0
        ELSE false END AS duration_api_ok,
      CASE
        WHEN NOT coalesce(blk.b ? 'harnessStopReason', false) THEN true
        ELSE jsonb_typeof(blk.b -> 'harnessStopReason') = 'string' END AS stop_reason_ok
  ) AS v
  WHERE e."loop_id" = l."id"
    AND e."type" = 'completed'
  ORDER BY e."created_at" DESC
  LIMIT 1
) AS reported
WHERE s."artifact_id" = a."id"
  AND lower(s."source_loop_id") = l."id"::text
  AND s."authoritative_cost_usd" IS NULL
  AND reported.value IS NOT NULL;

UPDATE "session_detail" AS s
SET "legacy_loop_cost_ledger" = coalesce(
  (
    SELECT CASE
      WHEN jsonb_typeof(l."metadata" -> 'apiKeySource') IS DISTINCT FROM 'string' THEN 'unknown'
      WHEN l."metadata" ->> 'apiKeySource' = 'none' THEN 'subscription'
      ELSE 'metered'
    END
    FROM "loops" AS l
    JOIN "artifacts" AS a
      ON a."id" = s."artifact_id"
     AND a."organization_id" = l."organization_id"
    -- Exact text equality with the canonical lowercase uuid, as the classifier's
    -- Map lookup was. The CASE casts only a canonical uuid, so a free-text
    -- pointer never raises 22P02, and the uuid comparison can use the key.
    WHERE l."id" = CASE
      WHEN s."source_loop_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN s."source_loop_id"::uuid
    END
  ),
  'unknown'
)
WHERE s."source_loop_id" IS NOT NULL
  AND s."legacy_loop_cost_ledger" IS NULL;

RESET lock_timeout;
