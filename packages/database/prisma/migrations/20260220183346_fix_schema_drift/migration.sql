-- DropForeignKey
ALTER TABLE "github_action_run_performances" DROP CONSTRAINT "github_action_run_performances_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "loops" DROP CONSTRAINT "loops_parent_loop_id_fkey";

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "id" DROP DEFAULT;
