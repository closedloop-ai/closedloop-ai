-- Add artifactId field to GitHubPullRequest model with foreign key to artifacts
ALTER TABLE "github_pull_requests" ADD COLUMN "artifact_id" UUID;

-- Add foreign key constraint (SET NULL on delete so PR records survive artifact deletion)
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
