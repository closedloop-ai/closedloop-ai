-- DropForeignKey
ALTER TABLE "github_action_run_performances" DROP CONSTRAINT "github_action_run_performances_artifact_id_fkey";

-- DropForeignKey
ALTER TABLE "github_action_runs" DROP CONSTRAINT "github_action_runs_organization_id_fkey";

-- DropTable
DROP TABLE "github_action_run_performances";

-- DropTable
DROP TABLE "github_action_runs";

-- DropEnum
DROP TYPE "GitHubActionStatus";
