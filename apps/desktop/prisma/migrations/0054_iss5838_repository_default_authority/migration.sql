-- ISS-5838: create-only Desktop cache for provider repository-default authority.
-- Historical rows are intentionally not backfilled, and local Git-derived
-- repos.default_branch remains a separate, non-authoritative overlay.
-- IF NOT EXISTS keeps untracked-store baseline adoption idempotent: the runner
-- replays the migration chain over an already-final schema without replacing
-- the equivalent table or its rows.
CREATE TABLE IF NOT EXISTS "repository_default_authorities" (
  "identity_key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_repository_id" TEXT NOT NULL,
  "repo_full_name" TEXT NOT NULL,
  "default_branch" TEXT,
  "availability" TEXT NOT NULL,
  "completeness" TEXT NOT NULL,
  "reason" TEXT,
  "source" TEXT NOT NULL,
  "source_identity" TEXT,
  "mechanism" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "credential_type" TEXT NOT NULL,
  "credential_owner_id" TEXT,
  "observation_key" TEXT NOT NULL,
  "observed_at" TEXT NOT NULL,
  "event_at" TEXT,
  "updated_at" TEXT NOT NULL,

  PRIMARY KEY ("identity_key", "provider", "provider_repository_id")
);

CREATE INDEX IF NOT EXISTS "idx_repository_default_authorities_identity_repo"
  ON "repository_default_authorities"("identity_key", "repo_full_name");
