-- DropForeignKey
ALTER TABLE "artifact_evaluations" DROP CONSTRAINT "artifact_evaluations_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_deployments" DROP CONSTRAINT "preview_deployments_artifact_id_fkey";
