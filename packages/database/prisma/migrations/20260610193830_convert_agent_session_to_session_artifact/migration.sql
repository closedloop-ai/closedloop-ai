-- =============================================================================
-- Convert agent_sessions (standalone table) into session_detail, the
-- class-table-inheritance detail table for the new SESSION artifact type
-- (PLN-854 / FEA-1699).
--
-- HAND-WRITTEN (not Prisma-generated): Prisma diffs this as a DROP TABLE
-- agent_sessions + CREATE TABLE session_detail, which would destroy all
-- captured session data. Instead we backfill one parent `artifacts` row per
-- existing session (reusing the session id as the artifact id, so the child
-- agent_session_events / agent_session_token_usage FK rows stay valid) and
-- rename the table in place — no data copy of sessions, events, or token usage.
--
-- The final object names below match exactly what Prisma generates for the
-- SessionDetail model, so `prisma migrate` reports no drift afterward.
--
-- The 'SESSION' enum value is added in the preceding migration and committed
-- before this one runs, because Postgres forbids using a newly added enum
-- value in the same transaction that adds it.
-- =============================================================================

-- 1. Backfill: one SESSION artifact per existing session. The artifact id IS the
--    session id, so child event/token-usage FKs (which reference it) remain
--    valid after the rename. created_by_id mirrors the session owner. name is
--    required on the parent, so fall back to a stable label when absent.
INSERT INTO "artifacts" (
  "id",
  "organization_id",
  "project_id",
  "type",
  "name",
  "status",
  "created_at",
  "created_by_id",
  "updated_at"
)
SELECT
  s."id",
  s."organization_id",
  s."project_id",
  'SESSION'::"ArtifactType",
  COALESCE(NULLIF(btrim(s."name"), ''), 'Session ' || s."external_session_id"),
  s."status",
  s."created_at",
  s."user_id",
  s."updated_at"
FROM "agent_sessions" s;

-- 2. Allocate dense per-org SES-* slugs, ordered by session start time. SES
--    numbering carries no semantic meaning, so per-org ordering is sufficient.
WITH numbered AS (
  SELECT
    s."id" AS session_id,
    row_number() OVER (
      PARTITION BY s."organization_id"
      ORDER BY s."session_started_at", s."id"
    ) AS rn
  FROM "agent_sessions" s
)
UPDATE "artifacts" a
SET "slug" = 'SES-' || n.rn
FROM numbered n
WHERE a."id" = n.session_id;

-- 3. Advance each org's SES slug counter so forward-capture continues the
--    sequence without colliding with backfilled slugs.
INSERT INTO "slug_counters" ("id", "organization_id", "type_prefix", "current_value")
SELECT
  gen_random_uuid(),
  counts."organization_id",
  'SES',
  counts."session_count"
FROM (
  SELECT s."organization_id" AS "organization_id", COUNT(*) AS "session_count"
  FROM "agent_sessions" s
  GROUP BY s."organization_id"
) counts
ON CONFLICT ("organization_id", "type_prefix")
DO UPDATE SET "current_value" =
  GREATEST("slug_counters"."current_value", EXCLUDED."current_value");

-- 4. Restructure agent_sessions -> session_detail in place.
ALTER TABLE "agent_sessions" RENAME TO "session_detail";
ALTER TABLE "session_detail" RENAME COLUMN "id" TO "artifact_id";

-- Drop hoisted columns (now owned by the parent artifact). Dropping
-- organization_id / project_id also drops their FK constraints and the
-- org-scoped composite indexes that referenced them.
ALTER TABLE "session_detail" DROP COLUMN "organization_id";
ALTER TABLE "session_detail" DROP COLUMN "project_id";
ALTER TABLE "session_detail" DROP COLUMN "name";
ALTER TABLE "session_detail" DROP COLUMN "status";

-- user_id: Cascade -> nullable SetNull (a session survives its owner's deletion
-- as an org-owned artifact).
ALTER TABLE "session_detail" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "session_detail" DROP CONSTRAINT "agent_sessions_user_id_fkey";
ALTER TABLE "session_detail" ADD CONSTRAINT "session_detail_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- compute_target_id: Cascade -> Restrict. Compute-target deletion must remove
-- the session artifacts explicitly (handled in the compute-targets service);
-- this guards against silently orphaning the parent artifact rows.
ALTER TABLE "session_detail" DROP CONSTRAINT "agent_sessions_compute_target_id_fkey";
ALTER TABLE "session_detail" ADD CONSTRAINT "session_detail_compute_target_id_fkey"
  FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New parent FK to the artifacts row.
ALTER TABLE "session_detail" ADD CONSTRAINT "session_detail_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Rename surviving primary key and indexes to the names Prisma expects for
--    the SessionDetail model. The PK is a real constraint; @@unique and @@index
--    are plain (unique) indexes in Prisma, so rename those via ALTER INDEX.
ALTER TABLE "session_detail" RENAME CONSTRAINT "agent_sessions_pkey" TO "session_detail_pkey";
ALTER INDEX "agent_sessions_compute_target_id_external_session_id_key"
  RENAME TO "session_detail_compute_target_id_external_session_id_key";
ALTER INDEX "agent_sessions_compute_target_id_session_updated_at_idx"
  RENAME TO "session_detail_compute_target_id_session_updated_at_idx";

-- 6. Create the new detail-scoped indexes. (Org-scoped composite indexes are
--    gone with the hoisted org column; reads now filter org via the artifacts
--    join and order by these session_detail columns.)
CREATE INDEX "session_detail_session_started_at_idx"
  ON "session_detail"("session_started_at");
CREATE INDEX "session_detail_user_id_session_started_at_idx"
  ON "session_detail"("user_id", "session_started_at");
CREATE INDEX "session_detail_harness_session_started_at_idx"
  ON "session_detail"("harness", "session_started_at");
