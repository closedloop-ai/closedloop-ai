-- =============================================================================
-- Post-conversion guards for the SESSION artifact migration (PLN-854 /
-- FEA-1699). Runs immediately after the agent_sessions -> session_detail
-- conversion on any fresh deploy.
--
-- HAND-WRITTEN: assertion + CHECK constraint only; no schema-model changes
-- (Prisma does not model CHECK constraints, so this does not affect drift
-- detection).
-- =============================================================================

-- 1. Assert the SES-* slug backfill completed: a NULL-slug SESSION artifact
--    would be invisible to slug lookups with no loud failure, so abort the
--    deploy instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "artifacts"
    WHERE "type" = 'SESSION'::"ArtifactType" AND "slug" IS NULL
  ) THEN
    RAISE EXCEPTION 'SESSION slug backfill incomplete: NULL-slug session artifacts remain';
  END IF;
END $$;

-- 2. DB-level invariant: project_id was made nullable solely so SESSION
--    artifacts can be unparented. Every other artifact type must keep a
--    project; the application services enforce this (branch-service,
--    deployment-service), and the CHECK guards against any future write path
--    silently regressing it.
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_non_session_project_required"
  CHECK ("type" = 'SESSION'::"ArtifactType" OR "project_id" IS NOT NULL);
