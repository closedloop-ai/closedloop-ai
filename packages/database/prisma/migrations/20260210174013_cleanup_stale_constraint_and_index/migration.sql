-- DropForeignKey (safe: already dropped by fix_migrations in some environments)
ALTER TABLE "artifact_evaluations" DROP CONSTRAINT IF EXISTS "artifact_evaluations_artifact_id_fkey";

-- RenameIndex
ALTER INDEX IF EXISTS "github_installation_repositories_installation_id_github_repo_id" RENAME TO "github_installation_repositories_installation_id_github_rep_key";
