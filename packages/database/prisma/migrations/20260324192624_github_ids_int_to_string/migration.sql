-- AlterTable: github_installations — convert integer GitHub IDs to text
-- Drop unique index before altering column type
DROP INDEX "github_installations_installation_id_key";

ALTER TABLE "github_installations"
  ALTER COLUMN "installation_id" SET DATA TYPE TEXT USING installation_id::text,
  ALTER COLUMN "account_id" SET DATA TYPE TEXT USING account_id::text,
  ALTER COLUMN "sender_id" SET DATA TYPE TEXT USING sender_id::text;

-- Recreate unique index
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");

-- AlterTable: github_installation_repositories — convert integer github_repo_id to text
-- Drop composite unique index before altering column type
DROP INDEX "github_installation_repositories_installation_id_github_rep_key";

ALTER TABLE "github_installation_repositories"
  ALTER COLUMN "github_repo_id" SET DATA TYPE TEXT USING github_repo_id::text;

-- Recreate composite unique index
CREATE UNIQUE INDEX "github_installation_repositories_installation_id_github_rep_key" ON "github_installation_repositories"("installation_id", "github_repo_id");

-- AlterTable: github_pull_requests — convert integer github_id to text
ALTER TABLE "github_pull_requests"
  ALTER COLUMN "github_id" SET DATA TYPE TEXT USING github_id::text;

-- AlterTable: github_action_runs — convert bigint run_id to text
-- Drop composite unique index before altering column type
DROP INDEX "github_action_runs_repository_id_run_id_key";

ALTER TABLE "github_action_runs"
  ALTER COLUMN "run_id" SET DATA TYPE TEXT USING run_id::text;

-- Recreate composite unique index
CREATE UNIQUE INDEX "github_action_runs_repository_id_run_id_key" ON "github_action_runs"("repository_id", "run_id");
