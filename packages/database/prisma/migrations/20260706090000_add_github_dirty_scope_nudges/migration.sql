-- Add durable debounce/rate-limit state for GitHub webhook dirty-scope nudges.
CREATE TABLE "github_dirty_scope_nudges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "github_installation_repository_id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "window_started_at" TIMESTAMP(3) NOT NULL,
    "dirty_scopes" JSONB NOT NULL,
    "generic_refresh" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_dispatch_at" TIMESTAMP(3) NOT NULL,
    "dispatch_claimed_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "delivery_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_dirty_scope_nudges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_dirty_scope_nudges_org_repo_target_window_key"
    ON "github_dirty_scope_nudges"("organization_id", "github_installation_repository_id", "compute_target_id", "window_started_at");

CREATE INDEX "github_dirty_scope_nudges_dispatch_due_idx"
    ON "github_dirty_scope_nudges"("scheduled_dispatch_at", "dispatched_at");

CREATE INDEX "github_dirty_scope_nudges_dispatch_claim_idx"
    ON "github_dirty_scope_nudges"("dispatch_claimed_at");

CREATE INDEX "github_dirty_scope_nudges_expires_idx"
    ON "github_dirty_scope_nudges"("expires_at");

CREATE INDEX "github_dirty_scope_nudges_org_repo_idx"
    ON "github_dirty_scope_nudges"("organization_id", "github_installation_repository_id");

ALTER TABLE "github_dirty_scope_nudges"
    ADD CONSTRAINT "github_dirty_scope_nudges_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_dirty_scope_nudges"
    ADD CONSTRAINT "github_dirty_scope_nudges_github_installation_repository_i_fkey"
    FOREIGN KEY ("github_installation_repository_id") REFERENCES "github_installation_repositories"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_dirty_scope_nudges"
    ADD CONSTRAINT "github_dirty_scope_nudges_compute_target_id_fkey"
    FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
