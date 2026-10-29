-- Prisma generated the nullable column. The CHECK and exact-match aggregate
-- repair are hand-authored because Prisma cannot express either construct.

-- AlterTable
ALTER TABLE "branch_activity_atoms" ADD COLUMN "activity_kind" VARCHAR(32);
ALTER TABLE "branch_activity_atoms" ADD COLUMN "compatibility_alias_for_source_event_id" VARCHAR(512);

ALTER TABLE "branch_activity_atoms"
ADD CONSTRAINT "branch_activity_atoms_activity_kind_check"
CHECK (
    "activity_kind" IS NULL
    OR "activity_kind" IN ('user_reference', 'agent_read', 'agent_action')
);

-- A future monitored event is retry-owned by its immutable first receive
-- instant. Persisting the anchor prevents the same poisoned evidence from
-- becoming trusted merely because a later retry happens after wall time moves.
CREATE TABLE "monitored_session_activity_quarantine" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "session_artifact_id" UUID NOT NULL,
    "event_identity_hash" CHAR(64) NOT NULL,
    "event_fingerprint" CHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitored_session_activity_quarantine_pkey" PRIMARY KEY ("id")
);

-- index-lock-ok(monitored_session_activity_quarantine): table is created empty in this same migration so the identity build locks zero rows, the unique is required for atomic replay, and CONCURRENTLY must stay in a bare migration rather than mix with this table DDL and compatibility repair
CREATE UNIQUE INDEX IF NOT EXISTS "monitored_activity_quarantine_identity_key"
ON "monitored_session_activity_quarantine"("organization_id", "session_artifact_id", "event_identity_hash");

ALTER TABLE "monitored_session_activity_quarantine"
ADD CONSTRAINT "monitored_activity_quarantine_organization_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "monitored_session_activity_quarantine"
ADD CONSTRAINT "monitored_activity_quarantine_session_fkey"
FOREIGN KEY ("session_artifact_id") REFERENCES "artifacts"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express that the quarantined artifact must belong to this org
-- and carry a SessionDetail. Enforce both invariants before every write.
CREATE FUNCTION "ensure_monitored_activity_quarantine_session_owner"()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "artifacts" artifact
    INNER JOIN "session_detail" session
      ON session."artifact_id" = artifact."id"
    WHERE artifact."id" = NEW."session_artifact_id"
      AND artifact."organization_id" = NEW."organization_id"
      AND artifact."type" = 'SESSION'
  ) THEN
    RAISE EXCEPTION 'monitored activity quarantine requires an organization-owned Session artifact'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "monitored_activity_quarantine_session_owner_check"
BEFORE INSERT OR UPDATE OF "organization_id", "session_artifact_id"
ON "monitored_session_activity_quarantine"
FOR EACH ROW
EXECUTE FUNCTION "ensure_monitored_activity_quarantine_session_owner"();

-- Repair only compatibility scalars whose exact value is proven to come from
-- an implausibly future atom. Trustworthy siblings remain the source of truth;
-- a poisoned Branch with no trustworthy atom returns honestly to NULL.
WITH "poisoned_branches" AS MATERIALIZED (
    SELECT branch."organization_id", branch."artifact_id"
    FROM "branch_detail" AS branch
    WHERE EXISTS (
        SELECT 1
        FROM "branch_activity_atoms" AS poisoned
        WHERE poisoned."organization_id" = branch."organization_id"
          AND poisoned."branch_artifact_id" = branch."artifact_id"
          AND poisoned."occurred_at" = branch."last_activity_at"
          AND poisoned."occurred_at" > poisoned."created_at" + INTERVAL '24 hours'
    )
    ORDER BY branch."artifact_id"
    FOR UPDATE OF branch
),
"recomputed" AS (
    SELECT
        poisoned."organization_id",
        poisoned."artifact_id",
        MAX(trusted."occurred_at") AS "last_activity_at"
    FROM "poisoned_branches" AS poisoned
    LEFT JOIN "branch_activity_atoms" AS trusted
      ON trusted."organization_id" = poisoned."organization_id"
     AND trusted."branch_artifact_id" = poisoned."artifact_id"
     AND trusted."version" = 1
     AND trusted."compatibility_alias_for_source_event_id" IS NULL
     AND trusted."source" IN (
       'git_head',
       'pull_request_lifecycle',
       'pull_request_review',
       'github_webhook',
       'monitored_session'
     )
     AND trusted."source_event_id" = btrim(trusted."source_event_id")
     AND length(trusted."source_event_id") BETWEEN 1 AND 512
     AND isfinite(trusted."occurred_at")
     AND trusted."occurred_at" <= trusted."created_at" + INTERVAL '24 hours'
     AND trusted."completeness" IN ('complete', 'partial')
     AND (
       (
         trusted."attribution_kind" = 'branch'
         AND trusted."pull_request_detail_id" IS NULL
       )
       OR (
         trusted."attribution_kind" = 'pull_request'
         AND trusted."pull_request_detail_id" IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM "pull_request_detail" AS activity_pr
           WHERE activity_pr."organization_id" = trusted."organization_id"
             AND activity_pr."id" = trusted."pull_request_detail_id"
             AND activity_pr."branch_artifact_id" = trusted."branch_artifact_id"
         )
       )
     )
    GROUP BY poisoned."organization_id", poisoned."artifact_id"
)
UPDATE "branch_detail" AS branch
SET "last_activity_at" = recomputed."last_activity_at",
    "updated_at" = CURRENT_TIMESTAMP
FROM "recomputed" AS recomputed
WHERE branch."organization_id" = recomputed."organization_id"
  AND branch."artifact_id" = recomputed."artifact_id"
  AND branch."last_activity_at" IS DISTINCT FROM recomputed."last_activity_at";
