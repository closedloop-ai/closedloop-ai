-- CreateTable
CREATE TABLE "branch_push_contributions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_artifact_id" UUID NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "ref_name" TEXT NOT NULL,
    "before_sha" VARCHAR(64) NOT NULL,
    "after_sha" VARCHAR(64) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "source_event_id" VARCHAR(255) NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "actor_type" VARCHAR(32) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_push_contributions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_push_contributions_dedupe_key" UNIQUE ("organization_id", "branch_artifact_id", "source", "source_event_id")
);


-- AddForeignKey
ALTER TABLE "branch_push_contributions" ADD CONSTRAINT "branch_push_contributions_branch_fkey" FOREIGN KEY ("organization_id", "branch_artifact_id") REFERENCES "branch_detail"("organization_id", "artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
