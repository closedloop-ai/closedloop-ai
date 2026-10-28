-- The preceding migration stamped every already-pending row at upgrade time,
-- but that instant is not the row's historical transition into pending. Its
-- tracking timestamp is the durable boundary between those fabricated values
-- and timestamps written by later enqueue/re-pend transitions.
--
-- The migration-chain agreement guard executes committed SQL without the
-- runner, so repeat the runner-owned table's idempotent declaration here before
-- consulting it. Production already has this table and this statement is a
-- no-op there.
CREATE TABLE IF NOT EXISTS "_desktop_migrations" (
  "name" TEXT PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "applied_at" TEXT NOT NULL
);

-- A missing or malformed boundary cannot safely distinguish fabricated history
-- from a later transition. Clearing all stored ages is conservative: the rows
-- still count as pending, while the burn-down refuses to report a made-up age.
WITH "legacy_boundary" AS (
  SELECT CASE
    WHEN COUNT(*) = 1
      AND "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND "applied_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T24:*'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', "applied_at") = "applied_at"
    THEN MIN("applied_at")
    ELSE NULL
  END AS "applied_at"
  FROM "_desktop_migrations"
  WHERE "name" = '20260918214249_iss10379_sync_outbox_pending_since'
)
UPDATE "agent_session_sync_outbox"
SET "pending_since" = NULL
WHERE "pending_since" IS NOT NULL
  AND (
    (SELECT "applied_at" FROM "legacy_boundary") IS NULL
    OR "pending_since" <= (SELECT "applied_at" FROM "legacy_boundary")
  );

WITH "legacy_boundary" AS (
  SELECT CASE
    WHEN COUNT(*) = 1
      AND "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND "applied_at" NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T24:*'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', "applied_at") = "applied_at"
    THEN MIN("applied_at")
    ELSE NULL
  END AS "applied_at"
  FROM "_desktop_migrations"
  WHERE "name" = '20260918214249_iss10379_sync_outbox_pending_since'
)
UPDATE "agent_component_invocation_sync_outbox"
SET "pending_since" = NULL
WHERE "pending_since" IS NOT NULL
  AND (
    (SELECT "applied_at" FROM "legacy_boundary") IS NULL
    OR "pending_since" <= (SELECT "applied_at" FROM "legacy_boundary")
  );
