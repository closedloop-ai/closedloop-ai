-- Add artifactId field to GitHubPullRequest model
ALTER TABLE "github_pull_requests" ADD COLUMN "artifact_id" UUID;
