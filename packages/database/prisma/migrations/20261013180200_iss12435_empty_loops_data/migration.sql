-- ISS-12435 (PRD-795), step 3 of 3: remove Loop data and every pointer to it
-- (Q1 answered by product: A, drop the data).
--
-- HAND-WRITTEN ON PURPOSE (packages/database/AGENTS.md): data only.
--
-- WHY ROWS AND NOT TABLES. Production applies this before the new API serves,
-- and old API code keeps serving after it: the build window, browser tabs
-- pinned to an older deployment, an instant rollback, and old mcp tasks. That
-- code still queries `loops`, `artifact_generation_status_dismissals` and
-- `tag_loops` on the documents list, the project tree and every tags list, and
-- still selects the Loop columns of `session_detail`, `routines`, `routine_runs`
-- and `organizations` in default projections. So every table, column, enum
-- value and index stays; only rows go and pointers become NULL. Old code then
-- reads empty results and never an error. The tables, enum values and columns
-- are dropped by a later migration-only change, once no older deployment is
-- servable (the FEA-3342 deploy gate refuses a DROP COLUMN before then anyway).
--
-- ORDER. Step 2 already copied the session cost and cost-split ledger out of
-- the Loop rows. Pointers on other surviving rows are cleared first. The
-- session copies then run once more, right before the Loop rows go (their
-- child tables cascade), for sessions older API code synced after step 2; then
-- the loop search trigger.
--
-- IDEMPOTENT: every statement matches only rows it has not already changed, so
-- re-running it is safe. No DROP TABLE, DROP COLUMN, RENAME, ALTER TYPE or
-- TRUNCATE.

SET lock_timeout = '5s';

-- Search: loop hits disappear. The status sync trigger on `loops` is dropped
-- last, below.
DELETE FROM "search_document" WHERE "entity_type" = 'loop';

-- Cloud routine execution is gone: settle its open runs the way the settle
-- sweep settled a cancelled loop (the run, then the routine's cached last-run
-- status, which `GET /routines` reports), and clear the schedule state only it
-- wrote. The cache refresh must run while `loop_id` still marks the cloud runs.
UPDATE "routine_runs"
   SET "status" = 'CANCELED', "finished_at" = coalesce("finished_at", now())
 WHERE "loop_id" IS NOT NULL
   AND "status" IN ('PENDING', 'RUNNING');
UPDATE "routines" AS r
   SET "last_status" = rr."status", "updated_at" = GREATEST(r."updated_at", now())
  FROM "routine_runs" AS rr
 WHERE rr."id" = r."last_run_id"
   AND rr."loop_id" IS NOT NULL
   AND rr."status" = 'CANCELED'
   AND r."last_status" IN ('PENDING', 'RUNNING');
UPDATE "routine_runs" SET "loop_id" = NULL WHERE "loop_id" IS NOT NULL;
UPDATE "routines"
   SET "next_run_at" = NULL
 WHERE "runs_on" = 'CLOUD' AND "source_id" IS NULL AND "next_run_at" IS NOT NULL;
UPDATE "routines"
   SET "cloud_dispatch_failures" = 0, "cloud_schedule_parked_until" = NULL
 WHERE "cloud_dispatch_failures" <> 0 OR "cloud_schedule_parked_until" IS NOT NULL;

-- Queued loop launches are never redelivered to an old Desktop.
UPDATE "desktop_commands"
   SET "status" = 'expired', "finished_at" = coalesce("finished_at", now())
 WHERE "status" = 'queued'
   AND "operation_id" IN ('symphony_loop', 'symphony_loop_kill', 'symphony_plan_loop');

-- Loop pointers on catalog, agents and judge evaluations. `artifact_evaluations`
-- is guarded because the judges removal (PLN-2125) may drop it first.
UPDATE "catalog_items" SET "source_loop_id" = NULL WHERE "source_loop_id" IS NOT NULL;
UPDATE "agents" SET "bootstrap_run_id" = NULL WHERE "bootstrap_run_id" IS NOT NULL;
DO $$
BEGIN
  IF to_regclass('artifact_evaluations') IS NOT NULL THEN
    UPDATE "artifact_evaluations" SET "loop_id" = NULL WHERE "loop_id" IS NOT NULL;
  END IF;
END $$;

-- Settings that only Loops read: the stored Claude API key, the compute
-- preference, and two organization settings keys.
UPDATE "users"
   SET "claude_api_key_encrypted" = NULL,
       "claude_api_key_last_four" = NULL,
       "claude_api_key_set_at" = NULL,
       "preferred_compute_mode" = NULL,
       "preferred_compute_target_id" = NULL,
       "preferred_harness" = NULL
 WHERE "claude_api_key_encrypted" IS NOT NULL
    OR "claude_api_key_last_four" IS NOT NULL
    OR "claude_api_key_set_at" IS NOT NULL
    OR "preferred_compute_mode" IS NOT NULL
    OR "preferred_compute_target_id" IS NOT NULL
    OR "preferred_harness" IS NOT NULL;
UPDATE "organizations"
   SET "claude_api_key_encrypted" = NULL,
       "claude_api_key_last_four" = NULL,
       "claude_api_key_set_at" = NULL
 WHERE "claude_api_key_encrypted" IS NOT NULL
    OR "claude_api_key_last_four" IS NOT NULL
    OR "claude_api_key_set_at" IS NOT NULL;
-- `updated_at` through GREATEST, as `writeOrganizationSettings` does, because a
-- raw UPDATE never reaches Prisma's `@updatedAt`.
UPDATE "organizations"
   SET "settings" = "settings" - 'maxConcurrentLoops' - 'computeMode',
       "updated_at" = GREATEST("updated_at", now())
 WHERE jsonb_typeof("settings") = 'object'
   AND ("settings" ? 'maxConcurrentLoops' OR "settings" ? 'computeMode');

-- Loop-only rows that hang off other tables.
DELETE FROM "artifact_generation_status_dismissals";
DELETE FROM "repo_bootstrap_configs";

-- Loop rows last. `parent_loop_id` is a RESTRICT self reference; it is cleared
-- first, although one DELETE of every row also satisfies it. `loop_events`, `loop_token_refresh`,
-- `loop_execution_credential_consumptions`, `tag_loops` and
-- `pr_materialization_retries` cascade from `loops`.
-- Sessions. Older API code keeps accepting a `source_loop_id` until the new
-- deploy serves, so a session can be first synced after step 2 ran. Step 2's
-- cost copy runs again here, in the transaction that deletes the loops and
-- right before it, and the ledger is written in the same statement that clears
-- the pointer, so no session loses its cost or cost split between the copy and
-- the delete. Both only fill NULL columns: a row step 2 filled is unchanged.
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
  s."legacy_loop_cost_ledger",
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
    WHERE l."id" = CASE
      WHEN s."source_loop_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN s."source_loop_id"::uuid
    END
  ),
  'unknown'
),
"source_loop_id" = NULL
WHERE s."source_loop_id" IS NOT NULL;

UPDATE "session_detail" SET "origin" = 'DESKTOP_SYNC' WHERE "origin" = 'LOOP';

UPDATE "loops" SET "parent_loop_id" = NULL WHERE "parent_loop_id" IS NOT NULL;
DELETE FROM "loops";

-- A session committed between the session statements above and this delete
-- points at a loop that no longer exists, which the cost-split classifier read
-- as unknown. Older API code writing after this commit is ISS-12450's.
UPDATE "session_detail"
SET "legacy_loop_cost_ledger" = coalesce("legacy_loop_cost_ledger", 'unknown'),
    "source_loop_id" = NULL
WHERE "source_loop_id" IS NOT NULL;
UPDATE "session_detail" SET "origin" = 'DESKTOP_SYNC' WHERE "origin" = 'LOOP';

-- Nothing keeps a loop's search status in sync any more. DROP TRIGGER takes an
-- ACCESS EXCLUSIVE lock on `loops` that is held until commit and blocks every
-- old-code read of it, so it runs last to keep that window short. Dropping it
-- last changes nothing above: it fires only on an UPDATE OF "status", which no
-- statement here issues, and it only updates an existing loop projection row,
-- which the search delete above already removed.
DROP TRIGGER IF EXISTS "loops_search_document_status_sync" ON "loops";
DROP FUNCTION IF EXISTS "sync_search_document_loop_status"();

RESET lock_timeout;
