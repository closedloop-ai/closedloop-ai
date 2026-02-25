-- DropForeignKey (safe: constraint may not exist if prior migration was applied before FK line was added)
ALTER TABLE "github_pull_requests" DROP CONSTRAINT IF EXISTS "github_pull_requests_artifact_id_fkey";
