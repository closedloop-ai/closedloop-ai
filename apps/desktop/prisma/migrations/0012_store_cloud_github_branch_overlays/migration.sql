-- Persist cloud-sourced GitHub branch overlays so Desktop can render the last
-- synced GitHub state while offline or when cloud refresh fails.
CREATE TABLE IF NOT EXISTS "cloud_github_branch_overlays" (
  "identity_key" TEXT NOT NULL,
  "repo_full_name" TEXT NOT NULL,
  "branch_name" TEXT NOT NULL,
  "overlay" JSONB NOT NULL,
  "last_synced_at" TEXT NOT NULL,
  PRIMARY KEY ("identity_key", "repo_full_name", "branch_name")
);

CREATE INDEX IF NOT EXISTS "idx_cloud_github_branch_overlays_identity_synced"
  ON "cloud_github_branch_overlays"("identity_key", "last_synced_at");
