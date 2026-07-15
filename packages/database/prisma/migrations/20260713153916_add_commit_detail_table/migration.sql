-- CreateTable
CREATE TABLE "commit_detail" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "branch_artifact_id" UUID NOT NULL,
    "message" TEXT,
    "committed_at" TIMESTAMP(3),
    "authored_at" TIMESTAMP(3),
    "author_name" TEXT,
    "author_email" TEXT,
    "author_login" TEXT,
    "lines_added" INTEGER,
    "lines_removed" INTEGER,
    "files_changed" INTEGER,
    "is_merge" BOOLEAN NOT NULL DEFAULT false,
    "merge_commit_sha" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commit_detail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commit_detail_branch_committed_at_idx" ON "commit_detail"("branch_artifact_id", "committed_at");

-- CreateIndex
CREATE UNIQUE INDEX "commit_detail_org_repo_full_name_sha_key" ON "commit_detail"("organization_id", "repository_full_name", "sha");

-- AddForeignKey
ALTER TABLE "commit_detail" ADD CONSTRAINT "commit_detail_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_detail" ADD CONSTRAINT "commit_detail_branch_artifact_id_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
