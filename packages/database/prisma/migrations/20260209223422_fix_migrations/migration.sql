-- DropForeignKey (safe: may already be dropped in some environments)
ALTER TABLE "artifact_evaluations" DROP CONSTRAINT IF EXISTS "artifact_evaluations_artifact_id_fkey";

-- DropForeignKey (safe: may already be dropped in some environments)
ALTER TABLE "preview_deployments" DROP CONSTRAINT IF EXISTS "preview_deployments_artifact_id_fkey";
